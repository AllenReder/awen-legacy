import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  AgentSessionId,
  AwenProjectId,
  EventId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  TerminalSessionId,
  ThreadId,
  TrimmedNonEmptyString,
  WorkspaceId,
} from "./baseSchemas.ts";

/**
 * Where the checkout sits in the Project's repository. "main" is the
 * registered root checkout; "worktree" is an associated or Awen-created
 * linked worktree. Display state (branch, commit, detached HEAD) never feeds
 * this value.
 */
export const WorkspaceRole = Schema.Literals(["main", "worktree"]);
export type WorkspaceRole = typeof WorkspaceRole.Type;

/**
 * How a "worktree" Workspace came to exist. Awen only deletes directories it
 * created, so the delete-directory action is gated on "awen-created".
 * Absent on "main" Workspaces and on shells from servers predating the field.
 */
export const WorkspaceOrigin = Schema.Literals(["associated", "awen-created"]);
export type WorkspaceOrigin = typeof WorkspaceOrigin.Type;

/**
 * A durable Awen Session shell: the fields every Session kind exposes in the
 * Workspace projection. The kind discriminates the identity, and the runtime
 * binding for that kind stays on its own shell variant.
 */
export const AwenSessionLifecycleStatus = Schema.Literals(["open", "closed"]);
export type AwenSessionLifecycleStatus = typeof AwenSessionLifecycleStatus.Type;

const AwenSessionShellFields = {
  workspaceId: WorkspaceId,
  title: TrimmedNonEmptyString,
  status: Schema.optional(AwenSessionLifecycleStatus).pipe(
    Schema.withDecodingDefault(Effect.succeed("open" as const)),
  ),
  closedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
};

/** The durable Awen identity and Awen conversation binding shown in a Workspace. */
export const AwenAgentSessionShell = Schema.Struct({
  /**
   * Agent was the only Session kind before the shared contract, so shells from
   * a server that predates this discriminant decode as Agent instead of
   * failing the whole snapshot. New encodings always carry the key.
   */
  kind: Schema.Literal("agent").pipe(Schema.withDecodingDefault(Effect.succeed("agent"))),
  id: AgentSessionId,
  ...AwenSessionShellFields,
  threadId: ThreadId,
});
export type AwenAgentSessionShell = typeof AwenAgentSessionShell.Type;

/**
 * A durable Awen Terminal Session shell. Its identity is independent of the
 * PTY process currently backing it; the runtime terminal id stays behind the
 * Terminal Session adapter.
 */
export const AwenTerminalSessionShell = Schema.Struct({
  kind: Schema.Literal("terminal"),
  id: TerminalSessionId,
  ...AwenSessionShellFields,
});
export type AwenTerminalSessionShell = typeof AwenTerminalSessionShell.Type;

/** The shared durable Session contract projected under a Workspace. */
export const AwenSessionShell = Schema.Union([AwenAgentSessionShell, AwenTerminalSessionShell]);
export type AwenSessionShell = typeof AwenSessionShell.Type;

/** Narrow a projected Session shell to the Agent kind. */
const isAwenAgentSessionShell = Schema.is(AwenAgentSessionShell);

/**
 * The Agent Session shells of one Workspace projection.
 *
 * Operates on *decoded* shells. `Schema.is` does not honour the Agent shell's
 * `kind` decoding default, so a raw pre-discriminant payload that never went
 * through `AwenProjectShell` decoding is not recognized and yields no Agent
 * Sessions. Every caller reads its Workspace from a decoded snapshot.
 */
export function agentSessionsIn(workspace: {
  readonly sessions?: ReadonlyArray<AwenSessionShell> | undefined;
  readonly historySessions?: ReadonlyArray<AwenSessionShell> | undefined;
}): ReadonlyArray<AwenAgentSessionShell> {
  return [...(workspace.sessions ?? []), ...(workspace.historySessions ?? [])].filter(
    isAwenAgentSessionShell,
  );
}

export function activeAgentSessionsIn(workspace: {
  readonly sessions?: ReadonlyArray<AwenSessionShell> | undefined;
}): ReadonlyArray<AwenAgentSessionShell> {
  return (workspace.sessions ?? []).filter(isAwenAgentSessionShell);
}

