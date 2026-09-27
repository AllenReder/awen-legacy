import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentSessionId,
  AwenProjectId,
  type AwenProjectShell,
  type AwenWorkspaceShell,
  ProjectId,
  type TerminalSummary,
  ThreadId,
  WorkspaceId,
  workspaceIdForAwenProject,
} from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";

import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as AwenWorkspaceService from "./AwenWorkspaceService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

const NOW = "2026-09-19T00:00:00.000Z";

function mainWorkspace(root: string): AwenWorkspaceShell {
  return {
    id: WorkspaceId.make("workspace:main"),
    projectId: AwenProjectId.make("awen-project:main"),
    awenProjectId: ProjectId.make("project-main"),
    title: "main",
    workspaceRoot: root,
    role: "main",
    sessions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function siblingWorkspace(root: string): AwenWorkspaceShell {
  return {
    id: WorkspaceId.make("workspace:sibling"),
    projectId: AwenProjectId.make("awen-project:main"),
    awenProjectId: ProjectId.make("project-main"),
    title: "sibling",
    workspaceRoot: root,
    role: "worktree",
    origin: "awen-created",
    sessions: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeProject(root: string, workspace = mainWorkspace(root)): AwenProjectShell {
  return {
    id: AwenProjectId.make("awen-project:main"),
    title: "Repository",
    workspaces: [workspace],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeRepositoryHandle(root: string, commonDir: string): VcsDriverRegistry.VcsDriverHandle {
  return {
    kind: "git",
    repository: {
      kind: "git",
      rootPath: root,
      metadataPath: commonDir,
      freshness: {
        source: "live-local",
        observedAt: DateTime.makeUnsafe(NOW),
        expiresAt: Option.none(),
      },
    },
    driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
  };
}

const makeLayer = (input: {
  readonly root: string;
  readonly sibling: string;
  readonly commonDir: string;
  readonly targetCommonDir?: string;
  readonly dirty?: boolean;
  readonly onCreate?: (
    input: Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0],
  ) => void;
  readonly onDispatch: (
    command: Parameters<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>[0],
  ) => void;
  readonly readProject: () => AwenProjectShell;
  readonly readWorkspace: () => Option.Option<AwenWorkspaceShell>;
  readonly onRename?: (input: {
    readonly workspaceId: WorkspaceId;
    readonly title: string;
  }) => void;
  readonly onRenameProject?: (input: {
    readonly awenProjectId: AwenProjectId;
    readonly title: string;
  }) => void;
  readonly terminals?: ReadonlyArray<TerminalSummary>;
}) => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
    prefix: "awen-workspace-service-test-",
  });
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getAwenProjectById: () => Effect.succeed(Option.some(input.readProject())),
    getAwenWorkspaceById: () => Effect.succeed(input.readWorkspace()),
    updateAwenWorkspaceTitle: ({ workspaceId, title }) =>
      Effect.sync(() => input.onRename?.({ workspaceId, title })),
    updateAwenProjectTitle: ({ awenProjectId, title }) =>
      Effect.sync(() => input.onRenameProject?.({ awenProjectId, title })),
    getShellSnapshot: () =>
      Effect.succeed({
        snapshotSequence: 1,
        projects: [],
        threads: [],
        awenProjects: [input.readProject()],
        updatedAt: NOW,
      }),
  });
  const registryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
    resolve: (request) =>
      Effect.succeed(
        makeRepositoryHandle(
          request.cwd === input.root ? input.root : input.sibling,
          request.cwd === input.root ? input.commonDir : (input.targetCommonDir ?? input.commonDir),
        ),
      ),
  });
  const gitLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
    resolveCommit: () => Effect.succeed({ commitSha: "0123456789abcdef0123456789abcdef01234567" }),
    statusDetails: () =>
      Effect.succeed({
        isRepo: true,
        hasOriginRemote: false,
        isDefaultBranch: true,
        branch: "main",
        headCommit: "0123456789abcdef0123456789abcdef01234567",
        upstreamRef: null,
        hasWorkingTreeChanges: input.dirty === true,
        workingTree: { files: [], insertions: 0, deletions: 0 },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
      }),
  });
  const workflowLayer = Layer.mock(GitWorkflowService.GitWorkflowService)({
    createWorktree: (request, _options) => {
      input.onCreate?.(request);
      return Effect.succeed({ worktree: { path: request.path!, refName: request.refName } });
    },
    removeWorktree: () => Effect.void,
  });
  const orchestrationLayer = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
    dispatch: (command, _options) =>
      Effect.sync(() => {
        input.onDispatch(command);
        return { sequence: 1 };
      }),
  });
  const terminalManagerLayer = Layer.mock(TerminalManager.TerminalManager)({
    getMetadata: () => Effect.succeed(input.terminals ?? []),
    open: () => Effect.die("unexpected"),
    attachStream: () => Effect.die("unexpected"),
    write: () => Effect.die("unexpected"),
    resize: () => Effect.die("unexpected"),
    clear: () => Effect.die("unexpected"),
    rename: () => Effect.die("unexpected"),
    restart: () => Effect.die("unexpected"),
    close: () => Effect.die("unexpected"),
    subscribe: () => Effect.die("unexpected"),
    subscribeMetadata: () => Effect.die("unexpected"),
  });

  return AwenWorkspaceService.layer.pipe(
    Layer.provide(projectionLayer),
    Layer.provide(registryLayer),
    Layer.provide(gitLayer),
    Layer.provide(workflowLayer),
    Layer.provide(orchestrationLayer),
    Layer.provide(terminalManagerLayer),
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(serverConfigLayer),
    Layer.provideMerge(NodeServices.layer),
  );
};

