import {
  columnsTree,
  reconcileColumns,
  reconcileBsp,
  placeInColumns,
  adjacentScrollingPaneTarget,
  LAYOUT_VERSION,
  MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  type Column,
  type LayoutMode,
  type LayoutMemory,
} from "./scrollingLayout";
import {
  closeLeaf,
  firstLeafId,
  leaf,
  leafParent,
  neighborLeafId,
  leafIds,
  movePane,
  newTab,
  placePane,
  removePane,
  replaceLeafId,
  setSplitRatio,
  type AwenTab,
  type FocusDir,
  type PaneEdge,
  type PaneDropZone,
  type SplitDir,
} from "./layout";
import { definitionIdForTarget, targetKey, targetsEqual, type ViewTarget } from "./viewRegistry";
import { fallbackTargetTitle } from "./workbenchTitles";

/** One presentation occurrence, independent of the Session it displays. */
export interface ViewInstance {
  readonly id: string;
  readonly definitionId: string;
  readonly target: ViewTarget;
}

/** Every layout leaf owns exactly one ViewInstance. */
export interface WorkbenchTab extends AwenTab {
  readonly panes: ReadonlyMap<string, ViewInstance>;
  readonly layoutMode?: LayoutMode;
  readonly columns?: readonly Column[];
  readonly layoutMemory?: LayoutMemory;
  readonly titleMode: "auto" | "manual";
  readonly titleOverride: string | null;
}

export interface WorkbenchSnapshot {
  readonly tabs: ReadonlyArray<WorkbenchTab>;
  readonly activeTabId: string;
}

export type SessionViewTarget = Extract<ViewTarget, { kind: "agentSession" | "workspaceTerminal" }>;

export type ViewDragSource =
  | {
      readonly kind: "sidebar";
      readonly target: ViewTarget;
      readonly workspaceId?: import("@awen/contracts").WorkspaceId;
      readonly onCommit?: (result: ViewDropResult) => void;
    }
  | { readonly kind: "pane"; readonly tabId: string; readonly paneId: string }
  | { readonly kind: "tab"; readonly tabId: string };

/**
 * True for the Session kinds whose View is unique across the whole Workbench.
 *
 * ADR-0010 gives a Session exactly one Session View; File, Git, Project, and
 * draft Views keep their own per-Tab rules and are not constrained here.
 */
export function isSessionViewTarget(target: ViewTarget): target is SessionViewTarget {
  return target.kind === "agentSession" || target.kind === "workspaceTerminal";
}

export type ViewDropTarget =
  | {
      readonly kind: "pane";
      readonly tabId: string;
      readonly paneId: string;
      readonly zone: PaneDropZone;
    }
  | { readonly kind: "existingTab"; readonly tabId: string }
  | { readonly kind: "newTab"; readonly index: number };

export interface ViewDropResult {
  readonly snapshot: WorkbenchSnapshot;
  readonly tabId: string;
  readonly paneId: string;
}

export function getActiveTab(snapshot: WorkbenchSnapshot): WorkbenchTab {
  const tab = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
  if (!tab) throw new Error("Workbench active Tab is missing");
  return tab;
}

export type SessionRowTabState =
  | "active-focused"
  | "active-unfocused"
  | "background-tab"
  | "unopened";

export function getSessionRowTabState(
  snapshot: WorkbenchSnapshot,
  target: ViewTarget,
): SessionRowTabState {
  const activeTab = getActiveTab(snapshot);
  const focused = activeTab.panes.get(activeTab.focusedPaneId);
  if (focused !== undefined && targetsEqual(focused.target, target)) {
    return "active-focused";
  }
  for (const pane of activeTab.panes.values()) {
    if (targetsEqual(pane.target, target)) return "active-unfocused";
  }
  for (const otherTab of snapshot.tabs) {
    if (otherTab.id === activeTab.id) continue;
    for (const pane of otherTab.panes.values()) {
      if (targetsEqual(pane.target, target)) return "background-tab";
    }
  }
  return "unopened";
}

function viewInstance(target: ViewTarget, generateId: () => string): ViewInstance {
  return { id: generateId(), definitionId: definitionIdForTarget(target), target };
}

function welcomeTab(generateId: () => string): WorkbenchTab {
  const paneId = generateId();
  return {
    ...newTab(paneId),
    panes: new Map([[paneId, viewInstance({ kind: "welcome" }, generateId)]]),
    titleMode: "auto",
    titleOverride: null,
  };
}

export function emptyWorkbenchSnapshot(generateId: () => string): WorkbenchSnapshot {
  const tab = welcomeTab(generateId);
  return { tabs: [tab], activeTabId: tab.id };
}

export function tabDisplayTitle(
  tab: WorkbenchTab,
  resolveTargetTitle: (target: ViewTarget) => string,
): string {
  if (tab.titleMode === "manual" && tab.titleOverride !== null) return tab.titleOverride;
  const firstPane = tab.panes.get(firstLeafId(tab.layout));
  if (firstPane === undefined) return "Welcome";
  const resolved = resolveTargetTitle(firstPane.target).trim();
  return resolved.length > 0 ? resolved : fallbackTargetTitle(firstPane.target);
}

function updateTab(snapshot: WorkbenchSnapshot, tab: WorkbenchTab): WorkbenchSnapshot {
  tab = reconcileTab(tab);
  return {
    ...snapshot,
    tabs: snapshot.tabs.map((current) => (current.id === tab.id ? tab : current)),
  };
}

export function reconcileTab(tab: WorkbenchTab): WorkbenchTab {
  if (tab.layoutMode !== "scrolling") return tab;
  const ids = leafIds(tab.layout).filter((id) => tab.panes.has(id));
  for (const id of tab.panes.keys()) if (!ids.includes(id)) ids.push(id);
  const columns = reconcileColumns(tab.columns ?? [], ids);
  return { ...tab, columns, layout: columnsTree(columns) };
}

