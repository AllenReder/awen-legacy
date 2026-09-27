import { afterEach, expect, it, vi } from "vite-plus/test";
import type { AgentSessionId, EnvironmentId, WorkspaceId } from "@awen/contracts";

import { targetKey, type ViewTarget } from "./viewRegistry";
import { newTab } from "./layout";
import {
  applyCreateTab,
  applyOpenTarget,
  emptyWorkbenchSnapshot,
  getActiveTab,
  type WorkbenchSnapshot,
} from "./workbenchState";
import { createWorkbenchStore } from "./workbenchStore";

const ENV_A: EnvironmentId = "env-a" as EnvironmentId;
const WS_A: WorkspaceId = "ws-a" as WorkspaceId;
const AGENT_A: AgentSessionId = "agent-a" as AgentSessionId;
const WORKSPACE_A: WorkspaceId = "workspace-a" as WorkspaceId;

function agent(): Extract<ViewTarget, { kind: "agentSession" }> {
  return {
    kind: "agentSession",
    environmentId: ENV_A,
    agentSessionId: AGENT_A,
  };
}

function agentB(): Extract<ViewTarget, { kind: "agentSession" }> {
  return {
    kind: "agentSession",
    environmentId: ENV_A,
    agentSessionId: "agent-b" as AgentSessionId,
  };
}

function makeIds(): () => string {
  let n = 100;
  return () => `id-${++n}`;
}

afterEach(() => {
  vi.useRealTimers();
});

it("restores a snapshot and persists later Tab transitions", () => {
  const ids = makeIds();
  const initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const writes: WorkbenchSnapshot[] = [];
  const store = createWorkbenchStore({
    initialSnapshot: initial,
    generateId: ids,
    persist: (snapshot) => writes.push(snapshot),
  });

  expect(store.getState().tabs).toEqual(initial.tabs);
  store.getState().createTab();
  store.getState().renameTab(store.getState().activeTabId, "Manual title");

  expect(writes).toHaveLength(2);
  expect(writes[1]?.tabs).toHaveLength(2);
  expect(writes[1]?.tabs[1]?.titleMode).toBe("manual");
  expect(writes[1]?.tabs[1]?.titleOverride).toBe("Manual title");
});

it("opens a deep link without replacing restored layout", () => {
  const ids = makeIds();
  let initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const originalPaneIds = [...getActiveTab(initial).panes.keys()];
  initial = applyCreateTab(initial, ids);
  const store = createWorkbenchStore({ initialSnapshot: initial, generateId: ids });

  store.getState().openDeepLinkTarget(agent());

  expect(store.getState().tabs).toHaveLength(2);
  expect(store.getState().tabs[0]?.panes).toHaveProperty("size", 1);
  expect([...store.getState().tabs[0]!.panes.keys()]).toEqual(originalPaneIds);
  expect(store.getState().activeTabId).toBe(store.getState().tabs[0]?.id);
});

it("repairs a restored layout that mirrored one Session into two Tabs", () => {
  const ids = makeIds();
  const opened = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const sourceTab = getActiveTab(opened);
  const sourcePaneId = sourceTab.focusedPaneId;
  const sourceView = sourceTab.panes.get(sourcePaneId)!;
  // The pre-ADR-0010 model could persist this mirror; the store must repair
  // it on load instead of rejecting the whole snapshot.
  const mirrored: WorkbenchSnapshot = {
    tabs: [
      sourceTab,
      {
        ...newTab("restored-pane"),
        id: "restored-tab",
        panes: new Map([["restored-pane", sourceView]]),
        titleMode: "auto",
        titleOverride: null,
      },
    ],
    activeTabId: sourceTab.id,
  };

  const store = createWorkbenchStore({ initialSnapshot: mirrored, generateId: ids });

  expect(store.getState().tabs).toHaveLength(2);
  expect(store.getState().tabs[0]?.panes.get(sourcePaneId)).toBe(sourceView);
  const restored = store.getState().tabs[1]!;
  expect(restored.panes.size).toBe(1);
  expect([...restored.panes.values()][0]?.target).toEqual({ kind: "welcome" });
});

