import {
  columnsTree,
  reconcileColumns,
  LAYOUT_VERSION,
  MIN_COLUMN_WIDTH,
  MAX_COLUMN_WIDTH,
  type Column,
  type LayoutMemory,
} from "./scrollingLayout";
import { leafIds, type LayoutNode } from "./layout";
import { targetKey, isViewTarget, isViewPresentation, definitionIdForTarget } from "./viewCatalog";
import type { PaneView, WorkbenchSnapshot, WorkbenchTab } from "./workbenchState";

export const WORKBENCH_PERSISTENCE_KEY = "awen:workbench:v2";
export const WORKBENCH_PERSISTENCE_BACKUP_KEY = "awen:workbench:v2.backup";
const WORKBENCH_PERSISTENCE_VERSION = 2;

export interface WorkbenchStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLayoutNode(value: unknown): value is LayoutNode {
  if (!isRecord(value)) return false;
  if (value.type === "leaf") return typeof value.id === "string" && value.id.length > 0;
  if (value.type !== "split") return false;
  if (
    typeof value.id !== "string" ||
    (value.dir !== "right" && value.dir !== "down") ||
    !Array.isArray(value.children) ||
    value.children.length < 2 ||
    !Array.isArray(value.sizes) ||
    value.sizes.length !== value.children.length ||
    !value.sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size > 0)
  ) {
    return false;
  }
  return value.children.every(isLayoutNode);
}

function isColumns(value: unknown): value is Column[] {
  if (!Array.isArray(value) || !value.length) return false;
  const ids = new Set<string>();
  const panes = new Set<string>();
  return value.every((c) => {
    if (
      !isRecord(c) ||
      typeof c.id !== "string" ||
      ids.has(c.id) ||
      typeof c.width !== "number" ||
      !Number.isFinite(c.width) ||
      c.width < MIN_COLUMN_WIDTH ||
      c.width > MAX_COLUMN_WIDTH ||
      !Array.isArray(c.paneIds) ||
      !c.paneIds.length ||
      !Array.isArray(c.shares) ||
      c.shares.length !== c.paneIds.length ||
      !c.shares.every((n) => typeof n === "number" && Number.isFinite(n) && n > 0)
    )
      return false;
    ids.add(c.id);
    return c.paneIds.every((id) => {
      if (typeof id !== "string" || !id || panes.has(id)) return false;
      panes.add(id);
      return true;
    });
  });
}

function isPaneView(value: unknown): value is PaneView {
  return (
    isRecord(value) &&
    value.id === undefined &&
    isRecord(value.presentation) &&
    typeof value.definitionId === "string" &&
    value.definitionId.length > 0 &&
    isViewTarget(value.target) &&
    value.definitionId === definitionIdForTarget(value.target) &&
    isViewPresentation(value.target, value.presentation)
  );
}

function decodeWorkbenchTab(value: unknown): WorkbenchTab | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !isLayoutNode(value.layout) ||
    typeof value.focusedPaneId !== "string" ||
    (value.titleMode !== "auto" && value.titleMode !== "manual") ||
    (value.titleOverride !== null && typeof value.titleOverride !== "string") ||
    !Array.isArray(value.panes)
  ) {
    return null;
  }
  const panes = new Map<string, PaneView>();
  const perTabTargetKeys = new Set<string>();
  for (const entry of value.panes) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") return null;
    if (!isPaneView(entry[1]) || panes.has(entry[0])) return null;
    const target = entry[1].target;
    if (target.kind !== "welcome") {
      const key = targetKey(target);
      if (perTabTargetKeys.has(key)) return null;
      perTabTargetKeys.add(key);
    }
    panes.set(entry[0], { ...entry[1], target });
  }
  const ids = leafIds(value.layout);
  if (new Set(ids).size !== ids.length) return null;
  if (ids.length !== panes.size || ids.some((id) => !panes.has(id))) return null;
  if (!panes.has(value.focusedPaneId)) return null;
  if (value.titleMode === "manual" && (value.titleOverride ?? "").trim().length === 0) return null;
  if (
    value.layoutMode !== undefined &&
    value.layoutMode !== "bsp" &&
    value.layoutMode !== "scrolling"
  )
    return null;
  const columns = isColumns(value.columns) ? reconcileColumns(value.columns, ids) : undefined;
  const rawMemory =
    isRecord(value.layoutMemory) && value.layoutMemory.version === LAYOUT_VERSION
      ? value.layoutMemory
      : null;
  const layoutMemory: LayoutMemory | undefined = rawMemory
    ? {
        version: LAYOUT_VERSION,
        ...(isLayoutNode(rawMemory.bsp) &&
        new Set(leafIds(rawMemory.bsp)).size === leafIds(rawMemory.bsp).length
          ? { bsp: rawMemory.bsp }
          : {}),
        ...(isColumns(rawMemory.columns) ? { columns: rawMemory.columns } : {}),
      }
    : undefined;
  // Keep valid work references even when optional layout metadata is damaged.
  const recoveredColumns =
    value.layoutMode === "scrolling" ? (columns ?? reconcileColumns([], ids)) : columns;
  return {
    id: value.id,
    ...(value.layoutMode ? { layoutMode: value.layoutMode } : {}),
    ...(recoveredColumns ? { columns: recoveredColumns } : {}),
    ...(layoutMemory ? { layoutMemory } : {}),
    layout: value.layoutMode === "scrolling" ? columnsTree(recoveredColumns!) : value.layout,
    focusedPaneId: value.focusedPaneId,
    titleMode: value.titleMode,
    titleOverride: value.titleOverride,
    panes,
  };
}

