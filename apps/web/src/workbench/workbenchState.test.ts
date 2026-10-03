import { describe, expect, it } from "vite-plus/test";

import type { AwenProjectId, AgentSessionId, EnvironmentId, WorkspaceId } from "@awen/contracts";

import {
  getActiveTab,
  applyCreateTab,
  applyActivateTab,
  applyCloseTab,
  applyClosePane,
  applyRenameTab,
  applyRemoveSessionViews,
  applyOpenTarget,
  applyOpenDeepLinkTarget,
  applySetFocused,
  applySetSplitRatio,
  applySetLayoutMode,
  applySplitFocused,
  applyViewDrop,
  initialPaneDropTarget,
  applyPruneWorkspaceViews,
  emptyWorkbenchSnapshot,
  isSameSessionTarget,
  tabDisplayTitle,
  type WorkbenchSnapshot,
  type WorkbenchTab,
  type PaneView,
} from "./workbenchState";
import { leafIds, newTab } from "./layout";
import { terminalTargetForRuntime } from "./sessionTarget";
import { targetKey, type ViewTarget } from "./viewRegistry";

const ENV_A: EnvironmentId = "env-a" as EnvironmentId;
const ENV_B: EnvironmentId = "env-b" as EnvironmentId;
const WS_A: WorkspaceId = "ws-a" as WorkspaceId;
const WS_B: WorkspaceId = "ws-b" as WorkspaceId;
const AGENT_X: AgentSessionId = "agent-x" as AgentSessionId;
const AGENT_Y: AgentSessionId = "agent-y" as AgentSessionId;

function agent(id: AgentSessionId): Extract<ViewTarget, { kind: "agentSession" }> {
  return {
    kind: "agentSession",
    environmentId: ENV_A,
    agentSessionId: id,
  };
}

function terminal(
  id: string,
  workspaceId: WorkspaceId = WS_A,
): Extract<ViewTarget, { kind: "workspaceTerminal" }> {
  return terminalTargetForRuntime({
    environmentId: ENV_A,
    workspaceId,
    terminalId: id,
  });
}

/** Deterministic id generator for tests. */
function makeIds(): () => string {
  let n = 0;
  return () => `id-${++n}`;
}

function workspaceFile(
  workspaceId: WorkspaceId = WS_A,
): Extract<ViewTarget, { kind: "workspace" }> {
  return {
    kind: "workspace",
    definitionId: "fileView",
    environmentId: ENV_A,
    workspaceId,
  };
}

function workspaceGit(workspaceId: WorkspaceId = WS_A): Extract<ViewTarget, { kind: "workspace" }> {
  return {
    kind: "workspace",
    definitionId: "gitView",
    environmentId: ENV_A,
    workspaceId,
  };
}

/** Count Views whose target matches, for uniqueness assertions. */
function countViews(snapshot: WorkbenchSnapshot, matches: (target: ViewTarget) => boolean): number {
  let count = 0;
  for (const tab of snapshot.tabs) {
    for (const view of tab.panes.values()) {
      if (matches(view.target)) count += 1;
    }
  }
  return count;
}

/** Count the Workbench's Session Views for one Session identity. */
function countSessionViews(snapshot: WorkbenchSnapshot, target: ViewTarget): number {
  return countViews(snapshot, (candidate) => isSameSessionTarget(candidate, target));
}

/** Count Views by full target identity, for kinds that may repeat per Tab. */
function countTargetViews(snapshot: WorkbenchSnapshot, target: ViewTarget): number {
  return countViews(snapshot, (candidate) => targetKey(candidate) === targetKey(target));
}

function paneTargetsOf(snapshot: WorkbenchSnapshot, tabId: string): ReadonlyArray<ViewTarget> {
  const tab = snapshot.tabs.find((candidate) => candidate.id === tabId);
  return tab === undefined ? [] : [...tab.panes.values()].map((view) => view.target);
}

/**
 * Build the pre-ADR-0010 mirror state that a restored snapshot may still carry.
 *
 * ADR-0010 removed mirroring, so the store API can no longer produce this; the
 * repair path still has to read it, which is exactly why it is built by hand.
 */
function withMirroredTab(
  snapshot: WorkbenchSnapshot,
  sourceTabId: string,
  sourcePaneId: string,
  tabId: string,
  paneId: string,
): WorkbenchSnapshot {
  const source = snapshot.tabs.find((tab) => tab.id === sourceTabId);
  const view: PaneView | undefined = source?.panes.get(sourcePaneId);
  if (source === undefined || view === undefined) throw new Error("mirror source is missing");
  const tab: WorkbenchTab = {
    ...newTab(paneId),
    id: tabId,
    panes: new Map([[paneId, view]]),
    titleMode: "auto",
    titleOverride: null,
  };
  const index = snapshot.tabs.findIndex((candidate) => candidate.id === sourceTabId);
  const tabs = [...snapshot.tabs];
  tabs.splice(index + 1, 0, tab);
  return { tabs, activeTabId: snapshot.activeTabId };
}

describe("emptyWorkbenchSnapshot", () => {
  it("starts with an explicit active Tab containing one Welcome View", () => {
    const snap = emptyWorkbenchSnapshot(makeIds());
    expect(snap.tabs).toHaveLength(1);
    const tab = getActiveTab(snap);
    expect(tab.id).toBe(snap.activeTabId);
    expect(leafIds(tab.layout)).toEqual([tab.focusedPaneId]);
    expect(tab.panes.get(tab.focusedPaneId)).toMatchObject({
      definitionId: "welcome",
      target: { kind: "welcome" },
    });
  });

  it("derives an automatic title from the first Pane and follows it when that Pane closes", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const firstPaneId = [...getActiveTab(snap).panes.entries()].find(
      ([, view]) => view.target.kind === "agentSession",
    )![0];
    const resolveTitle = (target: ViewTarget) =>
      target.kind === "agentSession" ? "Agent title" : "Terminal title";

    expect(tabDisplayTitle(getActiveTab(snap), resolveTitle)).toBe("Agent title");
    snap = applyClosePane(snap, firstPaneId, ids)!;
    expect(tabDisplayTitle(getActiveTab(snap), resolveTitle)).toBe("Terminal title");
  });

  it("keeps a manually renamed Tab title when its first Pane changes", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    const tabId = snap.activeTabId;
    snap = applyRenameTab(snap, tabId, "My workbench");
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);

    expect(tabDisplayTitle(getActiveTab(snap), () => "Agent title")).toBe("My workbench");
    expect(getActiveTab(snap).titleMode).toBe("manual");
  });
});

describe("applyCloseTab", () => {
  it("removes one Tab without changing another Tab's Views", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const firstTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const secondTabId = snap.activeTabId;

    snap = applyCloseTab(snap, secondTabId);

    expect(snap.tabs).toHaveLength(1);
    expect(snap.activeTabId).toBe(firstTabId);
    expect([...getActiveTab(snap).panes.values()][0]?.target).toEqual(agent(AGENT_X));
  });

  it("keeps the final Tab as an explicit Welcome state", () => {
    const snap = emptyWorkbenchSnapshot(makeIds());
    expect(applyCloseTab(snap, snap.activeTabId)).toBe(snap);
  });
});