/** Determine the initial drop target and zone for an existing pane in its current tab. */
export function initialPaneDropTarget(tab: WorkbenchTab, paneId: string): ViewDropTarget | null {
  if (tab.panes.size <= 1) return null;
  if (tab.layoutMode === "scrolling") {
    return adjacentScrollingPaneTarget(tab.columns ?? [], tab.id, paneId);
  }

  const parent = leafParent(tab.layout, paneId);
  if (!parent) return null;
  const neighborDir: FocusDir =
    parent.dir === "right"
      ? parent.index > 0
        ? "left"
        : "right"
      : parent.index > 0
        ? "up"
        : "down";
  const neighbor = neighborLeafId(tab.layout, paneId, neighborDir);
  if (!neighbor) return null;
  const zone: PaneDropZone =
    parent.dir === "right"
      ? parent.index === 0
        ? "left"
        : "right"
      : parent.index === 0
        ? "top"
        : "bottom";
  return { kind: "pane", tabId: tab.id, paneId: neighbor, zone };
}

/** Compute the base tab layout when dragging a pane, treating the tab as if the pane is removed. */
export function computeBaseTab(tab: WorkbenchTab, draggedPaneId: string): WorkbenchTab | null {
  if (tab.panes.size <= 1) return null;
  if (!tab.panes.has(draggedPaneId)) return tab;

  const panes = new Map(tab.panes);
  panes.delete(draggedPaneId);

  if (tab.layoutMode === "scrolling") {
    const remainingIds = [...panes.keys()];
    const columns = reconcileColumns(tab.columns ?? [], remainingIds);
    const layout = columnsTree(columns);
    return { ...tab, layout, columns, panes };
  }

  const layout = removePane(tab.layout, draggedPaneId);
  if (layout === null) return null;
  return { ...tab, layout, panes };
}

function placedLayout(tab: WorkbenchTab, paneId: string, targetId: string, zone: PaneDropZone) {
  if (tab.layoutMode !== "scrolling")
    return {
      layout:
        zone === "replace"
          ? replaceLeafId(tab.layout, targetId, paneId)
          : placePane(tab.layout, paneId, targetId, zone),
    };
  const columns = placeInColumns(tab.columns ?? [], paneId, targetId, zone);
  return { columns, layout: columnsTree(columns) };
}

export function applySetLayoutMode(
  snapshot: WorkbenchSnapshot,
  mode: LayoutMode,
): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  if ((tab.layoutMode ?? "bsp") === mode) return snapshot;
  const memory =
    tab.layoutMemory?.version === LAYOUT_VERSION ? tab.layoutMemory : { version: LAYOUT_VERSION };
  const ids = leafIds(tab.layout);
  if (mode === "scrolling") {
    const columns = reconcileColumns(memory.columns ?? [], ids);
    return updateTab(snapshot, {
      ...tab,
      layoutMode: mode,
      columns,
      layout: columnsTree(columns),
      layoutMemory: { ...memory, bsp: tab.layout },
    });
  }
  return updateTab(snapshot, {
    ...tab,
    layoutMode: mode,
    layout: reconcileBsp(memory.bsp, ids),
    layoutMemory: { ...memory, columns: tab.columns ?? [] },
  });
}

export function applyColumnChange(
  snapshot: WorkbenchSnapshot,
  columnId: string,
  change: { width?: number; direction?: -1 | 1; shares?: readonly number[] },
): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  if (tab.layoutMode !== "scrolling") return snapshot;
  const columns = [...(tab.columns ?? [])];
  const index = columns.findIndex((c) => c.id === columnId);
  const column = columns[index];
  if (!column) return snapshot;
  let updated = column;
  if (change.width !== undefined && Number.isFinite(change.width))
    updated = {
      ...updated,
      width: Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, change.width)),
    };
  if (
    change.shares?.length === column.paneIds.length &&
    change.shares.every((n) => Number.isFinite(n) && n > 0)
  ) {
    const sum = change.shares.reduce((a, b) => a + b, 0);
    updated = { ...updated, shares: change.shares.map((n) => n / sum) };
  }
  columns[index] = updated;
  if (change.direction && columns[index + change.direction]) {
    columns[index] = columns[index + change.direction]!;
    columns[index + change.direction] = updated;
  }
  return updateTab(snapshot, { ...tab, columns, layout: columnsTree(columns) });
}

export function applyMoveInColumn(
  snapshot: WorkbenchSnapshot,
  paneId: string,
  direction: -1 | 1,
): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  const columns = tab.columns?.map((column) => {
    const index = column.paneIds.indexOf(paneId);
    if (index < 0 || !column.paneIds[index + direction]) return column;
    const paneIds = [...column.paneIds];
    [paneIds[index], paneIds[index + direction]] = [paneIds[index + direction]!, paneIds[index]!];
    return { ...column, paneIds };
  });
  return tab.layoutMode === "scrolling" && columns
    ? updateTab(snapshot, { ...tab, columns, layout: columnsTree(columns) })
    : snapshot;
}

export function clearedTab(tab: WorkbenchTab, generateId: () => string): WorkbenchTab {
  return reconcileTab({
    ...welcomeTab(generateId),
    id: tab.id,
    titleMode: tab.titleMode,
    titleOverride: tab.titleOverride,
    layoutMode: tab.layoutMode ?? "bsp",
  });
}

function removeViewFromTab(
  tab: WorkbenchTab,
  paneId: string,
  generateId: () => string,
): WorkbenchTab | null {
  if (!tab.panes.has(paneId)) return null;
  const next = closeLeaf(tab, paneId);
  if (next === null) {
    return clearedTab(tab, generateId);
  }
  const panes = new Map(tab.panes);
  panes.delete(paneId);
  return reconcileTab({ ...tab, ...next, panes });
}

/**
 * Put a View into one Tab, either in the anchor Pane or in a new Pane beside it.
 *
 * A Welcome anchor and a center drop both reuse the anchor Pane; a new Pane is
 * only created beside a real View. `paneId` lets a moved View keep the Pane
 * identity it already had.
 */
