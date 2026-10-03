// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

import {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@awen/contracts";
import {
  CommandId,
  CheckpointRef,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  workspaceIdForAwenProject,
} from "@awen/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { CheckpointReactorLive } from "./CheckpointReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { RuntimeReceiptBusTest } from "./RuntimeReceiptBus.ts";
import * as RuntimeReceiptBus from "../Services/RuntimeReceiptBus.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { CheckpointReactor } from "../Services/CheckpointReactor.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import {
  checkpointBaselineRefForTurn,
  checkpointRefForThreadTurn,
} from "../../checkpointing/Utils.ts";
import { ProviderValidationError } from "../../provider/Errors.ts";
import { ServerConfig } from "../../config.ts";
import * as WorkspaceEntries from "../../workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { PullRequestService } from "../../pullRequest/PullRequestService.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

type LegacyProviderRuntimeEvent = {
  readonly type: string;
  readonly eventId: EventId;
  readonly provider: ProviderDriverKind;
  readonly createdAt: string;
  readonly threadId: ThreadId;
  readonly turnId?: string | undefined;
  readonly itemId?: string | undefined;
  readonly requestId?: string | undefined;
  readonly payload?: unknown | undefined;
  readonly [key: string]: unknown;
};

function createProviderServiceHarness(
  cwd: string,
  initialHasSession = true,
  sessionCwd = cwd,
  providerName: ProviderSession["provider"] = ProviderDriverKind.make("codex"),
) {
  const now = "2026-01-01T00:00:00.000Z";
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const streamSubscribed = Effect.runSync(Deferred.make<void>());
  const rollbackConversation = vi.fn(
    (_input: { readonly threadId: ThreadId; readonly numTurns: number }) => Effect.void,
  );
  const assertConversationRollbackSupported = vi.fn<
    ProviderServiceShape["assertConversationRollbackSupported"]
  >(() => Effect.void);
  let currentSessionCwd = sessionCwd;
  let hasSession = initialHasSession;

  const unsupported = <A>() =>
    Effect.die(new Error("Unsupported provider call in test")) as Effect.Effect<A, never>;
  const listSessions = () =>
    hasSession
      ? Effect.succeed([
          {
            provider: providerName,
            status: "ready",
            runtimeMode: "full-access",
            threadId: ThreadId.make("thread-1"),
            cwd: currentSessionCwd,
            createdAt: now,
            updatedAt: now,
          },
        ] satisfies ReadonlyArray<ProviderSession>)
      : Effect.succeed([] as ReadonlyArray<ProviderSession>);
  const service: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    compactThread: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: () => unsupported(),
    listSessions,
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    assertConversationRollbackSupported,
    getInstanceInfo: (instanceId) =>
      Effect.succeed({
        instanceId,
        driverKind: ProviderDriverKind.make(providerName),
        displayName: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: ProviderDriverKind.make(providerName),
          continuationKey: `${providerName}:instance:${instanceId}`,
        },
      }),
    rollbackConversation,
    uploadFeedback: () => unsupported(),
    get streamEvents() {
      return Stream.unwrap(
        PubSub.subscribe(runtimeEventPubSub).pipe(
          Effect.tap(() => Deferred.succeed(streamSubscribed, undefined)),
          Effect.map(Stream.fromSubscription),
        ),
      );
    },
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as unknown as ProviderRuntimeEvent));
  };

  return {
    service,
    assertConversationRollbackSupported,
    rollbackConversation,
    emit,
    waitForSubscription: Deferred.await(streamSubscribed),
    setSessionCwd: (cwd: string) => {
      currentSessionCwd = cwd;
    },
    setHasSession: (alive: boolean) => {
      hasSession = alive;
    },
  };
}

async function waitForThread<
  T extends {
    readonly id: ThreadId;
    readonly latestTurn: { readonly turnId: string } | null;
    readonly checkpoints: ReadonlyArray<{ readonly checkpointTurnCount: number }>;
    readonly activities: ReadonlyArray<{ readonly kind: string }>;
  },