function decodeWorkbenchSnapshot(value: unknown): WorkbenchSnapshot | null {
  if (
    !isRecord(value) ||
    value.version !== WORKBENCH_PERSISTENCE_VERSION ||
    typeof value.activeTabId !== "string" ||
    !Array.isArray(value.tabs) ||
    value.tabs.length === 0
  ) {
    return null;
  }
  const tabs: WorkbenchTab[] = [];
  const tabIds = new Set<string>();
  const paneIds = new Set<string>();
  const resources = new Set<string>();
  for (const candidate of value.tabs) {
    const tab = decodeWorkbenchTab(candidate);
    if (tab === null || tabIds.has(tab.id)) return null;
    for (const [paneId, pane] of tab.panes) {
      if (paneIds.has(paneId)) return null;
      paneIds.add(paneId);
      if (pane.target.kind !== "welcome") {
        const key = targetKey(pane.target);
        if (resources.has(key)) return null;
        resources.add(key);
      }
    }
    tabIds.add(tab.id);
    tabs.push(tab);
  }
  if (!tabIds.has(value.activeTabId)) return null;
  return { tabs, activeTabId: value.activeTabId };
}

export function serializeWorkbenchSnapshot(snapshot: WorkbenchSnapshot): string {
  return JSON.stringify({
    version: WORKBENCH_PERSISTENCE_VERSION,
    activeTabId: snapshot.activeTabId,
    tabs: snapshot.tabs.map((tab) => ({
      id: tab.id,
      layout: tab.layout,
      layoutMode: tab.layoutMode,
      columns: tab.columns,
      layoutMemory: tab.layoutMemory,
      focusedPaneId: tab.focusedPaneId,
      titleMode: tab.titleMode,
      titleOverride: tab.titleOverride,
      panes: [...tab.panes.entries()],
    })),
  });
}

export function deserializeWorkbenchSnapshot(raw: string): WorkbenchSnapshot | null {
  try {
    return decodeWorkbenchSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function resolveStorage(storage?: WorkbenchStorage): WorkbenchStorage | null {
  if (storage !== undefined) return storage;
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readWorkbenchSnapshot(storage?: WorkbenchStorage): WorkbenchSnapshot | null {
  const resolved = resolveStorage(storage);
  if (resolved === null) return null;
  try {
    const raw = resolved.getItem(WORKBENCH_PERSISTENCE_KEY);
    return raw === null ? null : deserializeWorkbenchSnapshot(raw);
  } catch {
    return null;
  }
}

export function writeWorkbenchSnapshot(
  snapshot: WorkbenchSnapshot,
  storage?: WorkbenchStorage,
): void {
  const resolved = resolveStorage(storage);
  if (resolved === null) return;
  try {
    const existing = resolved.getItem(WORKBENCH_PERSISTENCE_KEY);
    if (
      existing !== null &&
      deserializeWorkbenchSnapshot(existing) === null &&
      resolved.getItem(WORKBENCH_PERSISTENCE_BACKUP_KEY) === null
    ) {
      resolved.setItem(WORKBENCH_PERSISTENCE_BACKUP_KEY, existing);
    }
    resolved.setItem(WORKBENCH_PERSISTENCE_KEY, serializeWorkbenchSnapshot(snapshot));
  } catch {
    // Layout persistence is best-effort; a full or blocked storage must not stop work.
  }
}