describe("applyOpenDeepLinkTarget", () => {
  it("focuses a target that is already open in another Tab", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const firstTabId = snap.activeTabId;
    const firstPaneId = getActiveTab(snap).focusedPaneId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);

    snap = applyOpenDeepLinkTarget(snap, agent(AGENT_X), ids);

    expect(snap.activeTabId).toBe(firstTabId);
    expect(getActiveTab(snap).focusedPaneId).toBe(firstPaneId);
    expect(snap.tabs).toHaveLength(2);
  });

  it("opens a missing deep-link target in a new Tab without replacing restored work", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const firstTabId = snap.activeTabId;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const firstTabPaneIds = [...getActiveTab(snap).panes.keys()];

    snap = applyOpenDeepLinkTarget(snap, agent(AGENT_Y), ids);

    expect(snap.tabs).toHaveLength(2);
    expect(snap.tabs[0]?.id).toBe(firstTabId);
    expect([...snap.tabs[0]!.panes.keys()]).toEqual(firstTabPaneIds);
    expect([...getActiveTab(snap).panes.values()][0]?.target).toEqual(agent(AGENT_Y));
  });

  it("replaces a sole Welcome View instead of creating a redundant empty Tab", () => {
    const snap = applyOpenDeepLinkTarget(
      emptyWorkbenchSnapshot(makeIds()),
      agent(AGENT_X),
      makeIds(),
    );
    expect(snap.tabs).toHaveLength(1);
    expect([...getActiveTab(snap).panes.values()][0]?.target).toEqual(agent(AGENT_X));
  });
});

describe("applyOpenTarget", () => {
  it("creates a single pane carrying the target on an empty workbench", () => {
    const ids = makeIds();
    const before = emptyWorkbenchSnapshot(ids);
    const after = applyOpenTarget(before, agent(AGENT_X), ids);
    expect(getActiveTab(after).panes.size).toBe(1);
    expect(getActiveTab(after).panes.get(getActiveTab(after).focusedPaneId)?.target).toEqual(
      agent(AGENT_X),
    );
  });

  it("focuses the existing pane when the target is already open in the active Tab", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    const firstFocus = getActiveTab(snap).focusedPaneId;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const secondPaneId = findOtherLeaf(snap, firstFocus);
    snap = applySetFocused(snap, secondPaneId);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    expect(getActiveTab(snap).focusedPaneId).toBe(firstFocus);
    expect(getActiveTab(snap).panes.size).toBe(2);
    expect(snap.tabs).toHaveLength(1);
  });

  it("switches to the existing Tab and focuses the pane when the target is open in an inactive Tab", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    const tab1Id = snap.activeTabId;
    const tab1PaneId = getActiveTab(snap).focusedPaneId;

    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    expect(snap.activeTabId).not.toBe(tab1Id);

    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    expect(snap.activeTabId).toBe(tab1Id);
    expect(getActiveTab(snap).focusedPaneId).toBe(tab1PaneId);
    expect(snap.tabs).toHaveLength(2);
  });

  it("opens an unopened target in a new Tab next to the active Tab when active Tab has work", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    const tab1Id = snap.activeTabId;
    const tab1PaneId = getActiveTab(snap).focusedPaneId;

    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const tab2Id = snap.activeTabId;

    snap = applyActivateTab(snap, tab1Id);

    snap = applyOpenTarget(snap, agent(AGENT_Y), ids);
    expect(snap.tabs).toHaveLength(3);
    expect(snap.tabs[0]?.id).toBe(tab1Id);
    expect(snap.tabs[1]?.id).toBe(snap.activeTabId);
    expect(snap.tabs[2]?.id).toBe(tab2Id);
    expect(getActiveTab(snap).panes.size).toBe(1);
    expect(getActiveTab(snap).panes.get(getActiveTab(snap).focusedPaneId)?.target).toEqual(
      agent(AGENT_Y),
    );
    expect(snap.tabs[0]!.panes.size).toBe(1);
    expect(snap.tabs[0]!.panes.get(tab1PaneId)?.target).toEqual(agent(AGENT_X));
  });

  it("replaces the active Tab in-place if it is an empty Welcome Tab among multiple Tabs", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);

    snap = applyCreateTab(snap, ids);
    const tab2Id = snap.activeTabId;
    expect(snap.tabs).toHaveLength(2);
    expect(getActiveTab(snap).panes.get(getActiveTab(snap).focusedPaneId)?.target.kind).toBe(
      "welcome",
    );

    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    expect(snap.tabs).toHaveLength(2);
    expect(snap.activeTabId).toBe(tab2Id);
    expect(getActiveTab(snap).panes.size).toBe(1);
    expect(getActiveTab(snap).panes.get(getActiveTab(snap).focusedPaneId)?.target).toEqual(
      terminal("term-1"),
    );
  });
});

describe("applySplitFocused", () => {
  it("creates a new pane adjacent to the focused one", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    const focusBefore = getActiveTab(snap).focusedPaneId;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    expect(getActiveTab(snap).panes.size).toBe(2);
    expect(getActiveTab(snap).panes.get(focusBefore)?.target).toEqual(agent(AGENT_X));
    const newFocus = findOtherLeaf(snap, focusBefore);
    expect(getActiveTab(snap).panes.get(newFocus)?.target).toEqual(terminal("term-1"));
    expect(getActiveTab(snap).focusedPaneId).toBe(newFocus);
  });

  it("honors the requested split direction", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    snap = applySplitFocused(snap, terminal("term-1"), "down", ids);
    expect(getActiveTab(snap).layout.type).toBe("split");
    const layout = getActiveTab(snap).layout;
    if (layout.type !== "split") throw new Error("expected split");
    expect(layout.dir).toBe("down");
  });
});

describe("applyClosePane", () => {
  it("removes the pane from both the layout and the pane map", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const terminalPaneId = getActiveTab(snap).focusedPaneId;
    const next = applyClosePane(snap, terminalPaneId, ids);
    expect(next).not.toBeNull();
    if (next === null) return;
    snap = next;
    expect(getActiveTab(snap).panes.size).toBe(1);
    expect(getActiveTab(snap).panes.has(terminalPaneId)).toBe(false);
    expect(getActiveTab(snap).focusedPaneId).not.toBe(terminalPaneId);
  });

  it("restores Welcome in the same Tab when the last pane closes", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    const onlyPane = getActiveTab(snap).focusedPaneId;
    const reset = applyClosePane(snap, onlyPane, ids);
    expect(reset).not.toBeNull();
    if (reset === null) return;
    snap = reset;
    expect(getActiveTab(snap).panes.size).toBe(1);
    expect(getActiveTab(snap).panes.get(getActiveTab(snap).focusedPaneId)?.target).toEqual({
      kind: "welcome",
    });
    expect(getActiveTab(snap).layout.type).toBe("leaf");
    // The new empty workbench should not retain the closed Session — opening
    // the same target again creates a fresh pane.
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    expect(getActiveTab(snap).panes.size).toBe(1);
  });

  it("closes the Tab when its final non-Welcome Pane closes and another Tab exists", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const firstTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const closedTabId = snap.activeTabId;
    const onlyPane = getActiveTab(snap).focusedPaneId;

    const after = applyClosePane(snap, onlyPane, ids);

    expect(after).not.toBeNull();
    if (after === null) return;
    expect(after.tabs.map((tab) => tab.id)).toEqual([firstTabId]);
    expect(after.activeTabId).toBe(firstTabId);
    expect(getActiveTab(after).id).toBe(firstTabId);
    expect([...getActiveTab(after).panes.values()][0]?.target).toEqual(agent(AGENT_X));
    expect(after.tabs.some((tab) => tab.id === closedTabId)).toBe(false);
  });

  it("keeps a Tab when only its Welcome Pane closes", () => {
    const ids = makeIds();
    const snap = applyCreateTab(emptyWorkbenchSnapshot(ids), ids);
    const welcomePane = getActiveTab(snap).focusedPaneId;

    const after = applyClosePane(snap, welcomePane, ids);

    expect(after).not.toBeNull();
    if (after === null) return;
    expect(after.tabs).toHaveLength(2);
    expect([...getActiveTab(after).panes.values()][0]?.target).toEqual({ kind: "welcome" });
  });

  it("returns null when there is nothing to close", () => {
    const ids = makeIds();
    const snap = emptyWorkbenchSnapshot(ids);
    expect(applyClosePane(snap, "no-such-pane", ids)).toBeNull();
  });
});

