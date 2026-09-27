import {
  AwenProjectId,
  AwenWorkspaceError,
  type AwenWorkspaceAssociateInput,
  type AwenWorkspaceAssociateResult,
  type AwenWorkspaceRegisterInput,
  type AwenWorkspaceRegisterResult,
  type AwenWorkspaceCreateWorktreeInput,
  type AwenWorkspaceCreateWorktreeResult,
  type AwenWorkspaceRemoveInput,
  type AwenWorkspaceRemoveResult,
  type AwenWorkspaceRenameInput,
  type AwenWorkspaceRenameResult,
  type AwenProjectRenameInput,
  type AwenProjectRenameResult,
  CommandId,
  ProjectId,
  type AwenProjectShell,
  type AwenWorkspaceShell,
  WorkspaceId,
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

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import * as TerminalManager from "../terminal/Manager.ts";

/**
 * Server-side owner of Awen Workspace identity and worktree lifecycle.
 *
 * The orchestration project remains the durable event boundary. This service
 * validates the physical worktree first, then emits a project.create/delete
 * command that the existing projection pipeline turns into an Awen sibling.
 * Git is never invoked through a shell string assembled from user input.
 */
export class AwenWorkspaceService extends Context.Service<
  AwenWorkspaceService,
  {
    readonly register: (
      input: AwenWorkspaceRegisterInput,
    ) => Effect.Effect<AwenWorkspaceRegisterResult, AwenWorkspaceError>;
    readonly associate: (
      input: AwenWorkspaceAssociateInput,
    ) => Effect.Effect<AwenWorkspaceAssociateResult, AwenWorkspaceError>;
    readonly createWorktree: (
      input: AwenWorkspaceCreateWorktreeInput,
    ) => Effect.Effect<AwenWorkspaceCreateWorktreeResult, AwenWorkspaceError>;
    readonly remove: (
      input: AwenWorkspaceRemoveInput,
    ) => Effect.Effect<AwenWorkspaceRemoveResult, AwenWorkspaceError>;
    readonly rename: (
      input: AwenWorkspaceRenameInput,
    ) => Effect.Effect<AwenWorkspaceRenameResult, AwenWorkspaceError>;
    readonly renameProject: (
      input: AwenProjectRenameInput,
    ) => Effect.Effect<AwenProjectRenameResult, AwenWorkspaceError>;
  }
>()("@awen/server/workspace/AwenWorkspaceService") {}

type Repository = {
  readonly rootPath: string;
  readonly commonDir: string;
};

function workspaceError(
  reason: AwenWorkspaceError["reason"],
  detail: string,
  path?: string,
  cause?: unknown,
): AwenWorkspaceError {
  return new AwenWorkspaceError({
    reason,
    detail,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause }),
  });
}

