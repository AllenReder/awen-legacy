import { workspaceIdForAwenProject } from "@awen/contracts";
import type { ProjectId, EnvironmentId } from "@awen/contracts";
import type { EnvironmentAwenProject } from "./models.ts";

/** Resolve assignment as a whole. Draft paths and Git branches are never ownership. */
export function resolveSessionWorkspace(
  projects: ReadonlyArray<EnvironmentAwenProject>,
  assignment: { readonly environmentId: EnvironmentId; readonly projectId: ProjectId } | null,
) {
  if (assignment === null) return null;
  const workspaceId = workspaceIdForAwenProject(assignment.projectId);
  for (const project of projects) {
    if (project.environmentId !== assignment.environmentId) continue;
    const workspace = project.workspaces.find((candidate) => candidate.id === workspaceId);
    if (workspace) return workspace;
  }
  return null;
}
