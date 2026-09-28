import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentSessionId,
  AwenProjectId,
  type AwenAgentSessionShell,
  type AwenProjectShell,
  type AwenWorkspaceAssociateInput,
  type AwenWorkspaceAssociateResult,
  AwenWorkspaceError,
  type AwenWorkspaceShell,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProviderSession,
  type ProviderSessionStartInput,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WorkspaceId,
  workspaceIdForAwenProject,
} from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRequestError, type ProviderServiceError } from "../provider/Errors.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AwenWorkspaceService from "../workspace/AwenWorkspaceService.ts";
import * as AwenSessionService from "./AwenSessionService.ts";

const NOW = "2026-09-19T00:00:00.000Z";
const AWEN_PROJECT_ID = AwenProjectId.make("awen-project:main");
const SOURCE_PROJECT = ProjectId.make("project:source");
const TARGET_PROJECT = ProjectId.make("project:target");
const SOURCE_WORKSPACE = workspaceIdForAwenProject(SOURCE_PROJECT);
const TARGET_WORKSPACE = workspaceIdForAwenProject(TARGET_PROJECT);
const THREAD_ID = ThreadId.make("thread-migrate-1");
const SOURCE_ROOT = "/repo/source";
const TARGET_ROOT = "/repo/target";
const PROVIDER_INSTANCE = ProviderInstanceId.make("codex");
const PROVIDER_KIND = ProviderDriverKind.make("codex");