function placeViewInTab(
  tab: WorkbenchTab,
  view: ViewInstance,
  target: {
    readonly anchorPaneId: string;
    readonly zone: PaneDropZone;
    readonly paneId?: string;
  },
  generateId: () => string,
): { readonly tab: WorkbenchTab; readonly paneId: string } {
  const anchor = tab.panes.get(target.anchorPaneId);
  const reusesAnchorPane =
    target.zone === "replace" ||
    anchor === undefined ||
    (tab.panes.size === 1 && anchor.target.kind === "welcome");

  if (reusesAnchorPane) {
    const paneId = target.paneId ?? target.anchorPaneId;
    const panes = new Map(tab.panes);
    panes.delete(target.anchorPaneId);
    panes.set(paneId, view);
    return {
      tab: {
        ...tab,
        layout: replaceLeafId(tab.layout, target.anchorPaneId, paneId),
        panes,
        focusedPaneId: paneId,
      },
      paneId,
    };
  }

  const paneId = target.paneId ?? generateId();
  const panes = new Map(tab.panes);
  panes.set(paneId, view);
  return {
    tab: {
      ...tab,
      panes,
      ...placedLayout(tab, paneId, target.anchorPaneId, target.zone),
      focusedPaneId: paneId,
    },
    paneId,
  };
}

/**
 * Detach one Pane's View from its Tab, keeping the View instance for reuse.
 *
 * Moving a View preserves its identity: the same `ViewInstance` is placed at
 * the new position while the Pane it came from is closed.
 */
function detachView(
  snapshot: WorkbenchSnapshot,
  location: { readonly tabId: string; readonly paneId: string },
  generateId: () => string,
): { readonly snapshot: WorkbenchSnapshot; readonly view: ViewInstance } | null {
  const tab = snapshot.tabs.find((candidate) => candidate.id === location.tabId);
  const view = tab?.panes.get(location.paneId);
  if (tab === undefined || view === undefined) return null;
  const tabAfter = removeViewFromTab(tab, location.paneId, generateId);
  if (tabAfter === null) return null;
  return {
    snapshot: {
      ...snapshot,
      tabs: snapshot.tabs.map((candidate) => (candidate.id === tab.id ? tabAfter : candidate)),
    },
    view,
  };
}

/**
 * Place a detached Session View beside one anchor Pane.
 *
 * An explicit split names its anchor, so the moved View lands next to the Pane
 * the gesture came from rather than the active Tab's focus.
 */
function placeDetachedViewBeside(
  snapshot: WorkbenchSnapshot,
  view: ViewInstance,
  anchorPaneId: string,
  dir: SplitDir,
  generateId: () => string,
): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  // A Tab that just lost its only View is back to Welcome; the moved View
  // simply takes that Pane instead of splitting off a second one.
  const anchor = tab.panes.has(anchorPaneId) ? anchorPaneId : firstLeafId(tab.layout);
  const placed = placeViewInTab(
    tab,
    view,
    { anchorPaneId: anchor, zone: dir === "down" ? "bottom" : "right" },
    generateId,
  );
  return updateTab(snapshot, placed.tab);
}

function insertPresentationTab(
  snapshot: WorkbenchSnapshot,
  view: ViewInstance,
  index: number,
  generateId: () => string,
  paneId = generateId(),
): ViewDropResult {
  const tab: WorkbenchTab = {
    ...newTab(paneId),
    panes: new Map([[paneId, view]]),
    titleMode: "auto",
    titleOverride: null,
  };
  const tabs = [...snapshot.tabs];
  tabs.splice(Math.max(0, Math.min(index, tabs.length)), 0, tab);
  return { snapshot: { tabs, activeTabId: tab.id }, tabId: tab.id, paneId };
}

/**
 * Focus an existing Session View across tabs (leftmost tab if multiple, or current tab if open in active tab);
 * otherwise replace an active Welcome View or create a new Tab next to the active Tab.
 */
export function applyOpenTarget(
  snapshot: WorkbenchSnapshot,
  target: ViewTarget,
  generateId: () => string,
): WorkbenchSnapshot {
  // 1. If already open in the active Tab, focus it directly.
  const activeTab = getActiveTab(snapshot);
  const existingInActive = findPaneByTarget(activeTab, target);
  if (existingInActive !== null) return applySetFocused(snapshot, existingInActive);

  // 2. If already open in another Tab, activate the leftmost Tab containing it and focus.
  for (const tab of snapshot.tabs) {
    if (tab.id === activeTab.id) continue;
    const existingPaneId = findPaneByTarget(tab, target);
    if (existingPaneId !== null) {
      return applySetFocused(applyActivateTab(snapshot, tab.id), existingPaneId);
    }
  }

  // 3. Not open in any Tab:
  // 3a. If the active Tab is an empty Welcome Tab, replace it in-place.
  const isSoleWelcome =
    activeTab.panes.size === 1 && [...activeTab.panes.values()][0]?.target.kind === "welcome";

  if (isSoleWelcome) {
    const paneId = activeTab.focusedPaneId;
    const panes = new Map(activeTab.panes);
    panes.set(paneId, viewInstance(target, generateId));
    return updateTab(snapshot, { ...activeTab, panes });
  }

  // 3b. Otherwise, create a new Tab immediately to the right of the active Tab.
  const activeIndex = snapshot.tabs.findIndex((tab) => tab.id === snapshot.activeTabId);
  const insertIndex = activeIndex >= 0 ? activeIndex + 1 : snapshot.tabs.length;
  return insertPresentationTab(snapshot, viewInstance(target, generateId), insertIndex, generateId)
    .snapshot;
}

/**
 * Deep links are recovery inputs, not layout owners. Focus an existing target,
 * replace a sole Welcome View, or create a new Tab without mutating restored work.
 */
export function applyOpenDeepLinkTarget(
  snapshot: WorkbenchSnapshot,
  target: ViewTarget,
  generateId: () => string,
): WorkbenchSnapshot {
  return applyOpenTarget(snapshot, target, generateId);
}