export function historyAgentSessionsIn(workspace: {
  readonly historySessions?: ReadonlyArray<AwenSessionShell> | undefined;
}): ReadonlyArray<AwenAgentSessionShell> {
  return (workspace.historySessions ?? []).filter(isAwenAgentSessionShell);
}

/** A stable checkout owned by one Awen Project. */
export const AwenWorkspaceShell = Schema.Struct({
  id: WorkspaceId,
  projectId: AwenProjectId,
  /** The Awen orchestration project that owns the execution directory. */
  awenProjectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  role: WorkspaceRole,
  /** Only set for "worktree" Workspaces; absent on "main". */
  origin: Schema.optional(WorkspaceOrigin),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /**
   * Sessions of every kind. Decoded with `ForwardCompatibleArray` so a server
   * that adds a Session kind this build does not know drops that one element
   * instead of failing the whole Workspace snapshot. The transcript and
   * execution state remain on the Awen thread shell.
   */
  sessions: Schema.optional(ForwardCompatibleArray(AwenSessionShell)),
  historySessions: Schema.optional(ForwardCompatibleArray(AwenSessionShell)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AwenWorkspaceShell = typeof AwenWorkspaceShell.Type;

/** A navigation Project grouping one or more Awen Workspaces. */
export const AwenProjectShell = Schema.Struct({
  id: AwenProjectId,
  title: TrimmedNonEmptyString,
  workspaces: Schema.Array(AwenWorkspaceShell),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AwenProjectShell = typeof AwenProjectShell.Type;

/** Product Project identity for a newly registered directory. */
export function awenProjectIdForAwenProject(projectId: ProjectId): AwenProjectId {
  return AwenProjectId.make(`awen-project:${projectId}`);
}

/** Workspace address derived from the canonical directory record identity. */
export function workspaceIdForAwenProject(projectId: ProjectId): WorkspaceId {
  return WorkspaceId.make(`workspace:${projectId}`);
}

/** Stable Awen identity derived from the creation event, not the thread id. */
export function agentSessionIdForThreadCreatedEvent(eventId: EventId): AgentSessionId {
  return AgentSessionId.make(`agent-session:${eventId}`);
}

// --- Workspace management RPC (awenWorkspace.*) ---

/** Register a directory or checkout, reusing its Workspace when already known. */
export const AwenWorkspaceRegisterInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
  createIfMissing: Schema.optional(Schema.Boolean),
});
export type AwenWorkspaceRegisterInput = typeof AwenWorkspaceRegisterInput.Type;

export const AwenWorkspaceRegisterResult = Schema.Struct({
  workspace: AwenWorkspaceShell,
  reused: Schema.Boolean,
});
export type AwenWorkspaceRegisterResult = typeof AwenWorkspaceRegisterResult.Type;

/** Attach an existing on-disk checkout as a sibling Workspace of the Project. */
export const AwenWorkspaceAssociateInput = Schema.Struct({
  projectId: AwenProjectId,
  /** Directory of the checkout to associate. Subdirectories resolve to the checkout root. */
  path: TrimmedNonEmptyString,
  title: Schema.optional(TrimmedNonEmptyString),
});
export type AwenWorkspaceAssociateInput = typeof AwenWorkspaceAssociateInput.Type;

export const AwenWorkspaceAssociateResult = Schema.Struct({
  workspace: AwenWorkspaceShell,
  /** True when the checkout was already registered under this Project and nothing changed. */
  reused: Schema.Boolean,
});
export type AwenWorkspaceAssociateResult = typeof AwenWorkspaceAssociateResult.Type;

/** Create a Git worktree from the Project's repository and register it as a Workspace. */
export const AwenWorkspaceCreateWorktreeInput = Schema.Struct({
  projectId: AwenProjectId,
  /** Create and check out this new branch. Omit to detach at `baseRef`. */
  newBranch: Schema.optional(TrimmedNonEmptyString),
  /** Branch, tag, or commit the worktree starts from. Defaults to HEAD. */
  baseRef: Schema.optional(TrimmedNonEmptyString),
  /** Explicit destination directory. Defaults to the daemon-managed worktrees directory. */
  path: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
});
export type AwenWorkspaceCreateWorktreeInput = typeof AwenWorkspaceCreateWorktreeInput.Type;

export const AwenWorkspaceCreateWorktreeResult = Schema.Struct({
  workspace: AwenWorkspaceShell,
  worktreePath: TrimmedNonEmptyString,
  /**
   * False when the directory already held a completed worktree of the same
   * repository, so a retried request registers it instead of failing.
   */
  worktreeCreated: Schema.Boolean,
});
export type AwenWorkspaceCreateWorktreeResult = typeof AwenWorkspaceCreateWorktreeResult.Type;

export const AwenWorkspaceRemoveInput = Schema.Struct({
  workspaceId: WorkspaceId,
  /**
   * Also delete the directory from disk. Only honored for "worktree"
   * Workspaces with origin "awen-created"; the main checkout is never
   * deleted through this action.
   */
  deleteDirectory: Schema.optional(Schema.Boolean),
});
export type AwenWorkspaceRemoveInput = typeof AwenWorkspaceRemoveInput.Type;

export const AwenWorkspaceRemoveResult = Schema.Struct({
  /** False when the Workspace was already unregistered; removal is idempotent. */
  removed: Schema.Boolean,
  deletedDirectory: Schema.Boolean,
  /** Present when registration was removed but the requested directory cleanup was not. */
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type AwenWorkspaceRemoveResult = typeof AwenWorkspaceRemoveResult.Type;

export const AwenWorkspaceRenameInput = Schema.Struct({
  workspaceId: WorkspaceId,
  title: TrimmedNonEmptyString,
});
export type AwenWorkspaceRenameInput = typeof AwenWorkspaceRenameInput.Type;

export const AwenWorkspaceRenameResult = Schema.Struct({
  workspace: AwenWorkspaceShell,
});
export type AwenWorkspaceRenameResult = typeof AwenWorkspaceRenameResult.Type;

export const AwenProjectRenameInput = Schema.Struct({
  projectId: AwenProjectId,
  title: TrimmedNonEmptyString,
});
export type AwenProjectRenameInput = typeof AwenProjectRenameInput.Type;

export const AwenProjectRenameResult = Schema.Struct({
  project: AwenProjectShell,
});
export type AwenProjectRenameResult = typeof AwenProjectRenameResult.Type;

export const AwenWorkspaceErrorReason = Schema.Literals([
  /** The target Awen Project does not exist (or has no checkout to anchor on). */
  "project-not-found",
  /** The associate path does not exist or is not a directory. */
  "path-not-found",
  /** The associate path is not inside a Git working tree. */
  "not-a-repository",
  /** The checkout belongs to a different repository than the Project. */
  "different-repository",
  /** The checkout is already registered under another Project. */
  "already-registered",
  /** The target path exists, is reserved, or nests inside a registered checkout. */
  "path-conflict",
  /** The requested new branch name is invalid or already exists. */
  "branch-exists",
  /** The base ref does not resolve to a commit. */
  "invalid-ref",
  /** Directory deletion was requested for the main checkout. */
  "main-checkout-protected",
  /** Directory deletion was requested for a checkout Awen did not create. */
  "not-awen-created",
  /** Directory deletion was refused because the worktree has uncommitted or untracked files. */
  "dirty-worktree",
  /** Registration removal was refused because the Workspace still owns Sessions. */
  "workspace-not-empty",
  /** The requested Workspace identity does not exist on this server. */
  "workspace-not-found",
  /** The requested Awen Project identity does not exist on this server. */
  "awen-project-not-found",
  /** The underlying Git operation failed; the directory state is unchanged. */
  "git-failed",
  /** The worktree was created on disk but Workspace registration failed. The directory was kept. */
  "registration-failed",
]);
export type AwenWorkspaceErrorReason = typeof AwenWorkspaceErrorReason.Type;

export class AwenWorkspaceError extends Schema.TaggedError<AwenWorkspaceError>()(
  "AwenWorkspaceError",
  {
    reason: AwenWorkspaceErrorReason,
    detail: Schema.String,
    /** The on-disk path involved, when one exists (e.g. the kept worktree after a registration failure). */
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
