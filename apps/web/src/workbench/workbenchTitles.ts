import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";

import type { ViewTarget } from "./viewRegistry";

type WorkspaceScopedTarget = Extract<
  ViewTarget,
  { kind: "workspace" | "agentSession" | "workspaceTerminal" }
>;

function workspaceFor(
  target: WorkspaceScopedTarget,
  projects: ReadonlyArray<EnvironmentAwenProject>,
) {
  return locationFor(target, projects)?.workspace ?? null;
}

function locationFor(
  target: WorkspaceScopedTarget,
  projects: ReadonlyArray<EnvironmentAwenProject>,
) {
  for (const project of projects) {
    if (project.environmentId !== target.environmentId) continue;
    if (target.kind === "agentSession") {
      const workspace = project.workspaces.find((candidate) =>
        [...(candidate.sessions ?? []), ...(candidate.historySessions ?? [])].some(
          (session) => session.kind === "agent" && session.id === target.agentSessionId,
        ),
      );
      if (workspace !== undefined) return { project, workspace };
      continue;
    }
    if (target.kind === "workspaceTerminal") {
      // Prefer the current assignment; otherwise locate the workspace that
      // still projects this terminal so its breadcrumb survives a move.
      const assigned =
        target.workspaceId === undefined
          ? undefined
          : project.workspaces.find((candidate) => candidate.id === target.workspaceId);
      const workspace =
        assigned ??
        project.workspaces.find((candidate) =>
          [...(candidate.sessions ?? []), ...(candidate.historySessions ?? [])].some(
            (session) => session.kind === "terminal" && session.id === target.terminalSessionId,
          ),
        );
      if (workspace !== undefined) return { project, workspace };
      continue;
    }
    const workspace = project.workspaces.find((candidate) => candidate.id === target.workspaceId);
    if (workspace !== undefined) return { project, workspace };
  }
  return null;
}

/** Resolve the Project, Workspace, and View title breadcrumb for a Pane target. */
export function resolveTargetBreadcrumbs(
  target: ViewTarget,
  projects: ReadonlyArray<EnvironmentAwenProject>,
): ReadonlyArray<string> {
  if (target.kind === "welcome") return ["Welcome"];
  if (target.kind === "project") {
    const project = projects.find(
      (candidate) =>
        candidate.environmentId === target.environmentId && candidate.id === target.projectId,
    );
    return [project?.title ?? "Project"];
  }

  const location = locationFor(target, projects);
  const projectTitle = location?.project.title ?? "Project";
  const workspaceTitle = location?.workspace.title ?? "Workspace";
  if (target.kind === "workspace") {
    if (target.definitionId === "fileView") return [projectTitle, workspaceTitle, "Files"];
    if (target.definitionId === "gitView") return [projectTitle, workspaceTitle, "Changes"];
    return [projectTitle, workspaceTitle];
  }
  return [projectTitle, workspaceTitle, resolveTargetTitle(target, projects)];
}

export function resolveTargetContext(
  target: ViewTarget,
  projects: ReadonlyArray<EnvironmentAwenProject>,
): string {
  if (target.kind === "welcome") return "Workbench";
  if (target.kind === "project") return "Project";
  return workspaceFor(target, projects)?.title ?? "Workspace";
}

export function fallbackTargetTitle(target: ViewTarget): string {
  switch (target.kind) {
    case "welcome":
      return "Welcome";
    case "project":
      return "Project";
    case "workspace":
      if (target.definitionId === "fileView") return "Files";
      if (target.definitionId === "gitView") return "Changes";
      return "Workspace";
    case "agentSession":
      return "Agent";
    case "workspaceTerminal":
      return "Terminal";
  }
}

/** Resolve a human title from the latest public projection, never from runtime identity. */
export function resolveTargetTitle(
  target: ViewTarget,
  projects: ReadonlyArray<EnvironmentAwenProject>,
): string {
  if (target.kind === "welcome") return "Welcome";
  if (target.kind === "project") {
    for (const project of projects) {
      if (project.environmentId === target.environmentId && project.id === target.projectId) {
        return project.title;
      }
    }
    return fallbackTargetTitle(target);
  }

  const workspace = workspaceFor(target, projects);
  if (workspace === null) {
    return fallbackTargetTitle(target);
  }

  switch (target.kind) {
    case "workspace":
      if (target.definitionId === "fileView") return `${workspace.title}: Files`;
      if (target.definitionId === "gitView") return `${workspace.title}: Changes`;
      return workspace.title;
    case "agentSession":
      return (
        [...(workspace.sessions ?? []), ...(workspace.historySessions ?? [])].find(
          (session) => session.kind === "agent" && session.id === target.agentSessionId,
        )?.title ?? "Agent"
      );
    case "workspaceTerminal":
      return (
        [...(workspace.sessions ?? []), ...(workspace.historySessions ?? [])].find(
          (session) => session.kind === "terminal" && session.id === target.terminalSessionId,
        )?.title ?? "Terminal"
      );
  }
}
