import {
  AgentSessionOperationError,
  AgentSessionId,
  type AgentSessionMigrateToWorkspaceInput,
  type AgentSessionMigrateToWorkspaceResult,
  type AgentSessionMigrationRecovery,
  type AgentSessionMigrationStateInput,
  type AgentSessionMigrationStateResult,
  type AwenWorkspaceError,
  type AwenWorkspaceShell,
  type OrchestrationThreadShell,
  CommandId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceId,
  isOrchestrationSessionExecuting,
} from "@awen/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as AwenWorkspaceService from "../workspace/AwenWorkspaceService.ts";
import { toPersistenceSqlError } from "../persistence/Errors.ts";

/**
 * Server-side owner of Agent Session execution preparation and migration.
 *
 * Workspace operations own directory/Git/registration primitives; this module
 * is the single orchestrator that prepares a candidate execution context,
 * validates the provider can preserve the conversation there, commits the new
 * Workspace assignment, and keeps sends blocked when the provider and the
 * committed assignment disagree after a partial failure.
 */
export class AwenSessionService extends Context.Service<
  AwenSessionService,
  {
    readonly migrateToWorkspace: (
      input: AgentSessionMigrateToWorkspaceInput,
    ) => Effect.Effect<AgentSessionMigrateToWorkspaceResult, AgentSessionOperationError>;
    readonly getMigrationState: (
      input: AgentSessionMigrationStateInput,
    ) => Effect.Effect<AgentSessionMigrationStateResult, AgentSessionOperationError>;
    /**
     * Reject a turn while a failed migration leaves the provider and the
     * committed assignment in disagreement. Resolves the disagreement when the
     * observed provider context makes that unambiguous.
     */
    readonly assertSendAllowed: (
      threadId: ThreadId,
    ) => Effect.Effect<void, AgentSessionOperationError>;
  }
>()("@awen/server/session/AwenSessionService") {}