it("keeps drag preview out of persisted Workbench state until the exact result is committed", () => {
  const ids = makeIds();
  const initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const sourceTab = getActiveTab(initial);
  const sourcePaneId = sourceTab.focusedPaneId;
  const writes: WorkbenchSnapshot[] = [];
  const store = createWorkbenchStore({
    initialSnapshot: initial,
    generateId: ids,
    persist: (snapshot) => writes.push(snapshot),
  });

  const preview = store
    .getState()
    .previewDrop(
      { kind: "pane", tabId: sourceTab.id, paneId: sourcePaneId },
      { kind: "newTab", index: 1 },
    );

  expect(preview).not.toBeNull();
  expect(store.getState().tabs).toEqual(initial.tabs);
  expect(writes).toEqual([]);

  store.getState().commitDrop(preview!);

  expect(store.getState().tabs).toEqual(preview!.snapshot.tabs);
  expect(writes).toHaveLength(1);
});

it("drops legacy Workspace Views when restoring a Workbench layout", () => {
  const ids = makeIds();
  const legacyWorkspace = {
    kind: "workspace",
    environmentId: ENV_A,
    workspaceId: WORKSPACE_A,
  } as const;
  const restored = applyOpenTarget(emptyWorkbenchSnapshot(ids), legacyWorkspace, ids);

  const store = createWorkbenchStore({ initialSnapshot: restored, generateId: ids });
  const tab = getActiveTab(store.getState());

  expect(tab.panes.size).toBe(1);
  expect(tab.panes.get(tab.focusedPaneId)?.target).toEqual({ kind: "welcome" });
});

it("intercepts pane closure with registered close guard when dirty", async () => {
  const ids = makeIds();
  const initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const tab = getActiveTab(initial);
  const paneId = tab.focusedPaneId;
  const store = createWorkbenchStore({ initialSnapshot: initial, generateId: ids });

  let isDirty = true;
  let confirmResult = false;
  const unregister = store.getState().registerCloseGuard(paneId, {
    isDirty: () => isDirty,
    confirmClose: async () => confirmResult,
  });

  // When dirty and user cancels confirmation -> pane is NOT closed
  const closed1 = await store.getState().requestClosePane(paneId);
  expect(closed1).toBe(false);
  expect(getActiveTab(store.getState()).panes.has(paneId)).toBe(true);

  // When dirty and user confirms -> pane IS closed
  confirmResult = true;
  const closed2 = await store.getState().requestClosePane(paneId);
  expect(closed2).toBe(true);
  expect(getActiveTab(store.getState()).panes.has(paneId)).toBe(false);
});

it("canCloseTab checks close guards for all panes in the tab", async () => {
  const ids = makeIds();
  const initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const tab = getActiveTab(initial);
  const paneId = tab.focusedPaneId;
  const store = createWorkbenchStore({ initialSnapshot: initial, generateId: ids });

  let isDirty = true;
  let confirmResult = false;
  store.getState().registerCloseGuard(paneId, {
    isDirty: () => isDirty,
    confirmClose: async () => confirmResult,
  });

  // When dirty and user cancels confirmation -> canCloseTab returns false
  const canClose1 = await store.getState().canCloseTab(tab.id);
  expect(canClose1).toBe(false);

  // When dirty and user confirms -> canCloseTab returns true
  confirmResult = true;
  const canClose2 = await store.getState().canCloseTab(tab.id);
  expect(canClose2).toBe(true);

  // When clean -> canCloseTab returns true without confirmation
  isDirty = false;
  const canClose3 = await store.getState().canCloseTab(tab.id);
  expect(canClose3).toBe(true);
});

it("splits relative to a specific pane and focuses existing targets if already present", () => {
  const ids = makeIds();
  const initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const tab = getActiveTab(initial);
  const sourcePaneId = tab.focusedPaneId;
  const store = createWorkbenchStore({ initialSnapshot: initial, generateId: ids });

  const fileTarget: ViewTarget = {
    kind: "workspace",
    definitionId: "fileView",
    environmentId: ENV_A,
    workspaceId: WS_A,
  };

  store.getState().splitPane(sourcePaneId, fileTarget, "right");
  const tabAfterSplit = getActiveTab(store.getState());
  expect(tabAfterSplit.panes.size).toBe(2);
  const filePaneId = tabAfterSplit.focusedPaneId;
  expect(tabAfterSplit.panes.get(filePaneId)?.target).toEqual(fileTarget);

  store.getState().setFocused(sourcePaneId);
  expect(getActiveTab(store.getState()).focusedPaneId).toBe(sourcePaneId);

  store.getState().splitPane(sourcePaneId, fileTarget, "right");
  const tabAfterRefocus = getActiveTab(store.getState());
  expect(tabAfterRefocus.panes.size).toBe(2);
  expect(tabAfterRefocus.focusedPaneId).toBe(filePaneId);
});

