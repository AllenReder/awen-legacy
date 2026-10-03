import {
  CommandId,
  FILE_RESTORE_DISABLED_ACTIVITY_KIND,
  FILE_RESTORE_DISABLED_SUMMARY,
  CheckpointRef,
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
  type VcsStatusLocalResult,
} from "@awen/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@awen/shared/DrainableWorker";
import { isTemporaryWorktreeBranch } from "@awen/shared/git";

import { parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import {
  checkpointBaselineRefForTurn,
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ExecutionContext from "../../checkpointing/ExecutionContext.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { RuntimeReceiptBus } from "../Services/RuntimeReceiptBus.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as PullRequestService from "../../pullRequest/PullRequestService.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

class CheckpointOwnershipConflict extends Error {
  readonly _tag = "CheckpointOwnershipConflict";
}

type ReactorInput =
  | {
      readonly source: "runtime";
      readonly event: ProviderRuntimeEvent;
    }
  | {
      readonly source: "domain";
      readonly event: OrchestrationEvent;
    };

function toTurnId(value: string | undefined): TurnId | null {
  return value === undefined ? null : TurnId.make(String(value));
}

function sameId(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return false;
  }
  return left === right;
}

function isInPlaceRefChange(
  saved: ExecutionContext.ExecutionContext,
  current: ExecutionContext.ExecutionContext,
): boolean {
  return (
    saved.workspaceId === current.workspaceId &&
    saved.rootPath === current.rootPath &&
    saved.gitCommonDir === current.gitCommonDir &&
    saved.headRef !== current.headRef
  );
}

function checkpointStatusFromRuntime(status: string | undefined): "ready" | "missing" | "error" {
  switch (status) {
    case "failed":
      return "error";
    case "cancelled":
    case "interrupted":
      return "missing";
    case "completed":
    default:
      return "ready";
  }
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
  const serverCommandId = (tag: string) =>
    randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const executionContexts = yield* ExecutionContext.ExecutionContextStore;
  const receiptBus = yield* RuntimeReceiptBus;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const startedTurns = new Map<ThreadId, TurnId>();
  const pending = new Set<ThreadId>();

  const appendRevertFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-revert-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.revert.failed",
            summary: "Checkpoint revert failed",
            payload: {
              turnCount: input.turnCount,
              detail: input.detail,
            },
            turnId: null,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendCaptureFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("checkpoint-capture-failure"),
      activityId: serverEventId,
    }).pipe(
      Effect.flatMap(({ commandId, activityId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: activityId,
            tone: "error",
            kind: "checkpoint.capture.failed",
            summary: "Checkpoint capture failed",
            payload: {
              detail: input.detail,
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const resolveSessionRuntimeForThread = Effect.fn("resolveSessionRuntimeForThread")(function* (
    threadId: ThreadId,
  ): Effect.fn.Return<Option.Option<{ readonly threadId: ThreadId; readonly cwd: string }>> {
    const sessions = yield* providerService.listSessions();
    const session = sessions.find((entry) => entry.threadId === threadId);
    return session?.cwd
      ? Option.some({ threadId: session.threadId, cwd: session.cwd })
      : Option.none();
  });

  const resolveThreadDetail = Effect.fn("resolveThreadDetail")(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [FILE_RESTORE_DISABLED_ACTIVITY_KIND] })
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThreadProjects = Effect.fn("resolveThreadProjects")(function* (
    projectId: ProjectId,
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    return project ? [project] : [];
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);
    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }
    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }
    return cwd;
  });

  const inspectExecutionContext = Effect.fn("inspectExecutionContext")(function* (cwd: string) {
    const shell = yield* projectionSnapshotQuery.getShellSnapshot();
    const workspaces = (shell.awenProjects ?? [])
      .flatMap((project) => project.workspaces)
      .filter((entry) => entry.workspaceRoot === cwd);
    if (workspaces.length !== 1) return undefined;
    return yield* executionContexts
      .inspect(cwd, workspaces[0]!.id)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
  });

  // Keep the original context outside the rewindable turn/checkpoint keys. A
  // switch back, a rewind to zero, or a daemon restart must never re-enable restore.
  const observeFileRestoreContext = Effect.fn("observeFileRestoreContext")(function* (
    threadId: ThreadId,
    current: ExecutionContext.ExecutionContext | undefined,
    createdAt: string,
  ) {
    const thread = yield* resolveThreadDetail(threadId);
    if (
      thread?.activities.some((activity) => activity.kind === FILE_RESTORE_DISABLED_ACTIVITY_KIND)
    ) {
      return true;
    }
    if (!current) return false;
    const original =
      (yield* executionContexts.find(threadId, "session")) ??
      (yield* executionContexts.find(
        threadId,
        `checkpoint:${checkpointRefForThreadTurn(threadId, 0)}`,
      ));
    if (!original) {
      yield* executionContexts.remember(threadId, "session", current);
      return false;
    }
    const switched =
      original.workspaceId !== current.workspaceId || isInPlaceRefChange(original, current);
    if (!switched) return false;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`file-restore-disabled:${threadId}`),
      threadId,
      activity: {
        id: EventId.make(`file-restore-disabled:${threadId}`),
        kind: FILE_RESTORE_DISABLED_ACTIVITY_KIND,
        tone: "info",
        summary: FILE_RESTORE_DISABLED_SUMMARY,
        payload: {},
        turnId: null,
        createdAt,
      },
      createdAt,
    });
    return true;
  });

  const rememberCheckpointContext = Effect.fn("rememberCheckpointContext")(function* (
    threadId: ThreadId,
    checkpointRef: CheckpointRef,
    cwd: string,
    context: ExecutionContext.ExecutionContext,
  ) {
    const oid = yield* executionContexts.oidForRef(cwd, checkpointRef);
    if (oid) {
      yield* executionContexts.remember(threadId, `checkpoint:${checkpointRef}`, context, oid);
    }
  });

  type CheckpointCompletion = {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly thread: {
      readonly messages: ReadonlyArray<{
        readonly id: MessageId;
        readonly role: string;
        readonly turnId: TurnId | null;
      }>;
    };
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  };

  const publishCheckpointResult = Effect.fn("publishCheckpointResult")(function* (
    input: CheckpointCompletion,
    files: ReadonlyArray<{
      readonly path: string;
      readonly kind: "modified";
      readonly additions: number;
      readonly deletions: number;
    }>,
    status: "ready" | "missing" | "error",
    captured: boolean,
  ) {
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);
    const assistantMessageId =
      input.assistantMessageId ??
      input.thread.messages
        .toReversed()
        .find((entry) => entry.role === "assistant" && entry.turnId === input.turnId)?.id ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    if (!captured) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: { turnCount: input.turnCount, status },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // File capture is optional; every completed conversation turn still gets an
  // ordinal summary so rewind never depends on the availability of Git snapshots.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (
    input: CheckpointCompletion & { readonly cwd: string; readonly provenanceVerified: boolean },
  ) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const numberedBaselineRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const turnBaselineRef = checkpointBaselineRefForTurn(input.threadId, input.turnId);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);
    const beforeCapture = yield* inspectExecutionContext(input.cwd);

    yield* observeFileRestoreContext(input.threadId, beforeCapture, input.createdAt);
    const turnContext = yield* executionContexts.find(input.threadId, `turn:${input.turnId}`);
    const executionMatches =
      input.provenanceVerified && beforeCapture && turnContext
        ? yield* executionContexts.compatible(turnContext, beforeCapture)
        : false;
    // A verified in-place ref change is expected agent work. Its cross-branch
    // diff has no safe baseline, but later turns can still capture their own
    // diffs. The permanent notice, rather than a capture error, explains why
    // this Session can no longer restore files.
    if (
      input.provenanceVerified &&
      beforeCapture &&
      turnContext &&
      isInPlaceRefChange(turnContext, beforeCapture)
    ) {
      yield* publishCheckpointResult(input, [], "missing", false);
      return;
    }
    if (!executionMatches || !beforeCapture) {
      yield* appendCaptureFailureActivity({
        threadId: input.threadId,
        turnId: input.turnId,
        detail:
          "File checkpoint was not captured because the execution Workspace or checkout could not be verified.",
        createdAt: input.createdAt,
      });
      yield* publishCheckpointResult(input, [], "missing", false);
      return;
    }
    const usableBaseline = Effect.fn("usableCheckpointBaseline")(function* (ref: CheckpointRef) {
      if (!(yield* checkpointStore.hasCheckpointRef({ cwd: input.cwd, checkpointRef: ref }))) {
        return false;
      }
      const context = yield* executionContexts.find(input.threadId, `checkpoint:${ref}`);
      return (
        !!context &&
        context.checkpointOid === (yield* executionContexts.oidForRef(input.cwd, ref)) &&
        (yield* executionContexts.compatible(context, beforeCapture))
      );
    });
    const numberedBaselineUsable = yield* usableBaseline(numberedBaselineRef);
    const turnBaselineUsable = numberedBaselineUsable
      ? false
      : yield* usableBaseline(turnBaselineRef);
    const fromCheckpointRef = numberedBaselineUsable ? numberedBaselineRef : turnBaselineRef;
    const fromCheckpointExists = numberedBaselineUsable || turnBaselineUsable;
    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    const existingTargetOid = yield* executionContexts.oidForRef(input.cwd, targetCheckpointRef);
    if (existingTargetOid) {
      const savedTarget = yield* executionContexts.find(
        input.threadId,
        `checkpoint:${targetCheckpointRef}`,
      );
      if (
        !beforeCapture ||
        !savedTarget ||
        savedTarget.checkpointOid !== existingTargetOid ||
        !(yield* executionContexts.compatible(savedTarget, beforeCapture))
      ) {
        return yield* Effect.fail(
          new CheckpointOwnershipConflict(
            "An existing checkpoint belongs to another or unverifiable checkout.",
          ),
        );
      }
    }

    if (!existingTargetOid) {
      yield* checkpointStore.captureCheckpoint({
        cwd: input.cwd,
        checkpointRef: targetCheckpointRef,
      });
      const afterCapture = yield* inspectExecutionContext(input.cwd);
      const checkoutUnchanged =
        afterCapture &&
        beforeCapture.workspaceId === afterCapture.workspaceId &&
        beforeCapture.rootPath === afterCapture.rootPath &&
        beforeCapture.gitCommonDir === afterCapture.gitCommonDir &&
        beforeCapture.headRef === afterCapture.headRef &&
        beforeCapture.headCommit === afterCapture.headCommit;
      if (!checkoutUnchanged) {
        yield* observeFileRestoreContext(input.threadId, afterCapture, input.createdAt);
        yield* checkpointStore.deleteCheckpointRefs({
          cwd: input.cwd,
          checkpointRefs: [targetCheckpointRef],
        });
        if (!afterCapture || !isInPlaceRefChange(beforeCapture, afterCapture)) {
          yield* appendCaptureFailureActivity({
            threadId: input.threadId,
            turnId: input.turnId,
            detail: "File checkpoint was discarded because its checkout changed during capture.",
            createdAt: input.createdAt,
          });
        }
        yield* publishCheckpointResult(input, [], "missing", false);
        return;
      }
      yield* rememberCheckpointContext(
        input.threadId,
        targetCheckpointRef,
        input.cwd,
        beforeCapture,
      );
    }

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    // Git may have been initialized during this turn, leaving no pre-turn
    // snapshot. Keep the completion checkpoint for future turns, but do not
    // invent a baseline or attempt a diff against a ref that does not exist.
    const files = yield* (
      fromCheckpointExists
        ? checkpointStore.diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
            format: "numstat",
          })
        : Effect.succeed("")
    ).pipe(
      Effect.map((diff) =>
        parseTurnDiffFilesFromNumstat(diff).map((file) => ({
          path: file.path,
          kind: "modified" as const,
          additions: file.additions,
          deletions: file.deletions,
        })),
      ),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    yield* publishCheckpointResult(input, files, input.status, true);
  });

  // Capture the files left by a terminal turn event. A provider session that
  // exited mid-turn counts as interrupted: adapters drop the session and emit
  // `session.exited` without synthesizing `turn.aborted`.
  const captureCheckpointFromTerminalRuntimeEvent = Effect.fn(
    "captureCheckpointFromTerminalRuntimeEvent",
  )(function* (
    event: Extract<
      ProviderRuntimeEvent,
      { type: "turn.completed" | "turn.aborted" | "session.exited" }
    >,
  ) {
    const turnId = toTurnId(event.turnId);
    if (!turnId) {
      return;
    }

    const thread = yield* resolveThreadDetail(event.threadId);
    if (!thread) {
      return;
    }

    // When a primary turn is active, only that turn may produce completion checkpoints.
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
      return;
    }

    // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
    // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
    // before this reactor runs; those must not prevent real git capture.
    if (
      thread.checkpoints.some(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
      )
    ) {
      return;
    }

    // If a placeholder checkpoint exists for this turn, reuse its turn count
    // instead of incrementing past it.
    const existingPlaceholder = thread.checkpoints.find(
      (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
    );
    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const nextTurnCount = existingPlaceholder
      ? existingPlaceholder.checkpointTurnCount
      : currentTurnCount + 1;

    const input: CheckpointCompletion = {
      threadId: thread.id,
      turnId,
      thread,
      turnCount: nextTurnCount,
      status:
        event.type === "turn.completed"
          ? checkpointStatusFromRuntime(event.payload.state)
          : "ready",
      assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
      createdAt: event.createdAt,
    };
    yield* Effect.gen(function* () {
      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects: yield* resolveThreadProjects(thread.projectId),
        preferSessionRuntime: true,
      });
      if (!checkpointCwd) {
        yield* publishCheckpointResult(input, [], "missing", false);
        return;
      }
      const sessionRuntime = yield* resolveSessionRuntimeForThread(thread.id);
      const recordedTurnContext = yield* executionContexts.find(thread.id, `turn:${turnId}`);
      yield* captureAndDispatchCheckpoint({
        ...input,
        cwd: checkpointCwd,
        provenanceVerified: Option.isSome(sessionRuntime)
          ? sessionRuntime.value.cwd === checkpointCwd
          : recordedTurnContext !== undefined,
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          yield* appendCaptureFailureActivity({
            threadId: thread.id,
            turnId,
            detail: error.message,
            createdAt: event.createdAt,
          });
          yield* publishCheckpointResult(input, [], "missing", false);
        }),
      ),
    );
  });

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);
      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadDetail(event.threadId);
      if (!thread) {
        return;
      }

      const runtime = yield* resolveSessionRuntimeForThread(thread.id);
      const projects = yield* resolveThreadProjects(thread.projectId);
      const assignedCwd = resolveThreadWorkspaceCwd({ thread, projects });
      const checkpointCwd =
        Option.isSome(runtime) && (yield* checkpointStore.isGitRepository(runtime.value.cwd))
          ? runtime.value.cwd
          : assignedCwd;
      if (!checkpointCwd) return;
      if (!(yield* checkpointStore.isGitRepository(checkpointCwd))) return;

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );
      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);
      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      const context = yield* inspectExecutionContext(checkpointCwd);
      if (!context || Option.isNone(runtime) || runtime.value.cwd !== checkpointCwd) return;
      yield* observeFileRestoreContext(thread.id, context, event.createdAt);
      yield* executionContexts.remember(thread.id, `turn:${turnId}`, context);
      if (!baselineExists) {
        yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: baselineCheckpointRef,
        });
        yield* rememberCheckpointContext(thread.id, baselineCheckpointRef, checkpointCwd, context);
      }
      const turnBaselineRef = checkpointBaselineRefForTurn(thread.id, turnId);
      const existingTurnBaselineOid = yield* executionContexts.oidForRef(
        checkpointCwd,
        turnBaselineRef,
      );
      if (existingTurnBaselineOid) {
        const saved = yield* executionContexts.find(thread.id, `checkpoint:${turnBaselineRef}`);
        if (
          !context ||
          !saved ||
          saved.checkpointOid !== existingTurnBaselineOid ||
          !(yield* executionContexts.compatible(saved, context))
        ) {
          return yield* Effect.fail(
            new CheckpointOwnershipConflict(
              "An existing turn baseline belongs to another or unverifiable checkout.",
            ),
          );
        }
      } else {
        yield* checkpointStore.captureCheckpoint({
          cwd: checkpointCwd,
          checkpointRef: turnBaselineRef,
        });
        yield* rememberCheckpointContext(thread.id, turnBaselineRef, checkpointCwd, context);
      }
      if (!baselineExists) {
        yield* receiptBus.publish({
          type: "checkpoint.baseline.captured",
          threadId: thread.id,
          checkpointTurnCount: currentTurnCount,
          checkpointRef: baselineCheckpointRef,
          createdAt: event.createdAt,
        });
      }
    },
  );

  const refreshLocalGitStatusFromTurnCompletion = Effect.fn(
    "refreshLocalGitStatusFromTurnCompletion",
  )(function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) {
    const sessionRuntime = yield* resolveSessionRuntimeForThread(event.threadId);
    if (Option.isNone(sessionRuntime)) {
      return;
    }

    const local = yield* vcsStatusBroadcaster.refreshLocalStatus(sessionRuntime.value.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh local git status after turn completion", {
          threadId: event.threadId,
          turnId: event.turnId ?? null,
          cwd: sessionRuntime.value.cwd,
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );
    if (local !== null) {
      yield* followWorktreeBranchDrift({
        threadId: event.threadId,
        cwd: sessionRuntime.value.cwd,
        local,
      });
      yield* refreshPullRequestAfterTurn({
        threadId: event.threadId,
        turnId: toTurnId(event.turnId),
        cwd: sessionRuntime.value.cwd,
        local,
      });
    }
  });

  // Retry a missing PR after the agent finishes its push and PR creation.
  // Re-read the projected branch after drift adoption. A rejected metadata
  // update must not let this thread refresh another thread's checkout.
  const refreshPullRequestAfterTurn = Effect.fn("refreshPullRequestAfterTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || input.local.isDefaultRef) return;
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(input.threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread || thread.branch !== checkedOutBranch) return;
    if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, input.turnId)) return;
    yield* vcsStatusBroadcaster.refreshPullRequestStatus(input.cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("failed to refresh pull request status after turn completion", {
          threadId: input.threadId,
          cwd: input.cwd,
          detail: error.message,
        }),
      ),
    );
  });

  // A `git checkout` run inside a thread's dedicated worktree (by an agent or
  // the user) bypasses Awen's commands, so the thread's recorded branch goes
  // stale. Since #4460 the client only attributes PR state to a thread when
  // the checked-out branch equals the recorded one, so stale metadata silently
  // orphans the thread's PR. Follow the drift here: adopt the checked-out
  // branch as the thread's branch, but only when the worktree belongs to
  // exactly this thread — for shared cwds the strict matching is the point.
  const followWorktreeBranchDrift = Effect.fn("followWorktreeBranchDrift")(function* (input: {
    readonly threadId: ThreadId;
    readonly cwd: string;
    readonly local: VcsStatusLocalResult;
  }) {
    // Detached HEAD has no branch to adopt; a temporary placeholder checkout
    // means the first-turn auto-rename is still in flight — don't race it.
    const checkedOutBranch = input.local.refName;
    if (checkedOutBranch === null || isTemporaryWorktreeBranch(checkedOutBranch)) {
      return;
    }

    yield* Effect.gen(function* () {
      const thread = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (
        !thread ||
        thread.branch === null ||
        thread.branch === checkedOutBranch ||
        thread.worktreePath === null ||
        thread.worktreePath !== input.cwd
      ) {
        return;
      }

      const shell = yield* projectionSnapshotQuery.getShellSnapshot();
      const worktreeIsShared = shell.threads.some(
        (other) => other.id !== thread.id && other.worktreePath === thread.worktreePath,
      );
      if (worktreeIsShared) {
        return;
      }

      // expectedBranch makes this a compare-and-swap in the decider: if the
      // recorded branch moved between our read and the dispatch (rename,
      // concurrent drift-follow), the stale update is dropped.
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-drift"),
        threadId: thread.id,
        branch: checkedOutBranch,
        expectedBranch: thread.branch,
      });
      yield* Effect.logInfo("thread branch followed worktree checkout", {
        threadId: thread.id,
        previousBranch: thread.branch,
        branch: checkedOutBranch,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("failed to follow worktree branch drift", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        });
      }),
    );
  });

  // Refreshing git status ends in a remote PR lookup under the vcs status
  // write lock. Run it on its own worker so file capture for this turn (and
  // checkpoints for other threads) never wait behind that network call.
  const statusRefreshWorker = yield* makeDrainableWorker(
    (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" }>) =>
      refreshLocalGitStatusFromTurnCompletion(event).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("failed to refresh git status after turn completion", {
                threadId: event.threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      ),
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      // A bootstrap message lands before the worktree exists; its baseline
      // would snapshot the project checkout. The turn-start event that
      // follows captures it against the right cwd.
      if (
        event.metadata.historyImport === true ||
        event.metadata.deferredTurn === true ||
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadDetail(threadId);
    if (!thread) {
      return;
    }

    const projects = yield* resolveThreadProjects(thread.projectId);
    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });
    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );
    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);
    const context = yield* inspectExecutionContext(checkpointCwd);
    yield* observeFileRestoreContext(threadId, context, event.occurredAt);
    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    if (baselineExists) {
      return;
    }

    if (!context) return;
    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* rememberCheckpointContext(threadId, baselineCheckpointRef, checkpointCwd, context);
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  const handleRevertRequested = Effect.fn("handleRevertRequested")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.checkpoint-revert-requested" }>,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);

    const thread = yield* resolveThreadDetail(event.payload.threadId);
    if (!thread) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: "Thread was not found in read model.",
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const checkpointCwd =
      event.payload.restoreFiles === false
        ? undefined
        : yield* resolveCheckpointCwd({
            threadId: event.payload.threadId,
            thread,
            projects: yield* resolveThreadProjects(thread.projectId),
            preferSessionRuntime: true,
          });

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    if (event.payload.turnCount > currentTurnCount) {
      yield* appendRevertFailureActivity({
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        detail: `Checkpoint turn count ${event.payload.turnCount} exceeds current turn count ${currentTurnCount}.`,
        createdAt: now,
      }).pipe(Effect.catch(() => Effect.void));
      return;
    }

    yield* providerService.assertConversationRollbackSupported(event.payload.threadId);

    if (event.payload.restoreFiles !== false) {
      const currentContext = checkpointCwd
        ? yield* inspectExecutionContext(checkpointCwd)
        : undefined;
      if (yield* observeFileRestoreContext(event.payload.threadId, currentContext, now)) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: FILE_RESTORE_DISABLED_SUMMARY,
          createdAt: now,
        });
        return;
      }
      if (!checkpointCwd) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: "Checkpoint workspace is unavailable or is not a git repository.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const assignedCwd = resolveThreadWorkspaceCwd({
        thread,
        projects: yield* resolveThreadProjects(thread.projectId),
      });
      if (assignedCwd !== checkpointCwd) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            "The provider directory does not match the Session's assigned Workspace. Files and conversation were not changed.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const targetCheckpointRef =
        event.payload.turnCount === 0
          ? checkpointRefForThreadTurn(event.payload.threadId, 0)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
            )?.checkpointRef;

      if (!targetCheckpointRef) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Checkpoint ref for turn ${event.payload.turnCount} is unavailable in read model.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const savedContext = yield* executionContexts.find(
        event.payload.threadId,
        `checkpoint:${targetCheckpointRef}`,
      );
      const executionCheckpoint =
        event.payload.turnCount === 0
          ? thread.checkpoints.find((checkpoint) => checkpoint.checkpointTurnCount === 1)
          : thread.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === event.payload.turnCount,
            );
      const executionContext = executionCheckpoint
        ? yield* executionContexts.find(
            event.payload.threadId,
            `turn:${executionCheckpoint.turnId}`,
          )
        : undefined;
      const verifiedCheckpointOid = savedContext?.checkpointOid;
      const compatible =
        savedContext &&
        verifiedCheckpointOid &&
        currentContext &&
        verifiedCheckpointOid ===
          (yield* executionContexts.oidForRef(checkpointCwd, targetCheckpointRef))
          ? yield* executionContexts
              .compatible(savedContext, currentContext)
              .pipe(Effect.catch(() => Effect.succeed(false)))
          : false;
      const executionCompatible =
        executionContext && currentContext
          ? yield* executionContexts
              .compatible(executionContext, currentContext)
              .pipe(Effect.catch(() => Effect.succeed(false)))
          : currentTurnCount === 0;
      if (!compatible || !verifiedCheckpointOid || !executionCompatible) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail:
            "The checkpoint's original Workspace or checkout cannot be verified against the current checkout. Files and conversation were not changed.",
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      const restored = yield* checkpointStore.restoreCheckpoint({
        cwd: checkpointCwd,
        // Restore the verified immutable object; the named Git ref can move
        // after validation in another process or worktree.
        checkpointRef: CheckpointRef.make(verifiedCheckpointOid),
        fallbackToHead: false,
      });
      if (!restored) {
        yield* appendRevertFailureActivity({
          threadId: event.payload.threadId,
          turnCount: event.payload.turnCount,
          detail: `Filesystem checkpoint is unavailable for turn ${event.payload.turnCount}.`,
          createdAt: now,
        }).pipe(Effect.catch(() => Effect.void));
        return;
      }

      // Refresh the workspace entry index so the @-mention file picker
      // reflects the reverted filesystem state.
      yield* workspaceEntries.refresh(checkpointCwd);
    }

    const rolledBackTurns = Math.max(0, currentTurnCount - event.payload.turnCount);
    if (rolledBackTurns > 0) {
      yield* providerService.rollbackConversation({
        threadId: event.payload.threadId,
        numTurns: rolledBackTurns,
      });
    }

    const staleCheckpointRefs: Array<CheckpointRef> = [];
    for (const checkpoint of thread.checkpoints) {
      if (checkpoint.checkpointTurnCount > event.payload.turnCount) {
        staleCheckpointRefs.push(checkpoint.checkpointRef);
        staleCheckpointRefs.push(
          checkpointBaselineRefForTurn(event.payload.threadId, checkpoint.turnId),
        );
      }
    }

    // Conversation rewind does not require Git. Clean up old refs only after
    // the provider has rewound, and never turn cleanup failure into a failed rewind.
    if (staleCheckpointRefs.length > 0) {
      yield* Effect.gen(function* () {
        const cleanupCwd =
          checkpointCwd ??
          (yield* resolveCheckpointCwd({
            threadId: event.payload.threadId,
            thread,
            projects: yield* resolveThreadProjects(thread.projectId),
            preferSessionRuntime: true,
          }));
        if (cleanupCwd)
          yield* checkpointStore.deleteCheckpointRefs({
            cwd: cleanupCwd,
            checkpointRefs: staleCheckpointRefs,
          });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("checkpoint ref cleanup failed after conversation rewind", {
            cause: Cause.pretty(cause),
          }),
        ),
      );
    }
    if (staleCheckpointRefs.length > 0) {
      yield* executionContexts.forget(event.payload.threadId, [
        ...staleCheckpointRefs.map((ref) => `checkpoint:${ref}`),
        ...thread.checkpoints
          .filter((checkpoint) => checkpoint.checkpointTurnCount > event.payload.turnCount)
          .map((checkpoint) => `turn:${checkpoint.turnId}`),
      ]);
    }

    yield* orchestrationEngine
      .dispatch({
        type: "thread.revert.complete",
        commandId: yield* serverCommandId("checkpoint-revert-complete"),
        threadId: event.payload.threadId,
        turnCount: event.payload.turnCount,
        createdAt: now,
      })
      .pipe(
        Effect.catch((error) =>
          appendRevertFailureActivity({
            threadId: event.payload.threadId,
            turnCount: event.payload.turnCount,
            detail: error.message,
            createdAt: now,
          }),
        ),
        Effect.asVoid,
      );
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
      return;
    }

    if (
      event.type === "thread.meta-updated" &&
      (event.payload.branch !== undefined ||
        event.payload.projectId !== undefined ||
        event.payload.worktreePath !== undefined)
    ) {
      const thread = yield* resolveThreadDetail(event.payload.threadId);
      if (!thread) return;
      const cwd = resolveThreadWorkspaceCwd({
        thread,
        projects: yield* resolveThreadProjects(thread.projectId),
      });
      if (cwd)
        yield* observeFileRestoreContext(
          thread.id,
          yield* inspectExecutionContext(cwd),
          event.occurredAt,
        );
    }
  });

  /** Capture a terminal turn's files without failing the reactor on capture errors. */
  const captureTurnCheckpointSafely = Effect.fn("captureTurnCheckpointSafely")(function* (
    event: Extract<
      ProviderRuntimeEvent,
      { type: "turn.completed" | "turn.aborted" | "session.exited" }
    >,
  ) {
    yield* captureCheckpointFromTerminalRuntimeEvent(event).pipe(
      Effect.catch((error) =>
        Effect.flatMap(nowIso, (createdAt) =>
          appendCaptureFailureActivity({
            threadId: event.threadId,
            turnId: toTurnId(event.turnId),
            detail: error.message,
            createdAt,
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      ),
    );
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      const startedTurnId = startedTurns.get(event.threadId);
      const turnId = toTurnId(event.turnId) ?? startedTurnId ?? null;
      startedTurns.delete(event.threadId);
      pending.delete(event.threadId);
      if (turnId === null) {
        return;
      }
      // The exit is the only terminal signal for this turn, so this is the last
      // chance to capture the files it left behind. Otherwise the next turn's
      // baseline swallows them and rewind loses the turn.
      yield* captureTurnCheckpointSafely({ ...event, turnId });
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* providerService.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event).pipe(
        Effect.catch((error) =>
          appendCaptureFailureActivity({
            threadId: event.threadId,
            turnId,
            detail: error.message,
            createdAt: event.createdAt,
          }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* resolveThreadDetail(event.threadId);
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* statusRefreshWorker.enqueue(event);
      }
      if (
        turnId !== null &&
        thread !== undefined &&
        (isTrackedTurn ||
          sameId(thread.session?.activeTurnId, turnId) ||
          (startedTurnId === undefined && !thread.session?.activeTurnId))
      ) {
        pending.delete(event.threadId);
        yield* pullRequests.refreshAfterTurn(thread.projectId);
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureTurnCheckpointSafely(event);
      return;
    }
  });

  const processInput = (input: ReactorInput) =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested" &&
          event.type !== "thread.meta-updated"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(providerService.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(Effect.andThen(statusRefreshWorker.drain)),
  } satisfies CheckpointReactorShape;
});

export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make).pipe(
  Layer.provide(ExecutionContext.layer),
);