describe("applySetFocused", () => {
  it("moves focus to the requested leaf", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const first = findOtherLeaf(snap, getActiveTab(snap).focusedPaneId);
    snap = applySetFocused(snap, first);
    expect(getActiveTab(snap).focusedPaneId).toBe(first);
  });

  it("returns the same snapshot when the pane id is unknown", () => {
    const ids = makeIds();
    const snap = emptyWorkbenchSnapshot(ids);
    expect(applySetFocused(snap, "unknown")).toBe(snap);
  });
});

describe("applySetSplitRatio", () => {
  it("updates the boundary between two panes in a split", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const splitId =
      getActiveTab(snap).layout.type === "split" ? getActiveTab(snap).layout.id : null;
    expect(splitId).not.toBeNull();
    if (splitId === null) throw new Error("expected split");
    snap = applySetSplitRatio(snap, splitId, 0, 0.7);
    expect(getActiveTab(snap).layout.type).toBe("split");
    const layout = getActiveTab(snap).layout;
    if (layout.type !== "split") throw new Error("expected split");
    expect(layout.sizes[0]).toBeCloseTo(0.7);
    expect(layout.sizes[1]).toBeCloseTo(0.3);
  });
});

describe("isolation between panes", () => {
  it("splitting an already-open Session moves its View instead of duplicating it", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const agentPaneId = getActiveTab(snap).focusedPaneId;
    const view = getActiveTab(snap).panes.get(agentPaneId);
    snap = applySplitFocused(snap, terminal("term-1"), "down", ids);
    snap = applySplitFocused(snap, agent(AGENT_X), "right", ids);
    const tab = getActiveTab(snap);
    expect(tab.panes.size).toBe(2);
    expect([...tab.panes.values()].filter((candidate) => candidate === view)).toHaveLength(1);
    expect(tab.panes.get(tab.focusedPaneId)).toBe(view);
    expect(tab.focusedPaneId).toBe(agentPaneId);
  });

  it("keeps each pane's target intact across focus changes", () => {
    const ids = makeIds();
    let snap = emptyWorkbenchSnapshot(ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    const first = getActiveTab(snap).focusedPaneId;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const second = findOtherLeaf(snap, first);
    snap = applySetFocused(snap, first);
    expect(getActiveTab(snap).panes.get(first)?.target).toEqual(agent(AGENT_X));
    expect(getActiveTab(snap).panes.get(second)?.target).toEqual(terminal("term-1"));
  });
});

function findOtherLeaf(snap: WorkbenchSnapshot, paneId: string): string {
  const ids = leafIds(getActiveTab(snap).layout);
  const other = ids.find((id) => id !== paneId);
  if (!other) throw new Error("expected at least one other leaf");
  return other;
}
it("replaces Welcome when the first command is split", () => {
  const ids = makeIds();
  const snap = applySplitFocused(emptyWorkbenchSnapshot(ids), terminal("first"), "down", ids);
  expect(getActiveTab(snap).panes.size).toBe(1);
  expect([...getActiveTab(snap).panes.values()][0]?.target).toEqual(terminal("first"));
});

it("keeps each Tab's Views and closes a Tab when closeView empties it", () => {
  const ids = makeIds();
  let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
  const firstTab = getActiveTab(snap);
  snap = applyCreateTab(snap, ids);
  snap = applyOpenTarget(snap, terminal("term-1"), ids);
  const secondTab = getActiveTab(snap);
  expect(snap.tabs).toHaveLength(2);
  expect(secondTab.focusedPaneId).not.toBe(firstTab.focusedPaneId);
  snap = applyClosePane(snap, secondTab.focusedPaneId, ids)!;
  // Closing the second Tab's final Pane closes that Tab and focuses the first.
  expect(snap.tabs.map((tab) => tab.id)).toEqual([firstTab.id]);
  expect(getActiveTab(snap).id).toBe(firstTab.id);
  expect([...getActiveTab(snap).panes.values()][0]?.target).toEqual(agent(AGENT_X));
  snap = applySplitFocused(snap, agent(AGENT_X), "down", ids);
  expect(getActiveTab(snap).panes.size).toBe(1);
  expect(applyActivateTab(snap, "unknown")).toBe(snap);
});

it("opens Project and Workspace independently with the same local id", () => {
  const ids = makeIds();
  const project: ViewTarget = {
    kind: "project",
    definitionId: "project",
    environmentId: ENV_A,
    projectId: "shared" as AwenProjectId,
  };
  const workspace: ViewTarget = {
    kind: "workspace",
    definitionId: "fileView",
    environmentId: ENV_A,
    workspaceId: "shared" as WorkspaceId,
  };
  const initial = applyOpenTarget(emptyWorkbenchSnapshot(ids), project, ids);
  const split = applySplitFocused(initial, workspace, "right", ids);
  expect([...getActiveTab(split).panes.values()].map((view) => view.target)).toEqual([
    project,
    workspace,
  ]);
});