it("moves a tab from one index to another and persists the new order", () => {
  const ids = makeIds();
  let initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  initial = applyCreateTab(initial, ids);
  initial = applyCreateTab(initial, ids);

  const writes: WorkbenchSnapshot[] = [];
  const store = createWorkbenchStore({
    initialSnapshot: initial,
    generateId: ids,
    persist: (snapshot) => writes.push(snapshot),
  });

  const tab0Id = store.getState().tabs[0]!.id;
  const tab1Id = store.getState().tabs[1]!.id;
  const tab2Id = store.getState().tabs[2]!.id;

  // Move tab 0 to index 2
  store.getState().moveTab(0, 2);

  expect(store.getState().tabs.map((t) => t.id)).toEqual([tab1Id, tab2Id, tab0Id]);
  expect(writes).toHaveLength(1);
  expect(writes[0]!.tabs.map((t) => t.id)).toEqual([tab1Id, tab2Id, tab0Id]);

  // Invalid indices should no-op
  store.getState().moveTab(0, 0);
  store.getState().moveTab(-1, 2);
  store.getState().moveTab(0, 99);
  expect(writes).toHaveLength(1);
});

it("previews and commits a Tab drop to reorder tabs", () => {
  const ids = makeIds();
  let initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  initial = applyCreateTab(initial, ids);
  initial = applyCreateTab(initial, ids);

  const writes: WorkbenchSnapshot[] = [];
  const store = createWorkbenchStore({
    initialSnapshot: initial,
    generateId: ids,
    persist: (snapshot) => writes.push(snapshot),
  });

  const tab0Id = store.getState().tabs[0]!.id;
  const tab1Id = store.getState().tabs[1]!.id;
  const tab2Id = store.getState().tabs[2]!.id;

  // Drag tab 0 to existingTab 2
  const preview = store
    .getState()
    .previewDrop({ kind: "tab", tabId: tab0Id }, { kind: "existingTab", tabId: tab2Id });

  expect(preview).not.toBeNull();
  expect(preview!.snapshot.tabs.map((t) => t.id)).toEqual([tab1Id, tab2Id, tab0Id]);
  expect(store.getState().tabs.map((t) => t.id)).toEqual([tab0Id, tab1Id, tab2Id]);
  expect(writes).toHaveLength(0);

  store.getState().commitDrop(preview!);
  expect(store.getState().tabs.map((t) => t.id)).toEqual([tab1Id, tab2Id, tab0Id]);
  expect(writes).toHaveLength(1);
});

/** Two Tabs, each the sole View of a different Agent Session. */
function twoTabStore() {
  const ids = makeIds();
  let initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const firstTabId = getActiveTab(initial).id;
  initial = applyOpenTarget(initial, agentB(), ids);
  const secondTabId = getActiveTab(initial).id;
  const writes: WorkbenchSnapshot[] = [];
  const store = createWorkbenchStore({
    initialSnapshot: initial,
    generateId: ids,
    persist: (snapshot) => writes.push(snapshot),
  });
  return { store, ids, firstTabId, secondTabId, writes };
}

it("closeTab marks the Tab closing, switches its survivor immediately, and removes it after the collapse", () => {
  vi.useFakeTimers();
  const { store, firstTabId, secondTabId } = twoTabStore();
  store.getState().activateTab(firstTabId);

  store.getState().closeTab(firstTabId);

  // The Tab is still present, marked as closing, and the active context has
  // already moved to its survivor (ADR-0013 zero-latency switch).
  expect(store.getState().closingTabIds.has(firstTabId)).toBe(true);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([firstTabId, secondTabId]);
  expect(store.getState().activeTabId).toBe(secondTabId);

  vi.advanceTimersByTime(219);
  expect(store.getState().tabs).toHaveLength(2);

  vi.advanceTimersByTime(1);
  expect(store.getState().closingTabIds.size).toBe(0);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([secondTabId]);
  expect(store.getState().activeTabId).toBe(secondTabId);
});

it("closeTab on the sole Tab is a no-op and never schedules a removal", () => {
  vi.useFakeTimers();
  const ids = makeIds();
  const store = createWorkbenchStore({
    initialSnapshot: applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids),
    generateId: ids,
  });
  const soleTabId = getActiveTab(store.getState()).id;

  store.getState().closeTab(soleTabId);

  expect(store.getState().closingTabIds.size).toBe(0);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([soleTabId]);
  vi.advanceTimersByTime(220);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([soleTabId]);
});

