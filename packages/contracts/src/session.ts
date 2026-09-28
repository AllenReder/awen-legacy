import * as Schema from "effect/Schema";

import { AgentSessionId, TerminalSessionId } from "./baseSchemas.ts";
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