const RecoveryRequest = Schema.Struct({ threadId: ThreadId });
const RecoveryDbRow = Schema.Struct({
  threadId: ThreadId,
  intendedWorkspaceId: WorkspaceId,
  intendedProjectId: ProjectId,
  intendedCwd: TrimmedNonEmptyString,
  committedProjectId: ProjectId,
  committedCwd: Schema.NullOr(TrimmedNonEmptyString),
  providerMoved: Schema.Number,
  detail: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

function sessionError(
  reason: AgentSessionOperationError["reason"],
  detail: string,
  extra?: {
    readonly agentSessionId?: AgentSessionId;
    readonly workspaceId?: WorkspaceId;
    readonly recovery?: AgentSessionMigrationRecovery;
    readonly cause?: unknown;
  },
): AgentSessionOperationError {
  return new AgentSessionOperationError({
    reason,
    detail,
    ...(extra?.agentSessionId !== undefined ? { agentSessionId: extra.agentSessionId } : {}),
    ...(extra?.workspaceId !== undefined ? { workspaceId: extra.workspaceId } : {}),
    ...(extra?.recovery !== undefined ? { recovery: extra.recovery } : {}),
    ...(extra?.cause !== undefined ? { cause: extra.cause } : {}),
  });
}

/**
 * Normalize every failure that can escape the public Session operations into
 * the single typed contract error. Recoverable migration failures already
 * carry their recovery state; a lower-level persistence/provider error becomes
 * a non-recoverable operation error so callers never see an untyped channel.
 */
const normalizeSessionError = <A, E, R>(
  self: Effect.Effect<A, E, R>,
): Effect.Effect<A, AgentSessionOperationError, R> =>
  Effect.catchCause(self, (cause) => {
    if (Cause.hasInterruptsOnly(cause)) {
      return Effect.interrupt;
    }
    const error = Cause.squash(cause);
    return Schema.is(AgentSessionOperationError)(error)
      ? Effect.fail(error)
      : Effect.fail(
          sessionError("operation-failed", "Agent Session operation failed.", {
            cause: error,
          }),
        );
  });

/**
 * Lift an operation error into a failing Effect. Kept separate from
 * `sessionError` because `yield*` requires an Effect, not a bare error value.
 */
function failSession(
  reason: AgentSessionOperationError["reason"],
  detail: string,
  extra?: {
    readonly agentSessionId?: AgentSessionId;
    readonly workspaceId?: WorkspaceId;
    readonly recovery?: AgentSessionMigrationRecovery;
    readonly cause?: unknown;
  },
): Effect.Effect<never, AgentSessionOperationError> {
  return Effect.fail(sessionError(reason, detail, extra));
}

/**
 * Translate a Workspace registration failure into the Session operation error
 * contract. A checkout Awen cannot own (another Project or repository) is a
 * target mismatch, not an operational failure.
 */
function mapAssociateError(
  agentSessionId: AgentSessionId,
  targetPath: string,
  error: AwenWorkspaceError,
): AgentSessionOperationError {
  switch (error.reason) {
    case "already-registered":
    case "different-repository":
      return sessionError(
        "different-project",
        `'${targetPath}' belongs to another Project or repository.`,
        { agentSessionId, cause: error },
      );
    case "path-not-found":
      return sessionError("target-directory-missing", `'${targetPath}' does not exist.`, {
        agentSessionId,
        cause: error,
      });
    default:
      return sessionError(
        "operation-failed",
        `Could not prepare '${targetPath}' as a Workspace: ${error.detail}`,
        { agentSessionId, cause: error },
      );
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const projectionQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providerService = yield* ProviderService.ProviderService;
  const workspaceService = yield* AwenWorkspaceService.AwenWorkspaceService;

  const recoveryByThread = SqlSchema.findOneOption({
    Request: RecoveryRequest,
    Result: RecoveryDbRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        intended_workspace_id AS "intendedWorkspaceId",
        intended_project_id AS "intendedProjectId",
        intended_cwd AS "intendedCwd",
        committed_project_id AS "committedProjectId",
        committed_cwd AS "committedCwd",
        provider_moved AS "providerMoved",
        detail,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM agent_session_migrations
      WHERE thread_id = ${threadId}
      LIMIT 1
    `,
  });

  const listRecoveryThreadIds = () =>
    sql<{ threadId: string }>`
      SELECT thread_id AS "threadId" FROM agent_session_migrations
    `.pipe(
      Effect.map((rows) => rows.map((row) => row.threadId)),
      Effect.mapError(toPersistenceSqlError("AwenSessionService.listRecoveryThreadIds")),
    );

  const upsertRecovery = (input: {
    readonly threadId: ThreadId;
    readonly intendedWorkspaceId: WorkspaceId;
    readonly intendedProjectId: ProjectId;
    readonly intendedCwd: string;
    readonly committedProjectId: ProjectId;
    readonly committedCwd?: string;
    readonly providerMoved: boolean;
    readonly detail: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }) =>
    sql`
      INSERT INTO agent_session_migrations (
        thread_id,
        intended_workspace_id,
        intended_project_id,
        intended_cwd,
        committed_project_id,
        committed_cwd,
        provider_moved,
        detail,
        created_at,
        updated_at
      ) VALUES (
        ${input.threadId},
        ${input.intendedWorkspaceId},
        ${input.intendedProjectId},
        ${input.intendedCwd},
        ${input.committedProjectId},
        ${input.committedCwd ?? null},
        ${input.providerMoved ? 1 : 0},
        ${input.detail},
        ${input.createdAt},
        ${input.updatedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        intended_workspace_id = excluded.intended_workspace_id,
        intended_project_id = excluded.intended_project_id,
        intended_cwd = excluded.intended_cwd,
        committed_project_id = excluded.committed_project_id,
        committed_cwd = excluded.committed_cwd,
        provider_moved = excluded.provider_moved,
        detail = excluded.detail,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(toPersistenceSqlError("AwenSessionService.upsertRecovery")));

  const clearRecovery = (threadId: ThreadId) =>
    sql`
      DELETE FROM agent_session_migrations WHERE thread_id = ${threadId}
    `.pipe(Effect.mapError(toPersistenceSqlError("AwenSessionService.clearRecovery")));

  const toRecovery = (row: typeof RecoveryDbRow.Type): AgentSessionMigrationRecovery => ({
    agentSessionId: AgentSessionId.make(row.threadId),
    intendedWorkspaceId: row.intendedWorkspaceId,
    intendedProjectId: row.intendedProjectId,
    intendedCwd: row.intendedCwd,
    committedProjectId: row.committedProjectId,
    ...(row.committedCwd !== null ? { committedCwd: row.committedCwd } : {}),
    providerMoved: row.providerMoved !== 0,
    detail: row.detail,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  const readRecovery = (threadId: ThreadId) =>
    recoveryByThread({ threadId }).pipe(
      Effect.mapError((cause) =>
        sessionError("operation-failed", "Could not read migration recovery state.", {
          cause,
        }),
      ),
    );

  const readThread = (threadId: ThreadId) =>
    projectionQuery.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) =>
        sessionError("operation-failed", `Could not read Agent Session '${threadId}'.`, {
          cause,
        }),
      ),
    );

  const readAgentSession = (threadId: ThreadId) => {
    const getter = projectionQuery.getAwenAgentSessionByThreadId;
    if (getter === undefined) {
      return Effect.fail(
        sessionError(
          "operation-failed",
          "This server cannot read Agent Session Workspace assignments.",
        ),
      );
    }
    return getter(threadId).pipe(
      Effect.mapError((cause) =>
        sessionError("operation-failed", `Could not read Agent Session '${threadId}'.`, {
          cause,
        }),
      ),
    );
  };

  const readWorkspace = (workspaceId: WorkspaceId) => {
    const getter = projectionQuery.getAwenWorkspaceById;
    if (getter === undefined) {
      return Effect.fail(
        sessionError("operation-failed", "This server cannot read Workspace registrations."),
      );
    }
    return getter(workspaceId).pipe(
      Effect.mapError((cause) =>
        sessionError("operation-failed", `Could not read Workspace '${workspaceId}'.`, { cause }),
      ),
    );
  };

  const readProjectWorkspaceRoot = (projectId: ProjectId) =>
    projectionQuery.getProjectShellById(projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
    );

  const committedCwdForThread = Effect.fnUntraced(function* (
    thread: Pick<OrchestrationThreadShell, "projectId" | "worktreePath">,
  ) {
    if (thread.worktreePath !== null && thread.worktreePath.trim() !== "") {
      return thread.worktreePath;
    }
    const project = yield* readProjectWorkspaceRoot(thread.projectId);
    return project?.workspaceRoot;
  });

  const normalize = (value: string) => pathService.normalize(pathService.resolve(value));

  const sameDirectory = (left: string, right: string) => normalize(left) === normalize(right);

  const activeProviderSession = (threadId: ThreadId) =>
    providerService
      .listSessions()
      .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

  /**
   * Resolve the requested migration target to a sibling Workspace.
   *
   * A caller may name a registered Workspace directly, or a directory/worktree
   * path. A path is matched against the Session's Project Workspaces; an
   * unregistered checkout is associated as a new sibling Workspace first, so a
   * migration never publishes an assignment for a directory Awen does not own.
   */
  const resolveRequestedTarget = (
    input: AgentSessionMigrateToWorkspaceInput,
    sourceWorkspace: AwenWorkspaceShell,
  ): Effect.Effect<Option.Option<AwenWorkspaceShell>, AgentSessionOperationError> =>
    Effect.gen(function* () {
      if (input.targetWorkspaceId !== undefined) {
        return yield* readWorkspace(input.targetWorkspaceId);
      }
      const targetPath = input.targetPath;
      if (targetPath === undefined) {
        return yield* failSession(
          "workspace-not-found",
          "A target Workspace id or path is required.",
          { agentSessionId: input.agentSessionId },
        );
      }
      const getProject = projectionQuery.getAwenProjectById;
      if (getProject !== undefined) {
        const project = yield* getProject(sourceWorkspace.projectId).pipe(
          Effect.mapError((cause) =>
            sessionError("operation-failed", "Could not read the Session's Project.", { cause }),
          ),
        );
        if (Option.isSome(project)) {
          const sibling = project.value.workspaces.find((workspace) =>
            sameDirectory(workspace.workspaceRoot, targetPath),
          );
          if (sibling !== undefined) {
            return Option.some(sibling);
          }
        }
      }
      const associated = yield* workspaceService
        .associate({ projectId: sourceWorkspace.projectId, path: targetPath })
        .pipe(
          Effect.mapError((error) => mapAssociateError(input.agentSessionId, targetPath, error)),
        );
      return Option.some(associated.workspace);
    });

  // Serialize every migration against the others. Migrations are rare, and a
  // single lock guarantees that two migrations sharing any affected Workspace
  // (or the same Session) cannot interleave and observe a half-published move.
  const migrationSemaphore = yield* Semaphore.make(1);
  const withMigrationLock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    migrationSemaphore.withPermits(1)(effect);

  const dispatchAssignment = (input: {
    readonly threadId: ThreadId;
    readonly target: AwenWorkspaceShell;
    readonly expectedProjectId: ProjectId;
    readonly commandId: CommandId;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: input.commandId,
      threadId: input.threadId,
      projectId: input.target.awenProjectId,
      expectedProjectId: input.expectedProjectId,
      worktreePath: input.target.role === "worktree" ? input.target.workspaceRoot : null,
      branch: input.target.branch ?? null,
    });

  /**
   * Restore a known provider binding against the committed assignment. Used
   * when a recovery row exists but no provider session is live: the next send
   * must not assume the provider is already in the old directory.
   */
  const restoreProviderAtCommitted = (
    threadId: ThreadId,
    thread: OrchestrationThreadShell | undefined,
    row: typeof RecoveryDbRow.Type,
  ) =>
    Effect.gen(function* () {
      const session = thread?.session ?? null;
      if (thread === undefined || session === null || session.providerInstanceId === undefined) {
        return false;
      }
      const cwd = row.committedCwd ?? (yield* committedCwdForThread(thread));
      if (cwd === undefined) {
        return false;
      }
      const restored = yield* providerService
        .startSession(threadId, {
          threadId,
          providerInstanceId: session.providerInstanceId,
          cwd,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          ...(thread.title ? { title: thread.title } : {}),
        })
        .pipe(Effect.result);
      return Result.isSuccess(restored);
    });

  /**
   * Re-read the provider and committed assignment against a stored recovery
   * row. Completes the migration when the provider is already at the intended
   * directory, clears the row when the provider is verifiably back at (or
   * restored to) the committed directory, and keeps it blocked when the
   * provider context is uncertain.
   */
  const reconcileRecovery = Effect.fn("AwenSessionService.reconcileRecovery")(function* (
    threadId: ThreadId,
  ) {
    const stored = yield* readRecovery(threadId);
    if (Option.isNone(stored)) {
      return Option.none<AgentSessionMigrationRecovery>();
    }
    const row = stored.value;
    const thread = yield* readThread(threadId);
    const activeSession = yield* activeProviderSession(threadId);
    const providerCwd = activeSession?.cwd;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);

    const blockedRecovery = (detail: string): AgentSessionMigrationRecovery =>
      toRecovery({ ...row, detail, updatedAt });

    const finish = (detail: string) =>
      Effect.gen(function* () {
        const latest = yield* readThread(threadId);
        const workspace = yield* readWorkspace(row.intendedWorkspaceId);
        if (latest === undefined || Option.isNone(workspace)) {
          return Option.some(blockedRecovery(detail));
        }
        const committed = yield* dispatchAssignment({
          threadId,
          target: workspace.value,
          expectedProjectId: latest.projectId,
          commandId: CommandId.make(`awen-session:migrate:recover:${yield* crypto.randomUUIDv4}`),
        }).pipe(Effect.result);
        if (Result.isFailure(committed)) {
          return Option.some(blockedRecovery(`${detail} The assignment commit failed.`));
        }
        yield* clearRecovery(threadId);
        return Option.none<AgentSessionMigrationRecovery>();
      });

    // The committed assignment already reached the intended project: the
    // migration completed and only the recovery row survived.
    if (thread !== undefined && thread.projectId === row.intendedProjectId) {
      yield* clearRecovery(threadId);
      return Option.none<AgentSessionMigrationRecovery>();
    }

    if (providerCwd !== undefined && sameDirectory(providerCwd, row.intendedCwd)) {
      return yield* finish("Provider was already at the intended directory; completing migration.");
    }

    if (
      providerCwd !== undefined &&
      row.committedCwd !== null &&
      sameDirectory(providerCwd, row.committedCwd)
    ) {
      // The provider is verifiably at the committed directory, so the committed
      // assignment is the truth and no send can start in a wrong place.
      yield* clearRecovery(threadId);
      return Option.none<AgentSessionMigrationRecovery>();
    }

    if (providerCwd === undefined) {
      // No live provider. Never assume it is in the old directory: restore a
      // known binding against the committed assignment, or clear when there is
      // no binding to restore (a fresh send starts at the committed cwd).
      const restored = yield* restoreProviderAtCommitted(threadId, thread, row);
      if (restored) {
        yield* clearRecovery(threadId);
        return Option.none<AgentSessionMigrationRecovery>();
      }
      if (thread?.session?.providerInstanceId === undefined) {
        yield* clearRecovery(threadId);
        return Option.none<AgentSessionMigrationRecovery>();
      }
    }

    const uncertaintyDetail =
      "Provider execution context could not be verified against the committed Workspace assignment.";
    yield* upsertRecovery({
      threadId: row.threadId,
      intendedWorkspaceId: row.intendedWorkspaceId,
      intendedProjectId: row.intendedProjectId,
      intendedCwd: row.intendedCwd,
      committedProjectId: row.committedProjectId,
      ...(row.committedCwd !== null ? { committedCwd: row.committedCwd } : {}),
      providerMoved: row.providerMoved !== 0,
      detail: uncertaintyDetail,
      createdAt: row.createdAt,
      updatedAt,
    });
    return Option.some(
      toRecovery({
        ...row,
        detail: uncertaintyDetail,
        updatedAt,
      }),
    );
  });

  const migrateToWorkspaceUnsafe = Effect.fn("AwenSessionService.migrateToWorkspace")(function* (
    input: AgentSessionMigrateToWorkspaceInput,
  ) {
    const threadId = ThreadId.make(input.agentSessionId);
    const session = yield* readAgentSession(threadId);
    if (Option.isNone(session)) {
      return yield* failSession("session-not-found", `Agent Session '${threadId}' was not found.`, {
        agentSessionId: input.agentSessionId,
      });
    }
    const sourceWorkspaceOption = yield* readWorkspace(session.value.workspaceId);
    if (Option.isNone(sourceWorkspaceOption)) {
      return yield* failSession(
        "session-not-found",
        `Agent Session '${threadId}' has no owning Workspace projection.`,
        { agentSessionId: input.agentSessionId },
      );
    }
    const sourceWorkspace = sourceWorkspaceOption.value;
    const targetWorkspaceOption = yield* resolveRequestedTarget(input, sourceWorkspace);
    if (Option.isNone(targetWorkspaceOption)) {
      return yield* failSession(
        "workspace-not-found",
        input.targetPath !== undefined
          ? `No Workspace was found or registered at '${input.targetPath}'.`
          : `Workspace '${input.targetWorkspaceId ?? "unknown"}' was not found.`,
        {
          agentSessionId: input.agentSessionId,
          ...(input.targetWorkspaceId !== undefined
            ? { workspaceId: input.targetWorkspaceId }
            : {}),
        },
      );
    }
    const targetWorkspace = targetWorkspaceOption.value;
    const targetWorkspaceId = targetWorkspace.id;
    if (sourceWorkspace.id === targetWorkspaceId) {
      return yield* failSession(
        "already-in-workspace",
        `Agent Session '${threadId}' is already assigned to Workspace '${sourceWorkspace.title}'.`,
        { agentSessionId: input.agentSessionId, workspaceId: targetWorkspaceId },
      );
    }
    if (targetWorkspace.projectId !== sourceWorkspace.projectId) {
      return yield* failSession(
        "different-project",
        `Workspace '${targetWorkspace.title}' belongs to another Project; an Agent Session migrates only within its Project.`,
        { agentSessionId: input.agentSessionId, workspaceId: targetWorkspaceId },
      );
    }

    return yield* withMigrationLock(
      Effect.gen(function* () {
        const pending = yield* reconcileRecovery(threadId);
        if (Option.isSome(pending)) {
          return yield* failSession(
            "migration-recovery-required",
            "A previous migration must be verified before this Session can move again.",
            {
              agentSessionId: input.agentSessionId,
              workspaceId: pending.value.intendedWorkspaceId,
              recovery: pending.value,
            },
          );
        }

        const thread = yield* readThread(threadId);
        if (thread === undefined) {
          return yield* failSession(
            "session-not-found",
            `Agent Session '${threadId}' was not found.`,
            { agentSessionId: input.agentSessionId },
          );
        }
        if (thread.projectId === targetWorkspace.awenProjectId) {
          return yield* failSession(
            "already-in-workspace",
            `Agent Session '${threadId}' is already assigned to this Workspace.`,
            { agentSessionId: input.agentSessionId, workspaceId: targetWorkspaceId },
          );
        }
        if (thread.archivedAt !== null) {
          return yield* failSession(
            "session-archived",
            `Agent Session '${threadId}' is archived; restore it before migrating.`,
            { agentSessionId: input.agentSessionId, workspaceId: targetWorkspaceId },
          );
        }
        if (isOrchestrationSessionExecuting(thread.session)) {
          return yield* failSession(
            "session-executing",
            `Agent Session '${threadId}' is executing. Stop it before migrating; migration is not queued.`,
            { agentSessionId: input.agentSessionId, workspaceId: targetWorkspaceId },
          );
        }

        const targetCwd = targetWorkspace.workspaceRoot;
        const targetStat = yield* fileSystem
          .stat(targetCwd)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (targetStat === undefined || targetStat.type !== "Directory") {
          return yield* failSession(
            "target-directory-missing",
            `Workspace '${targetWorkspace.title}' has no directory at '${targetCwd}'.`,
            { agentSessionId: input.agentSessionId, workspaceId: targetWorkspaceId },
          );
        }

        const committedCwd = yield* committedCwdForThread(thread);
        const committedProjectId = thread.projectId;
        const activeSession = yield* activeProviderSession(threadId);
        const nowIso = DateTime.formatIso(yield* DateTime.now);

        // Recorded only after the provider has actually moved. A row written
        // before the move could be cleared by a concurrent send that still sees
        // the provider at the committed directory, erasing the recovery state
        // for a later failed commit.
        const recordMovedRecovery = (detail: string) =>
          upsertRecovery({
            threadId,
            intendedWorkspaceId: targetWorkspaceId,
            intendedProjectId: targetWorkspace.awenProjectId,
            intendedCwd: targetCwd,
            committedProjectId,
            ...(committedCwd !== undefined ? { committedCwd } : {}),
            providerMoved: true,
            detail,
            createdAt: nowIso,
            updatedAt: nowIso,
          });

        let providerMoved = false;
        let providerCwd: string | undefined;
        const providerAlreadyAtTarget =
          activeSession?.cwd !== undefined && sameDirectory(activeSession.cwd, targetCwd);
        if (activeSession !== undefined && !providerAlreadyAtTarget) {
          const hasResumeCursor =
            activeSession.resumeCursor !== undefined && activeSession.resumeCursor !== null;
          const hasExecuted = thread.latestTurn !== null;
          if (!hasResumeCursor && hasExecuted) {
            return yield* failSession(
              "provider-resume-unsupported",
              `Provider session for '${threadId}' has no resume state; migrating would lose the conversation.`,
              { agentSessionId: input.agentSessionId, workspaceId: targetWorkspaceId },
            );
          }
          if (activeSession.providerInstanceId === undefined) {
            return yield* failSession(
              "provider-move-failed",
              `Provider session for '${threadId}' has no provider instance id and cannot be relocated.`,
              { agentSessionId: input.agentSessionId, workspaceId: targetWorkspaceId },
            );
          }
          // The provider accepts the candidate directory directly, before any
          // committed assignment is published.
          const moved = yield* providerService
            .startSession(threadId, {
              threadId,
              provider: activeSession.provider,
              providerInstanceId: activeSession.providerInstanceId,
              cwd: targetCwd,
              ...(hasResumeCursor ? { resumeCursor: activeSession.resumeCursor } : {}),
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              ...(thread.title ? { title: thread.title } : {}),
            })
            .pipe(Effect.result);
          if (Result.isFailure(moved)) {
            return yield* failSession(
              "provider-move-failed",
              `Provider session for '${threadId}' could not be moved to '${targetCwd}'.`,
              {
                agentSessionId: input.agentSessionId,
                workspaceId: targetWorkspaceId,
                cause: moved.failure,
              },
            );
          }
          providerMoved = true;
          providerCwd = moved.success.cwd ?? targetCwd;
          yield* recordMovedRecovery("Provider moved; publishing the Workspace assignment.");
        }

        const commandId = CommandId.make(`awen-session:migrate:${yield* crypto.randomUUIDv4}`);
        const committed = yield* dispatchAssignment({
          threadId,
          target: targetWorkspace,
          expectedProjectId: committedProjectId,
          commandId,
        }).pipe(Effect.result);
        if (Result.isFailure(committed)) {
          if (providerMoved) {
            // A concurrent reconciler may have already published the same
            // assignment (and then failed its own commit). If the thread now
            // points at the target, the migration is complete; treat it as
            // success rather than reporting a false failure.
            const latest = yield* readThread(threadId);
            if (latest !== undefined && latest.projectId === targetWorkspace.awenProjectId) {
              yield* clearRecovery(threadId);
              return {
                agentSessionId: input.agentSessionId,
                workspaceId: targetWorkspaceId,
                providerMoved,
                ...(providerCwd !== undefined ? { providerCwd } : {}),
              } satisfies AgentSessionMigrateToWorkspaceResult;
            }
            const recovery = yield* readRecovery(threadId);
            return yield* failSession(
              "assignment-commit-failed",
              `Provider session for '${threadId}' moved but the Workspace assignment could not be committed. Sends are blocked until it is recovered.`,
              {
                agentSessionId: input.agentSessionId,
                workspaceId: targetWorkspaceId,
                ...(Option.isSome(recovery) ? { recovery: toRecovery(recovery.value) } : {}),
                cause: committed.failure,
              },
            );
          }
          yield* clearRecovery(threadId);
          return yield* failSession(
            "assignment-commit-failed",
            `Workspace assignment for '${threadId}' could not be committed.`,
            {
              agentSessionId: input.agentSessionId,
              workspaceId: targetWorkspaceId,
              cause: committed.failure,
            },
          );
        }

        yield* clearRecovery(threadId);
        // The thread left the source Awen workspace; nudge its Sidebar owner to
        // refetch so the moved row is not shown under the old Workspace.
        yield* orchestrationEngine
          .dispatch({
            type: "project.meta.update",
            commandId: CommandId.make(`${commandId}:source-workspace`),
            projectId: committedProjectId,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(
                "failed to notify the source Workspace after an Agent Session migration",
                { threadId, projectId: committedProjectId, cause: Cause.pretty(cause) },
              ),
            ),
          );

        return {
          agentSessionId: input.agentSessionId,
          workspaceId: targetWorkspaceId,
          providerMoved,
          ...(providerCwd !== undefined ? { providerCwd } : {}),
        } satisfies AgentSessionMigrateToWorkspaceResult;
      }),
    );
  });

  const migrateToWorkspace: AwenSessionService["Service"]["migrateToWorkspace"] = (input) =>
    normalizeSessionError(migrateToWorkspaceUnsafe(input));

  const getMigrationStateUnsafe = Effect.fn("AwenSessionService.getMigrationState")(function* (
    input: AgentSessionMigrationStateInput,
  ) {
    // Read-only: reconciliation (and any assignment completion) happens at the
    // send and migrate authorities, so a read-scoped client cannot trigger a
    // write by asking for the state.
    const threadId = ThreadId.make(input.agentSessionId);
    const stored = yield* readRecovery(threadId);
    return {
      recovery: Option.isSome(stored) ? toRecovery(stored.value) : null,
    } satisfies AgentSessionMigrationStateResult;
  });

  const getMigrationState: AwenSessionService["Service"]["getMigrationState"] = (input) =>
    normalizeSessionError(getMigrationStateUnsafe(input));

  const assertSendAllowedUnsafe = Effect.fn("AwenSessionService.assertSendAllowed")(function* (
    threadId: ThreadId,
  ) {
    // Held under the same lock as a migration, so a send cannot observe the
    // window between the provider move and the assignment commit.
    const recovery = yield* migrationSemaphore.withPermits(1)(reconcileRecovery(threadId));
    if (Option.isSome(recovery)) {
      return yield* failSession(
        "migration-recovery-required",
        "A Workspace migration is incomplete; verify or restore the provider before sending.",
        {
          agentSessionId: AgentSessionId.make(threadId),
          workspaceId: recovery.value.intendedWorkspaceId,
          recovery: recovery.value,
        },
      );
    }
  });

  const assertSendAllowed: AwenSessionService["Service"]["assertSendAllowed"] = (threadId) =>
    normalizeSessionError(assertSendAllowedUnsafe(threadId));

  // Reconcile interrupted migrations once at startup so a restart never
  // resumes a thread while its provider context is uncertain.
  yield* listRecoveryThreadIds().pipe(
    Effect.flatMap((threadIds) =>
      Effect.forEach(
        threadIds,
        (threadId) =>
          reconcileRecovery(ThreadId.make(threadId)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to reconcile an interrupted Agent Session migration", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
            Effect.asVoid,
          ),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("failed to list interrupted Agent Session migrations", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  return AwenSessionService.of({
    migrateToWorkspace,
    getMigrationState,
    assertSendAllowed,
  });
});

export const layer = Layer.effect(AwenSessionService, make);
