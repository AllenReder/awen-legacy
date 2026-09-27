import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import { AgentSessionId, EnvironmentId, WorkspaceId } from "@awen/contracts";

import { useWorkspaceViewActions } from "./useWorkspaceViewActions";
import { useWorkbenchStore, resetWorkbenchStore } from "./workbenchStore";

describe("useWorkspaceViewActions", () => {
  it("splits workspace file view to the right of the given pane", () => {
    resetWorkbenchStore();
    const envId = "env-1" as EnvironmentId;
    const wsId = "ws-1" as WorkspaceId;
    const initial = {
      kind: "agentSession" as const,
      environmentId: envId,
      agentSessionId: AgentSessionId.make("agent-1"),
    };
    useWorkbenchStore.getState().openTarget(initial);
    const sourcePaneId = useWorkbenchStore.getState().tabs[0]!.focusedPaneId;

    let actions!: ReturnType<typeof useWorkspaceViewActions>;
    function Probe() {
      actions = useWorkspaceViewActions({
        environmentId: envId,
        workspaceId: wsId,
        paneId: sourcePaneId,
      });
      return null;
    }

    act(() => {
      create(<Probe />);
    });

    act(() => {
      actions.onBrowseFiles();
    });

    const tab = useWorkbenchStore.getState().tabs[0]!;
    expect(tab.panes.size).toBe(2);
    const newPaneId = tab.focusedPaneId;
    expect(tab.panes.get(newPaneId)?.target).toEqual({
      kind: "workspace",
      definitionId: "fileView",
      environmentId: envId,
      workspaceId: wsId,
    });
  });
  it("splits workspace git view to the right of the given pane", () => {
    resetWorkbenchStore();
    const envId = "env-1" as EnvironmentId;
    const wsId = "ws-1" as WorkspaceId;
    const initial = {
      kind: "agentSession" as const,
      environmentId: envId,
      agentSessionId: AgentSessionId.make("agent-1"),
    };
    useWorkbenchStore.getState().openTarget(initial);
    const sourcePaneId = useWorkbenchStore.getState().tabs[0]!.focusedPaneId;

    let actions!: ReturnType<typeof useWorkspaceViewActions>;
    function Probe() {
      actions = useWorkspaceViewActions({
        environmentId: envId,
        workspaceId: wsId,
        paneId: sourcePaneId,
      });
      return null;
    }

    act(() => {
      create(<Probe />);
    });

    act(() => {
      actions.onReviewChanges();
    });

    const tab = useWorkbenchStore.getState().tabs[0]!;
    expect(tab.panes.size).toBe(2);
    const newPaneId = tab.focusedPaneId;
    expect(tab.panes.get(newPaneId)?.target).toEqual({
      kind: "workspace",
      definitionId: "gitView",
      environmentId: envId,
      workspaceId: wsId,
    });
  });
});