export function applySplitPane(
  snapshot: WorkbenchSnapshot,
  sourcePaneId: string,
  target: ViewTarget,
  dir: SplitDir,
  generateId: () => string,
): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  if (!tab.panes.has(sourcePaneId)) return applyOpenTarget(snapshot, target, generateId);

  // An explicit split is a layout intent. A Session View is unique across the
  // Workbench (ADR-0010), so an already-open Session moves to the requested
  // position instead of gaining a second View — including into an empty Tab.
  const location = findSessionViewPane(snapshot, target);
  if (location !== null) {
    if (location.tabId === tab.id && location.paneId === sourcePaneId) {
      return applySetFocused(snapshot, location.paneId);
    }
    const detached = detachView(snapshot, location, generateId);
    if (detached === null) return snapshot;
    return placeDetachedViewBeside(detached.snapshot, detached.view, sourcePaneId, dir, generateId);
  }

  if (tab.panes.get(sourcePaneId)?.target.kind === "welcome") {
    return applyOpenTarget(snapshot, target, generateId);
  }

  const existing = findPaneByTarget(tab, target);
  if (existing !== null) return applySetFocused(snapshot, existing);
  const paneId = generateId();
  const panes = new Map(tab.panes);
  panes.set(paneId, viewInstance(target, generateId));
  return updateTab(snapshot, {
    ...tab,
    panes,
    ...placedLayout(tab, paneId, sourcePaneId, dir === "down" ? "bottom" : "right"),
    focusedPaneId: paneId,
  });
}

export function applySplitFocused(
  snapshot: WorkbenchSnapshot,
  target: ViewTarget,
  dir: SplitDir,
  generateId: () => string,
): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  return applySplitPane(snapshot, tab.focusedPaneId, target, dir, generateId);
}

/** Closing presentation never stops or deletes its Session. */
export function applyClosePane(
  snapshot: WorkbenchSnapshot,
  paneId: string,
  generateId: () => string,
): WorkbenchSnapshot | null {
  const tab = getActiveTab(snapshot);
  const view = tab.panes.get(paneId);
  if (view === undefined) return null;
  const next = closeLeaf(tab, paneId);
  if (next === null) {
    // Closing a sole Welcome Pane is a no-op, and the Workbench always keeps at
    // least one Tab (ADR-0013): the final Tab recovers Welcome instead of
    // closing.
    if (view.target.kind === "welcome" || snapshot.tabs.length <= 1) {
      return updateTab(snapshot, clearedTab(tab, generateId));
    }
    // An explicit Pane close that empties its Tab closes the Tab (ADR-0023).
    return applyCloseTab(snapshot, tab.id);
  }
  const panes = new Map(tab.panes);
  panes.delete(paneId);
  return updateTab(snapshot, { ...tab, ...next, panes });
}

export function applySetFocused(snapshot: WorkbenchSnapshot, paneId: string): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  if (!tab.panes.has(paneId) || tab.focusedPaneId === paneId) return snapshot;
  return updateTab(snapshot, { ...tab, focusedPaneId: paneId });
}

/** Replace a Pane's target while preserving the ViewInstance identity. */
export function applyReplacePaneTarget(
  snapshot: WorkbenchSnapshot,
  paneId: string,
  target: ViewTarget,
  generateId: () => string,
): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  const view = tab.panes.get(paneId);
  if (view === undefined) return snapshot;

  // Binding a Pane to a target that already has a View must not create a
  // second one: a Session View is unique across the Workbench (ADR-0010),
  // while Project/Workspace/File targets keep their per-Tab rule.
  const sessionLocation = findSessionViewPane(snapshot, target);
  const localPaneId = findPaneByTarget(tab, target);
  const existing =
    sessionLocation ?? (localPaneId === null ? null : { tabId: tab.id, paneId: localPaneId });

  if (existing !== null && (existing.tabId !== tab.id || existing.paneId !== paneId)) {
    const panes = new Map(tab.panes);
    panes.delete(paneId);
    const withoutPane = closeLeaf(tab, paneId);
    const localTab =
      withoutPane === null
        ? clearedTab(tab, generateId)
        : reconcileTab({ ...tab, ...withoutPane, panes });
    const tabs = snapshot.tabs.map((candidate) => (candidate.id === tab.id ? localTab : candidate));
    return applySetFocused(
      applyActivateTab({ ...snapshot, tabs }, existing.tabId),
      existing.paneId,
    );
  }

  const panes = new Map(tab.panes);
  panes.set(paneId, {
    ...view,
    definitionId: definitionIdForTarget(target),
    target,
  });
  return updateTab(snapshot, { ...tab, panes });
}

/**
 * Detach a dragged Sidebar Session when the Workbench already shows it.
 *
 * Returns null when the target has no Session View yet, so the caller opens a
 * fresh one; otherwise the caller re-places the same ViewInstance and the
 * Pane it came from is closed.
 */
function takeDraggedSessionView(
  snapshot: WorkbenchSnapshot,
  target: ViewTarget,
  generateId: () => string,
): {
  readonly snapshot: WorkbenchSnapshot;
  readonly view: ViewInstance;
  readonly location: { readonly tabId: string; readonly paneId: string };
} | null {
  const location = findSessionViewPane(snapshot, target);
  if (location === null) return null;
  const detached = detachView(snapshot, location, generateId);
  if (detached === null) return null;
  return { snapshot: detached.snapshot, view: detached.view, location };
}

/** Insert a View into an existing Tab, reusing a sole Welcome Pane. */
function openSidebarViewInTab(
  snapshot: WorkbenchSnapshot,
  tabId: string,
  view: ViewInstance,
  generateId: () => string,
): ViewDropResult | null {
  const targetTab = snapshot.tabs.find((candidate) => candidate.id === tabId);
  if (targetTab === undefined) return null;
  const anchorPaneId = targetTab.panes.has(targetTab.focusedPaneId)
    ? targetTab.focusedPaneId
    : firstLeafId(targetTab.layout);
  const placed = placeViewInTab(targetTab, view, { anchorPaneId, zone: "right" }, generateId);
  return {
    snapshot: updateTab(applyActivateTab(snapshot, tabId), placed.tab),
    tabId,
    paneId: placed.paneId,
  };
}

