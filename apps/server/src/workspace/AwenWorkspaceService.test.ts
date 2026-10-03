import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  AgentSessionId,
  AwenProjectId,
  type AwenProjectShell,
  type AwenWorkspaceShell,
  ProjectId,
  TerminalSessionId,
  type TerminalSummary,
  ThreadId,
  WorkspaceId,
  VcsRepositoryDetectionError,
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
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
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

function makeStatusDetails(cwd: string, statusBranch?: (cwd: string) => string | null | undefined) {
  const branch = statusBranch?.(cwd);
  return {
    isRepo: true,
    hasOriginRemote: false,
    isDefaultBranch: true,
    branch: branch === undefined ? "main" : branch,
    headCommit: "0123456789abcdef0123456789abcdef01234567",
    upstreamRef: null,
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
  };
}

const makeLayer = (input: {
  readonly root: string;
  readonly sibling: string;
  readonly commonDir: string;
  readonly targetCommonDir?: string;
  readonly dirty?: boolean;
  readonly nonGit?: boolean;
  readonly detectFailure?: boolean;
  /** Branch that `git statusDetails` reports for a checkout; defaults to `main`. */
  readonly statusBranch?: (cwd: string) => string | null | undefined;
  readonly onCreate?: (
    input: Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0],
  ) => void;
  readonly onDispatch: (
    command: Parameters<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>[0],
  ) => void;
  readonly failProjectRenameDispatch?: boolean;
  /** When true, `project.create` dispatches fail, simulating a registration failure. */
  readonly failProjectCreateWhile?: () => boolean;
  readonly readProject: () => AwenProjectShell;
  readonly readWorkspace: () => Option.Option<AwenWorkspaceShell>;
  readonly onRenameProject?: (input: {
    readonly awenProjectId: AwenProjectId;
    readonly title: string;
  }) => void;
  /** Share one base dir across runs so the managed worktrees path is stable. */
  readonly serverConfigBaseDir?: string;
  readonly terminals?: ReadonlyArray<TerminalSummary>;
  readonly occupancy?: ReadonlyArray<TerminalManager.TerminalDirectoryOccupancy>;
  readonly onReleaseWorkspaceAssignment?: (workspaceId: string) => void;
}) => {
  const serverConfigLayer = ServerConfig.layerTest(
    process.cwd(),
    input.serverConfigBaseDir ?? { prefix: "awen-workspace-service-test-" },
  );
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
    getAwenProjectById: () => Effect.succeed(Option.some(input.readProject())),
    getAwenWorkspaceById: () => Effect.succeed(input.readWorkspace()),
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
    detect: (request) =>
      input.detectFailure
        ? Effect.fail(
            new VcsRepositoryDetectionError({
              operation: "detectRepository",
              cwd: request.cwd,
              detail: "Git inspection timed out",
            }),
          )
        : input.nonGit
          ? Effect.succeed(null)
          : Effect.succeed(
              makeRepositoryHandle(
                request.cwd === input.root ? input.root : input.sibling,
                request.cwd === input.root
                  ? input.commonDir
                  : (input.targetCommonDir ?? input.commonDir),
              ),
            ),
    resolve: (request) =>
      input.nonGit
        ? Effect.die(new Error("No Git repository"))
        : Effect.succeed(
            makeRepositoryHandle(
              request.cwd === input.root
                ? input.root
                : request.cwd === input.sibling
                  ? input.sibling
                  : // A daemon-managed worktree path resolves as its own root
                    // sharing the repository's common dir.
                    request.cwd,
              request.cwd === input.root
                ? input.commonDir
                : (input.targetCommonDir ?? input.commonDir),
            ),
          ),
  });
  const statusDetailsFor = (cwd: string) =>
    Effect.succeed({
      ...makeStatusDetails(cwd, input.statusBranch),
      hasWorkingTreeChanges: input.dirty === true,
    });
  const gitLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
    resolveCommit: () => Effect.succeed({ commitSha: "0123456789abcdef0123456789abcdef01234567" }),
    statusDetails: (cwd) => statusDetailsFor(cwd),
    statusDetailsLocal: (cwd) => statusDetailsFor(cwd),
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
      input.failProjectCreateWhile?.() === true && command.type === "project.create"
        ? Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: "simulated registration failure",
            }),
          )
        : input.failProjectRenameDispatch &&
            command.type === "project.meta.update" &&
            command.title === undefined
          ? Effect.fail(
              new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "simulated publish failure",
              }),
            )
          : Effect.sync(() => {
              input.onDispatch(command);
              return { sequence: 1 };
            }),
  });
  const terminalManagerLayer = Layer.mock(TerminalManager.TerminalManager)({
    getMetadata: () => Effect.succeed(input.terminals ?? []),
    getDirectoryOccupancy: () => Effect.succeed(input.occupancy ?? []),
    releaseWorkspaceAssignment: (workspaceId) =>
      Effect.sync(() => input.onReleaseWorkspaceAssignment?.(workspaceId)),
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
  it.effect("registers an ordinary directory once and returns its identity on retry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "awen-register-" });
        const root = path.join(parent, "directory");
        yield* fileSystem.makeDirectory(root);
        let project = makeProject(path.join(parent, "unrelated"));
        let creates = 0;
        const result = yield* Effect.gen(function* () {
          const service = yield* AwenWorkspaceService.AwenWorkspaceService;
          const first = yield* service.register({ path: root, title: "My directory" });
          const second = yield* service.register({ path: root, title: "Ignored retry title" });
          return { first, second };
        }).pipe(
          Effect.provide(
            makeLayer({
              root,
              sibling: root,
              commonDir: path.join(parent, ".git"),
              nonGit: true,
              onDispatch: (command) => {
                if (command.type !== "project.create") return;
                creates += 1;
                project = {
                  id: AwenProjectId.make(`awen-project:${command.projectId}`),
                  title: command.title,
                  workspaces: [
                    {
                      id: workspaceIdForAwenProject(command.projectId),
                      projectId: AwenProjectId.make(`awen-project:${command.projectId}`),
                      awenProjectId: command.projectId,
                      title: command.title,
                      workspaceRoot: command.workspaceRoot,
                      role: "main",
                      sessions: [],
                      createdAt: command.createdAt,
                      updatedAt: command.createdAt,
                    },
                  ],
                  createdAt: command.createdAt,
                  updatedAt: command.createdAt,
                };
              },
              readProject: () => project,
              readWorkspace: () => Option.none(),
            }),
          ),
        );
        assert.equal(creates, 1);
        assert.equal(result.first.reused, false);
        assert.equal(result.second.reused, true);
        assert.equal(result.second.workspace.id, result.first.workspace.id);
        assert.equal(result.second.workspace.title, "My directory");
        assert.equal(result.second.workspace.workspaceRoot, root);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects a missing directory without registering a Workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "awen-missing-" });
        const missing = path.join(parent, "missing");
        let dispatched = false;
        const error = yield* Effect.gen(function* () {
          const service = yield* AwenWorkspaceService.AwenWorkspaceService;
          return yield* service.register({ path: missing }).pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            makeLayer({
              root: missing,
              sibling: missing,
              commonDir: path.join(parent, ".git"),
              nonGit: true,
              onDispatch: () => {
                dispatched = true;
              },
              readProject: () => makeProject(path.join(parent, "unrelated")),
              readWorkspace: () => Option.none(),
            }),
          ),
        );
        assert.equal(error.reason, "path-not-found");
        assert.equal(dispatched, false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("does not register a separate Project when Git inspection fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "awen-git-error-" });
        const root = path.join(parent, "checkout");
        yield* fileSystem.makeDirectory(root);
        let dispatched = false;
        const error = yield* Effect.gen(function* () {
          const service = yield* AwenWorkspaceService.AwenWorkspaceService;
          return yield* service.register({ path: root }).pipe(Effect.flip);
        }).pipe(
          Effect.provide(
            makeLayer({
              root,
              sibling: root,
              commonDir: path.join(parent, ".git"),
              detectFailure: true,
              onDispatch: () => {
                dispatched = true;
              },
              readProject: () => makeProject(path.join(parent, "unrelated")),
              readWorkspace: () => Option.none(),
            }),
          ),
        );
        assert.equal(error.reason, "git-failed");
        assert.equal(dispatched, false);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("registers an existing worktree under its repository Project", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "awen-register-git-" });
        const root = path.join(parent, "main");
        const sibling = path.join(parent, "feature");
        yield* fileSystem.makeDirectory(root);
        yield* fileSystem.makeDirectory(sibling);
        let project = makeProject(root);
        const { first, second } = yield* Effect.gen(function* () {
          const service = yield* AwenWorkspaceService.AwenWorkspaceService;
          const first = yield* service.register({ path: sibling });
          const second = yield* service.register({ path: sibling });
          return { first, second };
        }).pipe(
          Effect.provide(
            makeLayer({
              root,
              sibling,
              commonDir: path.join(parent, ".git"),
              onDispatch: (command) => {
                if (command.type !== "project.create") return;
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
                      origin: "associated",
                      sessions: [],
                      createdAt: command.createdAt,
                      updatedAt: command.createdAt,
                    },
                  ],
                };
              },
              readProject: () => project,
              readWorkspace: () => Option.none(),
            }),
          ),
        );
        assert.equal(first.reused, false);
        assert.equal(first.workspace.projectId, project.id);
        assert.equal(first.workspace.role, "worktree");
        assert.equal(second.reused, true);
        assert.equal(second.workspace.id, first.workspace.id);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

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

  it.effect("reuses the kept worktree directory when a retry follows a registration failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "awen-retry-" });
        const root = path.join(parent, "main");
        const sibling = path.join(parent, "other");
        const baseDir = path.join(parent, "server");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        let project = makeProject(root);
        let failCreate = true;
        const createInputs: Array<
          Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0]
        > = [];
        let projectCreateDispatches = 0;
        // The retry reuses the directory the first attempt kept, and that
        // directory holds the requested branch in a real checkout.
        let keptWorktreePath: string | null = null;
        const run = () =>
          Effect.gen(function* () {
            const service = yield* AwenWorkspaceService.AwenWorkspaceService;
            return yield* service.createWorktree({
              projectId: project.id,
              baseRef: "HEAD",
              newBranch: "awen/retry-branch",
            });
          }).pipe(
            Effect.provide(
              makeLayer({
                root,
                sibling,
                commonDir: path.join(parent, ".git"),
                serverConfigBaseDir: baseDir,
                failProjectCreateWhile: () => failCreate,
                statusBranch: (cwd) => (cwd === keptWorktreePath ? "awen/retry-branch" : "main"),
                onCreate: (input) => {
                  createInputs.push(input);
                },
                onDispatch: (command) => {
                  if (command.type !== "project.create") return;
                  projectCreateDispatches += 1;
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
                },
                readProject: () => project,
                readWorkspace: () => Option.none(),
              }),
            ),
          );

        const first = yield* run().pipe(Effect.flip);
        assert.equal(first._tag, "AwenWorkspaceError");
        if (first._tag === "AwenWorkspaceError") {
          assert.equal(first.reason, "registration-failed");
        }
        assert.equal(createInputs.length, 1);
        const managedPath = createInputs[0]?.path;
        assert.include(managedPath ?? "", "awen-retry-branch");
        keptWorktreePath = managedPath ?? null;
        // The Git half succeeded and only the registration failed, so the
        // directory was kept on disk for the retry to reuse.
        yield* fileSystem.makeDirectory(managedPath ?? "", { recursive: true });

        // The retry pins the same branch name, so it resolves to the same
        // daemon-managed directory and reuses the checkout instead of
        // duplicating it.
        failCreate = false;
        const second = yield* run();
        assert.equal(createInputs.length, 1);
        assert.equal(second.worktreeCreated, false);
        assert.equal(second.workspace.workspaceRoot, managedPath);
        assert.equal(projectCreateDispatches, 1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates a distinct worktree when another branch owns the managed path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const parent = yield* fileSystem.makeTempDirectoryScoped({ prefix: "awen-create-" });
        const serverConfigBaseDir = path.join(parent, "state");
        const root = path.join(parent, "main");
        yield* fileSystem.makeDirectory(root, { recursive: true });
        // `feature/a` and `feature-a` share one slug, so they share one directory.
        const slugRoot = path.join(
          serverConfigBaseDir,
          "worktrees",
          path.basename(root),
          "feature-a",
        );
        yield* fileSystem.makeDirectory(slugRoot, { recursive: true });

        let project: AwenProjectShell = {
          ...makeProject(root),
          workspaces: [mainWorkspace(root), siblingWorkspace(slugRoot)],
        };
        let createInput:
          | Parameters<GitWorkflowService.GitWorkflowService["Service"]["createWorktree"]>[0]
          | undefined;
        const result = yield* Effect.gen(function* () {
          const service = yield* AwenWorkspaceService.AwenWorkspaceService;
          return yield* service.createWorktree({
            projectId: project.id,
            baseRef: "HEAD",
            newBranch: "feature-a",
          });
        }).pipe(
          Effect.provide(
            makeLayer({
              root,
              sibling: slugRoot,
              commonDir: path.join(parent, ".git"),
              serverConfigBaseDir,
              statusBranch: (cwd) => (cwd === slugRoot ? "feature/a" : "main"),
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

        assert.equal(createInput?.newRefName, "feature-a");
        assert.notEqual(createInput?.path, slugRoot);
        assert.isTrue(
          createInput?.path?.startsWith(
            `${path.join(serverConfigBaseDir, "worktrees", path.basename(root), "feature-a-")}`,
          ),
        );
        assert.equal(result.worktreeCreated, true);
        assert.equal(result.worktreePath, createInput?.path);
        // The checkout that owns the shared slug keeps it.
        assert.equal(
          project.workspaces.some((workspace) => workspace.workspaceRoot === slugRoot),
          true,
        );
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

  for (const [name, processDirectories, hasUnobservedProcesses, blocked] of [
    ["child working inside", ["/tmp/sibling/nested"], false, true],
    ["unknown child directory", [], true, true],
    ["child released", [], false, false],
  ] as const) {
    it.effect(`checks child occupancy on directory removal: ${name}`, () =>
      Effect.gen(function* () {
        const service = yield* AwenWorkspaceService.AwenWorkspaceService;
        const result = yield* service
          .remove({
            workspaceId: siblingWorkspace("/tmp/sibling").id,
            deleteDirectory: true,
          })
          .pipe(Effect.option);
        assert.equal(Option.isNone(result), blocked);
      }).pipe(
        Effect.provide(
          makeLayer({
            root: "/tmp/main",
            sibling: "/tmp/sibling",
            commonDir: "/tmp/main/.git",
            onDispatch: () => undefined,
            readProject: () => makeProject("/tmp/main"),
            readWorkspace: () => Option.some(siblingWorkspace("/tmp/sibling")),
            occupancy: [
              {
                terminalId: "term-child",
                workspaceId: "workspace:main",
                status: "running",
                launchCwd: "/tmp/main",
                observedDirectory: "/tmp/main",
                directoryObservationSupported: true,
                processDirectories,
                hasUnobservedProcesses,
              },
            ],
          }),
        ),
      ),
    );
  }

  it.effect("blocks destructive directory deletion while a running terminal occupies it", () =>
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
          occupancy: [
            {
              terminalId: "term-1",
              workspaceId: "workspace:sibling",
              status: "running",
              launchCwd: "/tmp/sibling",
              observedDirectory: "/tmp/sibling",
              processDirectories: [],
              hasUnobservedProcesses: false,
              directoryObservationSupported: true,
            },
          ],
        }),
      ),
    ),
  );

  it.effect(
    "blocks destructive deletion when a terminal left the directory but stays assigned to it",
    () =>
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
            occupancy: [
              {
                terminalId: "term-1",
                workspaceId: "workspace:sibling",
                status: "running",
                launchCwd: "/tmp/sibling",
                // Unknown observation retains the last confirmed assignment.
                observedDirectory: null,
                processDirectories: [],
                hasUnobservedProcesses: false,
                directoryObservationSupported: false,
              },
            ],
          }),
        ),
      ),
  );

  it.effect(
    "blocks destructive deletion when a never-observed unassigned terminal was launched in the directory",
    () =>
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
            occupancy: [
              {
                terminalId: "term-1",
                status: "running",
                launchCwd: "/tmp/sibling/sub",
                observedDirectory: null,
                processDirectories: [],
                hasUnobservedProcesses: false,
                directoryObservationSupported: false,
              },
            ],
          }),
        ),
      ),
  );

  it.effect("allows destructive deletion when a never-observed terminal launched elsewhere", () =>
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
          occupancy: [
            {
              terminalId: "term-1",
              status: "running",
              launchCwd: "/tmp/elsewhere",
              observedDirectory: null,
              processDirectories: [],
              hasUnobservedProcesses: false,
              directoryObservationSupported: false,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("allows destructive deletion for a terminal that moved out of the Workspace", () =>
    Effect.gen(function* () {
      const service = yield* AwenWorkspaceService.AwenWorkspaceService;
      const workspace = siblingWorkspace("/tmp/sibling");
      const result = yield* service.remove({
        workspaceId: workspace.id,
        deleteDirectory: true,
      });
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
          occupancy: [
            {
              terminalId: "term-1",
              workspaceId: "workspace:other",
              status: "running",
              launchCwd: "/tmp/sibling",
              observedDirectory: "/tmp/elsewhere",
              processDirectories: [],
              hasUnobservedProcesses: false,
              directoryObservationSupported: true,
            },
          ],
        }),
      ),
    ),
  );

  it.effect("allows destructive deletion once the terminal has exited", () =>
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
          occupancy: [
            {
              terminalId: "term-1",
              workspaceId: "workspace:sibling",
              status: "exited",
              launchCwd: "/tmp/sibling",
              observedDirectory: null,
              processDirectories: [],
              hasUnobservedProcesses: false,
              directoryObservationSupported: true,
            },
          ],
        }),
      ),
    ),
  );

  it.effect(
    "unregisters a Workspace while a terminal runs there and releases its assignment",
    () => {
      const released: string[] = [];
      return Effect.gen(function* () {
        const service = yield* AwenWorkspaceService.AwenWorkspaceService;
        const workspace = siblingWorkspace("/tmp/sibling");
        const result = yield* service.remove({
          workspaceId: workspace.id,
          deleteDirectory: false,
        });
        assert.equal(result.removed, true);
        assert.equal(result.deletedDirectory, false);
        assert.deepEqual(released, ["workspace:sibling"]);
      }).pipe(
        Effect.provide(
          makeLayer({
            root: "/tmp/main",
            sibling: "/tmp/sibling",
            commonDir: "/tmp/main/.git",
            onDispatch: () => undefined,
            readProject: () => makeProject("/tmp/main"),
            readWorkspace: () => Option.some(siblingWorkspace("/tmp/sibling")),
            occupancy: [
              {
                terminalId: "term-1",
                workspaceId: "workspace:sibling",
                status: "running",
                launchCwd: "/tmp/sibling",
                observedDirectory: "/tmp/sibling",
                processDirectories: [],
                hasUnobservedProcesses: false,
                directoryObservationSupported: true,
              },
            ],
            onReleaseWorkspaceAssignment: (workspaceId) => released.push(workspaceId),
          }),
        ),
      );
    },
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
          onDispatch: (command) => {
            if (command.type === "project.meta.update" && command.title !== undefined) {
              workspace = { ...workspace, title: command.title };
              project = { ...project, workspaces: [workspace] };
            }
          },
          readProject: () => project,
          readWorkspace: () => Option.some(workspace),
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

  it.effect("restores the Project title when the rename update cannot be published", () => {
    let project = makeProject("/tmp/main");
    return Effect.gen(function* () {
      const service = yield* AwenWorkspaceService.AwenWorkspaceService;
      const error = yield* service
        .renameProject({ projectId: project.id, title: "Renamed" })
        .pipe(Effect.flip);
      assert.equal(error.reason, "registration-failed");
      assert.equal(project.title, "Repository");
    }).pipe(
      Effect.provide(
        makeLayer({
          root: "/tmp/main",
          sibling: "/tmp/sibling",
          commonDir: "/tmp/main/.git",
          failProjectRenameDispatch: true,
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
