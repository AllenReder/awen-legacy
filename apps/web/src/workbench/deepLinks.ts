import {
  type EnvironmentId,
  type TerminalSessionId,
  type ThreadId,
  type WorkspaceId,
} from "@awen/contracts";
import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import { findAgentSession } from "../state/agentSessionLookup";

import type { ViewTarget } from "./viewRegistry";

export type SessionTarget = Extract<ViewTarget, { kind: "agentSession" | "workspaceTerminal" }>;
export type SessionRoutePath =
  | "/$environmentId/$threadId"
  | "/$environmentId/workspaces/$workspaceId/terminal-sessions/$terminalSessionId";

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
      readonly workspaceId: WorkspaceId;
      readonly terminalSessionId: TerminalSessionId;
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
      readonly reason: "environment" | "workspace" | "session";
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
    to: "/$environmentId/workspaces/$workspaceId/terminal-sessions/$terminalSessionId",
    params: {
      environmentId: target.environmentId,
      workspaceId: target.workspaceId,
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
    params.workspaceId !== undefined &&
    params.terminalSessionId !== undefined &&
    params.threadId === undefined
  ) {
    return {
      kind: "workspaceTerminal",
      environmentId,
      workspaceId: params.workspaceId as WorkspaceId,
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

function workspaceFor(
  projects: ReadonlyArray<EnvironmentAwenProject>,
  environmentId: EnvironmentId,
  workspaceId: WorkspaceId,
) {
  for (const project of projects) {
    if (project.environmentId !== environmentId) continue;
    const workspace = project.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace !== undefined) return workspace;
  }
  return null;
}

export function resolveDeepLink(
  input: DeepLinkRouteInput | null,
  projects: ReadonlyArray<EnvironmentAwenProject>,
  environment: DeepLinkEnvironmentState,
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

  const workspace = workspaceFor(projects, input.environmentId, input.workspaceId);
  if (workspace === null) return { state: "missing", reason: "workspace" };
  const terminalExists = [...(workspace.sessions ?? []), ...(workspace.historySessions ?? [])].some(
    (session) => session.kind === "terminal" && session.id === input.terminalSessionId,
  );
  if (!terminalExists) return { state: "missing", reason: "session" };
  return {
    state: "ready",
    target: input,
    canonicalRoute: sessionRouteForTarget(input),
  };
}