/** Place Sidebar content at a Pane drop position, replacing on a center drop. */
function placeSidebarViewInPane(
  snapshot: WorkbenchSnapshot,
  view: ViewInstance,
  tabId: string,
  targetPaneId: string,
  zone: PaneDropZone,
  generateId: () => string,
): ViewDropResult | null {
  const tab = snapshot.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined || !tab.panes.has(targetPaneId)) return null;
  const placed = placeViewInTab(tab, view, { anchorPaneId: targetPaneId, zone }, generateId);
  return { snapshot: updateTab(snapshot, placed.tab), tabId, paneId: placed.paneId };
}

/** Apply one drag/drop transaction without owning runtime Session lifecycle. */
export function applyViewDrop(
  snapshot: WorkbenchSnapshot,
  source: ViewDragSource,
  target: ViewDropTarget,
  generateId: () => string,
): ViewDropResult | null {
  if (source.kind === "tab") {
    const fromIndex = snapshot.tabs.findIndex((candidate) => candidate.id === source.tabId);
    if (fromIndex < 0) return null;
    const tab = snapshot.tabs[fromIndex]!;
    const paneId = firstLeafId(tab.layout);

    if (target.kind === "existingTab") {
      const toIndex = snapshot.tabs.findIndex((candidate) => candidate.id === target.tabId);
      if (toIndex < 0 || fromIndex === toIndex) {
        return { snapshot, tabId: tab.id, paneId };
      }
      return {
        snapshot: applyMoveTab(snapshot, fromIndex, toIndex),
        tabId: tab.id,
        paneId,
      };
    }

    if (target.kind === "newTab") {
      const targetIndex = Math.max(0, Math.min(target.index, snapshot.tabs.length - 1));
      if (fromIndex === targetIndex) {
        return { snapshot, tabId: tab.id, paneId };
      }
      return {
        snapshot: applyMoveTab(snapshot, fromIndex, targetIndex),
        tabId: tab.id,
        paneId,
      };
    }

    if (target.kind === "pane") {
      if (source.tabId === snapshot.activeTabId || target.tabId !== snapshot.activeTabId) {
        return null;
      }
      if (tab.panes.size !== 1) {
        return null;
      }
      const sourcePaneId = firstLeafId(tab.layout);
      const sourceView = tab.panes.get(sourcePaneId);
      if (!sourceView) return null;

      const targetTab = snapshot.tabs.find((candidate) => candidate.id === target.tabId);
      if (!targetTab || !targetTab.panes.has(target.paneId)) {
        return null;
      }

      if (findPaneByTarget(targetTab, sourceView.target) !== null) {
        return null;
      }

      const targetPane = targetTab.panes.get(target.paneId);
      let targetAfter: WorkbenchTab;
      if (targetTab.panes.size === 1 && targetPane?.target.kind === "welcome") {
        const panes = new Map<string, ViewInstance>();
        panes.set(sourcePaneId, sourceView);
        targetAfter = reconcileTab({
          ...targetTab,
          layout: leaf(sourcePaneId),
          panes,
          focusedPaneId: sourcePaneId,
        });
      } else {
        if (target.zone === "replace") {
          return null;
        }
        const panes = new Map(targetTab.panes);
        panes.set(sourcePaneId, sourceView);
        targetAfter = reconcileTab({
          ...targetTab,
          ...placedLayout(targetTab, sourcePaneId, target.paneId, target.zone),
          panes,
          focusedPaneId: sourcePaneId,
        });
      }

      const remainingTabs = snapshot.tabs.filter((candidate) => candidate.id !== source.tabId);
      const tabs = remainingTabs.map((candidate) =>
        candidate.id === targetTab.id ? targetAfter : candidate,
      );

      return {
        snapshot: {
          ...snapshot,
          tabs,
          activeTabId: targetTab.id,
        },
        tabId: targetTab.id,
        paneId: sourcePaneId,
      };
    }

    return null;
  }

  if (source.kind === "pane" && target.kind === "pane") {
    const sourceTab = snapshot.tabs.find((candidate) => candidate.id === source.tabId);
    const targetTab = snapshot.tabs.find((candidate) => candidate.id === target.tabId);
    if (
      sourceTab === undefined ||
      targetTab === undefined ||
      !sourceTab.panes.has(source.paneId) ||
      !targetTab.panes.has(target.paneId) ||
      source.paneId === target.paneId
    ) {
      return null;
    }
    if (sourceTab.id === targetTab.id) {
      const edge: PaneEdge = target.zone === "replace" ? "right" : target.zone;
      return {
        snapshot: updateTab(snapshot, {
          ...sourceTab,
          ...(sourceTab.layoutMode === "scrolling"
            ? placedLayout(sourceTab, source.paneId, target.paneId, edge)
            : { layout: movePane(sourceTab.layout, source.paneId, target.paneId, edge) }),
          focusedPaneId: source.paneId,
        }),
        tabId: sourceTab.id,
        paneId: source.paneId,
      };
    }
    const view = sourceTab.panes.get(source.paneId)!;
    if (findPaneByTarget(targetTab, view.target) !== null) return null;
    const sourceAfter = removeViewFromTab(sourceTab, source.paneId, generateId);
    if (!sourceAfter) return null;
    const panes = new Map(targetTab.panes);
    if (target.zone === "replace") panes.delete(target.paneId);
    panes.set(source.paneId, view);
    const targetAfter = reconcileTab({
      ...targetTab,
      ...placedLayout(targetTab, source.paneId, target.paneId, target.zone),
      panes,
      focusedPaneId: source.paneId,
    });
    return {
      snapshot: {
        ...snapshot,
        activeTabId: targetTab.id,
        tabs: snapshot.tabs.map((tab) =>
          tab.id === sourceTab.id ? sourceAfter : tab.id === targetTab.id ? targetAfter : tab,
        ),
      },
      tabId: targetTab.id,
      paneId: source.paneId,
    };
  }

  if (source.kind === "pane" && target.kind === "existingTab") {
    const sourceTab = snapshot.tabs.find((candidate) => candidate.id === source.tabId);
    const targetTab = snapshot.tabs.find((candidate) => candidate.id === target.tabId);
    if (
      sourceTab === undefined ||
      targetTab === undefined ||
      sourceTab.id === targetTab.id ||
      !sourceTab.panes.has(source.paneId) ||
      findPaneByTarget(targetTab, sourceTab.panes.get(source.paneId)!.target) !== null
    ) {
      return null;
    }
    const sourceView = sourceTab.panes.get(source.paneId);
    if (sourceView === undefined) return null;
    const anchorPaneId = targetTab.panes.has(targetTab.focusedPaneId)
      ? targetTab.focusedPaneId
      : firstLeafId(targetTab.layout);
    const inserted = placeViewInTab(
      targetTab,
      sourceView,
      { anchorPaneId, zone: "right", paneId: source.paneId },
      generateId,
    );
    const sourceAfter = removeViewFromTab(sourceTab, source.paneId, generateId);
    if (sourceAfter === null) return null;
    const tabs = snapshot.tabs.map((tab) => {
      if (tab.id === sourceTab.id) return sourceAfter;
      if (tab.id === targetTab.id) return reconcileTab(inserted.tab);
      return tab;
    });
    return {
      snapshot: { tabs, activeTabId: targetTab.id },
      tabId: targetTab.id,
      paneId: inserted.paneId,
    };
  }

  if (source.kind === "pane" && target.kind === "newTab") {
    const sourceTab = snapshot.tabs.find((candidate) => candidate.id === source.tabId);
    if (sourceTab === undefined || !sourceTab.panes.has(source.paneId)) return null;
    const sourceView = sourceTab.panes.get(source.paneId);
    if (sourceView === undefined) return null;
    const sourceAfter = removeViewFromTab(sourceTab, source.paneId, generateId);
    if (sourceAfter === null) return null;
    const nextSnapshot = {
      ...snapshot,
      tabs: snapshot.tabs.map((candidate) =>
        candidate.id === sourceTab.id ? sourceAfter : candidate,
      ),
    };
    return insertPresentationTab(nextSnapshot, sourceView, target.index, generateId, source.paneId);
  }

  if (source.kind === "sidebar" && target.kind === "existingTab") {
    const targetTab = snapshot.tabs.find((candidate) => candidate.id === target.tabId);
    if (targetTab === undefined) return null;

    // Dropping Sidebar content is an explicit layout intent: an already-open
    // Session moves to the target Tab instead of gaining a second View.
    const dragged = takeDraggedSessionView(snapshot, source.target, generateId);
    if (dragged !== null && dragged.location.tabId === targetTab.id) {
      return {
        snapshot: applySetFocused(
          applyActivateTab(snapshot, targetTab.id),
          dragged.location.paneId,
        ),
        tabId: targetTab.id,
        paneId: dragged.location.paneId,
      };
    }
    return openSidebarViewInTab(
      dragged === null ? snapshot : dragged.snapshot,
      targetTab.id,
      dragged === null ? viewInstance(source.target, generateId) : dragged.view,
      generateId,
    );
  }

  if (source.kind === "sidebar" && target.kind === "newTab") {
    const dragged = takeDraggedSessionView(snapshot, source.target, generateId);
    return dragged === null
      ? insertPresentationTab(
          snapshot,
          viewInstance(source.target, generateId),
          target.index,
          generateId,
        )
      : insertPresentationTab(
          dragged.snapshot,
          dragged.view,
          target.index,
          generateId,
          dragged.location.paneId,
        );
  }

  if (source.kind !== "sidebar" || target.kind !== "pane") return null;
  const tab = snapshot.tabs.find((candidate) => candidate.id === target.tabId);
  if (tab === undefined || !tab.panes.has(target.paneId)) return null;

  const dragged = takeDraggedSessionView(snapshot, source.target, generateId);
  if (dragged !== null) {
    if (dragged.location.tabId === tab.id && dragged.location.paneId === target.paneId) {
      return {
        snapshot: applySetFocused(applyActivateTab(snapshot, tab.id), dragged.location.paneId),
        tabId: tab.id,
        paneId: dragged.location.paneId,
      };
    }
    return placeSidebarViewInPane(
      dragged.snapshot,
      dragged.view,
      tab.id,
      target.paneId,
      target.zone,
      generateId,
    );
  }

  return placeSidebarViewInPane(
    snapshot,
    viewInstance(source.target, generateId),
    tab.id,
    target.paneId,
    target.zone,
    generateId,
  );
}