it("removeSessionViews animates the emptied Tab away and keeps the Workbench's other Tabs", () => {
  vi.useFakeTimers();
  const { store, firstTabId, secondTabId } = twoTabStore();
  store.getState().activateTab(firstTabId);

  store.getState().removeSessionViews(agent());

  // Immediate active switch, but the Tab holds on for its collapse.
  expect(store.getState().activeTabId).toBe(secondTabId);
  expect(store.getState().closingTabIds.has(firstTabId)).toBe(true);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([firstTabId, secondTabId]);

  vi.advanceTimersByTime(220);
  expect(store.getState().closingTabIds.size).toBe(0);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([secondTabId]);
  expect(store.getState().tabs[0]!.panes.size).toBe(1);
});

it("removeSessionViews recovers Welcome in place without animating when the Tab is the only one", () => {
  vi.useFakeTimers();
  const ids = makeIds();
  const store = createWorkbenchStore({
    initialSnapshot: applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids),
    generateId: ids,
  });
  const soleTabId = getActiveTab(store.getState()).id;

  store.getState().removeSessionViews(agent());

  // The final Tab recovers Welcome (ADR-0023); there is no Tab removal to animate.
  expect(store.getState().closingTabIds.size).toBe(0);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([soleTabId]);
  expect([...getActiveTab(store.getState()).panes.values()][0]?.target.kind).toBe("welcome");
});

it("closeView animates an emptied non-final Tab but recovers the sole Tab in place", () => {
  vi.useFakeTimers();
  const { store, firstTabId, secondTabId } = twoTabStore();
  store.getState().activateTab(firstTabId);
  const paneId = getActiveTab(store.getState()).focusedPaneId;

  store.getState().closeView(paneId);
  expect(store.getState().closingTabIds.has(firstTabId)).toBe(true);
  expect(store.getState().tabs).toHaveLength(2);

  vi.advanceTimersByTime(220);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([secondTabId]);

  // Closing the sole Tab's last Pane recovers Welcome synchronously.
  const solePaneId = getActiveTab(store.getState()).focusedPaneId;
  store.getState().closeView(solePaneId);
  expect(store.getState().closingTabIds.size).toBe(0);
  expect([...getActiveTab(store.getState()).panes.values()][0]?.target.kind).toBe("welcome");
});

it("animates concurrent closes without ever emptying the Workbench", () => {
  vi.useFakeTimers();
  const ids = makeIds();
  let initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(), ids);
  const tab0 = getActiveTab(initial).id;
  initial = applyOpenTarget(initial, agentB(), ids);
  const tab1 = getActiveTab(initial).id;
  initial = applyCreateTab(initial, ids);
  const tab2 = getActiveTab(initial).id;
  const store = createWorkbenchStore({ initialSnapshot: initial, generateId: ids });

  store.getState().closeTab(tab0);
  store.getState().closeTab(tab1);
  store.getState().closeTab(tab2); // refused: only one non-closing Tab would remain

  expect([...store.getState().closingTabIds].sort()).toEqual([tab0, tab1].sort());
  expect(store.getState().tabs).toHaveLength(3);

  vi.advanceTimersByTime(220);
  expect(store.getState().closingTabIds.size).toBe(0);
  expect(store.getState().tabs.map((tab) => tab.id)).toEqual([tab2]);
});

it("notifies a closed Tab's View closure only when the Tab is actually removed", () => {
  vi.useFakeTimers();
  const { store, firstTabId } = twoTabStore();
  store.getState().activateTab(firstTabId);
  const closed: string[][] = [];
  const unsubscribe = store.getState().subscribeViewClosures((targets) => {
    closed.push(targets.map((target) => targetKey(target)));
  });

  store.getState().closeTab(firstTabId);
  // The View stays mounted for the collapse, so its closure is not reported yet.
  expect(closed).toEqual([]);

  vi.advanceTimersByTime(220);
  expect(closed).toHaveLength(1);
  unsubscribe();
});

it("notifies a View closure as soon as an explicit close clears it", () => {
  vi.useFakeTimers();
  const { store, firstTabId } = twoTabStore();
  store.getState().activateTab(firstTabId);
  const closed: string[][] = [];
  store.getState().subscribeViewClosures((targets) => {
    closed.push(targets.map((target) => targetKey(target)));
  });

  store.getState().closeView(getActiveTab(store.getState()).focusedPaneId);
  // The emptied Tab is cleared to Welcome immediately, so the View is gone now.
  expect(closed).toHaveLength(1);
  vi.advanceTimersByTime(220);
  expect(closed).toHaveLength(1);
});