describe("applyRemoveSessionViews", () => {
  it("removes the Session from every Tab and leaves unrelated Views intact", () => {
    const ids = makeIds();
    // Tab 1: Agent X + Terminal 1
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const agentXPaneId = getActiveTab(snap).focusedPaneId;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const tab1Id = snap.activeTabId;

    // Tab 2: Agent Y + Terminal 2 (unrelated to Agent X)
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, agent(AGENT_Y), ids);
    snap = applySplitFocused(snap, terminal("term-2"), "right", ids);
    const tab2Id = snap.activeTabId;
    const tab2Before = snap.tabs.find((tab) => tab.id === tab2Id)!;

    // Remove Agent X across all Tabs
    const after = applyRemoveSessionViews(snap, agent(AGENT_X), ids);

    // Tab 1 should now only have Terminal 1
    const tab1After = after.tabs.find((tab) => tab.id === tab1Id)!;
    expect(tab1After.panes.size).toBe(1);
    expect([...tab1After.panes.values()][0]?.target).toEqual(terminal("term-1"));
    expect(tab1After.focusedPaneId).toBe([...tab1After.panes.keys()][0]);
    expect(tab1After.panes.has(agentXPaneId)).toBe(false);

    // Tab 2 was completely unaffected
    expect(after.tabs.find((tab) => tab.id === tab2Id)).toBe(tab2Before);

    // activeTabId preserved
    expect(after.activeTabId).toBe(snap.activeTabId);
  });

  it("closes a Tab that loses its only View", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tab1Id = snap.activeTabId;

    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const tab2Id = snap.activeTabId;

    const after = applyRemoveSessionViews(snap, agent(AGENT_X), ids);

    // The Tab whose only View was removed is closed, not reset to Welcome.
    expect(after.tabs.some((tab) => tab.id === tab1Id)).toBe(false);
    expect(after.tabs).toHaveLength(1);
    // The unrelated Tab keeps its View and stays active.
    expect(after.activeTabId).toBe(tab2Id);
    const tab2After = after.tabs.find((tab) => tab.id === tab2Id)!;
    expect([...tab2After.panes.values()][0]?.target).toEqual(terminal("term-1"));
  });

  it("activates a neighboring Tab when the active Tab loses its only View", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), terminal("term-1"), ids);
    const firstTabId = snap.activeTabId;

    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, agent(AGENT_X), ids);
    const closedTabId = snap.activeTabId;

    const after = applyRemoveSessionViews(snap, agent(AGENT_X), ids);

    expect(after.tabs.map((tab) => tab.id)).toEqual([firstTabId]);
    expect(after.activeTabId).toBe(firstTabId);
    expect(after.tabs.some((tab) => tab.id === closedTabId)).toBe(false);
  });

  it("keeps a single Welcome Tab when the only Tab loses its only View", () => {
    const ids = makeIds();
    const snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tabId = snap.activeTabId;

    const after = applyRemoveSessionViews(snap, agent(AGENT_X), ids);

    expect(after.tabs.map((tab) => tab.id)).toEqual([tabId]);
    expect(after.activeTabId).toBe(tabId);
    expect(after.tabs[0]!.panes.size).toBe(1);
    expect([...after.tabs[0]!.panes.values()][0]?.target).toEqual({ kind: "welcome" });
  });

  it("removes a Session across Workspace assignments but preserves another Environment", () => {
    const ids = makeIds();
    const envBTarget: ViewTarget = {
      kind: "agentSession",
      environmentId: ENV_B,
      agentSessionId: AGENT_X,
    };
    const wsBTarget: ViewTarget = {
      kind: "agentSession",
      environmentId: ENV_A,
      agentSessionId: AGENT_X,
    };
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), envBTarget, ids);
    snap = applySplitFocused(snap, wsBTarget, "right", ids);

    const after = applyRemoveSessionViews(snap, agent(AGENT_X), ids);
    expect(getActiveTab(after).panes.size).toBe(1);
    expect([...getActiveTab(after).panes.values()][0]?.target).toEqual(envBTarget);
  });

  it("matches session even when explicit definitionId is present on target", () => {
    const ids = makeIds();
    const customTarget: ViewTarget = {
      ...agent(AGENT_X),
      definitionId: "agentSession",
    };
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), customTarget, ids);
    const after = applyRemoveSessionViews(snap, agent(AGENT_X), ids);
    expect(getActiveTab(after).panes.get(getActiveTab(after).focusedPaneId)?.target).toEqual({
      kind: "welcome",
    });
  });

  it("is idempotent and causes no side effects on repeated calls", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    snap = applyRemoveSessionViews(snap, agent(AGENT_X), ids);
    const repeat = applyRemoveSessionViews(snap, agent(AGENT_X), ids);
    expect(repeat).toBe(snap);
  });
});

