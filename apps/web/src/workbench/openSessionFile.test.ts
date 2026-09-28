import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, WorkspaceId, AwenProjectId, ProjectId } from "@awen/contracts";
import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import { openSessionFile } from "./openSessionFile";
import { getActiveTab } from "./workbenchState";
import { resetWorkbenchStore, useWorkbenchStore } from "./workbenchStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";

// Runtime projection is the trusted adapter seam; exercise real navigation/store.
const projection = vi.hoisted(() => ({ projects: [] as EnvironmentAwenProject[] }));
vi.mock("../state/entities", () => ({ readAwenProjects: () => projection.projects }));
const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("agent");
const workspaceId = WorkspaceId.make("workspace");
const projectId = AwenProjectId.make("project");
const ref = { environmentId, threadId };
const now = "2026-09-28T00:00:00Z";
beforeEach(() => {
  resetWorkbenchStore();
  projection.projects = [
    {
      id: projectId,
      environmentId,
      title: "Project",
      createdAt: now,
      updatedAt: now,
      workspaces: [
        {
          id: workspaceId,
          projectId,
          awenProjectId: ProjectId.make("runtime-project"),
          title: "Workspace",
          workspaceRoot: "/checkout",
          role: "main",
          createdAt: now,
          updatedAt: now,
          sessions: [
            {
              kind: "agent",
              id: threadId,
              threadId,
              workspaceId,
              title: "Agent",
              status: "open",
              createdAt: now,
              updatedAt: now,
            },
          ],
        },
      ],
    },
  ];
  useWorkbenchStore
    .getState()
    .openTarget({ kind: "agentSession", environmentId, agentSessionId: threadId });
});
it("opens absolute and relative Session file links in the same peer Pane and reveals the latest line", () => {
  const source = getActiveTab(useWorkbenchStore.getState()).focusedPaneId;
  openSessionFile(ref, "/checkout/src/main.ts", 12);
  const opened = getActiveTab(useWorkbenchStore.getState());
  const editor = opened.focusedPaneId;
  expect(opened.panes.size).toBe(2);
  expect(opened.panes.has(source)).toBe(true);
  expect(opened.panes.get(editor)?.target).toEqual({
    kind: "workspace",
    definitionId: "fileView",
    environmentId,
    workspaceId,
  });
  expect(opened.panes.get(editor)?.presentation.selectedPath).toBe("src/main.ts");
  useWorkbenchStore.getState().createTab();
  openSessionFile(ref, "./src/main.ts", 42);
  expect(getActiveTab(useWorkbenchStore.getState()).focusedPaneId).toBe(editor);
  expect(
    getActiveTab(useWorkbenchStore.getState()).panes.get(editor)?.presentation.revealLine,
  ).toBe(42);
});
it("opens diff files through the same Session navigation command", () => {
  openDiffFilePrimaryAction({
    threadRef: ref,
    filePath: "src/main.ts",
    activeCwd: "/checkout",
    openInEditor: () => {
      throw new Error("Should open a peer Pane");
    },
  });
  expect(getActiveTab(useWorkbenchStore.getState()).panes.size).toBe(2);
});
