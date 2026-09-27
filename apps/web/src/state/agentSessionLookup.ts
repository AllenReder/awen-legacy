import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import {
  agentSessionsIn,
  type AgentSessionId,
  type AwenAgentSessionShell,
  type EnvironmentId,
} from "@awen/contracts";

/** Resolve a durable Agent Session across its mutable Workspace assignment. */
export function findAgentSession(
  projects: ReadonlyArray<EnvironmentAwenProject>,
  environmentId: EnvironmentId,
  sessionId: AgentSessionId,
): AwenAgentSessionShell | null {
  for (const project of projects) {
    if (project.environmentId !== environmentId) continue;
    for (const workspace of project.workspaces) {
      const session = agentSessionsIn(workspace).find((candidate) => candidate.id === sessionId);
      if (session !== undefined) return session;
    }
  }
  return null;
}