export function applySetSplitRatio(
  snapshot: WorkbenchSnapshot,
  splitId: string,
  index: number,
  ratio: number,
): WorkbenchSnapshot {
  const tab = getActiveTab(snapshot);
  if (!Number.isFinite(ratio)) return snapshot;
  const layout = setSplitRatio(tab.layout, splitId, index, ratio);
  return layout === tab.layout ? snapshot : updateTab(snapshot, { ...tab, layout });
}

/** Find a pane in a Tab that displays the given Session target. */
function findPaneBySessionTarget(tab: WorkbenchTab, target: ViewTarget): string | null {
  for (const [paneId, view] of tab.panes) {
    if (isSameSessionTarget(view.target, target)) return paneId;
  }
  return null;
}

/**
 * Locate the Workbench's single Session View for a target, leftmost Tab first.
 *
 * Non-Session targets return null: File, Git, Project, and draft Views keep
 * their own per-Tab rules (ADR-0008) rather than Workbench uniqueness.
 */
export function findSessionViewPane(
  snapshot: WorkbenchSnapshot,
  target: ViewTarget,
): { readonly tabId: string; readonly paneId: string } | null {
  if (!isSessionViewTarget(target)) return null;
  for (const tab of snapshot.tabs) {
    const paneId = findPaneBySessionTarget(tab, target);
    if (paneId !== null) return { tabId: tab.id, paneId };
  }
  return null;
}