describe("applyViewDrop", () => {
  it("replaces the target Pane with a new View instance when Sidebar content is dropped in the center", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tab = getActiveTab(snap);
    const targetPaneId = tab.focusedPaneId;
    const previousView = tab.panes.get(targetPaneId)!;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: terminal("term-1") },
      { kind: "pane", tabId: tab.id, paneId: targetPaneId, zone: "replace" },
      ids,
    );

    expect(result).not.toBeNull();
    const dropped = getActiveTab(result!.snapshot);
    expect(dropped.id).toBe(tab.id);
    expect(dropped.panes.get(targetPaneId)?.target).toEqual(terminal("term-1"));
    expect(dropped.panes.get(targetPaneId)).not.toBe(previousView);
    expect(result!.paneId).toBe(targetPaneId);
  });

  it("splits the target Pane on the requested edge when Sidebar content is dropped near an edge", () => {
    const ids = makeIds();
    const snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tab = getActiveTab(snap);
    const targetPaneId = tab.focusedPaneId;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: terminal("term-1") },
      { kind: "pane", tabId: tab.id, paneId: targetPaneId, zone: "right" },
      ids,
    );

    expect(result).not.toBeNull();
    const dropped = getActiveTab(result!.snapshot);
    expect(dropped.panes.size).toBe(2);
    expect(dropped.panes.get(targetPaneId)?.target).toEqual(agent(AGENT_X));
    expect(dropped.panes.get(result!.paneId)?.target).toEqual(terminal("term-1"));
    expect(leafIds(dropped.layout)).toEqual([targetPaneId, result!.paneId]);
    expect(dropped.focusedPaneId).toBe(result!.paneId);
  });

  it("moves Sidebar content that is already open onto another Pane in the same Tab", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tab = getActiveTab(snap);
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const terminalPaneId = getActiveTab(snap).focusedPaneId;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: agent(AGENT_X) },
      { kind: "pane", tabId: tab.id, paneId: terminalPaneId, zone: "replace" },
      ids,
    );

    expect(result).not.toBeNull();
    const tabAfter = result!.snapshot.tabs.find((candidate) => candidate.id === tab.id)!;
    expect(tabAfter.panes.size).toBe(1);
    expect(tabAfter.panes.get(tab.focusedPaneId)?.target).toEqual(agent(AGENT_X));
    expect(countSessionViews(result!.snapshot, agent(AGENT_X))).toBe(1);
    expect(result).toMatchObject({ tabId: tab.id, paneId: tab.focusedPaneId });
  });

  it("keeps one File View when the same Sidebar View is dropped onto another Pane in its Tab (ADR-0008)", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tab = getActiveTab(snap);
    const agentPaneId = tab.focusedPaneId;
    snap = applySplitFocused(snap, workspaceFile(), "right", ids);
    const filePaneId = getActiveTab(snap).focusedPaneId;
    const fileView = getActiveTab(snap).panes.get(filePaneId)!;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: workspaceFile() },
      { kind: "pane", tabId: tab.id, paneId: agentPaneId, zone: "replace" },
      ids,
    );

    expect(result).not.toBeNull();
    expect(countTargetViews(result!.snapshot, workspaceFile())).toBe(1);
    const tabAfter = result!.snapshot.tabs.find((candidate) => candidate.id === tab.id)!;
    expect(tabAfter.panes.get(filePaneId)).toBe(fileView);
    expect(result!.paneId).toBe(filePaneId);
  });

  it("focuses the File View already in the Tab instead of opening a duplicate (ADR-0008)", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), workspaceFile(), ids);
    const tab = getActiveTab(snap);
    const filePaneId = tab.focusedPaneId;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const terminalPaneId = getActiveTab(snap).focusedPaneId;
    snap = applySetFocused(snap, terminalPaneId);

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: workspaceFile() },
      { kind: "existingTab", tabId: tab.id },
      ids,
    );

    expect(result).not.toBeNull();
    expect(countTargetViews(result!.snapshot, workspaceFile())).toBe(1);
    expect(result!.paneId).toBe(filePaneId);
    expect(getActiveTab(result!.snapshot).focusedPaneId).toBe(filePaneId);
  });

  it("focuses the Git View already in the Tab when Review Changes is dropped again (ADR-0008)", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), workspaceGit(), ids);
    const tab = getActiveTab(snap);
    const gitPaneId = tab.focusedPaneId;
    snap = applyCreateTab(snap, ids);
    const otherTabId = getActiveTab(snap).id;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: workspaceGit() },
      { kind: "existingTab", tabId: tab.id },
      ids,
    );

    expect(result).not.toBeNull();
    expect(countTargetViews(result!.snapshot, workspaceGit())).toBe(1);
    expect(result!.tabId).toBe(tab.id);
    expect(result!.paneId).toBe(gitPaneId);
    expect(result!.snapshot.tabs.find((candidate) => candidate.id === otherTabId)).toBeDefined();
  });

  it("opens Sidebar content into an existing Tab and focuses it there", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    snap = applyCreateTab(snap, ids);
    const targetTab = getActiveTab(snap);
    const welcomePaneId = targetTab.focusedPaneId;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: terminal("term-1") },
      { kind: "existingTab", tabId: targetTab.id },
      ids,
    );

    expect(result).not.toBeNull();
    const dropped = result!.snapshot.tabs.find((tab) => tab.id === targetTab.id)!;
    expect(dropped.panes.size).toBe(1);
    expect(dropped.panes.get(welcomePaneId)?.target).toEqual(terminal("term-1"));
    expect(result!.snapshot.activeTabId).toBe(targetTab.id);
    expect(dropped.focusedPaneId).toBe(welcomePaneId);
  });

  it("opens Sidebar content into a new Tab at the requested index", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const firstTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    const secondTabId = snap.activeTabId;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: terminal("term-1") },
      { kind: "newTab", index: 1 },
      ids,
    );

    expect(result).not.toBeNull();
    expect(result!.snapshot.tabs.map((tab) => tab.id)).toEqual([
      firstTabId,
      result!.tabId,
      secondTabId,
    ]);
    const newTab = result!.snapshot.tabs.find((tab) => tab.id === result!.tabId)!;
    expect(newTab.panes.get(result!.paneId)?.target).toEqual(terminal("term-1"));
    expect(result!.snapshot.activeTabId).toBe(result!.tabId);
  });

  it("moves a Pane View instance to another Pane edge without changing its identity", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tabId = snap.activeTabId;
    const sourcePaneId = getActiveTab(snap).focusedPaneId;
    const sourceView = getActiveTab(snap).panes.get(sourcePaneId)!;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const targetPaneId = getActiveTab(snap).focusedPaneId;

    const result = applyViewDrop(
      snap,
      { kind: "pane", tabId, paneId: sourcePaneId },
      { kind: "pane", tabId, paneId: targetPaneId, zone: "right" },
      ids,
    );

    expect(result).not.toBeNull();
    const dropped = getActiveTab(result!.snapshot);
    expect(leafIds(dropped.layout)).toEqual([targetPaneId, sourcePaneId]);
    expect(dropped.panes.get(sourcePaneId)).toBe(sourceView);
    expect(dropped.focusedPaneId).toBe(sourcePaneId);
    expect(result).toMatchObject({ tabId, paneId: sourcePaneId });
  });

  it("repositions a Pane when dropped with directional edge within the same Tab in BSP mode", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tabId = snap.activeTabId;
    const sourcePaneId = getActiveTab(snap).focusedPaneId;
    const sourceView = getActiveTab(snap).panes.get(sourcePaneId)!;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const targetPaneId = getActiveTab(snap).focusedPaneId;
    const targetView = getActiveTab(snap).panes.get(targetPaneId)!;

    const result = applyViewDrop(
      snap,
      { kind: "pane", tabId, paneId: sourcePaneId },
      { kind: "pane", tabId, paneId: targetPaneId, zone: "right" },
      ids,
    );

    expect(result).not.toBeNull();
    const dropped = getActiveTab(result!.snapshot);
    expect(leafIds(dropped.layout)).toEqual([targetPaneId, sourcePaneId]);
    expect(dropped.panes.get(sourcePaneId)).toBe(sourceView);
    expect(dropped.panes.get(targetPaneId)).toBe(targetView);
    expect(dropped.focusedPaneId).toBe(sourcePaneId);
    expect(result).toMatchObject({ tabId, paneId: sourcePaneId });
  });

  it("repositions a Pane when dropped with directional edge within the same Tab in scrolling mode", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tabId = snap.activeTabId;
    const sourcePaneId = getActiveTab(snap).focusedPaneId;
    const sourceView = getActiveTab(snap).panes.get(sourcePaneId)!;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const targetPaneId = getActiveTab(snap).focusedPaneId;
    const targetView = getActiveTab(snap).panes.get(targetPaneId)!;
    snap = applySetLayoutMode(snap, "scrolling");

    const result = applyViewDrop(
      snap,
      { kind: "pane", tabId, paneId: sourcePaneId },
      { kind: "pane", tabId, paneId: targetPaneId, zone: "right" },
      ids,
    );

    expect(result).not.toBeNull();
    const dropped = getActiveTab(result!.snapshot);
    expect(dropped.columns?.map((c) => c.paneIds)).toEqual([[targetPaneId], [sourcePaneId]]);
    expect(dropped.panes.get(sourcePaneId)).toBe(sourceView);
    expect(dropped.panes.get(targetPaneId)).toBe(targetView);
    expect(dropped.focusedPaneId).toBe(sourcePaneId);
    expect(result).toMatchObject({ tabId, paneId: sourcePaneId });
  });

  it("moves a Pane View instance into an existing Tab and leaves Welcome behind", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const sourceTabId = snap.activeTabId;
    const sourcePaneId = getActiveTab(snap).focusedPaneId;
    const sourceView = getActiveTab(snap).panes.get(sourcePaneId)!;
    snap = applyCreateTab(snap, ids);
    const targetTabId = snap.activeTabId;
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const targetPaneId = getActiveTab(snap).focusedPaneId;

    const result = applyViewDrop(
      snap,
      { kind: "pane", tabId: sourceTabId, paneId: sourcePaneId },
      { kind: "existingTab", tabId: targetTabId },
      ids,
    );

    expect(result).not.toBeNull();
    const sourceTab = result!.snapshot.tabs.find((tab) => tab.id === sourceTabId)!;
    const targetTab = result!.snapshot.tabs.find((tab) => tab.id === targetTabId)!;
    expect(sourceTab.panes.size).toBe(1);
    expect(sourceTab.panes.get(sourceTab.focusedPaneId)?.target).toEqual({ kind: "welcome" });
    expect(targetTab.panes.get(targetPaneId)?.target).toEqual(terminal("term-1"));
    expect(targetTab.panes.get(sourcePaneId)).toBe(sourceView);
    expect(leafIds(targetTab.layout)).toEqual([targetPaneId, sourcePaneId]);
    expect(result!.snapshot.activeTabId).toBe(targetTabId);
    expect(targetTab.focusedPaneId).toBe(sourcePaneId);
  });

  it("refuses a Pane move when a restored Tab still holds the same Session", () => {
    const ids = makeIds();
    const opened = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const sourceTabId = opened.activeTabId;
    const sourcePaneId = getActiveTab(opened).focusedPaneId;
    // The store repairs this state on load; the drop guard must still refuse to
    // build a second View if a restored snapshot ever slips through.
    const snap = withMirroredTab(
      opened,
      sourceTabId,
      sourcePaneId,
      "restored-tab",
      "restored-pane",
    );

    const result = applyViewDrop(
      snap,
      { kind: "pane", tabId: sourceTabId, paneId: sourcePaneId },
      { kind: "existingTab", tabId: "restored-tab" },
      ids,
    );

    expect(result).toBeNull();
  });

  it("moves a Pane View instance into a new Tab at the requested index", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const sourceTabId = snap.activeTabId;
    const sourcePaneId = getActiveTab(snap).focusedPaneId;
    const sourceView = getActiveTab(snap).panes.get(sourcePaneId)!;
    snap = applyCreateTab(snap, ids);
    const secondTabId = snap.activeTabId;
    snap = applyOpenTarget(snap, terminal("term-1"), ids);

    const result = applyViewDrop(
      snap,
      { kind: "pane", tabId: sourceTabId, paneId: sourcePaneId },
      { kind: "newTab", index: 1 },
      ids,
    );

    expect(result).not.toBeNull();
    expect(result!.snapshot.tabs.map((tab) => tab.id)).toEqual([
      sourceTabId,
      result!.tabId,
      secondTabId,
    ]);
    const sourceTab = result!.snapshot.tabs.find((tab) => tab.id === sourceTabId)!;
    const newTab = result!.snapshot.tabs.find((tab) => tab.id === result!.tabId)!;
    expect(sourceTab.panes.get(sourceTab.focusedPaneId)?.target).toEqual({ kind: "welcome" });
    expect(newTab.panes.get(result!.paneId)).toBe(sourceView);
    expect(result!.paneId).toBe(sourcePaneId);
    expect(result!.snapshot.activeTabId).toBe(result!.tabId);
  });

  describe("tab source canvas docking into pane target (ADR-0017)", () => {
    it("splits target Pane and removes source Tab when inactive single-pane Tab is dropped onto active Tab pane", () => {
      const ids = makeIds();
      let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
      const activeTabId = snap.activeTabId;
      const activeTabPaneId = getActiveTab(snap).focusedPaneId;

      // Create a second tab and open a terminal in it
      snap = applyCreateTab(snap, ids);
      snap = applyOpenTarget(snap, terminal("term-1"), ids);
      const inactiveTabId = snap.activeTabId;
      const inactiveTab = snap.tabs.find((t) => t.id === inactiveTabId)!;
      const inactivePaneId = inactiveTab.focusedPaneId;
      const inactiveView = inactiveTab.panes.get(inactivePaneId)!;

      // Switch active tab back to Tab 1
      snap = { ...snap, activeTabId };

      const result = applyViewDrop(
        snap,
        { kind: "tab", tabId: inactiveTabId },
        { kind: "pane", tabId: activeTabId, paneId: activeTabPaneId, zone: "right" },
        ids,
      );

      expect(result).not.toBeNull();
      // Source tab must be closed and removed
      expect(result!.snapshot.tabs.find((t) => t.id === inactiveTabId)).toBeUndefined();
      expect(result!.snapshot.tabs.length).toBe(1);
      expect(result!.snapshot.activeTabId).toBe(activeTabId);

      const targetTab = result!.snapshot.tabs.find((t) => t.id === activeTabId)!;
      expect(targetTab.panes.size).toBe(2);
      expect(targetTab.panes.get(activeTabPaneId)?.target).toEqual(agent(AGENT_X));
      expect(targetTab.panes.get(inactivePaneId)).toBe(inactiveView);
      expect(targetTab.focusedPaneId).toBe(inactivePaneId);
      expect(result!.tabId).toBe(activeTabId);
      expect(result!.paneId).toBe(inactivePaneId);
    });

    it("absorbs and replaces Welcome View when inactive single-pane Tab is dropped into an empty active Tab", () => {
      const ids = makeIds();
      // Tab 1 is an empty tab (welcome view)
      let snap = emptyWorkbenchSnapshot(ids);
      const emptyTabId = snap.activeTabId;

      // Tab 2 has a terminal session
      snap = applyCreateTab(snap, ids);
      snap = applyOpenTarget(snap, terminal("term-1"), ids);
      const terminalTabId = snap.activeTabId;
      const terminalPaneId = snap.tabs.find((t) => t.id === terminalTabId)!.focusedPaneId;
      const terminalView = snap.tabs
        .find((t) => t.id === terminalTabId)!
        .panes.get(terminalPaneId)!;

      // Switch active tab back to empty Tab 1
      snap = { ...snap, activeTabId: emptyTabId };
      const emptyPaneId = snap.tabs.find((t) => t.id === emptyTabId)!.focusedPaneId;

      const result = applyViewDrop(
        snap,
        { kind: "tab", tabId: terminalTabId },
        { kind: "pane", tabId: emptyTabId, paneId: emptyPaneId, zone: "right" },
        ids,
      );

      expect(result).not.toBeNull();
      expect(result!.snapshot.tabs.find((t) => t.id === terminalTabId)).toBeUndefined();
      expect(result!.snapshot.tabs.length).toBe(1);
      const targetTab = result!.snapshot.tabs[0]!;
      expect(targetTab.panes.size).toBe(1);
      expect(targetTab.panes.get(terminalPaneId)).toBe(terminalView);
      expect(targetTab.focusedPaneId).toBe(terminalPaneId);
    });

    it("splits target Pane into a new Column when inactive single-pane Tab is dropped in Scrolling mode", () => {
      const ids = makeIds();
      let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
      snap = applySetLayoutMode(snap, "scrolling");
      const activeTabId = snap.activeTabId;
      const activeTabPaneId = getActiveTab(snap).focusedPaneId;

      snap = applyCreateTab(snap, ids);
      snap = applyOpenTarget(snap, terminal("term-1"), ids);
      const inactiveTabId = snap.activeTabId;
      const inactivePaneId = snap.tabs.find((t) => t.id === inactiveTabId)!.focusedPaneId;
      const inactiveView = snap.tabs
        .find((t) => t.id === inactiveTabId)!
        .panes.get(inactivePaneId)!;

      snap = { ...snap, activeTabId };

      const result = applyViewDrop(
        snap,
        { kind: "tab", tabId: inactiveTabId },
        { kind: "pane", tabId: activeTabId, paneId: activeTabPaneId, zone: "right" },
        ids,
      );

      expect(result).not.toBeNull();
      expect(result!.snapshot.tabs.find((t) => t.id === inactiveTabId)).toBeUndefined();
      const targetTab = result!.snapshot.tabs.find((t) => t.id === activeTabId)!;
      expect(targetTab.columns?.length).toBe(2);
      expect(targetTab.columns?.map((c) => c.paneIds)).toEqual([
        [activeTabPaneId],
        [inactivePaneId],
      ]);
      expect(targetTab.panes.get(inactivePaneId)).toBe(inactiveView);
    });

    it("rejects canvas drop if target zone is central replace on an active Tab with existing content", () => {
      const ids = makeIds();
      let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
      const activeTabId = snap.activeTabId;
      const activePaneId = getActiveTab(snap).focusedPaneId;

      snap = applyCreateTab(snap, ids);
      snap = applyOpenTarget(snap, terminal("term-1"), ids);
      const inactiveTabId = snap.activeTabId;

      snap = { ...snap, activeTabId };

      const result = applyViewDrop(
        snap,
        { kind: "tab", tabId: inactiveTabId },
        { kind: "pane", tabId: activeTabId, paneId: activePaneId, zone: "replace" },
        ids,
      );

      expect(result).toBeNull();
    });

    it("rejects canvas drop if source Tab contains multiple panes", () => {
      const ids = makeIds();
      let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
      const activeTabId = snap.activeTabId;
      const activePaneId = getActiveTab(snap).focusedPaneId;

      // Tab 2 with 2 panes
      snap = applyCreateTab(snap, ids);
      snap = applyOpenTarget(snap, terminal("term-1"), ids);
      snap = applySplitFocused(snap, terminal("term-2"), "right", ids);
      const multiPaneTabId = snap.activeTabId;

      snap = { ...snap, activeTabId };

      const result = applyViewDrop(
        snap,
        { kind: "tab", tabId: multiPaneTabId },
        { kind: "pane", tabId: activeTabId, paneId: activePaneId, zone: "right" },
        ids,
      );

      expect(result).toBeNull();
    });

    it("rejects canvas drop if source Tab is the active Tab itself", () => {
      const ids = makeIds();
      let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
      const activeTabId = snap.activeTabId;
      const activePaneId = getActiveTab(snap).focusedPaneId;

      const result = applyViewDrop(
        snap,
        { kind: "tab", tabId: activeTabId },
        { kind: "pane", tabId: activeTabId, paneId: activePaneId, zone: "right" },
        ids,
      );

      expect(result).toBeNull();
    });

    it("rejects canvas drop if target Tab already contains the same session view", () => {
      const ids = makeIds();
      let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
      const activeTabId = snap.activeTabId;
      const activePaneId = getActiveTab(snap).focusedPaneId;

      // Tab 2 also contains agent(AGENT_X)
      snap = applyCreateTab(snap, ids);
      snap = applyOpenTarget(snap, agent(AGENT_X), ids);
      const duplicateTabId = snap.activeTabId;

      snap = { ...snap, activeTabId };

      const result = applyViewDrop(
        snap,
        { kind: "tab", tabId: duplicateTabId },
        { kind: "pane", tabId: activeTabId, paneId: activePaneId, zone: "right" },
        ids,
      );

      expect(result).toBeNull();
    });
  });
});