function sourceWorkspace(): AwenWorkspaceShell {
  return {
    id: SOURCE_WORKSPACE,
    projectId: AWEN_PROJECT_ID,
    awenProjectId: SOURCE_PROJECT,
    title: "source",
    workspaceRoot: SOURCE_ROOT,
    role: "main",
    sessions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function targetWorkspace(
  projectId: ProjectId = TARGET_PROJECT,
  awenProjectId: AwenProjectId = AWEN_PROJECT_ID,
): AwenWorkspaceShell {
  return {
    id: workspaceIdForAwenProject(projectId),
    projectId: awenProjectId,
    awenProjectId: projectId,
    title: "target",
    workspaceRoot: TARGET_ROOT,
    role: "worktree",
    origin: "awen-created",
    branch: "feature",
    sessions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function agentSession(workspaceId: WorkspaceId): AwenAgentSessionShell {
  return {
    kind: "agent",
    id: AgentSessionId.make(THREAD_ID),
    workspaceId,
    threadId: THREAD_ID,
    title: "Conversation",
    status: "open",
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function thread(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: SOURCE_PROJECT,
    title: "Conversation",
    modelSelection: { instanceId: PROVIDER_INSTANCE, model: "gpt-5-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  } as OrchestrationThreadShell;
}

function projectShell(id: ProjectId, workspaceRoot: string): OrchestrationProjectShell {
  return {
    id,
    title: "Repository",
    workspaceRoot,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: NOW,
    updatedAt: NOW,
  } as OrchestrationProjectShell;
}

function providerSession(overrides: Partial<ProviderSession> = {}): ProviderSession {
  return {
    provider: PROVIDER_KIND,
    providerInstanceId: PROVIDER_INSTANCE,
    status: "ready",
    runtimeMode: "full-access",
    cwd: SOURCE_ROOT,
    model: "gpt-5-codex",
    threadId: THREAD_ID,
    resumeCursor: { threadId: THREAD_ID },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ProviderSession;
}

interface Harness {
  readonly thread: () => OrchestrationThreadShell;
  readonly agentSession: () => AwenAgentSessionShell;
  readonly workspaces: Map<WorkspaceId, AwenWorkspaceShell>;
  readonly providerSessions: () => ReadonlyArray<ProviderSession>;
  readonly startSession: (
    threadId: ThreadId,
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, ProviderServiceError>;
  readonly failCommit: () => boolean;
  readonly targetDirectoryExists?: () => boolean;
  readonly awenProjectWorkspaces?: () => ReadonlyArray<AwenWorkspaceShell>;
  readonly associate?: (
    input: AwenWorkspaceAssociateInput,
  ) => Effect.Effect<AwenWorkspaceAssociateResult, AwenWorkspaceError>;
  readonly dispatched: Parameters<
    OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]
  >[0][];
}

const makeLayer = (harness: Harness) => {
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getThreadShellById: () => Effect.succeed(Option.some(harness.thread())),
    getAwenAgentSessionByThreadId: () => Effect.succeed(Option.some(harness.agentSession())),
    getAwenWorkspaceById: (workspaceId) =>
      Effect.succeed(Option.fromNullishOr(harness.workspaces.get(workspaceId))),
    getAwenProjectById: () =>
      Effect.succeed(
        Option.some({
          id: AWEN_PROJECT_ID,
          title: "main",
          workspaces: [...(harness.awenProjectWorkspaces?.() ?? [sourceWorkspace()])],
          createdAt: NOW,
          updatedAt: NOW,
        } satisfies AwenProjectShell),
      ),
    getProjectShellById: (projectId) =>
      Effect.succeed(
        Option.some(
          projectShell(projectId, projectId === SOURCE_PROJECT ? SOURCE_ROOT : TARGET_ROOT),
        ),
      ),
  });
  const workspaceLayer = Layer.mock(AwenWorkspaceService.AwenWorkspaceService)({
    associate: (input) =>
      harness.associate?.(input) ?? Effect.die("unexpected Workspace association during migration"),
  });
  const providerLayer = Layer.mock(ProviderService.ProviderService)({
    listSessions: () => Effect.succeed(harness.providerSessions()),
    startSession: (threadId, input) => harness.startSession(threadId, input),
  });
  const engineLayer = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
    dispatch: (command) =>
      harness.failCommit()
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "simulated commit failure",
            }),
          )
        : Effect.sync(() => {
            harness.dispatched.push(command);
            return { sequence: harness.dispatched.length };
          }),
  });

  const fileSystemLayer = Layer.mock(FileSystem.FileSystem)({
    stat: () =>
      Effect.succeed(
        harness.targetDirectoryExists?.() === false ? { type: "File" } : { type: "Directory" },
      ),
  } as never);

  return AwenSessionService.layer.pipe(
    Layer.provide(projectionLayer),
    Layer.provide(providerLayer),
    Layer.provide(engineLayer),
    Layer.provide(workspaceLayer),
    Layer.provide(fileSystemLayer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  );
};

const baseHarness = (overrides: Partial<Harness> = {}): Harness => {
  const workspaces = new Map<WorkspaceId, AwenWorkspaceShell>([
    [SOURCE_WORKSPACE, sourceWorkspace()],
    [TARGET_WORKSPACE, targetWorkspace()],
  ]);
  const dispatched: Harness["dispatched"] = [];
  const harness: Harness = {
    thread: () => thread(),
    agentSession: () => agentSession(SOURCE_WORKSPACE),
    workspaces,
    providerSessions: () => [],
    startSession: () => Effect.die("unexpected provider start"),
    failCommit: () => false,
    dispatched,
    ...overrides,
  };
  return harness;
};

describe("AwenSessionService.migrateToWorkspace", () => {
  it.effect("moves an idle zero-turn Agent Session to a sibling Workspace", () => {
    const harness = baseHarness();
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const result = yield* service.migrateToWorkspace({
        agentSessionId: AgentSessionId.make(THREAD_ID),
        targetWorkspaceId: TARGET_WORKSPACE,
      });
      assert.strictEqual(result.workspaceId, TARGET_WORKSPACE);
      assert.isFalse(result.providerMoved);
      const migration = harness.dispatched.find((command) => command.type === "thread.meta.update");
      assert.isDefined(migration);
      if (migration?.type !== "thread.meta.update") return assert.fail("wrong command");
      assert.strictEqual(migration.projectId, TARGET_PROJECT);
      assert.strictEqual(migration.worktreePath, TARGET_ROOT);
      assert.strictEqual(migration.expectedProjectId, SOURCE_PROJECT);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("refuses migration while the Agent is executing", () => {
    const harness = baseHarness({
      thread: () =>
        thread({
          session: {
            threadId: THREAD_ID,
            status: "running",
            providerName: PROVIDER_KIND,
            providerInstanceId: PROVIDER_INSTANCE,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const error = yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: TARGET_WORKSPACE,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "session-executing");
      assert.strictEqual(harness.dispatched.length, 0);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("refuses migration to a Workspace of another Project", () => {
    const other = ProjectId.make("project:other");
    const otherAwenProject = AwenProjectId.make("awen-project:other");
    const harness = baseHarness();
    harness.workspaces.set(
      workspaceIdForAwenProject(other),
      targetWorkspace(other, otherAwenProject),
    );
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const error = yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: workspaceIdForAwenProject(other),
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "different-project");
      assert.strictEqual(harness.dispatched.length, 0);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("moves a live provider session to the candidate directory before committing", () => {
    const starts: ProviderSessionStartInput[] = [];
    const harness = baseHarness({
      providerSessions: () => [providerSession()],
      startSession: (_threadId, input) => {
        starts.push(input);
        return Effect.succeed(providerSession({ cwd: TARGET_ROOT }));
      },
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const result = yield* service.migrateToWorkspace({
        agentSessionId: AgentSessionId.make(THREAD_ID),
        targetWorkspaceId: TARGET_WORKSPACE,
      });
      assert.isTrue(result.providerMoved);
      assert.strictEqual(result.providerCwd, TARGET_ROOT);
      assert.strictEqual(starts[0]?.cwd, TARGET_ROOT);
      assert.deepStrictEqual(starts[0]?.resumeCursor, { threadId: THREAD_ID });
      const migration = harness.dispatched.find((command) => command.type === "thread.meta.update");
      assert.isDefined(migration);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("leaves no recovery state when the provider cannot be moved", () => {
    const harness = baseHarness({
      providerSessions: () => [providerSession()],
      startSession: () =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER_KIND,
            method: "ProviderService.startSession",
            detail: "simulated provider restart failure",
          }),
        ),
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const error = yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: TARGET_WORKSPACE,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "provider-move-failed");
      assert.strictEqual(harness.dispatched.length, 0);
      const state = yield* service.getMigrationState({
        agentSessionId: AgentSessionId.make(THREAD_ID),
      });
      assert.isNull(state.recovery);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("fails explicitly when the provider cannot resume the conversation", () => {
    const harness = baseHarness({
      thread: () =>
        thread({
          latestTurn: {
            turnId: "turn-1",
            requestedAt: NOW,
            startedAt: NOW,
            completedAt: NOW,
          } as OrchestrationThreadShell["latestTurn"],
        }),
      providerSessions: () => [providerSession({ resumeCursor: undefined })],
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const error = yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: TARGET_WORKSPACE,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "provider-resume-unsupported");
      assert.strictEqual(harness.dispatched.length, 0);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect(
    "keeps the committed assignment and blocks sends when the commit fails after moving",
    () => {
      let fail = true;
      let providerCwd = SOURCE_ROOT;
      const harness = baseHarness({
        providerSessions: () => [providerSession({ cwd: providerCwd })],
        startSession: () => {
          providerCwd = TARGET_ROOT;
          return Effect.succeed(providerSession({ cwd: TARGET_ROOT }));
        },
        failCommit: () => fail,
      });
      return Effect.gen(function* () {
        const service = yield* AwenSessionService.AwenSessionService;
        const error = yield* service
          .migrateToWorkspace({
            agentSessionId: AgentSessionId.make(THREAD_ID),
            targetWorkspaceId: TARGET_WORKSPACE,
          })
          .pipe(Effect.flip);
        assert.strictEqual(error.reason, "assignment-commit-failed");
        assert.isDefined(error.recovery);

        const state = yield* service.getMigrationState({
          agentSessionId: AgentSessionId.make(THREAD_ID),
        });
        assert.isNotNull(state.recovery);

        const blocked = yield* Effect.result(service.assertSendAllowed(THREAD_ID));
        if (blocked._tag !== "Failure") return assert.fail("expected sends to be blocked");
        assert.strictEqual(blocked.failure.reason, "migration-recovery-required");

        // Once the provider is verifiably at the intended directory, the next
        // send performs reconciliation, completes the pending assignment, and
        // unblocks.
        fail = false;
        const allowed = yield* Effect.result(service.assertSendAllowed(THREAD_ID));
        if (allowed._tag === "Failure") {
          return assert.fail(`sends still blocked: ${allowed.failure.message}`);
        }
        const reconciled = yield* Effect.result(
          service.getMigrationState({
            agentSessionId: AgentSessionId.make(THREAD_ID),
          }),
        );
        if (reconciled._tag === "Failure") {
          return assert.fail(`getMigrationState failed: ${reconciled.failure.message}`);
        }
        assert.isNull(reconciled.success.recovery);
      }).pipe(Effect.provide(makeLayer(harness)));
    },
  );

  it.effect("refuses a second migration while a recovery is pending", () => {
    let providerCwd = SOURCE_ROOT;
    const harness = baseHarness({
      providerSessions: () => [providerSession({ cwd: providerCwd })],
      startSession: () => {
        providerCwd = TARGET_ROOT;
        return Effect.succeed(providerSession({ cwd: TARGET_ROOT }));
      },
      failCommit: () => true,
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: TARGET_WORKSPACE,
        })
        .pipe(Effect.flip);
      const error = yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: TARGET_WORKSPACE,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "migration-recovery-required");
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("treats a commit failure as success when the assignment already moved", () => {
    let providerCwd = SOURCE_ROOT;
    let threadProjectId = SOURCE_PROJECT;
    const harness = baseHarness({
      // A concurrent reconciler publishes the same assignment after the
      // provider moves but before this commit attempt.
      thread: () => thread({ projectId: threadProjectId }),
      providerSessions: () => [providerSession({ cwd: providerCwd })],
      startSession: () => {
        providerCwd = TARGET_ROOT;
        threadProjectId = TARGET_PROJECT;
        return Effect.succeed(providerSession({ cwd: TARGET_ROOT }));
      },
      failCommit: () => true,
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const result = yield* service.migrateToWorkspace({
        agentSessionId: AgentSessionId.make(THREAD_ID),
        targetWorkspaceId: TARGET_WORKSPACE,
      });
      assert.strictEqual(result.workspaceId, TARGET_WORKSPACE);
      assert.isTrue(result.providerMoved);
      const state = yield* service.getMigrationState({
        agentSessionId: AgentSessionId.make(THREAD_ID),
      });
      assert.isNull(state.recovery);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("refuses a target Workspace whose directory is missing", () => {
    const harness = baseHarness({ targetDirectoryExists: () => false });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const error = yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: TARGET_WORKSPACE,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "target-directory-missing");
      assert.strictEqual(harness.dispatched.length, 0);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("refuses to migrate an archived Agent Session", () => {
    const harness = baseHarness({ thread: () => thread({ archivedAt: NOW }) });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const error = yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: TARGET_WORKSPACE,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "session-archived");
      assert.strictEqual(harness.dispatched.length, 0);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("restores a dead provider at the committed directory before unblocking", () => {
    const starts: ProviderSessionStartInput[] = [];
    let providerAlive = true;
    let providerCwd = SOURCE_ROOT;
    const harness = baseHarness({
      thread: () =>
        thread({
          session: {
            threadId: THREAD_ID,
            status: "ready",
            providerName: PROVIDER_KIND,
            providerInstanceId: PROVIDER_INSTANCE,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: NOW,
          },
        }),
      providerSessions: () => (providerAlive ? [providerSession({ cwd: providerCwd })] : []),
      startSession: (_threadId, input) => {
        starts.push(input);
        providerCwd = input.cwd ?? SOURCE_ROOT;
        return Effect.succeed(providerSession({ cwd: providerCwd }));
      },
      failCommit: () => true,
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      // Provider moves to the target, but the assignment commit fails.
      yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetWorkspaceId: TARGET_WORKSPACE,
        })
        .pipe(Effect.flip);
      // The provider then dies. The next send must restore it at the committed
      // directory instead of assuming it is already there.
      providerAlive = false;
      yield* service.assertSendAllowed(THREAD_ID);
      assert.strictEqual(starts.at(-1)?.cwd, SOURCE_ROOT);
      const state = yield* service.getMigrationState({
        agentSessionId: AgentSessionId.make(THREAD_ID),
      });
      assert.isNull(state.recovery);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("resolves a registered sibling Workspace from a target path", () => {
    const harness = baseHarness({
      awenProjectWorkspaces: () => [sourceWorkspace(), targetWorkspace()],
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const result = yield* service.migrateToWorkspace({
        agentSessionId: AgentSessionId.make(THREAD_ID),
        targetPath: TARGET_ROOT,
      });
      assert.strictEqual(result.workspaceId, TARGET_WORKSPACE);
      assert.isFalse(result.providerMoved);
      const migration = harness.dispatched.find((command) => command.type === "thread.meta.update");
      assert.strictEqual(
        migration?.type === "thread.meta.update" ? migration.projectId : undefined,
        TARGET_PROJECT,
      );
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("associates an unregistered checkout and migrates to it", () => {
    const associatedProject = ProjectId.make("project:associated");
    const associatedWorkspace = targetWorkspace(associatedProject);
    const associateCalls: AwenWorkspaceAssociateInput[] = [];
    const harness = baseHarness({
      awenProjectWorkspaces: () => [sourceWorkspace()],
      associate: (input) => {
        associateCalls.push(input);
        return Effect.succeed({ workspace: associatedWorkspace, reused: false });
      },
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const result = yield* service.migrateToWorkspace({
        agentSessionId: AgentSessionId.make(THREAD_ID),
        targetPath: TARGET_ROOT,
      });
      assert.deepStrictEqual(associateCalls, [{ projectId: AWEN_PROJECT_ID, path: TARGET_ROOT }]);
      assert.strictEqual(result.workspaceId, associatedWorkspace.id);
      const migration = harness.dispatched.find((command) => command.type === "thread.meta.update");
      assert.strictEqual(
        migration?.type === "thread.meta.update" ? migration.projectId : undefined,
        associatedProject,
      );
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("refuses a migration with neither a target Workspace nor a path", () => {
    const harness = baseHarness();
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const error = yield* service
        .migrateToWorkspace({ agentSessionId: AgentSessionId.make(THREAD_ID) })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "workspace-not-found");
      assert.strictEqual(harness.dispatched.length, 0);
    }).pipe(Effect.provide(makeLayer(harness)));
  });

  it.effect("maps a cross-Project checkout association to different-project", () => {
    const harness = baseHarness({
      awenProjectWorkspaces: () => [sourceWorkspace()],
      associate: () =>
        Effect.fail(
          new AwenWorkspaceError({
            reason: "already-registered",
            detail: "registered elsewhere",
            path: TARGET_ROOT,
          }),
        ),
    });
    return Effect.gen(function* () {
      const service = yield* AwenSessionService.AwenSessionService;
      const error = yield* service
        .migrateToWorkspace({
          agentSessionId: AgentSessionId.make(THREAD_ID),
          targetPath: TARGET_ROOT,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "different-project");
      assert.strictEqual(harness.dispatched.length, 0);
    }).pipe(Effect.provide(makeLayer(harness)));
  });
});