/** Whether the Session's one View holds focus in the active Tab. */
export function isSessionViewFocused(snapshot: WorkbenchSnapshot, target: ViewTarget): boolean {
  const location = findSessionViewPane(snapshot, target);
  return (
    location !== null &&
    location.tabId === snapshot.activeTabId &&
    getActiveTab(snapshot).focusedPaneId === location.paneId
  );
}

function findPaneByTarget(tab: WorkbenchTab, target: ViewTarget): string | null {
  const key = targetKey(target);
  for (const [paneId, view] of tab.panes) {
    if (targetKey(view.target) === key) return paneId;
  }
  return null;
}

export function getPaneTarget(snapshot: WorkbenchSnapshot, paneId: string): ViewTarget | null {
  return getActiveTab(snapshot).panes.get(paneId)?.target ?? null;
}

export function paneTargetKey(snapshot: WorkbenchSnapshot, paneId: string): string | null {
  const target = getPaneTarget(snapshot, paneId);
  return target === null ? null : targetKey(target);
}

export type { AwenTab, SplitDir };

/** Create a presentation area; Tabs have no Workspace owner. */
export function applyCreateTab(
  snapshot: WorkbenchSnapshot,
  generateId: () => string,
): WorkbenchSnapshot {
  const tab = welcomeTab(generateId);
  return { tabs: [...snapshot.tabs, tab], activeTabId: tab.id };
}

export function applyActivateTab(snapshot: WorkbenchSnapshot, tabId: string): WorkbenchSnapshot {
  return snapshot.tabs.some((tab) => tab.id === tabId) && snapshot.activeTabId !== tabId
    ? { ...snapshot, activeTabId: tabId }
    : snapshot;
}

export function applyRenameTab(
  snapshot: WorkbenchSnapshot,
  tabId: string,
  title: string | null,
): WorkbenchSnapshot {
  const tab = snapshot.tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined) return snapshot;
  const trimmed = title?.trim() ?? "";
  return updateTab(snapshot, {
    ...tab,
    titleMode: trimmed.length === 0 ? "auto" : "manual",
    titleOverride: trimmed.length === 0 ? null : trimmed,
  });
}

export function applyCloseTab(snapshot: WorkbenchSnapshot, tabId: string): WorkbenchSnapshot {
  if (snapshot.tabs.length <= 1) return snapshot;
  const closingIndex = snapshot.tabs.findIndex((tab) => tab.id === tabId);
  if (closingIndex < 0) return snapshot;
  const tabs = snapshot.tabs.filter((tab) => tab.id !== tabId);
  if (snapshot.activeTabId !== tabId) return { ...snapshot, tabs };
  return {
    ...snapshot,
    tabs,
    activeTabId: activeTabIdAfterClose(snapshot, tabs, new Set([tabId])),
  };
}

/**
 * Pick the active Tab after some Tabs are removed.
 *
 * Prefers the survivor at the closed active Tab's index, else the last
 * survivor. Shared by the direct Tab close and by bulk close that empties
 * Tabs, so both honour one rule. Assumes at least one survivor.
 */
export function activeTabIdAfterClose(
  snapshot: WorkbenchSnapshot,
  survivors: ReadonlyArray<WorkbenchTab>,
  closedTabIds: ReadonlySet<string>,
): string {
  if (!closedTabIds.has(snapshot.activeTabId)) return snapshot.activeTabId;
  const closingIndex = snapshot.tabs.findIndex((tab) => tab.id === snapshot.activeTabId);
  const nextActive = survivors[Math.min(Math.max(closingIndex, 0), survivors.length - 1)];
  return nextActive?.id ?? survivors[0]!.id;
}

export function applyMoveTab(
  snapshot: WorkbenchSnapshot,
  fromIndex: number,
  toIndex: number,
): WorkbenchSnapshot {
  if (
    fromIndex < 0 ||
    fromIndex >= snapshot.tabs.length ||
    toIndex < 0 ||
    toIndex >= snapshot.tabs.length ||
    fromIndex === toIndex
  ) {
    return snapshot;
  }
  const nextTabs = [...snapshot.tabs];
  const [moved] = nextTabs.splice(fromIndex, 1);
  if (!moved) return snapshot;
  nextTabs.splice(toIndex, 0, moved);
  return { ...snapshot, tabs: nextTabs };
}

/** Compare two targets by stable Session identity. */
export function isSameSessionTarget(a: ViewTarget, b: ViewTarget): boolean {
  if (a.kind === "agentSession" && b.kind === "agentSession") {
    return a.environmentId === b.environmentId && a.agentSessionId === b.agentSessionId;
  }
  if (a.kind === "workspaceTerminal" && b.kind === "workspaceTerminal") {
    return a.environmentId === b.environmentId && a.terminalSessionId === b.terminalSessionId;
  }
  return false;
}

/** How a Tab that loses its last Pane via bulk removal should be recovered. */
type EmptiedTabPolicy = "welcome" | "close";

/**
 * Close the given Panes per Tab, recovering Welcome and focus like closeView.
 *
 * `emptiedTabPolicy` selects what happens when a Tab loses every Pane:
 * background reconciliation (`"welcome"`, the default) keeps the Tab as
 * Welcome, while an explicit close (`"close"`) closes the Tab, still keeping at
 * least one Tab. Callers that pass `"close"` must not match Welcome Views.
 */