describe("applyPruneWorkspaceViews", () => {
  it("restores Welcome instead of closing the Tab when a background prune empties it", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), workspaceFile(), ids);
    const prunedTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const activeId = snap.activeTabId;

    const after = applyPruneWorkspaceViews(snap, [], ids, [ENV_A]);

    // Background reconciliation keeps the Tab and recovers Welcome.
    expect(after.tabs.map((tab) => tab.id)).toEqual([prunedTabId, activeId]);
    expect(after.activeTabId).toBe(activeId);
    expect([...after.tabs[0]!.panes.values()][0]?.target).toEqual({ kind: "welcome" });
  });
});

describe("initialPaneDropTarget", () => {
  const ids = makeIds();

  it("identifies the initial left/right drop target in a horizontal split", () => {
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const leftPaneId = getActiveTab(snap).focusedPaneId;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const rightPaneId = getActiveTab(snap).focusedPaneId;
    const tab = getActiveTab(snap);

    const targetLeft = initialPaneDropTarget(tab, leftPaneId);
    expect(targetLeft).toEqual({
      kind: "pane",
      tabId: tab.id,
      paneId: rightPaneId,
      zone: "left",
    });

    const targetRight = initialPaneDropTarget(tab, rightPaneId);
    expect(targetRight).toEqual({
      kind: "pane",
      tabId: tab.id,
      paneId: leftPaneId,
      zone: "right",
    });
  });

  it("identifies the initial top/bottom drop target in a vertical split", () => {
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const topPaneId = getActiveTab(snap).focusedPaneId;
    snap = applySplitFocused(snap, terminal("term-1"), "down", ids);
    const bottomPaneId = getActiveTab(snap).focusedPaneId;
    const tab = getActiveTab(snap);

    const targetTop = initialPaneDropTarget(tab, topPaneId);
    expect(targetTop).toEqual({
      kind: "pane",
      tabId: tab.id,
      paneId: bottomPaneId,
      zone: "top",
    });

    const targetBottom = initialPaneDropTarget(tab, bottomPaneId);
    expect(targetBottom).toEqual({
      kind: "pane",
      tabId: tab.id,
      paneId: topPaneId,
      zone: "bottom",
    });
  });

  it("identifies initial drop target in scrolling columns", () => {
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const firstPaneId = getActiveTab(snap).focusedPaneId;
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const secondPaneId = getActiveTab(snap).focusedPaneId;
    snap = applySetLayoutMode(snap, "scrolling");
    const tab = getActiveTab(snap);

    expect(initialPaneDropTarget(tab, firstPaneId)).toEqual({
      kind: "pane",
      tabId: tab.id,
      paneId: secondPaneId,
      zone: "left",
    });
  });

  it("returns null when the tab has only one pane", () => {
    const snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const tab = getActiveTab(snap);
    expect(initialPaneDropTarget(tab, tab.focusedPaneId)).toBeNull();
  });
});

