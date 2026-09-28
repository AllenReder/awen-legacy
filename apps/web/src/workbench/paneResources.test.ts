import { expect, it } from "vite-plus/test";
import { EnvironmentId, WorkspaceId } from "@awen/contracts";
import { createWorkbenchStore } from "./workbenchStore";
import { getActiveTab } from "./workbenchState";
import type { ViewTarget } from "./viewRegistry";

const file = (path: string): ViewTarget => ({
  kind: "workspace",
  definitionId: "fileEditor",
  environmentId: "env" as EnvironmentId,
  workspaceId: "ws" as WorkspaceId,
  initialPath: path,
});
it("opens different files beside each other and moves the original Pane across Tabs", () => {
  const store = createWorkbenchStore({ persist: () => {} });
  store.getState().openTarget(file("a.ts"));
  const original = getActiveTab(store.getState()).focusedPaneId;
  store.getState().splitPane(original, file("b.ts"), "right");
  expect(getActiveTab(store.getState()).panes.size).toBe(2);
  store.getState().createTab();
  const destination = getActiveTab(store.getState());
  store.getState().splitPane(destination.focusedPaneId, file("a.ts"), "right");
  expect(getActiveTab(store.getState()).focusedPaneId).toBe(original);
  expect(
    store
      .getState()
      .tabs.flatMap((tab) => [...tab.panes.values()])
      .filter((pane) => pane.target.kind === "workspace" && pane.target.initialPath === "a.ts"),
  ).toHaveLength(1);
});

it("restores file targets and Pane presentation from the current format", async () => {
  const { serializeWorkbenchSnapshot, deserializeWorkbenchSnapshot } =
    await import("./workbenchPersistence");
  const store = createWorkbenchStore({ persist: () => {} });
  store.getState().openTarget(file("a.ts"));
  const paneId = getActiveTab(store.getState()).focusedPaneId;
  store.getState().setPanePresentation(paneId, { revealLine: 42 });
  const decoded = deserializeWorkbenchSnapshot(serializeWorkbenchSnapshot(store.getState()));
  expect(decoded).not.toBeNull();
  const restored = createWorkbenchStore({ initialSnapshot: decoded!, persist: () => {} });
  expect(getActiveTab(restored.getState()).panes.get(paneId)?.presentation).toEqual({
    revealLine: 42,
  });
  expect(getActiveTab(restored.getState()).panes.get(paneId)?.target).toEqual(file("a.ts"));
});

it("ordinary source navigation focuses a file in another Tab without moving it", () => {
  const store = createWorkbenchStore({ persist: () => {} });
  store.getState().openTarget(file("a.ts"));
  const fileTab = getActiveTab(store.getState());
  store.getState().createTab();
  store.getState().openTarget(file("b.ts"));
  const source = getActiveTab(store.getState());
  store.getState().openFromPane(source.focusedPaneId, file("a.ts"));
  expect(getActiveTab(store.getState()).id).toBe(fileTab.id);
  expect(getActiveTab(store.getState()).focusedPaneId).toBe(fileTab.focusedPaneId);
  expect(store.getState().tabs.find((tab) => tab.id === source.id)?.panes.size).toBe(1);
});

it("keeps Files, Git and concrete files side by side", () => {
  const store = createWorkbenchStore({ persist: () => {} });
  const {
    initialPath: _,
    revealLine: _line,
    ...files
  } = file("a.ts") as Extract<ViewTarget, { kind: "workspace" }>;
  store.getState().openTarget({ ...files, definitionId: "fileView" });
  const origin = getActiveTab(store.getState()).focusedPaneId;
  store.getState().openFromPane(origin, file("a.ts"));
  store.getState().openFromPane(origin, { ...files, definitionId: "gitView" });
  expect(getActiveTab(store.getState()).panes.size).toBe(3);
});

it("rejects unknown definitions, unsafe file paths and old persistence", async () => {
  const { deserializeWorkbenchSnapshot, serializeWorkbenchSnapshot } =
    await import("./workbenchPersistence");
  const store = createWorkbenchStore({ persist: () => {} });
  expect(() =>
    store
      .getState()
      .openTarget({ ...file("a.ts"), definitionId: "unknown" } as unknown as ViewTarget),
  ).toThrow();
  expect(() => store.getState().openTarget(file("../outside.ts"))).toThrow();
  store.getState().openTarget(file("a.ts"));
  const saved = JSON.parse(serializeWorkbenchSnapshot(store.getState()));
  saved.version = 1;
  expect(deserializeWorkbenchSnapshot(JSON.stringify(saved))).toBeNull();
});
