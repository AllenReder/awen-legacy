import * as Schema from "effect/Schema";

import {
  AgentSessionId,
  IsoDateTime,
  ProjectId,
  TerminalSessionId,
  TrimmedNonEmptyString,
  WorkspaceId,
} from "./baseSchemas.ts";
import type { AwenSessionShell } from "./workspace.ts";

/** The stable Awen work units shown below a Workspace in the Sidebar. */
export const SessionKind = Schema.Literals(["agent", "terminal"]);
export type SessionKind = typeof SessionKind.Type;

/**
 * A durable Agent Session is the Awen Thread. The Workspace describes its
 * current assignment and may change without changing this identity.
 */
export const AgentSessionRef = Schema.Struct({
  kind: Schema.Literal("agent"),
  agentSessionId: AgentSessionId,
});
export type AgentSessionRef = typeof AgentSessionRef.Type;

/**
 * A durable Awen Terminal Session identity.
 *
 * The reference carries only the stable identity. Its Workspace assignment is
 * nullable and mutable, so it is deliberately absent here: a Terminal Session
 * can be opened, attached, streamed, and deep-linked whether or not a Workspace
 * still exists for it.
 */
export const TerminalSessionRef = Schema.Struct({
  kind: Schema.Literal("terminal"),
  terminalSessionId: TerminalSessionId,
});
export type TerminalSessionRef = typeof TerminalSessionRef.Type;

/**
 * The shared Session contract addresses each Session by stable identity.
 *
 * Provider runtime sessions and PTYs are never part of this reference.
 */
export const SessionRef = Schema.Union([AgentSessionRef, TerminalSessionRef]);
export type SessionRef = typeof SessionRef.Type;

/**
 * The Awen Terminal Session identity for the runtime terminal id chosen by the
 * client. The id is stable across PTY restarts and Workspace reassignment; the
 * runtime binds its PTY and history to it directly, so no Workspace is folded
 * into the identity.
 */
export function terminalSessionIdForTerminal(terminalId: string): TerminalSessionId {
  return TerminalSessionId.make(terminalId);
}

/** Adapter from the runtime terminal id to the canonical Awen reference. */
export function terminalSessionRefForTerminal(input: {
  readonly terminalId: string;
}): TerminalSessionRef {
  return {
    kind: "terminal",
    terminalSessionId: terminalSessionIdForTerminal(input.terminalId),
  };
}

/** Resolve the runtime terminal id behind an Awen Terminal Session reference. */
export function terminalIdForSession(ref: TerminalSessionRef): string {
  return ref.terminalSessionId;
}

/** Adapter from a Workspace Terminal Session shell to its canonical reference. */
export function terminalSessionRefForShell(shell: {
  readonly id: TerminalSessionId;
}): TerminalSessionRef {
  return { kind: "terminal", terminalSessionId: shell.id };
}

/**
 * Adapter from a durable Agent Session shell to its canonical reference,
 * omitting its mutable Workspace assignment.
 */
export function agentSessionRefForShell(shell: { readonly id: AgentSessionId }): AgentSessionRef {
  return { kind: "agent", agentSessionId: shell.id };
}

/**
 * Adapter from any durable Session shell to the shared Session reference.
 *
 * It narrows on the shell's `kind`, so the shared contract stays the single
 * source of Session identity and no caller has to re-derive it.
 */
export function sessionRefForShell(shell: AwenSessionShell): SessionRef {
  return shell.kind === "agent"
    ? agentSessionRefForShell(shell)
    : terminalSessionRefForShell(shell);
}

// --- Agent Session Workspace migration (awenSession.*) ---

/**
 * A migration that moved the provider execution context but failed to publish
 * the committed Workspace assignment. The Session keeps its last committed
 * assignment, further sends stay blocked, and the provider must be verified or
 * restored against that assignment before work continues.
 */