>(
  readModel: () => Promise<{ readonly threads: ReadonlyArray<T> }>,
  predicate: (thread: T) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<T> => {
    const snapshot = await readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread && predicate(thread)) {
      return thread;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for thread state.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

async function waitForEvent(
  engine: OrchestrationEngineShape,
  predicate: (event: { type: string }) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async () => {
    const events = await Effect.runPromise(
      Stream.runCollect(engine.readEvents(0)).pipe(Effect.map((chunk) => Array.from(chunk))),
    );
    if (events.some(predicate)) {
      return events;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for orchestration event.");
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-checkpoint-handler-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

async function waitForGitRefExists(cwd: string, ref: string, timeoutMs = 15_000) {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (gitRefExists(cwd, ref)) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error(`Timed out waiting for git ref '${ref}'.`);
    }
    await Effect.runPromise(Effect.sleep("10 millis"));
    return poll();
  };
  return poll();
}

describe("CheckpointReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | CheckpointReactor
    | CheckpointStore.CheckpointStore
    | ProjectionSnapshotQuery
    | RuntimeReceiptBus.RuntimeReceiptBus
    | SqlClient.SqlClient,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    readonly cwd?: string;
    readonly dbPath?: string;
    readonly hasSession?: boolean;
    readonly seedFilesystemCheckpoints?: boolean;
    readonly initializeGit?: boolean;
    readonly projectWorkspaceRoot?: string;
    readonly threadWorktreePath?: string | null;
    readonly threadBranch?: string | null;
    readonly secondThreadSharingWorktree?: boolean;
    readonly localStatusRefName?: string | null;
    readonly providerSessionCwd?: string;
    readonly providerName?: ProviderDriverKind;
    readonly gitStatusRefreshCalls?: Array<string>;
    readonly pullRequestRefreshCalls?: Array<string>;
    readonly pullRequestRefresh?: Effect.Effect<void>;
  }) {
    const cwd = options?.cwd ?? createGitRepository();
    const persistenceLayer = options?.dbPath
      ? makeSqlitePersistenceLive(options.dbPath)
      : SqlitePersistenceMemory;
    if (options?.initializeGit === false) {
      NodeFS.rmSync(NodePath.join(cwd, ".git"), { recursive: true });
    }
    tempDirs.push(cwd);
    const provider = createProviderServiceHarness(
      cwd,
      options?.hasSession ?? true,
      options?.providerSessionCwd ?? cwd,
      options?.providerName ?? ProviderDriverKind.make("codex"),
    );
    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(persistenceLayer),
    );
    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(ThreadBackgroundLiveness.layer),
      Layer.provide(ThreadPlanProgress.layer),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(persistenceLayer),
    );

    const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "awen-checkpoint-reactor-test-",
    });
    const pullRequestRefreshes: number[] = [];
    const refreshAfterTurn = () => Effect.sync(() => void pullRequestRefreshes.push(1));
    const vcsStatusBroadcasterLayer = Layer.succeed(VcsStatusBroadcaster, {
      getStatus: () => Effect.die("getStatus should not be called in this test"),
      refreshLocalStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.gitStatusRefreshCalls?.push(cwd);
        }).pipe(
          Effect.as({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef:
              options?.localStatusRefName === undefined || options.localStatusRefName === "main",
            refName:
              options?.localStatusRefName !== undefined ? options.localStatusRefName : "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        ),
      refreshStatus: () => Effect.die("refreshStatus should not be called in this test"),
      refreshPullRequestStatus: (cwd: string) =>
        Effect.sync(() => {
          options?.pullRequestRefreshCalls?.push(cwd);
        }).pipe(Effect.andThen(options?.pullRequestRefresh ?? Effect.void), Effect.as(null)),
      streamStatus: () => Stream.empty,
    });

    const layer = CheckpointReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(RuntimeReceiptBusTest),
      Layer.provideMerge(Layer.succeed(ProviderService, provider.service)),
      Layer.provideMerge(Layer.mock(PullRequestService)({ refreshAfterTurn })),
      Layer.provideMerge(vcsStatusBroadcasterLayer),
      Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(
        WorkspaceEntries.layer.pipe(
          Layer.provide(WorkspacePaths.layer),
          Layer.provideMerge(VcsDriverRegistry.layer),
        ),
      ),
      Layer.provideMerge(WorkspacePaths.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(persistenceLayer),
      Layer.provideMerge(ServerConfigLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const reactor = await runtime.runPromise(Effect.service(CheckpointReactor));
    const checkpointStore = await runtime.runPromise(
      Effect.service(CheckpointStore.CheckpointStore),
    );
    const receiptBus = await runtime.runPromise(
      Effect.service(RuntimeReceiptBus.RuntimeReceiptBus),
    );
    const testScope = await Effect.runPromise(Scope.make("sequential"));
    scope = testScope;
    const receipts = await Effect.runPromise(
      Effect.gen(function* () {
        const receipts = yield* Queue.unbounded<RuntimeReceiptBus.OrchestrationRuntimeReceipt>();
        yield* Stream.runForEach(receiptBus.streamEventsForTest, (receipt) =>
          Queue.offer(receipts, receipt),
        ).pipe(Effect.forkIn(testScope, { startImmediately: true }));
        yield* reactor.start().pipe(Scope.provide(testScope));
        yield* provider.waitForSubscription;
        return receipts;
      }),
    );
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = "2026-01-01T00:00:00.000Z";
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "Test Project",
        workspaceRoot: options?.projectWorkspaceRoot ?? cwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make("cmd-thread-create"),
          threadId: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: options?.threadBranch ?? null,
          worktreePath:
            options?.threadWorktreePath !== undefined ? options.threadWorktreePath : cwd,
          createdAt,
        })
        .pipe(
          options?.secondThreadSharingWorktree
            ? Effect.andThen(
                engine.dispatch({
                  type: "thread.create",
                  commandId: CommandId.make("cmd-thread-create-2"),
                  threadId: ThreadId.make("thread-2"),
                  projectId: asProjectId("project-1"),
                  title: "Thread 2",
                  modelSelection: {
                    instanceId: ProviderInstanceId.make("codex"),
                    model: "gpt-5-codex",
                  },
                  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
                  runtimeMode: "approval-required",
                  branch: null,
                  worktreePath:
                    options?.threadWorktreePath !== undefined ? options.threadWorktreePath : cwd,
                  createdAt,
                }),
              )
            : Effect.asVoid,
        ),
    );

    if (options?.seedFilesystemCheckpoints ?? true) {
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v2\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        }),
      );
      NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "v3\n", "utf8");
      await runtime.runPromise(
        checkpointStore.captureCheckpoint({
          cwd,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        }),
      );
      const root = NodeFS.realpathSync(cwd);
      const commonDir = NodeFS.realpathSync(
        runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
      );
      const headRef = runGit(cwd, ["symbolic-ref", "HEAD"]).trim();
      const headCommit = runGit(cwd, ["rev-parse", "HEAD"]).trim();
      await runtime.runPromise(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          for (const count of [0, 1, 2]) {
            const ref = checkpointRefForThreadTurn(ThreadId.make("thread-1"), count);
            const key = `checkpoint:${ref}`;
            const oid = runGit(cwd, ["rev-parse", ref]).trim();
            yield* sql`
              INSERT INTO checkpoint_execution_contexts
                (thread_id, context_key, workspace_id, root_path, git_common_dir, head_ref, head_commit, checkpoint_oid)
              VALUES (
                ${"thread-1"}, ${key}, ${workspaceIdForAwenProject(asProjectId("project-1"))},
                ${root}, ${commonDir}, ${headRef}, ${headCommit}, ${oid}
              )
            `;
          }
          for (const turnId of [
            "turn-1",
            "turn-2",
            "turn-claude-1",
            "turn-claude-2",
            "guard-turn-1",
            "guard-turn-2",
          ]) {
            yield* sql`
              INSERT INTO checkpoint_execution_contexts
                (thread_id, context_key, workspace_id, root_path, git_common_dir, head_ref, head_commit)
              VALUES (
                ${"thread-1"}, ${`turn:${turnId}`}, ${workspaceIdForAwenProject(asProjectId("project-1"))},
                ${root}, ${commonDir}, ${headRef}, ${headCommit}
              )
            `;
          }
        }),
      );
    }

    return {
      engine,
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      readDetail: () =>
        snapshotQuery.getThreadDetailSnapshot(ThreadId.make("thread-1"), { turnLimit: 1 }),
      provider,
      checkpointStore,
      cwd,
      drain,
      nextReceipt: Queue.take(receipts),
      pullRequestRefreshes,
      dropCheckpointContext: (count: number) =>
        runtime!.runPromise(
          Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const key = `checkpoint:${checkpointRefForThreadTurn(ThreadId.make("thread-1"), count)}`;
            yield* sql`DELETE FROM checkpoint_execution_contexts WHERE thread_id = ${"thread-1"} AND context_key = ${key}`;
          }),
        ),
    };
  }

  effectIt.effect("captures baseline and large turn summaries before completion receipts", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      const createdAt = "2026-01-01T00:00:00.000Z";

      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });

      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-1"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
        checkpointTurnCount: 0,
      });

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
      const largeFileLineCount = 25_000;
      NodeFS.writeFileSync(
        NodePath.join(harness.cwd, "large.txt"),
        `${"payload".repeat(64)}\n`.repeat(largeFileLineCount),
        "utf8",
      );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-1"),
        provider: ProviderDriverKind.make("codex"),

        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        payload: { state: "completed" },
      });

      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId: "turn-1",
        checkpointTurnCount: 1,
      });
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === "thread-1",
      );
      expect(thread?.checkpoints[0]).toMatchObject({
        checkpointTurnCount: 1,
        files: [
          { path: "large.txt", kind: "modified", additions: largeFileLineCount, deletions: 0 },
          { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
        ],
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "turn.processing.quiesced",
        turnId: "turn-1",
        checkpointTurnCount: 1,
      });
      yield* Effect.promise(harness.drain);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
      ).toBe(true);
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
      ).toBe(true);
      expect(
        gitShowFileAtRef(
          harness.cwd,
          checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
          "README.md",
        ),
      ).toBe("v1\n");
      expect(
        gitShowFileAtRef(
          harness.cwd,
          checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
          "README.md",
        ),
      ).toBe("v2\n");
    }),
  );

  effectIt.effect("captures and reverts checkpoints from a nested Git workspace", () =>
    Effect.gen(function* () {
      const repositoryRoot = createGitRepository();
      tempDirs.push(repositoryRoot);
      const workspaceRoot = NodePath.join(repositoryRoot, "apps", "server");
      NodeFS.mkdirSync(workspaceRoot, { recursive: true });
      const filePath = NodePath.join(workspaceRoot, "index.ts");
      NodeFS.writeFileSync(filePath, "export const value = 1;\n");
      runGit(repositoryRoot, ["add", "."]);
      runGit(repositoryRoot, ["commit", "-m", "Add nested workspace"]);
      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          projectWorkspaceRoot: workspaceRoot,
          threadWorktreePath: workspaceRoot,
          providerSessionCwd: workspaceRoot,
        }),
      );
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-nested");
      const createdAt = "2026-01-01T00:00:00.000Z";
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-nested-start"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
      });
      yield* Effect.promise(harness.drain);
      expect(gitRefExists(repositoryRoot, checkpointRefForThreadTurn(threadId, 0))).toBe(true);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
      });

      NodeFS.writeFileSync(filePath, "export const value = 2;\n");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-nested-complete"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: { state: "completed" },
      });
      yield* Effect.promise(harness.drain);
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.checkpoints[0]).toMatchObject({
        status: "ready",
        files: [{ path: "apps/server/index.ts", additions: 1, deletions: 1 }],
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-nested-revert"),
        threadId,
        turnCount: 0,
        createdAt,
      });
      yield* Effect.promise(harness.drain);
      expect(NodeFS.readFileSync(filePath, "utf8")).toBe("export const value = 1;\n");
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({ threadId, numTurns: 1 });
      expect(gitRefExists(repositoryRoot, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
      const reverted = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(reverted?.checkpoints).toEqual([]);
    }),
  );

  effectIt.effect.each(["turn.completed", "turn.aborted"] as const)(
    "captures every edit after a mid-turn diff update on %s",
    (terminalEventType) =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ seedFilesystemCheckpoints: false }),
        );
        const threadId = ThreadId.make("thread-1");
        const turnId = asTurnId("turn-1");
        const assistantMessageId = MessageId.make("assistant:mid-turn");
        const createdAt = "2026-01-01T00:00:00.000Z";
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-mid-turn-running"),
          threadId,
          session: {
            threadId,
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-mid-turn-start"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.baseline.captured",
        });

        NodeFS.writeFileSync(NodePath.join(harness.cwd, "early.ts"), "export const early = 1;\n");
        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-mid-turn-diff"),
          threadId,
          turnId,
          completedAt: createdAt,
          checkpointRef: CheckpointRef.make("provider-diff:mid-turn"),
          assistantMessageId,
          status: "missing",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        });
        yield* Effect.promise(harness.drain);

        NodeFS.writeFileSync(NodePath.join(harness.cwd, "late.ts"), "export const late = 2;\n");
        yield* harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-mid-turn-settled"),
          threadId,
          session: {
            threadId,
            status: terminalEventType === "turn.aborted" ? "interrupted" : "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        });
        harness.provider.emit({
          eventId: EventId.make("evt-mid-turn-complete"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId,
          ...(terminalEventType === "turn.completed"
            ? { type: "turn.completed", payload: { state: "completed" } }
            : { type: "turn.aborted", payload: { reason: "Interrupted by user." } }),
        });
        yield* Effect.promise(harness.drain);
        expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId,
          checkpointTurnCount: 1,
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "turn.processing.quiesced",
          turnId,
        });
        yield* Effect.promise(harness.drain);
        const thread = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(thread?.checkpoints).toHaveLength(1);
        expect(thread?.checkpoints[0]?.status).toBe("ready");
        expect(thread?.latestTurn?.state).toBe(
          terminalEventType === "turn.aborted" ? "interrupted" : "completed",
        );
        expect(thread?.checkpoints[0]?.assistantMessageId).toBe(assistantMessageId);
        expect(thread?.checkpoints[0]?.files.map((file) => file.path)).toEqual([
          "early.ts",
          "late.ts",
        ]);
        expect(
          gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "late.ts"),
        ).toBe("export const late = 2;\n");

        const followUpTurnId = asTurnId("turn-2");
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("evt-follow-up-start"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: followUpTurnId,
        });
        harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("evt-follow-up-complete"),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: followUpTurnId,
          payload: { state: "completed" },
        });
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: followUpTurnId,
          checkpointTurnCount: 2,
        });
        const followUp = (yield* Effect.promise(harness.readModel)).threads.find(
          (entry) => entry.id === threadId,
        );
        expect(
          followUp?.checkpoints.find((checkpoint) => checkpoint.turnId === followUpTurnId),
        ).toMatchObject({ checkpointTurnCount: 2, files: [] });
      }),
  );

  effectIt.effect("captures a checkpoint when the provider session exits mid-turn", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-session-exit");
      const createdAt = "2026-01-01T00:00:00.000Z";
      yield* harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-exit-running"),
        threadId,
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: turnId,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      });
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-session-exit-start"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.baseline.captured",
      });

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "partial.ts"), "export const partial = 1;\n");
      // The provider drops the session from its registry before emitting the
      // exit, so the session cwd is no longer observable at capture time.
      harness.provider.setHasSession(false);
      harness.provider.emit({
        type: "session.exited",
        eventId: EventId.make("evt-session-exit"),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
        payload: { reason: "OpenCode session exited.", recoverable: false, exitKind: "error" },
      });
      yield* Effect.promise(harness.drain);
      yield* Effect.promise(harness.drain);

      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(true);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        turnId,
        checkpointTurnCount: 1,
      });
      const thread = (yield* Effect.promise(harness.readModel)).threads.find(
        (entry) => entry.id === threadId,
      );
      expect(thread?.checkpoints).toHaveLength(1);
      expect(thread?.checkpoints[0]?.status).toBe("ready");
      expect(thread?.checkpoints[0]?.files.map((file) => file.path)).toEqual(["partial.ts"]);
      expect(
        gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 1), "partial.ts"),
      ).toBe("export const partial = 1;\n");
    }),
  );

  it("does not capture an aborted turn without a matching start or active session", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    harness.provider.emit({
      type: "turn.aborted",
      eventId: EventId.make("evt-untracked-abort"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-untracked"),
      payload: { reason: "Interrupted before the turn started." },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === "thread-1");
    expect(thread?.checkpoints).toEqual([]);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(false);
  });

  it("refreshes local git status state on turn completion using the session cwd", async () => {
    const gitStatusRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      gitStatusRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-local-status"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-local-status"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(gitStatusRefreshCalls).toEqual([harness.cwd]);
  });

  it("re-asks for the pull request at turn end when the thread branch is checked out", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "awen/feature",
      localStatusRefName: "awen/feature",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-refresh-pr"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-refresh-pr"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
  });

  effectIt.effect("captures files while the pull request lookup is still pending", () =>
    Effect.gen(function* () {
      const lookupStarted = yield* Deferred.make<void>();
      const finishLookup = yield* Deferred.make<void>();
      const harness = yield* Effect.promise(() =>
        createHarness({
          seedFilesystemCheckpoints: false,
          threadBranch: "awen/feature",
          localStatusRefName: "awen/feature",
          pullRequestRefresh: Deferred.succeed(lookupStarted, undefined).pipe(
            Effect.andThen(Deferred.await(finishLookup)),
          ),
        }),
      );
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("evt-turn-started-slow-pr"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-slow-pr"),
      });
      yield* Effect.promise(harness.drain);
      expect(yield* harness.nextReceipt).toMatchObject({ type: "checkpoint.baseline.captured" });
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "completed turn\n");
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-slow-pr"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-slow-pr"),
        payload: { state: "completed" },
      });

      yield* Deferred.await(lookupStarted);
      yield* Effect.gen(function* () {
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.diff.finalized",
          turnId: "turn-slow-pr",
        });
        yield* Effect.promise(() =>
          waitForGitRefExists(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
          ),
        );
        expect(
          gitShowFileAtRef(
            harness.cwd,
            checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
            "README.md",
          ),
        ).toBe("completed turn\n");
      }).pipe(Effect.ensuring(Deferred.succeed(finishLookup, undefined)));
      yield* Effect.promise(harness.drain);
    }),
  );

  it("re-asks for the pull request after adopting a drifted checkout", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "awen/original-branch",
      localStatusRefName: "awen/renamed-by-agent",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-drift-pr"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-drift-pr"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
  });

  it("does not re-ask for the pull request at turn end on the default branch", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "main",
      localStatusRefName: "main",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-no-pr-refresh"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-no-pr-refresh"),
      payload: { state: "completed" },
    });

    await harness.drain();

    expect(pullRequestRefreshCalls).toEqual([]);
  });

  it("adopts a drifted checkout as the thread branch on a dedicated worktree", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "awen/original-branch",
      localStatusRefName: "awen/renamed-by-agent",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();
    await waitForEvent(
      harness.engine,
      (event) =>
        event.type === "thread.meta-updated" &&
        (event as unknown as { payload: { branch?: string } }).payload.branch ===
          "awen/renamed-by-agent",
    );

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("awen/renamed-by-agent");
  });

  it("follows a checkout from a saved placeholder branch and refreshes its pull request", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "awen/fd9cbe0e",
      localStatusRefName: "fix/mobile-tool-detail-expansion",
      pullRequestRefreshCalls,
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-placeholder-drift"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-placeholder-drift"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("fix/mobile-tool-detail-expansion");
    expect(thread?.worktreePath).toBe(harness.cwd);
    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
  });

  it.each(["awen/original-branch", "awen/fd9cbe0e"])(
    "does not adopt a drifted checkout from %s when the worktree is shared by another thread",
    async (threadBranch) => {
      const pullRequestRefreshCalls: string[] = [];
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        threadBranch,
        localStatusRefName: "awen/renamed-by-agent",
        secondThreadSharingWorktree: true,
        pullRequestRefreshCalls,
      });

      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-branch-drift-shared"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-branch-drift-shared"),
        payload: { state: "completed" },
      });

      await harness.drain();

      const snapshot = await harness.readModel();
      const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
      expect(thread?.branch).toBe(threadBranch);
      expect(pullRequestRefreshCalls).toEqual([]);
    },
  );

  it("does not adopt a temporary placeholder checkout as the thread branch", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "awen/original-branch",
      localStatusRefName: "awen/0a1b2c3d",
    });

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-branch-drift-temp"),
      provider: ProviderDriverKind.make("codex"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-branch-drift-temp"),
      payload: { state: "completed" },
    });

    await harness.drain();

    const snapshot = await harness.readModel();
    const thread = snapshot.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.branch).toBe("awen/original-branch");
  });

  it("ignores auxiliary thread turn completion while primary turn is active", async () => {
    const pullRequestRefreshCalls: string[] = [];
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      threadBranch: "awen/feature",
      localStatusRefName: "awen/feature",
      pullRequestRefreshCalls,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-primary-running"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-main"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-aux"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
    });
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-aux"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-aux"),
      payload: { state: "completed" },
    });

    await harness.drain();
    const midReadModel = await harness.readModel();
    const midThread = midReadModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(midThread?.checkpoints).toHaveLength(0);
    expect(pullRequestRefreshCalls).toEqual([]);
    expect(harness.pullRequestRefreshes).toEqual([]);

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-main"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-main"),
      payload: { state: "completed" },
    });

    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-main" && entry.checkpoints.length === 1,
    );
    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    await harness.drain();
    expect(pullRequestRefreshCalls).toEqual([harness.cwd]);
    expect(harness.pullRequestRefreshes).toEqual([1]);
  });

  it("captures pre-turn and completion checkpoints for claude runtime events", async () => {
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerName: ProviderDriverKind.make("claudeAgent"),
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-capture-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
    });
    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-claude-1"),
      provider: ProviderDriverKind.make("claudeAgent"),
      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-claude-1"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-claude-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  it.each(["branch", "detached HEAD"])(
    "settles an agent switch to %s with a conversation-only notice instead of a checkpoint error",
    async (target) => {
      const harness = await createHarness({
        seedFilesystemCheckpoints: false,
        threadWorktreePath: null,
        threadBranch: "main",
      });
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("turn-switch");
      const createdAt = "2026-01-01T00:00:00.000Z";
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("start-switch"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt,
      });
      await waitForGitRefExists(harness.cwd, checkpointBaselineRefForTurn(threadId, turnId));
      runGit(
        harness.cwd,
        target === "branch" ? ["switch", "-c", "feature/agent"] : ["checkout", "--detach"],
      );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("complete-switch"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt,
        payload: { state: "completed" },
      });
      await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
      await harness.drain();
      const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId)!;
      expect(
        thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(false);
      expect(
        thread.activities.filter(
          (activity) => activity.kind === "checkpoint.file-restore-disabled",
        ),
      ).toEqual([expect.objectContaining({ tone: "info", turnId: null })]);
      expect(thread.checkpoints[0]?.status).toBe("missing");
    },
  );

  effectIt.effect("permanently disables restore when a branch switches during file capture", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      const threadId = ThreadId.make("thread-1");
      const turnId = asTurnId("capture-race");
      const createdAt = "2026-01-01T00:00:00.000Z";
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make("capture-race-start"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt,
      });
      yield* Effect.promise(() =>
        waitForGitRefExists(harness.cwd, checkpointBaselineRefForTurn(threadId, turnId)),
      );
      const capture = harness.checkpointStore.captureCheckpoint;
      const spy = vi
        .spyOn(harness.checkpointStore, "captureCheckpoint")
        .mockImplementation((input) =>
          capture(input).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (input.checkpointRef === checkpointRefForThreadTurn(threadId, 1))
                  runGit(harness.cwd, ["switch", "-c", "during-capture"]);
              }),
            ),
          ),
        );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("capture-race-end"),
        provider: ProviderDriverKind.make("codex"),
        threadId,
        turnId,
        createdAt,
        payload: { state: "completed" },
      });
      yield* Effect.promise(() =>
        waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed"),
      );
      yield* Effect.promise(harness.drain);
      spy.mockRestore();
      const thread = (yield* Effect.promise(harness.readModel)).threads[0]!;
      expect(
        thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(false);
      expect(thread.activities).toContainEqual(
        expect.objectContaining({ kind: "checkpoint.file-restore-disabled" }),
      );
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
      runGit(harness.cwd, ["switch", "main"]);
      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("restore-after-capture-race"),
        threadId,
        turnCount: 0,
        createdAt,
      });
      yield* Effect.promise(harness.drain);
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    }),
  );

  effectIt.effect(
    "rewinds completed conversation turns even when no Git checkpoints can be captured",
    () =>
      Effect.gen(function* () {
        const harness = yield* Effect.promise(() =>
          createHarness({ initializeGit: false, seedFilesystemCheckpoints: false }),
        );
        const threadId = ThreadId.make("thread-1");
        const createdAt = "2026-01-01T00:00:00.000Z";
        for (const count of [1, 2]) {
          const turnId = asTurnId(`no-git-${count}`);
          harness.provider.emit({
            type: "turn.started",
            eventId: EventId.make(`no-git-start-${count}`),
            provider: ProviderDriverKind.make("codex"),
            threadId,
            turnId,
            createdAt,
          });
          harness.provider.emit({
            type: "turn.completed",
            eventId: EventId.make(`no-git-end-${count}`),
            provider: ProviderDriverKind.make("codex"),
            threadId,
            turnId,
            createdAt,
            payload: { state: "completed" },
          });
          yield* Effect.promise(harness.drain);
        }
        yield* harness.engine.dispatch({
          type: "thread.conversation.revert",
          commandId: CommandId.make("rewind-without-git"),
          threadId,
          turnCount: 0,
          createdAt,
        });
        yield* Effect.promise(harness.drain);
        expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
          threadId,
          numTurns: 2,
        });
        expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");
        expect(NodeFS.existsSync(NodePath.join(harness.cwd, ".git"))).toBe(false);
      }),
  );

  effectIt.effect(
    "keeps file restore disabled after switching back, restarting, and rewinding to zero",
    () =>
      Effect.gen(function* () {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "awen-restore-policy-"),
        );
        tempDirs.push(directory);
        const dbPath = NodePath.join(directory, "state.sqlite");
        let harness = yield* Effect.promise(() =>
          createHarness({ dbPath, seedFilesystemCheckpoints: false }),
        );
        const threadId = ThreadId.make("thread-1");
        const createdAt = "2026-01-01T00:00:00.000Z";
        const turnId = asTurnId("switch-before-restart");
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("restart-start"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId,
          createdAt,
        });
        yield* Effect.promise(() =>
          waitForGitRefExists(harness.cwd, checkpointBaselineRefForTurn(threadId, turnId)),
        );
        runGit(harness.cwd, ["switch", "-c", "other"]);
        harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("restart-end"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId,
          createdAt,
          payload: { state: "completed" },
        });
        yield* Effect.promise(() =>
          waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed"),
        );
        yield* Effect.promise(() => harness.drain());
        runGit(harness.cwd, ["switch", "main"]);
        const cwd = harness.cwd;
        yield* Scope.close(scope!, Exit.void);
        scope = null;
        yield* Effect.promise(() => runtime!.dispose());
        runtime = null;
        harness = yield* Effect.promise(() =>
          createHarness({ cwd, dbPath, seedFilesystemCheckpoints: false }),
        );

        // Read through the same bounded snapshot interface used on reconnect. The
        // Session capability must survive even when its notice predates the window.
        for (let index = 0; index < 505; index++) {
          yield* harness.engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`noise-${index}`),
            threadId,
            activity: {
              id: EventId.make(`noise-${index}`),
              tone: "info",
              kind: "test.noise",
              summary: "Later activity",
              payload: {},
              turnId: null,
              createdAt,
            },
            createdAt,
          });
        }
        const detail = yield* harness.readDetail();
        expect(detail._tag).toBe("Some");
        if (detail._tag === "Some")
          expect(detail.value.thread.activities).toContainEqual(
            expect.objectContaining({ kind: "checkpoint.file-restore-disabled" }),
          );

        NodeFS.writeFileSync(NodePath.join(cwd, "README.md"), "keep these files\n");
        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("blocked-after-restart"),
          threadId,
          turnCount: 0,
          createdAt,
        });
        yield* Effect.promise(() => harness.drain());
        expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
        expect(NodeFS.readFileSync(NodePath.join(cwd, "README.md"), "utf8")).toBe(
          "keep these files\n",
        );
        expect(
          (yield* Effect.promise(() => harness.readModel())).threads[0]?.activities,
        ).toContainEqual(
          expect.objectContaining({
            kind: "checkpoint.revert.failed",
            payload: expect.objectContaining({
              detail: expect.stringContaining("file restore is disabled"),
            }),
          }),
        );

        yield* harness.engine.dispatch({
          type: "thread.conversation.revert",
          commandId: CommandId.make("conversation-after-restart"),
          threadId,
          turnCount: 0,
          createdAt,
        });
        yield* Effect.promise(() =>
          waitForEvent(harness.engine, (event) => event.type === "thread.reverted"),
        );
        yield* Effect.promise(() => harness.drain());
        expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
          threadId,
          numTurns: 1,
        });
        expect(NodeFS.readFileSync(NodePath.join(cwd, "README.md"), "utf8")).toBe(
          "keep these files\n",
        );
        harness.provider.rollbackConversation.mockClear();
        const nextTurnId = asTurnId("after-rewind");
        harness.provider.emit({
          type: "turn.started",
          eventId: EventId.make("after-rewind-start"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId: nextTurnId,
          createdAt,
        });
        harness.provider.emit({
          type: "turn.completed",
          eventId: EventId.make("after-rewind-end"),
          provider: ProviderDriverKind.make("codex"),
          threadId,
          turnId: nextTurnId,
          createdAt,
          payload: { state: "completed" },
        });
        yield* Effect.promise(() =>
          waitForThread(harness.readModel, (thread) =>
            thread.checkpoints.some((checkpoint) => checkpoint.turnId === nextTurnId),
          ),
        );
        yield* Effect.promise(() => harness.drain());
        const after = (yield* Effect.promise(() => harness.readModel())).threads[0]!;
        expect(
          after.activities.filter(
            (activity) => activity.kind === "checkpoint.file-restore-disabled",
          ),
        ).toHaveLength(1);
        expect(
          after.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
        ).toBe(false);
        yield* harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("still-blocked-after-rewind"),
          threadId,
          turnCount: 0,
          createdAt,
        });
        yield* Effect.promise(() => harness.drain());
        expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      }),
  );

  it("also disables file restore when a temporary worktree branch is renamed during the turn", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("turn-rename-1");
    const createdAt = "2026-01-01T00:00:00.000Z";

    runGit(harness.cwd, ["checkout", "-b", "awen/a1b2c3d4"]);
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-initial-branch"),
        threadId,
        branch: "awen/a1b2c3d4",
      }),
    );

    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-rename-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await waitForGitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 0));

    runGit(harness.cwd, ["branch", "-m", "awen/a1b2c3d4", "awen/semantic-feature"]);
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-rename-branch"),
        threadId,
        branch: "awen/semantic-feature",
      }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-rename-1"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    const thread = await waitForThread(
      harness.readModel,
      (entry) => entry.latestTurn?.turnId === "turn-rename-1" && entry.checkpoints.length === 1,
    );

    expect(thread.checkpoints[0]?.status).toBe("missing");
    expect(thread.activities).toContainEqual(
      expect.objectContaining({ kind: "checkpoint.file-restore-disabled", tone: "info" }),
    );
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
    expect(
      thread.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
    ).toBe(false);
  });

  effectIt.effect("marks completion without an execution start as missing", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ seedFilesystemCheckpoints: false }),
      );
      harness.provider.emit({
        type: "turn.completed",
        eventId: EventId.make("evt-turn-completed-missing-baseline"),
        provider: ProviderDriverKind.make("codex"),
        createdAt: "2026-01-01T00:00:00.000Z",
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-missing-baseline"),
        payload: { state: "completed" },
      });
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 1,
      });
      yield* Effect.promise(harness.drain);
      const thread = yield* Effect.promise(() =>
        waitForThread(harness.readModel, (entry) => entry.checkpoints[0]?.status === "missing"),
      );
      expect(thread?.checkpoints[0]).toMatchObject({
        status: "missing",
        checkpointTurnCount: 1,
        files: [],
      });
      expect(
        gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
      ).toBe(false);
      expect(
        thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(true);
    }),
  );

  effectIt.effect.each([
    { timing: "between turns", commit: false },
    { timing: "between turns", commit: true },
    { timing: "during a turn", commit: false },
    { timing: "during a turn", commit: true },
  ])("resumes checkpointing after git init $timing (commit: $commit)", ({ timing, commit }) =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ initializeGit: false, seedFilesystemCheckpoints: false }),
      );
      const threadId = ThreadId.make("thread-1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const emit = (type: "turn.started" | "turn.completed", turn: number) =>
        harness.provider.emit({
          type,
          eventId: EventId.make(`${type}-${turn}`),
          provider: ProviderDriverKind.make("codex"),
          createdAt,
          threadId,
          turnId: asTurnId(`turn-${turn}`),
          ...(type === "turn.completed" ? { payload: { state: "completed" } } : {}),
        });
      emit("turn.started", 1);
      yield* Effect.promise(harness.drain);
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "before git\n");
      emit("turn.completed", 1);
      yield* Effect.promise(harness.drain);
      expect((yield* Effect.promise(harness.readModel)).threads[0]?.checkpoints).toEqual([
        expect.objectContaining({ turnId: "turn-1", checkpointTurnCount: 1, status: "missing" }),
      ]);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 1,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });

      if (timing === "during a turn") {
        emit("turn.started", 2);
        yield* Effect.promise(harness.drain);
      }
      runGit(harness.cwd, ["init", "--initial-branch=main"]);
      if (commit) {
        runGit(harness.cwd, ["add", "."]);
        runGit(harness.cwd, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "Initial",
        ]);
      }
      if (timing === "between turns") {
        // Exercise the domain entry point as well as the provider turn-start event.
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-after-git-init"),
          threadId,
          message: {
            messageId: MessageId.make("message-after-git-init"),
            role: "user",
            text: "continue",
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        if (commit) {
          expect(yield* harness.nextReceipt).toMatchObject({
            type: "checkpoint.baseline.captured",
            checkpointTurnCount: 1,
          });
        }
        emit("turn.started", 2);
        yield* Effect.promise(harness.drain);
      }
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "after git\n");
      emit("turn.completed", 2);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 2,
      });
      expect(yield* harness.nextReceipt).toMatchObject({ type: "turn.processing.quiesced" });
      yield* Effect.promise(harness.drain);
      const firstReady = commit && timing === "between turns";
      const firstTurn = yield* Effect.promise(() =>
        waitForThread(
          harness.readModel,
          (entry) => entry.checkpoints[1]?.status === (firstReady ? "ready" : "missing"),
        ),
      );
      const firstCheckpoint = firstTurn.checkpoints[1];
      expect(firstCheckpoint?.files).toEqual(
        firstReady ? [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }] : [],
      );
      if (firstReady) {
        expect(
          gitShowFileAtRef(harness.cwd, checkpointRefForThreadTurn(threadId, 2), "README.md"),
        ).toBe("after git\n");
      } else {
        expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(false);
      }
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(firstReady);

      if (!commit) {
        runGit(harness.cwd, ["add", "."]);
        runGit(harness.cwd, [
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "-m",
          "Initial",
        ]);
      }
      emit("turn.started", 3);
      yield* Effect.promise(harness.drain);
      if (!firstReady) {
        expect(yield* harness.nextReceipt).toMatchObject({
          type: "checkpoint.baseline.captured",
          checkpointTurnCount: 2,
        });
      }
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "next turn\n");
      emit("turn.completed", 3);
      expect(yield* harness.nextReceipt).toMatchObject({
        type: "checkpoint.diff.finalized",
        checkpointTurnCount: 3,
      });
      yield* Effect.promise(harness.drain);
      const thread = yield* Effect.promise(() =>
        waitForThread(harness.readModel, (entry) => entry.checkpoints[2]?.status === "ready"),
      );
      expect(thread?.checkpoints[2]?.files).toEqual([
        { path: "README.md", kind: "modified", additions: 1, deletions: 1 },
      ]);
      expect(
        thread?.activities.some((activity) => activity.kind === "checkpoint.capture.failed"),
      ).toBe(!firstReady);
    }),
  );

  it("captures pre-turn baseline from project workspace root when thread worktree is unset", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-turn-start-for-baseline"),
        threadId: ThreadId.make("thread-1"),
        message: {
          messageId: MessageId.make("message-user-1"),
          role: "user",
          text: "start turn",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
    );
    expect(
      gitShowFileAtRef(
        harness.cwd,
        checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
        "README.md",
      ),
    ).toBe("v1\n");
  });

  it("does not create checkpoints while importing historical user messages", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    if (runtime === null) throw new Error("Checkpoint test runtime was not initialized.");

    await runtime.runPromise(
      harness.engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.make("cmd-import-history-without-checkpoint"),
        threadId: ThreadId.make("thread-1"),
        messages: [
          {
            messageId: MessageId.make("imported-user-message"),
            role: "user",
            text: "A message from an existing agent session",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await harness.drain();

    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0)),
    ).toBe(false);
  });

  it("does not capture a file checkpoint from the projected directory without a provider cwd", async () => {
    const harness = await createHarness({
      hasSession: false,
      seedFilesystemCheckpoints: false,
      threadWorktreePath: null,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-missing-provider-cwd"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "running",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: asTurnId("turn-missing-cwd"),
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n", "utf8");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-turn-completed-missing-provider-cwd"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-missing-cwd"),
      payload: { state: "completed" },
    });

    await waitForEvent(harness.engine, (event) => event.type === "thread.turn-diff-completed");
    await waitForThread(harness.readModel, (entry) => entry.checkpoints[0]?.status === "missing");
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v2\n");
  });

  it("ignores non-v2 checkpoint.captured runtime events", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-checkpoint-captured"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "checkpoint.captured",
      eventId: EventId.make("evt-checkpoint-captured-3"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-3"),
      turnCount: 3,
      status: "completed",
    });

    await harness.drain();
    const readModel = await harness.readModel();
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    expect(thread?.checkpoints.some((checkpoint) => checkpoint.checkpointTurnCount === 3)).toBe(
      false,
    );
  });

  it("continues processing runtime events after a single checkpoint runtime failure", async () => {
    const nonRepositorySessionCwd = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "awen-checkpoint-runtime-non-repo-"),
    );
    tempDirs.push(nonRepositorySessionCwd);

    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: nonRepositorySessionCwd,
    });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-non-repo-runtime"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-runtime-capture-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-runtime-failure"),
      payload: { state: "completed" },
    });

    harness.provider.setSessionCwd(harness.cwd);
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-turn-started-after-runtime-failure"),
      provider: ProviderDriverKind.make("codex"),

      createdAt: "2026-01-01T00:00:00.000Z",
      threadId: ThreadId.make("thread-1"),
      turnId: asTurnId("turn-after-runtime-failure"),
    });

    await waitForGitRefExists(
      harness.cwd,
      checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
    );
    expect(
      gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)),
    ).toBe(true);
  });

  effectIt.effect("rejects unsupported rewind before changing files, checkpoints, or history", () =>
    Effect.gen(function* () {
      const harness = yield* Effect.promise(() =>
        createHarness({ providerName: ProviderDriverKind.make("antigravity") }),
      );
      const threadId = ThreadId.make("thread-1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      const checked = yield* Deferred.make<void>();
      harness.provider.assertConversationRollbackSupported.mockImplementation(() =>
        Deferred.succeed(checked, undefined).pipe(
          Effect.andThen(
            Effect.fail(
              new ProviderValidationError({
                operation: "ProviderService.assertConversationRollbackSupported",
                issue: "Provider 'antigravity' does not support conversation rewind.",
              }),
            ),
          ),
        ),
      );

      for (const turnCount of [1, 2]) {
        yield* harness.engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(`cmd-unsupported-rewind-message-${turnCount}`),
          threadId,
          message: {
            messageId: MessageId.make(`message-unsupported-rewind-${turnCount}`),
            role: "user",
            text: `Keep message ${turnCount}`,
            attachments: [],
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          createdAt,
        });
        yield* harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(`cmd-unsupported-rewind-diff-${turnCount}`),
          threadId,
          turnId: asTurnId(`turn-unsupported-rewind-${turnCount}`),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(threadId, turnCount),
          status: "ready",
          files: [],
          checkpointTurnCount: turnCount,
          createdAt,
        });
      }
      const before = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (thread) => thread.id === threadId,
      );

      yield* harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-unsupported-rewind"),
        threadId,
        turnCount: 1,
        createdAt,
      });
      yield* Deferred.await(checked);
      yield* Effect.promise(() => harness.drain());

      const after = (yield* Effect.promise(() => harness.readModel())).threads.find(
        (thread) => thread.id === threadId,
      );
      expect(after?.checkpoints).toEqual(before?.checkpoints);
      expect(after?.messages).toEqual(before?.messages);
      expect(after?.latestTurn).toEqual(before?.latestTurn);
      expect(after?.activities).toContainEqual(
        expect.objectContaining({
          kind: "checkpoint.revert.failed",
          payload: expect.objectContaining({
            detail: expect.stringContaining("does not support conversation rewind"),
          }),
        }),
      );
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
      expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 2))).toBe(true);
    }),
  );

  it.each([
    { commandType: "thread.checkpoint.revert", initializeGit: true },
    { commandType: "thread.conversation.revert", initializeGit: true },
    { commandType: "thread.conversation.revert", initializeGit: false },
  ] as const)(
    "$commandType rewinds history with the requested filesystem behavior (git: $initializeGit)",
    async ({ commandType, initializeGit }) => {
      const harness = await createHarness({
        initializeGit,
        seedFilesystemCheckpoints: initializeGit,
      });
      const createdAt = "2026-01-01T00:00:00.000Z";

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make("cmd-session-set"),
          threadId: ThreadId.make("thread-1"),
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "ready",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: null,
            lastError: null,
            updatedAt: createdAt,
          },
          createdAt,
        }),
      );

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-diff-1"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          completedAt: createdAt,
          checkpointRef: initializeGit
            ? checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1)
            : CheckpointRef.make("provider-diff:thread-1:turn-1"),
          status: initializeGit ? "ready" : "missing",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-diff-2"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-2"),
          completedAt: createdAt,
          checkpointRef: initializeGit
            ? checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)
            : CheckpointRef.make("provider-diff:thread-1:turn-2"),
          status: initializeGit ? "ready" : "missing",
          files: [],
          checkpointTurnCount: 2,
          createdAt,
        }),
      );

      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "staged edit\n");
      if (initializeGit) {
        NodeChildProcess.execFileSync("git", ["add", "README.md"], { cwd: harness.cwd });
      }
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "unstaged edit\n");
      NodeFS.writeFileSync(NodePath.join(harness.cwd, "scratch.txt"), "untracked edit\n");
      const indexBefore = initializeGit
        ? NodeChildProcess.execFileSync("git", ["ls-files", "--stage"], {
            cwd: harness.cwd,
            encoding: "utf8",
          })
        : undefined;

      await Effect.runPromise(
        harness.engine.dispatch({
          type: commandType,
          commandId: CommandId.make("cmd-revert-request"),
          threadId: ThreadId.make("thread-1"),
          turnCount: 1,
          createdAt,
        }),
      );

      await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
      const thread = await waitForThread(
        harness.readModel,
        (entry) => entry.checkpoints.length === 1,
      );

      expect(thread.latestTurn?.turnId).toBe("turn-1");
      expect(thread.checkpoints).toHaveLength(1);
      expect(thread.checkpoints[0]?.checkpointTurnCount).toBe(1);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
        numTurns: 1,
      });
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe(
        commandType === "thread.conversation.revert" ? "unstaged edit\n" : "v2\n",
      );
      if (commandType === "thread.conversation.revert") {
        expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "scratch.txt"), "utf8")).toBe(
          "untracked edit\n",
        );
        if (initializeGit) {
          expect(
            NodeChildProcess.execFileSync("git", ["ls-files", "--stage"], {
              cwd: harness.cwd,
              encoding: "utf8",
            }),
          ).toBe(indexBefore);
        }
      }
      if (initializeGit) {
        expect(
          gitRefExists(harness.cwd, checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2)),
        ).toBe(false);
      } else {
        expect(NodeFS.existsSync(NodePath.join(harness.cwd, ".git"))).toBe(false);
      }
    },
  );

  it("executes provider revert and emits thread.reverted for claude sessions", async () => {
    const harness = await createHarness({ providerName: ProviderDriverKind.make("claudeAgent") });
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-claude"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "claudeAgent",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-diff-claude-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-claude-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-request-claude"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );

    await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(1);
    expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it("processes consecutive revert requests with deterministic rollback sequencing", async () => {
    const harness = await createHarness();
    const createdAt = "2026-01-01T00:00:00.000Z";

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-session-set-inline-revert"),
        threadId: ThreadId.make("thread-1"),
        session: {
          threadId: ThreadId.make("thread-1"),
          status: "ready",
          providerName: "codex",
          runtimeMode: "approval-required",
          activeTurnId: null,
          lastError: null,
          updatedAt: createdAt,
        },
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-1"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-1"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [],
        checkpointTurnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-inline-revert-diff-2"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt: createdAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 2),
        status: "ready",
        files: [],
        checkpointTurnCount: 2,
        createdAt,
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-1"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 1,
        createdAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-sequenced-revert-request-0"),
        threadId: ThreadId.make("thread-1"),
        turnCount: 0,
        createdAt,
      }),
    );

    await harness.drain();

    expect(harness.provider.rollbackConversation).toHaveBeenCalledTimes(2);
    expect(harness.provider.rollbackConversation.mock.calls[0]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
    expect(harness.provider.rollbackConversation.mock.calls[1]?.[0]).toEqual({
      threadId: ThreadId.make("thread-1"),
      numTurns: 1,
    });
  });

  it.each([false, true])(
    "reverts without an active session using project cwd fallback: %s",
    async (useProjectCwd) => {
      const harness = await createHarness({
        hasSession: false,
        ...(useProjectCwd ? { threadWorktreePath: null } : {}),
      });
      const createdAt = "2026-01-01T00:00:00.000Z";

      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make("cmd-diff-before-session-recovery"),
          threadId: ThreadId.make("thread-1"),
          turnId: asTurnId("turn-1"),
          completedAt: createdAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
          status: "ready",
          files: [],
          checkpointTurnCount: 1,
          createdAt,
        }),
      );
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make("cmd-revert-no-session"),
          threadId: ThreadId.make("thread-1"),
          turnCount: 0,
          createdAt,
        }),
      );

      await waitForEvent(harness.engine, (event) => event.type === "thread.reverted");
      expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
        threadId: ThreadId.make("thread-1"),
        numTurns: 1,
      });
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");
    },
  );

  it.each([
    "different branch",
    "rewritten checkout",
    "missing provenance",
    "moved Workspace",
  ] as const)(
    "rejects file rollback before changing files or conversation for %s",
    async (scenario) => {
      const harness = await createHarness();
      const threadId = ThreadId.make("thread-1");
      const createdAt = "2026-01-01T00:00:00.000Z";
      for (const count of [1, 2]) {
        await runtime!.runPromise(
          harness.engine.dispatch({
            type: "thread.turn.diff.complete",
            commandId: CommandId.make(`cmd-guard-diff-${count}`),
            threadId,
            turnId: asTurnId(`guard-turn-${count}`),
            completedAt: createdAt,
            checkpointRef: checkpointRefForThreadTurn(threadId, count),
            status: "ready",
            files: [],
            checkpointTurnCount: count,
            createdAt,
          }),
        );
      }
      const before = (await harness.readModel()).threads.find((thread) => thread.id === threadId);
      if (scenario === "different branch") {
        runGit(harness.cwd, ["checkout", "-b", "other"]);
      } else if (scenario === "rewritten checkout") {
        runGit(harness.cwd, ["checkout", "--orphan", "replacement"]);
        runGit(harness.cwd, ["add", "."]);
        runGit(harness.cwd, ["commit", "-m", "Unrelated root"]);
        runGit(harness.cwd, ["branch", "-D", "main"]);
        runGit(harness.cwd, ["branch", "-m", "main"]);
      } else if (scenario === "missing provenance") {
        await harness.dropCheckpointContext(1);
      } else {
        const otherCwd = createGitRepository();
        tempDirs.push(otherCwd);
        await runtime!.runPromise(
          harness.engine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make("cmd-move-before-revert"),
            threadId,
            worktreePath: otherCwd,
          }),
        );
      }

      const fileBefore = NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8");
      await runtime!.runPromise(
        harness.engine.dispatch({
          type: "thread.checkpoint.revert",
          commandId: CommandId.make(`cmd-reject-revert-${scenario}`),
          threadId,
          turnCount: 1,
          createdAt,
        }),
      );
      await harness.drain();

      const after = (await harness.readModel()).threads.find((thread) => thread.id === threadId);
      expect(after?.checkpoints).toEqual(before?.checkpoints);
      expect(after?.messages).toEqual(before?.messages);
      expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
      expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe(fileBefore);
      expect(after?.activities).toContainEqual(
        expect.objectContaining({ kind: "checkpoint.revert.failed" }),
      );

      if (scenario === "different branch") {
        await runtime!.runPromise(
          harness.engine.dispatch({
            type: "thread.conversation.revert",
            commandId: CommandId.make("cmd-conversation-only-after-branch-change"),
            threadId,
            turnCount: 1,
            createdAt,
          }),
        );
        await harness.drain();
        expect(harness.provider.rollbackConversation).toHaveBeenCalledWith({
          threadId,
          numTurns: 1,
        });
        expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe(
          fileBefore,
        );
      }
    },
  );

  it("binds a captured checkpoint to the provider's actual Workspace across a move", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const otherParent = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "awen-checkpoint-other-"),
    );
    tempDirs.push(otherParent);
    const otherCwd = NodePath.join(otherParent, "checkout");
    runGit(harness.cwd, ["worktree", "add", "-b", "feature", otherCwd]);
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-register-other-checkout"),
        projectId: asProjectId("project-2"),
        title: "Other Workspace",
        workspaceRoot: otherCwd,
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        createdAt,
      }),
    );

    harness.provider.setSessionCwd(otherCwd);
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-other-checkout-start"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-other-checkout"),
    });
    await harness.drain();
    NodeFS.writeFileSync(NodePath.join(otherCwd, "README.md"), "changed in other checkout\n");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-other-checkout-complete"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("turn-other-checkout"),
      payload: { state: "completed" },
    });
    await harness.drain();
    const before = (await harness.readModel()).threads.find((thread) => thread.id === threadId);
    expect(before?.checkpoints).toHaveLength(1);
    expect(before?.checkpoints[0]?.status).toBe("ready");

    harness.provider.setSessionCwd(harness.cwd);
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-restore-other-checkout-in-original"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();

    const after = (await harness.readModel()).threads.find((thread) => thread.id === threadId);
    expect(after?.checkpoints).toEqual(before?.checkpoints);
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");
    expect(NodeFS.readFileSync(NodePath.join(otherCwd, "README.md"), "utf8")).toBe(
      "changed in other checkout\n",
    );
    expect(after?.activities).toContainEqual(
      expect.objectContaining({ kind: "checkpoint.revert.failed" }),
    );

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.meta.update",
        commandId: CommandId.make("cmd-assign-captured-checkout"),
        threadId,
        worktreePath: otherCwd,
      }),
    );
    harness.provider.setSessionCwd(otherCwd);
    NodeFS.writeFileSync(NodePath.join(otherCwd, "README.md"), "later edit\n");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-restore-in-captured-checkout"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();
    expect(NodeFS.readFileSync(NodePath.join(otherCwd, "README.md"), "utf8")).toBe("later edit\n");
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v1\n");

    NodeFS.writeFileSync(NodePath.join(otherCwd, "README.md"), "foreign ref contents\n");
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: otherCwd,
        checkpointRef: checkpointRefForThreadTurn(threadId, 1),
      }),
    );
    NodeFS.writeFileSync(NodePath.join(otherCwd, "README.md"), "later edit\n");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-reject-changed-checkpoint-ref"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();
    expect(NodeFS.readFileSync(NodePath.join(otherCwd, "README.md"), "utf8")).toBe("later edit\n");
  });

  it("keeps fresh turn diffs but permanently refuses file restore after an in-place branch change", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const emit = (type: "turn.started" | "turn.completed", count: number) =>
      harness.provider.emit({
        type,
        eventId: EventId.make(`evt-branch-context-${type}-${count}`),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId: asTurnId(`branch-context-turn-${count}`),
        ...(type === "turn.completed" ? { payload: { state: "completed" } } : {}),
      });
    emit("turn.started", 1);
    await harness.drain();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v2\n");
    emit("turn.completed", 1);
    await harness.drain();

    runGit(harness.cwd, ["checkout", "-b", "feature"]);
    emit("turn.started", 2);
    await harness.drain();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v3\n");
    emit("turn.completed", 2);
    await harness.drain();
    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.checkpoints[1]?.files).toContainEqual(
      expect.objectContaining({ path: "README.md", additions: 1, deletions: 1 }),
    );

    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-reject-before-branch-change"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v3\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "v4\n");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-restore-after-branch-change"),
        threadId,
        turnCount: 2,
        createdAt,
      }),
    );
    await harness.drain();
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe("v4\n");
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("refuses a completion checkpoint when checkout changed during its turn", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const createdAt = "2026-01-01T00:00:00.000Z";
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-mid-turn-checkout-start"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("mid-turn-checkout"),
    });
    await harness.drain();
    runGit(harness.cwd, ["checkout", "-b", "feature"]);
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "feature checkpoint\n");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-mid-turn-checkout-complete"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId: asTurnId("mid-turn-checkout"),
      payload: { state: "completed" },
    });
    await harness.drain();
    expect((await harness.readModel()).threads[0]?.checkpoints).toHaveLength(1);
    expect((await harness.readModel()).threads[0]?.checkpoints[0]?.status).toBe("missing");
    expect(gitRefExists(harness.cwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "later edit\n");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-mid-turn-checkout"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe(
      "later edit\n",
    );
    expect(harness.provider.rollbackConversation).not.toHaveBeenCalled();
  });

  it("keeps the first file checkpoint when a missing completion is retried", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("retried-completion");
    const createdAt = "2026-01-01T00:00:00.000Z";
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-retried-start"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await harness.drain();

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "first completion\n");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-retried-missing"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "cancelled" },
    });
    await harness.drain();
    expect((await harness.readModel()).threads[0]?.checkpoints[0]?.status).toBe("missing");

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "later completion\n");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-retried-ready"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });
    await harness.drain();

    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "unsaved edit\n");
    await runtime!.runPromise(
      harness.engine.dispatch({
        type: "thread.checkpoint.revert",
        commandId: CommandId.make("cmd-revert-retried-completion"),
        threadId,
        turnCount: 1,
        createdAt,
      }),
    );
    await harness.drain();
    expect(NodeFS.readFileSync(NodePath.join(harness.cwd, "README.md"), "utf8")).toBe(
      "first completion\n",
    );
  });

  it("keeps the turn-start baseline when the start event is repeated", async () => {
    const harness = await createHarness({ seedFilesystemCheckpoints: false });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("repeated-start");
    const createdAt = "2026-01-01T00:00:00.000Z";
    const emitStart = (eventId: string) =>
      harness.provider.emit({
        type: "turn.started",
        eventId: EventId.make(eventId),
        provider: ProviderDriverKind.make("codex"),
        createdAt,
        threadId,
        turnId,
      });

    emitStart("evt-first-start");
    await harness.drain();
    const baselineRef = checkpointBaselineRefForTurn(threadId, turnId);
    const originalOid = runGit(harness.cwd, ["rev-parse", baselineRef]).trim();
    NodeFS.writeFileSync(NodePath.join(harness.cwd, "README.md"), "edit after start\n");

    emitStart("evt-repeated-start");
    await harness.drain();
    expect(runGit(harness.cwd, ["rev-parse", baselineRef]).trim()).toBe(originalOid);
  });

  it("records a missing file checkpoint without capturing from an unknown Workspace", async () => {
    const unknownCwd = createGitRepository();
    tempDirs.push(unknownCwd);
    const harness = await createHarness({
      seedFilesystemCheckpoints: false,
      providerSessionCwd: unknownCwd,
    });
    const threadId = ThreadId.make("thread-1");
    const turnId = asTurnId("unknown-origin");
    const createdAt = "2026-01-01T00:00:00.000Z";
    harness.provider.emit({
      type: "turn.started",
      eventId: EventId.make("evt-unknown-start"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
    });
    await harness.drain();
    NodeFS.writeFileSync(NodePath.join(unknownCwd, "README.md"), "unknown origin edit\n");
    harness.provider.emit({
      type: "turn.completed",
      eventId: EventId.make("evt-unknown-complete"),
      provider: ProviderDriverKind.make("codex"),
      createdAt,
      threadId,
      turnId,
      payload: { state: "completed" },
    });
    await harness.drain();

    const thread = (await harness.readModel()).threads.find((entry) => entry.id === threadId);
    expect(thread?.checkpoints[0]?.status).toBe("missing");
    expect(gitRefExists(unknownCwd, checkpointRefForThreadTurn(threadId, 1))).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(unknownCwd, "README.md"), "utf8")).toBe(
      "unknown origin edit\n",
    );
  });
});
