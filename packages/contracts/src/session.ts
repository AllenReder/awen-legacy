import * as Schema from "effect/Schema";

import { AgentSessionId, TerminalSessionId, WorkspaceId } from "./baseSchemas.ts";
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

/** A durable Awen Terminal Session identity scoped to its owning Workspace. */
export const TerminalSessionRef = Schema.Struct({
  kind: Schema.Literal("terminal"),
  workspaceId: WorkspaceId,
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
 * Awen identity for the terminal currently known to the runtime as
 * `(workspaceId, terminalId)`.
 *
 * The runtime terminal id is only unique inside its Workspace, so the Awen
 * identity embeds the Workspace id and keeps the runtime id as an opaque
 * suffix. The Workspace id is length-prefixed so the two halves stay
 * unambiguous even when either id itself contains ":" — without it,
 * `("a:b", "c")` and `("a", "b:c")` would collide on one Awen identity.
 *
 * New Workspace terminals allocate a UUID once per creation request. The
 * runtime persists that id across process generations; old term-N identities
 * remain readable through the same adapter.
 */
const TERMINAL_SESSION_ID_PREFIX = "terminal-session:";

function runtimeTerminalIdPrefix(workspaceId: WorkspaceId): string {
  return `${TERMINAL_SESSION_ID_PREFIX}${workspaceId.length}:${workspaceId}:`;
}

/** Stable Awen Terminal Session identity for a runtime `(workspaceId, terminalId)` pair. */
export function terminalSessionIdForRuntime(
  workspaceId: WorkspaceId,
  terminalId: string,
): TerminalSessionId {
  return TerminalSessionId.make(`${runtimeTerminalIdPrefix(workspaceId)}${terminalId}`);
}

/**
 * Adapter from the existing terminal runtime identity to the canonical Awen
 * Terminal Session reference. Existing terminal flows keep sending
 * `(workspaceId, terminalId)`; only the adapter boundary sees that pair.
 */
export function terminalSessionRefForRuntime(input: {
  readonly workspaceId: WorkspaceId;
  readonly terminalId: string;
}): TerminalSessionRef {
  return {
    kind: "terminal",
    workspaceId: input.workspaceId,
    terminalSessionId: terminalSessionIdForRuntime(input.workspaceId, input.terminalId),
  };
}

/** Adapter from a Workspace Terminal Session shell to its canonical reference. */
export function terminalSessionRefForShell(shell: {
  readonly id: TerminalSessionId;
  readonly workspaceId: WorkspaceId;
}): TerminalSessionRef {
  return { kind: "terminal", workspaceId: shell.workspaceId, terminalSessionId: shell.id };
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

/**
 * Resolve the runtime terminal id behind an Awen Terminal Session reference.
 *
 * Returns null for an identity this adapter did not produce, so callers must
 * treat a null as "no runtime binding" instead of guessing at the wire id.
 */
export function runtimeTerminalIdForSession(ref: TerminalSessionRef): string | null {
  const prefix = runtimeTerminalIdPrefix(ref.workspaceId);
  if (!ref.terminalSessionId.startsWith(prefix)) return null;
  const terminalId = ref.terminalSessionId.slice(prefix.length);
  return terminalId.length === 0 ? null : terminalId;
}