export const AgentSessionMigrationRecovery = Schema.Struct({
  agentSessionId: AgentSessionId,
  /** The Workspace the failed migration intended to reach. */
  intendedWorkspaceId: WorkspaceId,
  intendedProjectId: ProjectId,
  intendedCwd: TrimmedNonEmptyString,
  /** The assignment that remains committed while recovery is pending. */
  committedProjectId: ProjectId,
  committedCwd: Schema.optional(TrimmedNonEmptyString),
  /** True when the provider runtime was observed at the intended cwd. */
  providerMoved: Schema.Boolean,
  detail: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentSessionMigrationRecovery = typeof AgentSessionMigrationRecovery.Type;

/** Move an idle Agent Session to another Workspace of the same Project. */
export const AgentSessionMigrateToWorkspaceInput = Schema.Struct({
  agentSessionId: AgentSessionId,
  /** Registered target Workspace identity. */
  targetWorkspaceId: Schema.optional(WorkspaceId),
  /**
   * Candidate execution directory. The server resolves it to a sibling
   * Workspace of the Session's Project, associating an unregistered checkout as
   * a Workspace when needed. Exactly one of `targetWorkspaceId` / `targetPath`
   * must be supplied; the service rejects a request that names neither.
   */
  targetPath: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionMigrateToWorkspaceInput = typeof AgentSessionMigrateToWorkspaceInput.Type;

export const AgentSessionMigrateToWorkspaceResult = Schema.Struct({
  agentSessionId: AgentSessionId,
  /** The Workspace the Session is assigned to after the migration. */
  workspaceId: WorkspaceId,
  /** True when the provider runtime was restarted into the target directory. */
  providerMoved: Schema.Boolean,
  /** The provider execution directory observed after the migration. */
  providerCwd: Schema.optional(TrimmedNonEmptyString),
});
export type AgentSessionMigrateToWorkspaceResult = typeof AgentSessionMigrateToWorkspaceResult.Type;

/** Ref selection is a Session operation; the server resolves checkout versus migration. */
export const AgentSessionSelectRefInput = Schema.Struct({
  agentSessionId: AgentSessionId,
  expectedWorkspaceId: WorkspaceId,
  refName: TrimmedNonEmptyString,
  create: Schema.Boolean,
});
export type AgentSessionSelectRefInput = typeof AgentSessionSelectRefInput.Type;

export const AgentSessionSelectRefResult = Schema.Struct({
  workspaceId: WorkspaceId,
  refName: Schema.NullOr(TrimmedNonEmptyString),
});
export type AgentSessionSelectRefResult = typeof AgentSessionSelectRefResult.Type;

export const AgentSessionMigrationStateInput = Schema.Struct({
  agentSessionId: AgentSessionId,
});
export type AgentSessionMigrationStateInput = typeof AgentSessionMigrationStateInput.Type;

export const AgentSessionMigrationStateResult = Schema.Struct({
  recovery: Schema.NullOr(AgentSessionMigrationRecovery),
});
export type AgentSessionMigrationStateResult = typeof AgentSessionMigrationStateResult.Type;

export const AgentSessionOperationErrorReason = Schema.Literals([
  /** The Agent Session identity does not exist on this server. */
  "session-not-found",
  "assignment-changed",
  /** The target Workspace identity does not exist on this server. */
  "workspace-not-found",
  /** The target Workspace does not belong to the Session's Awen Project. */
  "different-project",
  /** The Session is already assigned to the target Workspace. */
  "already-in-workspace",
  /** The Agent is executing or starting a turn; migration is refused, not queued. */
  "session-executing",
  /** Archived Sessions cannot be migrated until they are restored. */
  "session-archived",
  /** A previous interrupted migration must be verified or recovered first. */
  "migration-recovery-required",
  /** The provider cannot preserve the conversation at the candidate directory. */
  "provider-resume-unsupported",
  /** The provider runtime failed to restart into the candidate directory. */
  "provider-move-failed",
  /** The provider moved, but publishing the committed assignment failed. */
  "assignment-commit-failed",
  /** An unexpected persistence/provider failure escaped the operation. */
  "operation-failed",
  /** The target Workspace directory is missing or is not a directory. */
  "target-directory-missing",
]);
export type AgentSessionOperationErrorReason = typeof AgentSessionOperationErrorReason.Type;

export class AgentSessionOperationError extends Schema.TaggedError<AgentSessionOperationError>()(
  "AgentSessionOperationError",
  {
    reason: AgentSessionOperationErrorReason,
    detail: Schema.String,
    agentSessionId: Schema.optional(AgentSessionId),
    workspaceId: Schema.optional(WorkspaceId),
    /** Present for a recoverable failure; clients can surface it and poll state. */
    recovery: Schema.optional(AgentSessionMigrationRecovery),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
