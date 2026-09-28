import { expect, it } from "vite-plus/test";
import type { EnvironmentId, WorkspaceId } from "@awen/contracts";
import { createWorkbenchStore } from "./workbenchStore";
import { getActiveTab, getPanePresentation } from "./workbenchState";
import type { ViewTarget } from "./viewRegistry";
import { serializeWorkbenchSnapshot, deserializeWorkbenchSnapshot } from "./workbenchPersistence";

const files = {
  kind: "workspace" as const,
  definitionId: "fileView" as const,
  environmentId: "env" as EnvironmentId,
  workspaceId: "ws" as WorkspaceId,
};
const file = (initialPath: string): ViewTarget => ({ ...files, initialPath });
const makeStore = () => createWorkbenchStore({ persist: () => {} });

it("reuses the Workspace Files Pane when opening successive files", () => {
  const store = makeStore();
  store.getState().openTarget(files);
  const paneId = getActiveTab(store.getState()).focusedPaneId;
  store.getState().openFromPane(paneId, file("a.ts"));
  store.getState().openFromPane(paneId, file("b.ts"));
  expect(getActiveTab(store.getState()).panes.size).toBe(1);
  expect(getActiveTab(store.getState()).focusedPaneId).toBe(paneId);
  expect(getPanePresentation(store.getState(), paneId)?.selectedPath).toBe("b.ts");
  expect(getActiveTab(store.getState()).panes.get(paneId)?.target).toEqual(files);
});

it("restores selected file, line and draft with the Workspace Pane", () => {
  const store = makeStore();
  store.getState().openTarget(file("a.ts"));
  const paneId = getActiveTab(store.getState()).focusedPaneId;
  const fileDraft = { path: "a.ts", contents: "unsaved", contentHash: "original" };
  store.getState().setPanePresentation(paneId, { revealLine: 42, fileDraft });
  const decoded = deserializeWorkbenchSnapshot(serializeWorkbenchSnapshot(store.getState()));
  expect(decoded).not.toBeNull();
  const restored = createWorkbenchStore({ initialSnapshot: decoded!, persist: () => {} });
  expect(getPanePresentation(restored.getState(), paneId)).toEqual({
    selectedPath: "a.ts",
    revealLine: 42,
    fileDraft,
  });
  expect(getActiveTab(restored.getState()).panes.get(paneId)?.target).toEqual(files);
  restored.getState().openTarget(files);
  expect(getPanePresentation(restored.getState(), paneId)?.fileDraft).toEqual(fileDraft);
});

it("opens another file in the existing Files Pane across Tabs without moving it", () => {
  const store = makeStore();
  store.getState().openTarget(file("a.ts"));
  const fileTab = getActiveTab(store.getState());
  store.getState().createTab();
  const source = getActiveTab(store.getState());
  store.getState().openFromPane(source.focusedPaneId, file("b.ts"));
  expect(getActiveTab(store.getState()).id).toBe(fileTab.id);
  expect(getActiveTab(store.getState()).focusedPaneId).toBe(fileTab.focusedPaneId);
  expect(getPanePresentation(store.getState(), fileTab.focusedPaneId)?.selectedPath).toBe("b.ts");
  expect(store.getState().tabs.find((tab) => tab.id === source.id)?.panes.size).toBe(1);
});

it("moves the original Files Pane and its selection on explicit split", () => {
  const store = makeStore();
  store.getState().openTarget(file("a.ts"));
  const paneId = getActiveTab(store.getState()).focusedPaneId;
  store.getState().createTab();
  store.getState().splitFocused(files, "right");
  expect(getActiveTab(store.getState()).focusedPaneId).toBe(paneId);
  expect(getPanePresentation(store.getState(), paneId)?.selectedPath).toBe("a.ts");
  expect(
    store
      .getState()
      .tabs.flatMap((tab) => [...tab.panes.values()])
      .filter((pane) => pane.definitionId === "fileView"),
  ).toHaveLength(1);
});

it("keeps Files, Git and another Workspace's Files as separate Panes", () => {
  const store = makeStore();
  store.getState().openTarget(file("a.ts"));
  const origin = getActiveTab(store.getState()).focusedPaneId;
  store.getState().openFromPane(origin, { ...files, definitionId: "gitView" });
  store
    .getState()
    .openFromPane(origin, { ...files, workspaceId: "other" as WorkspaceId, initialPath: "a.ts" });
  expect(getActiveTab(store.getState()).panes.size).toBe(3);
});

