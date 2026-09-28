import type { ScopedThreadRef } from "@awen/contracts";
import { normalizeProjectPathForComparison } from "@awen/shared/path";
import { readAwenProjects } from "../state/entities";
import { findAgentSession } from "../state/agentSessionLookup";
import { useRightPanelStore } from "../rightPanelStore";
import { isAbsolutePath } from "../terminal-links";
import { findSessionViewPane } from "./workbenchState";
import { useWorkbenchStore } from "./workbenchStore";
import { isViewTarget, type ViewTarget } from "./viewCatalog";

/** Resolve Session-origin file navigation against its current Workspace assignment. */
export function openSessionFile(ref: ScopedThreadRef, path: string, line?: number): void {
  const projects = readAwenProjects();
  const session = findAgentSession(projects, ref.environmentId, ref.threadId);
  const workspace = projects
    .filter((project) => project.environmentId === ref.environmentId)
    .flatMap((project) => project.workspaces)
    .find((workspace) => workspace.id === session?.workspaceId);
  let withinWorkspace = !isAbsolutePath(path);
  let relativePath = path.replaceAll("\\", "/");
  if (workspace && isAbsolutePath(path)) {
    const root = normalizeProjectPathForComparison(workspace.workspaceRoot)
      .replaceAll("\\", "/")
      .replace(/\/$/, "");
    const normalized = normalizeProjectPathForComparison(path).replaceAll("\\", "/");
    if (normalized.startsWith(`${root}/`)) {
      relativePath = relativePath.slice(root.length + 1);
      withinWorkspace = true;
    }
  }
  relativePath = relativePath
    .split("/")
    .filter((part) => part !== "." && part !== "")
    .join("/");
  const target: ViewTarget | null =
    workspace && withinWorkspace && !path.startsWith("attachment:")
      ? {
          kind: "workspace",
          definitionId: "fileEditor",
          environmentId: ref.environmentId,
          workspaceId: workspace.id,
          initialPath: relativePath,
          ...(line === undefined ? {} : { revealLine: line }),
        }
      : null;
  if (!target || !isViewTarget(target)) {
    // Attachments and host files outside a Workspace retain their Session surface.
    useRightPanelStore.getState().openFile(ref, path, line);
    return;
  }
  const store = useWorkbenchStore.getState();
  const source = findSessionViewPane(store, {
    kind: "agentSession",
    environmentId: ref.environmentId,
    agentSessionId: ref.threadId,
  });
  if (source) store.openFromPane(source.paneId, target);
  else store.openTarget(target);
}