function isInsideOrEqual(pathService: Path.Path, parent: string, candidate: string): boolean {
  const relative = pathService.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathService.sep}`) &&
      !pathService.isAbsolute(relative))
  );
}

function isSamePath(pathService: Path.Path, left: string, right: string): boolean {
  return pathService.relative(left, right) === "";
}

function pathSlug(value: string): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length === 0 ? "detached" : slug;
}

function allWorkspaces(
  projects: ReadonlyArray<AwenProjectShell>,
): ReadonlyArray<AwenWorkspaceShell> {
  return projects.flatMap((project) => project.workspaces);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectionQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const terminalManagerOption = yield* Effect.serviceOption(TerminalManager.TerminalManager);

  const readAwenProject = (projectId: AwenProjectId) => {
    const getter = projectionQuery.getAwenProjectById;
    if (getter === undefined) {
      return Effect.fail(
        workspaceError(
          "project-not-found",
          `Awen Project '${projectId}' is not available on this server.`,
        ),
      );
    }
    return getter(projectId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              workspaceError("project-not-found", `Awen Project '${projectId}' was not found.`),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((cause) =>
        Schema.is(AwenWorkspaceError)(cause)
          ? cause
          : workspaceError(
              "registration-failed",
              `Could not read Awen Project '${projectId}'.`,
              undefined,
              cause,
            ),
      ),
    );
  };

  const readWorkspace = (workspaceId: WorkspaceId) => {
    const getter = projectionQuery.getAwenWorkspaceById;
    if (getter === undefined) return Effect.succeed(Option.none<AwenWorkspaceShell>());
    return getter(workspaceId);
  };

  const readAllProjects = () =>
    projectionQuery.getShellSnapshot().pipe(
      Effect.map((snapshot) => snapshot.awenProjects ?? []),
      Effect.mapError((cause) =>
        workspaceError(
          "registration-failed",
          "Failed to read registered Awen Workspaces.",
          undefined,
          cause,
        ),
      ),
    );

  const realPathOrResolved = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => pathService.resolve(value)));

  const normalizeExistingDirectory = (value: string, createIfMissing = false) =>
    workspacePaths.normalizeWorkspaceRoot(value, { createIfMissing }).pipe(
      Effect.mapError((cause) => workspaceError("path-not-found", cause.message, value, cause)),
      Effect.flatMap((resolved) =>
        realPathOrResolved(resolved).pipe(
          Effect.mapError((cause) =>
            workspaceError(
              "path-not-found",
              `Could not resolve worktree path '${value}'.`,
              value,
              cause,
            ),
          ),
        ),
      ),
    );

  const resolveRepository = (cwd: string, pathForError = cwd) =>
    vcsRegistry.resolve({ cwd }).pipe(
      Effect.catchCause((cause) =>
        Effect.fail(
          workspaceError(
            "not-a-repository",
            `The path '${pathForError}' is not a supported Git worktree.`,
            pathForError,
            Cause.squash(cause),
          ),
        ),
      ),
      Effect.flatMap((handle) => {
        if (handle.kind !== "git" || handle.repository.metadataPath === null) {
          return Effect.fail(
            workspaceError(
              "not-a-repository",
              `The path '${pathForError}' is not a supported Git worktree.`,
              pathForError,
            ),
          );
        }
        const metadataPath = handle.repository.metadataPath.trim();
        const commonDir = pathService.isAbsolute(metadataPath)
          ? metadataPath
          : pathService.resolve(handle.repository.rootPath, metadataPath);
        return Effect.all({
          rootPath: realPathOrResolved(handle.repository.rootPath),
          commonDir: realPathOrResolved(commonDir),
        }).pipe(
          Effect.mapError((cause) =>
            workspaceError(
              "git-failed",
              `Could not inspect Git worktree '${pathForError}'.`,
              pathForError,
              cause,
            ),
          ),
        );
      }),
    );

  const detectRepository = (cwd: string) =>
    vcsRegistry.detect({ cwd }).pipe(
      Effect.mapError((cause) =>
        workspaceError("git-failed", `Could not inspect repository at '${cwd}'.`, cwd, cause),
      ),
      Effect.flatMap((handle) => {
        if (handle === null || handle.kind !== "git") {
          return Effect.succeed(Option.none<Repository>());
        }
        return resolveRepository(cwd).pipe(
          Effect.map(Option.some),
          Effect.mapError((cause) =>
            workspaceError("git-failed", `Could not inspect repository at '${cwd}'.`, cwd, cause),
          ),
        );
      }),
    );

  const registeredWorkspaceAt = (
    projects: ReadonlyArray<AwenProjectShell>,
    candidate: string,
  ): AwenWorkspaceShell | undefined =>
    allWorkspaces(projects).find((workspace) =>
      isSamePath(pathService, pathService.resolve(workspace.workspaceRoot), candidate),
    );

  const rejectNestedWorkspace = (
    projects: ReadonlyArray<AwenProjectShell>,
    candidate: string,
    allowWorkspaceId?: WorkspaceId,
  ) => {
    const conflict = allWorkspaces(projects).find((workspace) => {
      if (allowWorkspaceId !== undefined && workspace.id === allowWorkspaceId) return false;
      const registered = pathService.resolve(workspace.workspaceRoot);
      return (
        isInsideOrEqual(pathService, registered, candidate) ||
        isInsideOrEqual(pathService, candidate, registered)
      );
    });
    return conflict === undefined
      ? Effect.void
      : Effect.fail(
          workspaceError(
            "path-conflict",
            `Worktree path '${candidate}' conflicts with registered Workspace '${conflict.workspaceRoot}'.`,
            candidate,
          ),
        );
  };

  const mainWorkspaceFor = (project: AwenProjectShell) => {
    const workspace =
      project.workspaces.find((candidate) => candidate.role === "main") ?? project.workspaces[0];
    return workspace === undefined
      ? Effect.fail(
          workspaceError(
            "project-not-found",
            `Awen Project '${project.id}' has no main Workspace.`,
          ),
        )
      : Effect.succeed(workspace);
  };

  const assertSameRepository = (mainRoot: string, targetRoot: string) =>
    Effect.all({ main: resolveRepository(mainRoot), target: resolveRepository(targetRoot) }).pipe(
      Effect.flatMap(({ main, target }) =>
        main.commonDir === target.commonDir
          ? Effect.succeed({ main, target })
          : Effect.fail(
              workspaceError(
                "different-repository",
                `Worktree '${targetRoot}' belongs to a different Git repository than '${mainRoot}'.`,
                targetRoot,
              ),
            ),
      ),
    );

  const dispatchCreate = (input: {
    readonly project: AwenProjectShell;
    readonly workspaceRoot: string;
    readonly title: string;
    readonly origin: "associated" | "awen-created";
  }) =>
    Effect.gen(function* () {
      const uuid = yield* crypto.randomUUIDv4;
      const projectId = ProjectId.make(`awen-workspace:${uuid}`);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make(`awen-workspace:create:${uuid}`),
        projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        createWorkspaceRootIfMissing: false,
        awenWorkspace: {
          awenProjectId: input.project.id,
          role: "worktree",
          origin: input.origin,
        },
        createdAt,
      });
      return projectId;
    });

  const registeredWorkspaceFor = (projectId: AwenProjectId, workspaceRoot: string) =>
    readAwenProject(projectId).pipe(
      Effect.flatMap((project) => {
        const workspace = project.workspaces.find((candidate) =>
          isSamePath(pathService, pathService.resolve(candidate.workspaceRoot), workspaceRoot),
        );
        return workspace === undefined
          ? Effect.fail(
              workspaceError(
                "registration-failed",
                `Workspace '${workspaceRoot}' was not visible after registration.`,
                workspaceRoot,
              ),
            )
          : Effect.succeed(workspace);
      }),
    );

  const register: AwenWorkspaceService["Service"]["register"] = Effect.fn(
    "AwenWorkspaceService.register",
  )(function* (input) {
    const directory = yield* normalizeExistingDirectory(input.path, input.createIfMissing);
    const repository = yield* detectRepository(directory);
    const root = Option.isSome(repository) ? repository.value.rootPath : directory;
    const projects = yield* readAllProjects();
    const existing = registeredWorkspaceAt(projects, root);
    if (existing !== undefined) return { workspace: existing, reused: true };

    if (Option.isSome(repository)) {
      for (const project of projects) {
        const main =
          project.workspaces.find((workspace) => workspace.role === "main") ??
          project.workspaces[0];
        if (main === undefined) continue;
        const mainRepository = yield* detectRepository(main.workspaceRoot);
        if (
          Option.isSome(mainRepository) &&
          mainRepository.value.commonDir === repository.value.commonDir
        ) {
          return yield* associate({ projectId: project.id, path: root, title: input.title });
        }
      }
    }
    yield* rejectNestedWorkspace(projects, root);
    const uuid = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        workspaceError(
          "registration-failed",
          "Could not prepare Workspace registration.",
          root,
          cause,
        ),
      ),
    );
    const projectId = ProjectId.make(`awen-workspace:${uuid}`);
    const title = input.title?.trim() || pathService.basename(root) || "workspace";
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const registration = yield* orchestrationEngine
      .dispatch({
        type: "project.create",
        commandId: CommandId.make(`awen-workspace:register:${uuid}`),
        projectId,
        title,
        workspaceRoot: root,
        createWorkspaceRootIfMissing: false,
        createdAt,
      })
      .pipe(Effect.result);
    const registered = registeredWorkspaceAt(yield* readAllProjects(), root);
    if (registered === undefined) {
      return yield* workspaceError(
        "registration-failed",
        Result.isFailure(registration)
          ? `Could not register '${root}': ${String(registration.failure)}`
          : `Workspace '${root}' was not visible after registration.`,
        root,
        Result.isFailure(registration) ? registration.failure : undefined,
      );
    }
    return { workspace: registered, reused: Result.isFailure(registration) };
  });

  const associate: AwenWorkspaceService["Service"]["associate"] = Effect.fn(
    "AwenWorkspaceService.associate",
  )(function* (input) {
    const project = yield* readAwenProject(input.projectId);
    const mainWorkspace = yield* mainWorkspaceFor(project);
    const targetRoot = yield* normalizeExistingDirectory(input.path);
    const projects = yield* readAllProjects();
    const { target: targetRepository } = yield* assertSameRepository(
      mainWorkspace.workspaceRoot,
      targetRoot,
    );
    // Git may resolve a path supplied inside a checkout to its top-level root.
    // A Workspace always owns that root, never an arbitrary subdirectory.
    const checkoutRoot = targetRepository.rootPath;
    const existing = registeredWorkspaceAt(projects, checkoutRoot);
    if (existing !== undefined) {
      if (existing.projectId === input.projectId) {
        return { workspace: existing, reused: true };
      }
      return yield* workspaceError(
        "already-registered",
        `Worktree '${checkoutRoot}' is already registered under another Awen Project.`,
        checkoutRoot,
      );
    }
    yield* rejectNestedWorkspace(projects, checkoutRoot);

    const title = input.title?.trim() || pathService.basename(checkoutRoot) || "workspace";
    yield* dispatchCreate({
      project,
      workspaceRoot: checkoutRoot,
      title,
      origin: "associated",
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(AwenWorkspaceError)(cause)
          ? cause
          : workspaceError(
              "registration-failed",
              `Failed to register worktree '${checkoutRoot}'.`,
              checkoutRoot,
              cause,
            ),
      ),
    );
    const workspace = yield* registeredWorkspaceFor(input.projectId, checkoutRoot);
    return { workspace, reused: false };
  });

  const createWorktree: AwenWorkspaceService["Service"]["createWorktree"] = Effect.fn(
    "AwenWorkspaceService.createWorktree",
  )(function* (input) {
    const project = yield* readAwenProject(input.projectId);
    const mainWorkspace = yield* mainWorkspaceFor(project);
    const mainRoot = pathService.resolve(mainWorkspace.workspaceRoot);
    const mainRepository = yield* resolveRepository(mainRoot);
    const baseRef = input.baseRef?.trim() || "HEAD";
    const resolvedBase = yield* git
      .resolveCommit({ cwd: mainRoot, revision: baseRef })
      .pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "invalid-ref",
            `Base ref '${baseRef}' does not resolve to a commit.`,
            mainRoot,
            cause,
          ),
        ),
      );
    const mainStatus = yield* git
      .statusDetails(mainRoot)
      .pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "git-failed",
            `Could not inspect the main worktree '${mainRoot}'.`,
            mainRoot,
            cause,
          ),
        ),
      );
    if (mainStatus.hasWorkingTreeChanges) {
      return yield* workspaceError(
        "dirty-worktree",
        `The main Workspace '${mainRoot}' has uncommitted or untracked changes.`,
        mainRoot,
      );
    }

    const managedDefaultPath = pathService.join(
      serverConfig.worktreesDir,
      pathService.basename(mainRoot) || "project",
      pathSlug(input.newBranch ?? `detached-${resolvedBase.commitSha.slice(0, 12)}`),
    );
    const requestedPath = input.path?.trim() || managedDefaultPath;
    const requestedAbsolutePath = pathService.resolve(requestedPath);
    const projects = yield* readAllProjects();
    const existingRegistered = registeredWorkspaceAt(projects, requestedAbsolutePath);
    if (existingRegistered !== undefined) {
      if (existingRegistered.projectId === input.projectId) {
        return {
          workspace: existingRegistered,
          worktreePath: existingRegistered.workspaceRoot,
          worktreeCreated: false,
        };
      }
      return yield* workspaceError(
        "already-registered",
        `Worktree '${requestedAbsolutePath}' is already registered under another Awen Project.`,
        requestedAbsolutePath,
      );
    }
    yield* rejectNestedWorkspace(projects, requestedAbsolutePath);

    const destinationExists = yield* fileSystem
      .exists(requestedAbsolutePath)
      .pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "path-conflict",
            `Could not inspect worktree destination '${requestedAbsolutePath}'.`,
            requestedAbsolutePath,
            cause,
          ),
        ),
      );
    let worktreeCreated = false;
    let workspaceRoot = requestedAbsolutePath;
    let origin: "associated" | "awen-created" = "awen-created";
    if (destinationExists) {
      const stat = yield* fileSystem
        .stat(requestedAbsolutePath)
        .pipe(
          Effect.mapError((cause) =>
            workspaceError(
              "path-conflict",
              `Could not inspect worktree destination '${requestedAbsolutePath}'.`,
              requestedAbsolutePath,
              cause,
            ),
          ),
        );
      if (stat.type !== "Directory") {
        return yield* workspaceError(
          "path-conflict",
          `Worktree destination '${requestedAbsolutePath}' is not a directory.`,
          requestedAbsolutePath,
        );
      }
      const existingRepository = yield* resolveRepository(
        requestedAbsolutePath,
        requestedAbsolutePath,
      ).pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "path-conflict",
            `Worktree destination '${requestedAbsolutePath}' is not a completed Git worktree.`,
            requestedAbsolutePath,
            cause,
          ),
        ),
      );
      if (existingRepository.commonDir !== mainRepository.commonDir) {
        return yield* workspaceError(
          "path-conflict",
          `Worktree destination '${requestedAbsolutePath}' belongs to another repository.`,
          requestedAbsolutePath,
        );
      }
      workspaceRoot = existingRepository.rootPath;
      if (!isSamePath(pathService, workspaceRoot, requestedAbsolutePath)) {
        return yield* workspaceError(
          "path-conflict",
          `Worktree destination '${requestedAbsolutePath}' is nested inside another worktree.`,
          requestedAbsolutePath,
        );
      }
      // A retry after Git succeeded but Awen registration failed reuses the
      // existing checkout only inside the daemon-managed worktrees root. An
      // existing explicit path elsewhere must be associated explicitly, so a
      // user-owned checkout can never become an Awen-deletable directory.
      const managedRoot = pathService.resolve(serverConfig.worktreesDir);
      if (!isInsideOrEqual(pathService, managedRoot, workspaceRoot)) {
        return yield* workspaceError(
          "path-conflict",
          `Destination '${workspaceRoot}' already exists outside Awen's managed worktrees directory; associate it instead.`,
          workspaceRoot,
        );
      }
      origin = "awen-created";
    } else {
      yield* fileSystem
        .makeDirectory(pathService.dirname(requestedAbsolutePath), { recursive: true })
        .pipe(
          Effect.mapError((cause) =>
            workspaceError(
              "path-conflict",
              `Could not prepare worktree destination '${requestedAbsolutePath}'.`,
              requestedAbsolutePath,
              cause,
            ),
          ),
        );
      yield* gitWorkflow
        .createWorktree({
          cwd: mainRoot,
          refName: input.newBranch === undefined ? resolvedBase.commitSha : baseRef,
          ...(input.newBranch === undefined
            ? { detach: true }
            : { newRefName: input.newBranch, baseRefName: baseRef }),
          path: requestedAbsolutePath,
        })
        .pipe(
          Effect.mapError((cause) =>
            workspaceError(
              input.newBranch === undefined ? "git-failed" : "branch-exists",
              `Git could not create worktree '${requestedAbsolutePath}'.`,
              requestedAbsolutePath,
              cause,
            ),
          ),
        );
      worktreeCreated = true;
    }

    const title = input.title?.trim() || pathService.basename(workspaceRoot) || "workspace";
    yield* dispatchCreate({
      project,
      workspaceRoot,
      title,
      origin,
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(AwenWorkspaceError)(cause)
          ? cause
          : workspaceError(
              "registration-failed",
              `Worktree '${workspaceRoot}' was created but could not be registered. The directory was kept.`,
              workspaceRoot,
              cause,
            ),
      ),
    );
    const workspace = yield* registeredWorkspaceFor(input.projectId, workspaceRoot);
    return { workspace, worktreePath: workspaceRoot, worktreeCreated };
  });

  const remove: AwenWorkspaceService["Service"]["remove"] = (input) =>
    Effect.gen(function* () {
      const workspaceOption = yield* readWorkspace(input.workspaceId).pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "registration-failed",
            `Could not read Workspace '${input.workspaceId}'.`,
            undefined,
            cause,
          ),
        ),
      );
      if (Option.isNone(workspaceOption)) {
        return { removed: false, deletedDirectory: false };
      }
      const workspace = workspaceOption.value;
      if ((workspace.sessions?.length ?? 0) > 0) {
        return yield* workspaceError(
          "workspace-not-empty",
          `Workspace '${workspace.title}' still has active Sessions. Stop them before removing it.`,
          workspace.workspaceRoot,
        );
      }
      if (Option.isSome(terminalManagerOption)) {
        const terminalSummaries = yield* terminalManagerOption.value.getMetadata();
        const hasActiveTerminal = terminalSummaries.some(
          (t) =>
            t.workspaceId === input.workspaceId &&
            (t.status === "running" || t.status === "starting"),
        );
        if (hasActiveTerminal) {
          return yield* workspaceError(
            "workspace-not-empty",
            `Workspace '${workspace.title}' still has active Sessions. Stop them before removing it.`,
            workspace.workspaceRoot,
          );
        }
      }
      const shouldDeleteDirectory = input.deleteDirectory === true;
      if (shouldDeleteDirectory && workspace.role === "main") {
        return yield* workspaceError(
          "main-checkout-protected",
          "The main checkout can be unregistered, but it cannot be deleted by this action.",
          workspace.workspaceRoot,
        );
      }
      if (shouldDeleteDirectory && workspace.origin !== "awen-created") {
        return yield* workspaceError(
          "not-awen-created",
          "This Workspace was associated from disk; remove its registration without deleting the directory.",
          workspace.workspaceRoot,
        );
      }

      let mainWorkspace: AwenWorkspaceShell | undefined;
      if (shouldDeleteDirectory) {
        const project = yield* readAwenProject(workspace.projectId);
        mainWorkspace = yield* mainWorkspaceFor(project);
        yield* assertSameRepository(mainWorkspace.workspaceRoot, workspace.workspaceRoot);
        const exists = yield* fileSystem
          .exists(workspace.workspaceRoot)
          .pipe(
            Effect.mapError((cause) =>
              workspaceError(
                "git-failed",
                `Could not inspect Workspace '${workspace.workspaceRoot}'.`,
                workspace.workspaceRoot,
                cause,
              ),
            ),
          );
        if (exists) {
          const status = yield* git
            .statusDetails(workspace.workspaceRoot)
            .pipe(
              Effect.mapError((cause) =>
                workspaceError(
                  "git-failed",
                  `Could not inspect Workspace '${workspace.workspaceRoot}'.`,
                  workspace.workspaceRoot,
                  cause,
                ),
              ),
            );
          if (status.hasWorkingTreeChanges) {
            return yield* workspaceError(
              "dirty-worktree",
              `Workspace '${workspace.workspaceRoot}' has uncommitted or untracked changes.`,
              workspace.workspaceRoot,
            );
          }
        }
      }

      const commandId = yield* crypto.randomUUIDv4.pipe(
        Effect.map((uuid) => CommandId.make(`awen-workspace:remove:${uuid}`)),
      );
      yield* orchestrationEngine
        .dispatch({
          type: "project.delete",
          commandId,
          projectId: workspace.awenProjectId,
          force: false,
        })
        .pipe(
          Effect.mapError((cause) =>
            workspaceError(
              cause instanceof Error && cause.message.toLowerCase().includes("not empty")
                ? "workspace-not-empty"
                : "registration-failed",
              `Could not remove Workspace '${workspace.workspaceRoot}' from Awen.`,
              workspace.workspaceRoot,
              cause,
            ),
          ),
        );

      if (!shouldDeleteDirectory || mainWorkspace === undefined) {
        return { removed: true, deletedDirectory: false };
      }
      const deletion = yield* gitWorkflow
        .removeWorktree({ cwd: mainWorkspace.workspaceRoot, path: workspace.workspaceRoot })
        .pipe(Effect.result);
      if (Result.isFailure(deletion)) {
        yield* Effect.logWarning(
          "Workspace registration removed but Git directory cleanup failed",
          {
            workspaceRoot: workspace.workspaceRoot,
            cause: deletion.failure,
          },
        );
        return {
          removed: true,
          deletedDirectory: false,
          warning:
            "Workspace registration was removed, but the directory was kept because Git cleanup failed.",
        };
      }
      return { removed: true, deletedDirectory: true };
    }).pipe(
      Effect.catchCause((cause) => {
        const error = Cause.squash(cause);
        return Effect.fail(
          Schema.is(AwenWorkspaceError)(error)
            ? error
            : workspaceError(
                "git-failed",
                `Workspace operation failed for '${input.workspaceId}'.`,
                undefined,
                error,
              ),
        );
      }),
    );

  const rename: AwenWorkspaceService["Service"]["rename"] = (input) =>
    Effect.gen(function* () {
      const workspaceOption = yield* readWorkspace(input.workspaceId).pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "registration-failed",
            `Could not read Workspace '${input.workspaceId}'.`,
            undefined,
            cause,
          ),
        ),
      );
      if (Option.isNone(workspaceOption)) {
        return yield* workspaceError(
          "workspace-not-found",
          `Workspace '${input.workspaceId}' was not found.`,
        );
      }
      const uuid = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "registration-failed",
            "Could not prepare Workspace rename.",
            undefined,
            cause,
          ),
        ),
      );
      yield* orchestrationEngine
        .dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(`awen-workspace:rename:${uuid}`),
          projectId: workspaceOption.value.awenProjectId,
          title: input.title,
        })
        .pipe(
          Effect.mapError((cause) =>
            workspaceError(
              "registration-failed",
              `Could not rename Workspace '${input.workspaceId}'.`,
              workspaceOption.value.workspaceRoot,
              cause,
            ),
          ),
        );
      const updated = yield* readWorkspace(input.workspaceId).pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "registration-failed",
            `Could not read Workspace '${input.workspaceId}' after rename.`,
            workspaceOption.value.workspaceRoot,
            cause,
          ),
        ),
      );
      if (Option.isNone(updated)) {
        return yield* workspaceError(
          "workspace-not-found",
          `Workspace '${input.workspaceId}' disappeared after rename.`,
        );
      }
      return { workspace: updated.value };
    });

  const renameProject: AwenWorkspaceService["Service"]["renameProject"] = (input) =>
    Effect.gen(function* () {
      yield* readAwenProject(input.projectId);
      const updateTitle = projectionQuery.updateAwenProjectTitle;
      if (updateTitle === undefined) {
        return yield* workspaceError(
          "registration-failed",
          "Project rename is unavailable on this server.",
        );
      }
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      yield* updateTitle({
        awenProjectId: input.projectId,
        title: input.title,
        updatedAt,
      }).pipe(
        Effect.mapError((cause) =>
          workspaceError(
            "registration-failed",
            `Could not rename Awen Project '${input.projectId}'.`,
            undefined,
            cause,
          ),
        ),
      );
      return { project: yield* readAwenProject(input.projectId) };
    });

  return AwenWorkspaceService.of({
    register,
    associate,
    createWorktree,
    remove,
    rename,
    renameProject,
  });
});

export const layer = Layer.effect(AwenWorkspaceService, make);
