import type { EnvironmentId, WorkspaceId } from "@awen/contracts";
import { terminalIdForSession, terminalSessionIdForTerminal } from "@awen/contracts";

import type { ViewTarget } from "./viewRegistry";

/**
 * The Workbench's Terminal Session target.
 *
 * The product-level identity is the stable Awen `terminalSessionId`. The
 * Workspace is a nullable, mutable assignment carried alongside for launch and
 * navigation, never for identity or reuse. The runtime PTY id is not part of
 * the target: it is the same string as the session id and the adapter below
 * resolves it.
 */
export type WorkspaceTerminalTarget = Extract<ViewTarget, { kind: "workspaceTerminal" }>;

/**
 * Adapter from a runtime terminal id to a Workbench target.
 *
 * The client chooses the runtime terminal id at creation; it is the stable
 * Awen identity, so no Workspace is required to derive the reference.
 */
export function terminalTargetForRuntime(input: {
  readonly environmentId: EnvironmentId;
  readonly terminalId: string;
  readonly workspaceId?: WorkspaceId;
}): WorkspaceTerminalTarget {
  return {
    kind: "workspaceTerminal",
    environmentId: input.environmentId,
    terminalSessionId: terminalSessionIdForTerminal(input.terminalId),
    ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
  };
}

/**
 * Adapter from a Workbench target back to the runtime terminal id that
 * attaches, writes, and resizes through the terminal RPC.
 */
export function runtimeTerminalIdForTarget(target: WorkspaceTerminalTarget): string {
  return terminalIdForSession({
    kind: "terminal",
    terminalSessionId: target.terminalSessionId,
  });
}