describe("AwenWorkspaceService", () => {
  it.effect("associates a sibling worktree and records its origin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "awen-associate-" });
        const root = path.join(parent, "main");
        const sibling = path.join(parent, "sibling");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* fileSystem.makeDirectory(sibling, { recursive: true });
        let project = makeProject(root);
        let dispatched:
          | Parameters<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>[0]
          | undefined;
        const result = yield* Effect.gen(function* () {
          const service = yield* AwenWorkspaceService.AwenWorkspaceService;
          return yield* service.associate({
            projectId: project.id,
            path: sibling,
            title: "feature worktree",
          });
        }).pipe(
          Effect.provide(
            makeLayer({
              root,
              sibling,
              commonDir: path.join(parent, ".git"),
              onDispatch: (command) => {
                dispatched = command;
                if (command.type === "project.create") {
                  project = {
                    ...project,
                    workspaces: [
                      ...project.workspaces,
                      {
                        id: workspaceIdForAwenProject(command.projectId),
                        projectId: project.id,
                        awenProjectId: command.projectId,
                        title: command.title,
                        workspaceRoot: command.workspaceRoot,
                        role: "worktree",
                        origin: command.awenWorkspace?.origin,
                        sessions: [],
                        createdAt: command.createdAt,
                        updatedAt: command.createdAt,
                      },
                    ],
                  };
                }
              },
              readProject: () => project,
              readWorkspace: () => Option.none(),
            }),
          ),
        );
        assert.equal(dispatched?.type, "project.create");
        if (dispatched?.type === "project.create") {
          assert.deepEqual(dispatched.awenWorkspace, {
            awenProjectId: project.id,
            role: "worktree",
            origin: "associated",
          });
        }
        assert.equal(result.reused, false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a worktree from a different Git common directory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "awen-different-repo-",
        });
        const root = path.join(parent, "main");
        const sibling = path.join(parent, "other");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        yield* fileSystem.makeDirectory(sibling, { recursive: true });
        const error = yield* Effect.gen(function* () {
          const service = yield* AwenWorkspaceService.AwenWorkspaceService;
          return yield* service.associate({
            projectId: AwenProjectId.make("awen-project:main"),
            path: sibling,
          });
        }).pipe(
          Effect.flip,
          Effect.provide(
            makeLayer({
              root,
              sibling,
              commonDir: path.join(root, ".git"),
              targetCommonDir: path.join(sibling, ".git"),
              onDispatch: () => undefined,
              readProject: () => makeProject(root),
              readWorkspace: () => Option.none(),
            }),
          ),
        );
        assert.equal(error.reason, "different-repository");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates a detached worktree before registering it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "awen-create-" });
        const root = path.join(parent, "main");
        const sibling = path.join(parent, "created");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        let project = makeProject(root);
        let createInput:
          | Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0]
          | undefined;
        const result = yield* Effect.gen(function* () {
          const service = yield* AwenWorkspaceService.AwenWorkspaceService;
          return yield* service.createWorktree({
            projectId: project.id,
            baseRef: "HEAD",
            path: sibling,
          });
        }).pipe(
          Effect.provide(
            makeLayer({
              root,
              sibling,
              commonDir: path.join(parent, ".git"),
              onCreate: (input) => {
                createInput = input;
              },
              onDispatch: (command) => {
                if (command.type === "project.create") {
                  project = {
                    ...project,
                    workspaces: [
                      ...project.workspaces,
                      {
                        id: workspaceIdForAwenProject(command.projectId),
                        projectId: project.id,
                        awenProjectId: command.projectId,
                        title: command.title,
                        workspaceRoot: command.workspaceRoot,
                        role: "worktree",
                        origin: command.awenWorkspace?.origin,
                        sessions: [],
                        createdAt: command.createdAt,
                        updatedAt: command.createdAt,
                      },
                    ],
                  };
                }
              },
              readProject: () => project,
              readWorkspace: () => Option.none(),
            }),
          ),
        );
        assert.equal(createInput?.detach, true);
        assert.equal(result.worktreeCreated, true);
        assert.equal(result.workspace.origin, "awen-created");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("blocks Workspace removal when active agent Sessions exist", () => {
    const workspace: AwenWorkspaceShell = {
      ...siblingWorkspace("/tmp/sibling"),
      sessions: [
        {
          kind: "agent" as const,
          id: AgentSessionId.make("session-1"),
          workspaceId: WorkspaceId.make("workspace:sibling"),
          threadId: ThreadId.make("thread-1"),
          title: "Active Session",
          status: "open" as const,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    };
    return Effect.gen(function* () {
      const service = yield* AwenWorkspaceService.AwenWorkspaceService;
      const error = yield* service
        .remove({ workspaceId: workspace.id, deleteDirectory: true })
        .pipe(Effect.flip);
      assert.equal(error.reason, "workspace-not-empty");
    }).pipe(
      Effect.provide(
        makeLayer({
          root: "/tmp/main",
          sibling: "/tmp/sibling",
          commonDir: "/tmp/main/.git",
          onDispatch: () => undefined,
          readProject: () => makeProject("/tmp/main"),
          readWorkspace: () => Option.some(workspace),
        }),
      ),
    );
  });

  it.effect("blocks Workspace removal when active terminal Sessions exist", () =>
    Effect.gen(function* () {
      const service = yield* AwenWorkspaceService.AwenWorkspaceService;
      const workspace = siblingWorkspace("/tmp/sibling");
      const error = yield* service
        .remove({ workspaceId: workspace.id, deleteDirectory: true })
        .pipe(Effect.flip);
      assert.equal(error.reason, "workspace-not-empty");
    }).pipe(
      Effect.provide(
        makeLayer({
          root: "/tmp/main",
          sibling: "/tmp/sibling",
          commonDir: "/tmp/main/.git",
          onDispatch: () => undefined,
          readProject: () => makeProject("/tmp/main"),
          readWorkspace: () => Option.some(siblingWorkspace("/tmp/sibling")),
          terminals: [
            {
              workspaceId: "workspace:sibling",
              terminalId: "term-1",
              cwd: "/tmp/sibling",
              worktreePath: "/tmp/sibling",
              status: "running",
              pid: 1234,
              exitCode: null,
              exitSignal: null,
              hasRunningSubprocess: false,
              label: "terminal",
              updatedAt: NOW,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("allows Workspace removal when terminal Sessions are exited", () =>
    Effect.gen(function* () {
      const service = yield* AwenWorkspaceService.AwenWorkspaceService;
      const workspace = siblingWorkspace("/tmp/sibling");
      const result = yield* service.remove({ workspaceId: workspace.id, deleteDirectory: true });
      assert.equal(result.removed, true);
      assert.equal(result.deletedDirectory, true);
    }).pipe(
      Effect.provide(
        makeLayer({
          root: "/tmp/main",
          sibling: "/tmp/sibling",
          commonDir: "/tmp/main/.git",
          onDispatch: () => undefined,
          readProject: () => makeProject("/tmp/main"),
          readWorkspace: () => Option.some(siblingWorkspace("/tmp/sibling")),
          terminals: [
            {
              workspaceId: "workspace:sibling",
              terminalId: "term-1",
              cwd: "/tmp/sibling",
              worktreePath: "/tmp/sibling",
              status: "exited",
              pid: null,
              exitCode: 0,
              exitSignal: null,
              hasRunningSubprocess: false,
              label: "terminal",
              updatedAt: NOW,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("protects the main Workspace from directory deletion", () =>
    Effect.gen(function* () {
      const service = yield* AwenWorkspaceService.AwenWorkspaceService;
      const error = yield* service
        .remove({ workspaceId: WorkspaceId.make("workspace:main"), deleteDirectory: true })
        .pipe(Effect.flip);
      assert.equal(error.reason, "main-checkout-protected");
    }).pipe(
      Effect.provide(
        makeLayer({
          root: "/tmp/main",
          sibling: "/tmp/sibling",
          commonDir: "/tmp/main/.git",
          onDispatch: () => undefined,
          readProject: () => makeProject("/tmp/main"),
          readWorkspace: () => Option.some(mainWorkspace("/tmp/main")),
        }),
      ),
    ),
  );

  it.effect("renames a Workspace without renaming its Project", () => {
    let project = makeProject("/tmp/main");
    let workspace = mainWorkspace("/tmp/main");
    return Effect.gen(function* () {
      const service = yield* AwenWorkspaceService.AwenWorkspaceService;
      const result = yield* service.rename({
        workspaceId: workspace.id,
        title: "Primary checkout",
      });
      assert.equal(result.workspace.title, "Primary checkout");
      assert.equal(project.title, "Repository");
      assert.equal(project.workspaces[0]?.title, "Primary checkout");
    }).pipe(
      Effect.provide(
        makeLayer({
          root: "/tmp/main",
          sibling: "/tmp/sibling",
          commonDir: "/tmp/main/.git",
          onDispatch: () => undefined,
          readProject: () => project,
          readWorkspace: () => Option.some(workspace),
          onRename: ({ title }) => {
            workspace = { ...workspace, title };
            project = {
              ...project,
              workspaces: [workspace],
            };
          },
        }),
      ),
    );
  });

  it.effect("renames an Awen Project without renaming its Workspaces", () => {
    let project = makeProject("/tmp/main");
    const originalWorkspaceTitle = project.workspaces[0]!.title;
    return Effect.gen(function* () {
      const service = yield* AwenWorkspaceService.AwenWorkspaceService;
      const result = yield* service.renameProject({ projectId: project.id, title: "Renamed" });
      assert.equal(result.project.title, "Renamed");
      assert.equal(result.project.workspaces[0]?.title, originalWorkspaceTitle);
    }).pipe(
      Effect.provide(
        makeLayer({
          root: "/tmp/main",
          sibling: "/tmp/sibling",
          commonDir: "/tmp/main/.git",
          onDispatch: () => undefined,
          readProject: () => project,
          readWorkspace: () => Option.some(mainWorkspace("/tmp/main")),
          onRenameProject: ({ title }) => {
            project = { ...project, title };
          },
        }),
      ),
    );
  });
});
