import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@awen/contracts";
import { resolveSessionWorkspace } from "@awen/client-runtime/state/sessionContext";
import { useAwenProjects, useThreadShell } from "./entities";

/** Committed execution context. A missing snapshot is pending, never a draft fallback. */
export function useSessionExecutionContext(
  ref: ScopedThreadRef | null,
  proposedAssignment?: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  } | null,
) {
  const thread = useThreadShell(ref);
  const projects = useAwenProjects();
  const workspace = resolveSessionWorkspace(projects, thread ?? proposedAssignment ?? null);
  return {
    thread,
    workspace,
    cwd: workspace?.workspaceRoot ?? null,
    worktreePath: workspace?.role === "worktree" ? workspace.workspaceRoot : null,
  };
}