it("keeps a dirty file when switching is cancelled, and switches only after consent", async () => {
  const store = makeStore();
  store.getState().openTarget(file("a.ts"));
  const paneId = getActiveTab(store.getState()).focusedPaneId;
  const draft = { path: "a.ts", contents: "unsaved", contentHash: "original" };
  store.getState().setPanePresentation(paneId, { fileDraft: draft });
  let decide!: (allowed: boolean) => void;
  store.getState().registerCloseGuard(paneId, {
    isDirty: () => Boolean(getPanePresentation(store.getState(), paneId)?.fileDraft),
    confirmClose: () =>
      new Promise((resolve) => {
        decide = resolve;
      }),
  });
  store.getState().createTab();
  const opening = store
    .getState()
    .openFromPane(getActiveTab(store.getState()).focusedPaneId, file("b.ts"));
  expect(getActiveTab(store.getState()).focusedPaneId).toBe(paneId);
  expect(getPanePresentation(store.getState(), paneId)?.selectedPath).toBe("a.ts");
  decide(false);
  expect(await opening).toBe(false);
  expect(getPanePresentation(store.getState(), paneId)?.fileDraft).toEqual(draft);
  const retry = store.getState().openTarget(file("b.ts"));
  decide(true);
  expect(await retry).toBe(true);
  expect(getPanePresentation(store.getState(), paneId)).toMatchObject({
    selectedPath: "b.ts",
    fileDraft: null,
  });
  expect(getActiveTab(store.getState()).panes.size).toBe(1);
});

it("waits for a restored dirty Files Pane to mount before offering the switch decision", async () => {
  const store = makeStore();
  store.getState().openTarget(file("a.ts"));
  const paneId = getActiveTab(store.getState()).focusedPaneId;
  store
    .getState()
    .setPanePresentation(paneId, { fileDraft: { path: "a.ts", contents: "unsaved" } });
  const opening = store.getState().openTarget(file("b.ts"));
  let settled = false;
  void opening.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(getPanePresentation(store.getState(), paneId)?.selectedPath).toBe("a.ts");
  store
    .getState()
    .registerCloseGuard(paneId, { isDirty: () => true, confirmClose: async () => true });
  expect(await opening).toBe(true);
  expect(getPanePresentation(store.getState(), paneId)?.selectedPath).toBe("b.ts");
});

it("rejects unknown definitions, unsafe file paths and old persistence", () => {
  const store = makeStore();
  expect(() =>
    store.getState().openTarget({ ...files, definitionId: "unknown" } as unknown as ViewTarget),
  ).toThrow();
  expect(() => store.getState().openTarget(file("../outside.ts"))).toThrow();
  store.getState().openTarget(file("a.ts"));
  const saved = JSON.parse(serializeWorkbenchSnapshot(store.getState()));
  saved.version = 1;
  expect(deserializeWorkbenchSnapshot(JSON.stringify(saved))).toBeNull();
});

it("rejects a persisted file selection outside its Workspace", () => {
  const store = makeStore();
  store.getState().openTarget(file("a.ts"));
  const saved = JSON.parse(serializeWorkbenchSnapshot(store.getState()));
  saved.tabs[0].panes[0][1].presentation.selectedPath = "../outside.ts";
  expect(deserializeWorkbenchSnapshot(JSON.stringify(saved))).toBeNull();
});

it("cancels pending file navigation if its unmounted Files Pane is closed", async () => {
  const store = makeStore();
  store.getState().openTarget(file("a.ts"));
  const paneId = getActiveTab(store.getState()).focusedPaneId;
  store
    .getState()
    .setPanePresentation(paneId, { fileDraft: { path: "a.ts", contents: "unsaved" } });
  const opening = store.getState().openTarget(file("b.ts"));
  store.getState().closeView(paneId);
  expect(await opening).toBe(false);
  expect(
    store
      .getState()
      .tabs.flatMap((tab) => [...tab.panes.values()])
      .some((pane) => pane.definitionId === "fileView"),
  ).toBe(false);
});