function removePaneIdsFromTabs(
  snapshot: WorkbenchSnapshot,
  removals: ReadonlyMap<string, ReadonlySet<string>>,
  generateId: () => string,
  emptiedTabPolicy: EmptiedTabPolicy = "welcome",
): WorkbenchSnapshot {
  if (removals.size === 0) return snapshot;
  const emptiedTabIds = new Set<string>();
  const tabs = snapshot.tabs.map((tab) => {
    const paneIds = removals.get(tab.id);
    if (paneIds === undefined || paneIds.size === 0) return tab;
    let currentTab: AwenTab | null = { ...tab };
    const panes = new Map(tab.panes);
    for (const paneId of paneIds) {
      panes.delete(paneId);
      if (currentTab !== null) {
        currentTab = closeLeaf(currentTab, paneId);
      }
    }
    if (currentTab === null) {
      emptiedTabIds.add(tab.id);
      return clearedTab(tab, generateId);
    }
    const validFocus = leafIds(currentTab.layout).includes(currentTab.focusedPaneId)
      ? currentTab.focusedPaneId
      : firstLeafId(currentTab.layout);
    return reconcileTab({
      ...tab,
      layout: currentTab.layout,
      focusedPaneId: validFocus,
      panes,
    });
  });

  if (emptiedTabPolicy === "welcome" || emptiedTabIds.size === 0) {
    return { ...snapshot, tabs };
  }

  // Explicit close: a Tab that lost its last View is closed (ADR-0023), but the
  // Workbench always keeps at least one Tab (ADR-0013).
  const survivors = tabs.filter((tab) => !emptiedTabIds.has(tab.id));
  if (survivors.length === 0) {
    const keeper = tabs.find((tab) => tab.id === snapshot.activeTabId) ?? tabs[0]!;
    return { ...snapshot, tabs: [keeper], activeTabId: keeper.id };
  }
  return {
    ...snapshot,
    tabs: survivors,
    activeTabId: activeTabIdAfterClose(snapshot, survivors, emptiedTabIds),
  };
}

/** Collect the Pane ids to close, grouped by Tab, for one match predicate. */
function paneIdsMatching(
  snapshot: WorkbenchSnapshot,
  matches: (target: ViewTarget) => boolean,
): Map<string, Set<string>> {
  const removals = new Map<string, Set<string>>();
  for (const tab of snapshot.tabs) {
    for (const [paneId, view] of tab.panes) {
      if (!matches(view.target)) continue;
      const paneIds = removals.get(tab.id) ?? new Set<string>();
      paneIds.add(paneId);
      removals.set(tab.id, paneIds);
    }
  }
  return removals;
}

function applyRemoveMatchingViews(
  snapshot: WorkbenchSnapshot,
  matches: (target: ViewTarget) => boolean,
  generateId: () => string,
  emptiedTabPolicy: EmptiedTabPolicy = "welcome",
): WorkbenchSnapshot {
  return removePaneIdsFromTabs(
    snapshot,
    paneIdsMatching(snapshot, matches),
    generateId,
    emptiedTabPolicy,
  );
}

/**
 * Remove every ViewInstance displaying this Session from every Tab.
 *
 * Preserves the surviving Tabs and their Views. A Tab that held only this
 * Session's View is closed (ADR-0023); the final Tab recovers Welcome.
 */
export function applyRemoveSessionViews(
  snapshot: WorkbenchSnapshot,
  target: ViewTarget,
  generateId: () => string,
): WorkbenchSnapshot {
  return applyRemoveMatchingViews(
    snapshot,
    (candidate) => isSameSessionTarget(candidate, target),
    generateId,
    "close",
  );
}

/**
 * Repair a restored layout that still shows one Session in several Tabs.
 *
 * Snapshots written before ADR-0010 could contain mirrors. Keep the occurrence
 * the user is most likely to be looking at — the active Tab's focused Pane,
 * else the active Tab, else the leftmost Tab — and close the rest instead of
 * rejecting the whole snapshot and losing every Tab.
 */
export function applyDedupeSessionViews(
  snapshot: WorkbenchSnapshot,
  generateId: () => string,
): WorkbenchSnapshot {
  const occurrences = new Map<string, Array<{ readonly tabId: string; readonly paneId: string }>>();
  for (const tab of snapshot.tabs) {
    for (const [paneId, view] of tab.panes) {
      if (!isSessionViewTarget(view.target)) continue;
      const key = targetKey(view.target);
      const entries = occurrences.get(key) ?? [];
      entries.push({ tabId: tab.id, paneId });
      occurrences.set(key, entries);
    }
  }

  const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
  const removals = new Map<string, Set<string>>();
  for (const entries of occurrences.values()) {
    if (entries.length <= 1) continue;
    const keeper =
      entries.find(
        (entry) =>
          entry.tabId === snapshot.activeTabId && entry.paneId === activeTab?.focusedPaneId,
      ) ??
      entries.find((entry) => entry.tabId === snapshot.activeTabId) ??
      entries[0]!;
    for (const entry of entries) {
      if (entry.tabId === keeper.tabId && entry.paneId === keeper.paneId) continue;
      const paneIds = removals.get(entry.tabId) ?? new Set<string>();
      paneIds.add(entry.paneId);
      removals.set(entry.tabId, paneIds);
    }
  }

  return removePaneIdsFromTabs(snapshot, removals, generateId);
}

/** Remove legacy Workspace overview Views from restored layouts. */
export function applyRemoveWorkspaceViews(
  snapshot: WorkbenchSnapshot,
  generateId: () => string,
): WorkbenchSnapshot {
  return applyRemoveMatchingViews(snapshot, (target) => target.kind === "workspace", generateId);
}

export interface KnownWorkspace {
  readonly environmentId: string;
  readonly workspaceId: string;
}

/** Remove Views whose scoped Workspace is no longer present in projections. */
export function applyPruneWorkspaceViews(
  snapshot: WorkbenchSnapshot,
  knownWorkspaces: ReadonlyArray<KnownWorkspace>,
  generateId: () => string,
  observedEnvironmentIds: ReadonlyArray<string> = [],
): WorkbenchSnapshot {
  const known = new Set(
    knownWorkspaces.map((workspace) => `${workspace.environmentId}:${workspace.workspaceId}`),
  );
  const observedEnvironments = new Set(observedEnvironmentIds);
  return applyRemoveMatchingViews(
    snapshot,
    (target) => {
      switch (target.kind) {
        case "workspace":
          return (
            observedEnvironments.has(target.environmentId) &&
            !known.has(`${target.environmentId}:${target.workspaceId}`)
          );
        case "workspaceTerminal":
          // A terminal's Workspace is a mutable assignment. Unregistering the
          // Workspace must not close or replace a still-running terminal.
          return false;
        case "project":
        case "agentSession":
        case "welcome":
          return false;
      }
    },
    generateId,
  );
}
