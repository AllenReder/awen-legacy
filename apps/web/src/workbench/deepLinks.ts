import {
  type EnvironmentId,
  type TerminalSessionId,
  type TerminalSummary,
  type ThreadId,
  WorkspaceId,
} from "@awen/contracts";
import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import { findAgentSession } from "../state/agentSessionLookup";

import type { ViewTarget } from "./viewRegistry";

export type SessionTarget = Extract<ViewTarget, { kind: "agentSession" | "workspaceTerminal" }>;
export type SessionRoutePath =
  | "/$environmentId/$threadId"
  | "/$environmentId/terminal-sessions/$terminalSessionId";

export interface SessionRouteLocation {
  readonly to: SessionRoutePath;
  readonly params: Readonly<Record<string, string>>;
}

export type DeepLinkRouteInput =
  | {
      readonly kind: "agentSession";
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
    }
  | {
      readonly kind: "workspaceTerminal";
      readonly environmentId: EnvironmentId;
      readonly terminalSessionId: TerminalSessionId;
      /** Current assignment, resolved from the projection when it exists. */
      readonly workspaceId?: WorkspaceId;
    };

export type DeepLinkResolution =
  | { readonly state: "idle" }
  | { readonly state: "pending" }
  | {
      readonly state: "ready";
      readonly target: SessionTarget;
      readonly canonicalRoute: SessionRouteLocation;
    }
  | {
      readonly state: "missing";
      readonly reason: "environment" | "session";
    };

export interface DeepLinkEnvironmentState {
  readonly catalogReady: boolean;
  readonly environmentExists: boolean;
  readonly environmentEnabled: boolean;
  readonly environmentSnapshotPresent: boolean;
}

export function sessionRouteForTarget(target: SessionTarget): SessionRouteLocation {
  if (target.kind === "agentSession") {
    return {
      to: "/$environmentId/$threadId",
      params: {
        environmentId: target.environmentId,
        threadId: target.agentSessionId,
      },
    };
  }
  return {
    to: "/$environmentId/terminal-sessions/$terminalSessionId",
    params: {
      environmentId: target.environmentId,
      terminalSessionId: target.terminalSessionId,
    },
  };
}

export function deepLinkInputFromParams(
  params: Partial<
    Record<"environmentId" | "workspaceId" | "terminalSessionId" | "threadId", string | undefined>
  >,
): DeepLinkRouteInput | null {
  if (params.environmentId === undefined) return null;
  const environmentId = params.environmentId as EnvironmentId;

  if (
    params.terminalSessionId !== undefined &&
    params.threadId === undefined &&
    params.workspaceId === undefined
  ) {
    return {
      kind: "workspaceTerminal",
      environmentId,
      terminalSessionId: params.terminalSessionId as TerminalSessionId,
    };
  }

  if (
    params.workspaceId === undefined &&
    params.terminalSessionId === undefined &&
    params.threadId !== undefined
  ) {
    return {
      kind: "agentSession",
      environmentId,
      threadId: params.threadId as ThreadId,
    };
  }

  return null;
}

function pendingEnvironment(environment: DeepLinkEnvironmentState): DeepLinkResolution | null {
  if (!environment.catalogReady) return { state: "pending" };
  if (!environment.environmentExists || !environment.environmentEnabled) {
    return { state: "missing", reason: "environment" };
  }
  if (!environment.environmentSnapshotPresent) return { state: "pending" };
  return null;
}

/** The Workspace whose projection currently carries this Terminal Session. */
function workspaceProjectingTerminal(
  projects: ReadonlyArray<EnvironmentAwenProject>,
  environmentId: EnvironmentId,
  terminalSessionId: TerminalSessionId,
): { readonly workspaceId: WorkspaceId } | null {
  for (const project of projects) {
    if (project.environmentId !== environmentId) continue;
    for (const workspace of project.workspaces) {
      const sessions = [...(workspace.sessions ?? []), ...(workspace.historySessions ?? [])];
      if (
        sessions.some((session) => session.kind === "terminal" && session.id === terminalSessionId)
      ) {
        return { workspaceId: workspace.id };
      }
    }
  }
  return null;
}

export function resolveDeepLink(
  input: DeepLinkRouteInput | null,
  projects: ReadonlyArray<EnvironmentAwenProject>,
  environment: DeepLinkEnvironmentState,
  terminals: ReadonlyArray<TerminalSummary>,
): DeepLinkResolution {
  if (input === null) return { state: "idle" };

  const pending = pendingEnvironment(environment);
  if (pending !== null) return pending;

  if (input.kind === "agentSession") {
    const session = findAgentSession(projects, input.environmentId, input.threadId);
    if (session === null) return { state: "missing", reason: "session" };
    const target: SessionTarget = {
      kind: "agentSession",
      environmentId: input.environmentId,
      agentSessionId: session.id,
    };
    return {
      state: "ready",
      target,
      canonicalRoute: sessionRouteForTarget(target),
    };
  }

  // The terminal metadata stream is authoritative and includes unassigned
  // terminals; the Workspace projection is a fallback while metadata loads.
  const summary =
    terminals.find((terminal) => terminal.sessionId === input.terminalSessionId) ?? null;
  const projected = workspaceProjectingTerminal(
    projects,
    input.environmentId,
    input.terminalSessionId,
  );
  if (summary === null && projected === null) return { state: "missing", reason: "session" };
  const workspaceId =
    summary?.workspaceId !== undefined
      ? WorkspaceId.make(summary.workspaceId)
      : projected?.workspaceId;
  const target: SessionTarget = {
    kind: "workspaceTerminal",
    environmentId: input.environmentId,
    terminalSessionId: input.terminalSessionId,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
  };
  return {
    state: "ready",
    target,
    canonicalRoute: sessionRouteForTarget(target),
  };
}
