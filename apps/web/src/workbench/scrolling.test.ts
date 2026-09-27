import type {
  EnvironmentId,
  WorkspaceId,
  AgentSessionId,
  TerminalSessionId,
} from "@awen/contracts";
import { deserializeWorkbenchSnapshot, serializeWorkbenchSnapshot } from "./workbenchPersistence";
import { describe, expect, it } from "vite-plus/test";
import { createWorkbenchStore } from "./workbenchStore";
import { getActiveTab } from "./workbenchState";
import { leafIds } from "./layout";
import type { ViewTarget } from "./viewRegistry";
const agent = (id: string): ViewTarget => ({
  kind: "agentSession",
  environmentId: "env" as EnvironmentId,
  agentSessionId: id as AgentSessionId,
});
const terminal: ViewTarget = {
  kind: "workspaceTerminal",
  environmentId: "env" as EnvironmentId,
  workspaceId: "ws" as WorkspaceId,
  terminalSessionId: "terminal" as TerminalSessionId,
};
function setup() {
  let id = 0;
  return createWorkbenchStore({ generateId: () => "pane-" + ++id, persist: () => {} });
}
describe("Scrolling presentation commands", () => {
  it("converts BSP order into columns, then stacks a terminal View", () => {
    const store = setup();
    store.getState().openTarget(agent("a"));
    const first = getActiveTab(store.getState()).focusedPaneId;
    store.getState().splitFocused(agent("b"), "right");
    const second = getActiveTab(store.getState()).focusedPaneId;
    const views = getActiveTab(store.getState()).panes;
    store.getState().setLayoutMode("scrolling");
    expect(getActiveTab(store.getState()).columns?.map((c) => c.paneIds)).toEqual([
      [first],
      [second],
    ]);
    expect(getActiveTab(store.getState()).panes).toBe(views);
    store.getState().splitFocused(terminal, "down");
    const tab = getActiveTab(store.getState());
    expect(tab.columns?.map((c) => c.paneIds)).toEqual([[first], [second, tab.focusedPaneId]]);
    expect(leafIds(tab.layout)).toEqual([first, second, tab.focusedPaneId]);
    expect(tab.panes.get(tab.focusedPaneId)?.target).toEqual(terminal);
  });
});

it("restores resized columns after switching and restart without resurrecting closed panes", () => {
  const store = setup();
  store.getState().openTarget(agent("a"));
  const a = getActiveTab(store.getState()).focusedPaneId;
  store.getState().splitFocused(agent("b"), "down");
  const b = getActiveTab(store.getState()).focusedPaneId;
  const bsp = getActiveTab(store.getState()).layout;
  store.getState().setLayoutMode("scrolling");
  const column = getActiveTab(store.getState()).columns![0]!;
  store.getState().changeColumn(column.id, { width: 740, direction: 1 });
  store.getState().setLayoutMode("bsp");
  expect(getActiveTab(store.getState()).layout).toEqual(bsp);
  store.getState().closeView(b);
  store.getState().splitFocused(agent("c"), "down");
  const c = getActiveTab(store.getState()).focusedPaneId;
  store.getState().setLayoutMode("scrolling");
  const restored = deserializeWorkbenchSnapshot(serializeWorkbenchSnapshot(store.getState()))!;
  expect(getActiveTab(restored).layoutMode).toBe("scrolling");
  expect(getActiveTab(restored).columns?.map((c) => [c.width, c.paneIds])).toEqual([
    [740, [a]],
    [560, [c]],
  ]);
  expect(getActiveTab(restored).panes.has(b)).toBe(false);
});

it("moves a pane from BSP to a column edge and removes the empty source column", () => {
  const store = setup();
  store.getState().openTarget(agent("a"));
  const source = getActiveTab(store.getState());
  const view = source.panes.get(source.focusedPaneId);
  store.getState().createTab();
  store.getState().openTarget(terminal);
  store.getState().setLayoutMode("scrolling");
  const target = getActiveTab(store.getState());
  const result = store
    .getState()
    .previewDrop(
      { kind: "pane", tabId: source.id, paneId: source.focusedPaneId },
      { kind: "pane", tabId: target.id, paneId: target.focusedPaneId, zone: "bottom" },
    );
  expect(result).not.toBeNull();
  store.getState().commitDrop(result!);
  const tab = getActiveTab(store.getState());
  expect(tab.columns?.map((c) => c.paneIds)).toEqual([
    [target.focusedPaneId, source.focusedPaneId],
  ]);
  expect(tab.panes.get(source.focusedPaneId)).toBe(view);
  store.getState().closeView(source.focusedPaneId);
  expect(getActiveTab(store.getState()).columns?.map((c) => c.shares)).toEqual([[1]]);
});

it("rejects a stale drop preview after another presentation command", () => {
  const store = setup();
  store.getState().openTarget(agent("a"));
  const tab = getActiveTab(store.getState());
  const result = store
    .getState()
    .previewDrop(
      { kind: "pane", tabId: tab.id, paneId: tab.focusedPaneId },
      { kind: "newTab", index: 1 },
    )!;
  store.getState().openTarget(agent("b"));
  const current = getActiveTab(store.getState());
  store.getState().commitDrop(result);
  expect(getActiveTab(store.getState())).toBe(current);
});

it("keeps scrolling mode when its final pane closes and recovers damaged column metadata", () => {
  const store = setup();
  store.getState().openTarget(agent("a"));
  store.getState().setLayoutMode("scrolling");
  store.getState().closeView(getActiveTab(store.getState()).focusedPaneId);
  expect(getActiveTab(store.getState()).layoutMode).toBe("scrolling");
  store.getState().openTarget(terminal);
  const saved = JSON.parse(serializeWorkbenchSnapshot(store.getState()));
  saved.tabs[0].columns = [{ id: "broken", width: -5, paneIds: [], shares: [] }];
  saved.tabs[0].layoutMemory = { version: 999, bsp: { type: "leaf", id: "deleted" } };
  const recovered = deserializeWorkbenchSnapshot(JSON.stringify(saved))!;
  expect([...getActiveTab(recovered).panes.values()][0]?.target).toEqual(terminal);
  expect(getActiveTab(recovered).columns?.[0]?.width).toBe(560);
});

it("extracts the first pane of a stack into a distinct independently resizable column", () => {
  const store = setup();
  store.getState().openTarget(agent("a"));
  store.getState().setLayoutMode("scrolling");
  const first = getActiveTab(store.getState()).focusedPaneId;
  store.getState().splitFocused(terminal, "down");
  const tab = getActiveTab(store.getState());
  const second = tab.focusedPaneId;
  const drop = store
    .getState()
    .previewDrop(
      { kind: "pane", tabId: tab.id, paneId: first },
      { kind: "pane", tabId: tab.id, paneId: second, zone: "right" },
    )!;
  store.getState().commitDrop(drop);
  const columns = getActiveTab(store.getState()).columns!;
  expect(columns.map((c) => c.paneIds)).toEqual([[second], [first]]);
  expect(new Set(columns.map((c) => c.id)).size).toBe(2);
  store.getState().changeColumn(columns[1]!.id, { width: 700 });
  expect(getActiveTab(store.getState()).columns?.map((c) => c.width)).toEqual([560, 700]);
  expect(deserializeWorkbenchSnapshot(serializeWorkbenchSnapshot(store.getState()))).not.toBeNull();
});