describe("Session View uniqueness across the Workbench", () => {
  it("focuses a Session that is already open in another Tab without adding a Tab", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const firstTabId = snap.activeTabId;
    const firstPaneId = getActiveTab(snap).focusedPaneId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);

    snap = applyOpenTarget(snap, agent(AGENT_X), ids);

    expect(snap.tabs).toHaveLength(2);
    expect(snap.activeTabId).toBe(firstTabId);
    expect(getActiveTab(snap).focusedPaneId).toBe(firstPaneId);
    expect(countSessionViews(snap, agent(AGENT_X))).toBe(1);
  });

  it("moves an already-open Session into the requested split position and closes its previous pane", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const sourceTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const splitTabId = snap.activeTabId;

    snap = applySplitFocused(snap, agent(AGENT_X), "right", ids);

    expect(snap.activeTabId).toBe(splitTabId);
    expect(snap.tabs).toHaveLength(2);
    expect(countSessionViews(snap, agent(AGENT_X))).toBe(1);
    expect(paneTargetsOf(snap, splitTabId)).toContainEqual(agent(AGENT_X));
    expect(paneTargetsOf(snap, splitTabId)).toContainEqual(terminal("term-1"));
    expect(paneTargetsOf(snap, sourceTabId)).toEqual([{ kind: "welcome" }]);
  });

  it("repositions an already-open Session inside its Tab without adding a Pane", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const tabId = snap.activeTabId;
    const leavesBefore = leafIds(getActiveTab(snap).layout);
    const panesBefore = getActiveTab(snap).panes.size;

    snap = applySplitFocused(snap, agent(AGENT_X), "right", ids);

    const tab = getActiveTab(snap);
    expect(tab.id).toBe(tabId);
    expect(tab.panes.size).toBe(panesBefore);
    expect(countSessionViews(snap, agent(AGENT_X))).toBe(1);
    expect(countSessionViews(snap, terminal("term-1"))).toBe(1);
    expect(leafIds(tab.layout)).not.toEqual(leavesBefore);
    expect(tab.panes.get(tab.focusedPaneId)?.target).toEqual(agent(AGENT_X));
  });

  it("leaves the Session in place when the split anchor is its own Pane", () => {
    const ids = makeIds();
    const snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);

    const after = applySplitFocused(snap, agent(AGENT_X), "right", ids);

    expect(after).toBe(snap);
  });

  it("moves the single Workspace File Pane across Tabs on explicit split", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), workspaceFile(), ids);
    const firstTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);

    snap = applySplitFocused(snap, workspaceFile(), "right", ids);

    expect(countTargetViews(snap, workspaceFile())).toBe(1);
    expect(snap.tabs.find((tab) => tab.id === firstTabId)?.panes.size).toBe(1);
    expect(getActiveTab(snap).panes.size).toBe(2);
  });

  it("moves already-open Sidebar content into the Pane drop zone", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const sourceTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const targetTab = getActiveTab(snap);

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: agent(AGENT_X) },
      { kind: "pane", tabId: targetTab.id, paneId: targetTab.focusedPaneId, zone: "right" },
      ids,
    );

    expect(result).not.toBeNull();
    const after = result!.snapshot;
    expect(countSessionViews(after, agent(AGENT_X))).toBe(1);
    expect(paneTargetsOf(after, targetTab.id)).toContainEqual(agent(AGENT_X));
    expect(paneTargetsOf(after, targetTab.id)).toContainEqual(terminal("term-1"));
    expect(paneTargetsOf(after, sourceTabId)).toEqual([{ kind: "welcome" }]);
  });

  it("replaces the target Pane when already-open Sidebar content is dropped in the center", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const targetTab = getActiveTab(snap);

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: agent(AGENT_X) },
      { kind: "pane", tabId: targetTab.id, paneId: targetTab.focusedPaneId, zone: "replace" },
      ids,
    );

    expect(result).not.toBeNull();
    const after = result!.snapshot;
    expect(countSessionViews(after, agent(AGENT_X))).toBe(1);
    expect(countSessionViews(after, terminal("term-1"))).toBe(0);
    expect(paneTargetsOf(after, targetTab.id)).toEqual([agent(AGENT_X)]);
    expect(after.tabs).toHaveLength(2);
  });

  it("focuses the Pane when already-open Sidebar content is dropped on itself", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    snap = applySplitFocused(snap, terminal("term-1"), "right", ids);
    const tab = getActiveTab(snap);
    const agentPaneId = [...tab.panes.entries()].find(
      ([, view]) => view.target.kind === "agentSession",
    )![0];

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: agent(AGENT_X) },
      { kind: "pane", tabId: tab.id, paneId: agentPaneId, zone: "replace" },
      ids,
    );

    expect(result).not.toBeNull();
    expect(result!.paneId).toBe(agentPaneId);
    expect(result!.snapshot.tabs).toHaveLength(1);
    expect(countSessionViews(result!.snapshot, agent(AGENT_X))).toBe(1);
  });

  it("moves already-open Sidebar content into an existing Tab", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const sourceTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    snap = applyOpenTarget(snap, terminal("term-1"), ids);
    const targetTabId = snap.activeTabId;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: agent(AGENT_X) },
      { kind: "existingTab", tabId: targetTabId },
      ids,
    );

    expect(result).not.toBeNull();
    const after = result!.snapshot;
    expect(countSessionViews(after, agent(AGENT_X))).toBe(1);
    expect(paneTargetsOf(after, targetTabId)).toContainEqual(agent(AGENT_X));
    expect(paneTargetsOf(after, sourceTabId)).toEqual([{ kind: "welcome" }]);
  });

  it("moves already-open Sidebar content into a new Tab and leaves Welcome behind", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const sourceTabId = snap.activeTabId;

    const result = applyViewDrop(
      snap,
      { kind: "sidebar", target: agent(AGENT_X) },
      { kind: "newTab", index: 1 },
      ids,
    );

    expect(result).not.toBeNull();
    const after = result!.snapshot;
    expect(after.tabs).toHaveLength(2);
    expect(countSessionViews(after, agent(AGENT_X))).toBe(1);
    expect(paneTargetsOf(after, result!.tabId)).toEqual([agent(AGENT_X)]);
    expect(paneTargetsOf(after, sourceTabId)).toEqual([{ kind: "welcome" }]);
  });

  it("moves an already-open Session into an empty Tab when it is split there", () => {
    const ids = makeIds();
    let snap = applyOpenTarget(emptyWorkbenchSnapshot(ids), agent(AGENT_X), ids);
    const sourceTabId = snap.activeTabId;
    snap = applyCreateTab(snap, ids);
    const emptyTabId = snap.activeTabId;
    expect(getActiveTab(snap).panes.get(getActiveTab(snap).focusedPaneId)?.target.kind).toBe(
      "welcome",
    );

    snap = applySplitFocused(snap, agent(AGENT_X), "right", ids);

    expect(snap.activeTabId).toBe(emptyTabId);
    expect(countSessionViews(snap, agent(AGENT_X))).toBe(1);
    expect(paneTargetsOf(snap, emptyTabId)).toEqual([agent(AGENT_X)]);
    expect(paneTargetsOf(snap, sourceTabId)).toEqual([{ kind: "welcome" }]);
  });
});

describe("session identity", () => {
  it("treats Session targetKey and Session identity alike so dedupe keys cannot drift", () => {
    const plain = agent(AGENT_X);
    const customDefinition = { ...agent(AGENT_X), definitionId: "agentSession" as const };

    expect(isSameSessionTarget(plain, customDefinition)).toBe(true);
    expect(targetKey(plain)).toBe(targetKey(customDefinition));

    for (const other of [
      agent(AGENT_Y),
      { ...agent(AGENT_X), environmentId: ENV_B },
      terminal("term-1"),
    ]) {
      expect(isSameSessionTarget(plain, other)).toBe(false);
      expect(targetKey(plain)).not.toBe(targetKey(other));
    }
  });
});
