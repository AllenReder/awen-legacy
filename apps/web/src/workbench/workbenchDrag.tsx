import {
  MessageSquarePlusIcon,
  TerminalIcon,
  MoveIcon,
  FolderIcon,
  GitBranchIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { paneDropZoneFromPoint, paneDirectionalZoneFromPoint, firstLeafId } from "./layout";
import { computePaneLayoutRects } from "./layoutGeometry";
import type { LayoutMode } from "./scrollingLayout";
import type { ViewTarget } from "./viewRegistry";
import { usePrimarySettings } from "../hooks/useSettings";
import { useUiStateStore } from "../uiStateStore";
import { dismissContextMenu } from "../contextMenuFallback";
import {
  computeBaseTab,
  initialPaneDropTarget,
  type ViewDragSource,
  type ViewDropTarget,
  type ViewDropResult,
  type WorkbenchTab,
} from "./workbenchState";
import { useWorkbenchStore } from "./workbenchStore";

export interface WorkbenchRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export type WorkbenchDragPhase = "dragging" | "canceling" | "rejected";

export interface WorkbenchDropResolver {
  readonly elementFromPoint: (x: number, y: number) => Element | null;
  readonly tabCount: () => number;
}

export interface SidebarDropTarget {
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly position: "before" | "after";
}

export interface WorkbenchDragState {
  readonly phase: WorkbenchDragPhase;
  readonly label: string;
  readonly source: ViewDragSource;
  readonly pointer: { readonly x: number; readonly y: number };
  readonly startPointer: { readonly x: number; readonly y: number };
  readonly startRect: WorkbenchRect;
  readonly target: ViewDropTarget | null;
  readonly result: ViewDropResult | null;
  readonly valid: boolean;
  readonly isOverSidebar: boolean;
  readonly sidebarDropTarget: SidebarDropTarget | null;
}

interface WorkbenchDragControllerValue {
  readonly beginDrag: (
    source: ViewDragSource,
    label: string,
    event: ReactPointerEvent<HTMLElement> | PointerEvent,
  ) => void;
  readonly consumeSuppressedClick: () => boolean;
}

const DEFAULT_CONTROLLER: WorkbenchDragControllerValue = {
  beginDrag: () => {},
  consumeSuppressedClick: () => false,
};

const WorkbenchDragControllerContext =
  createContext<WorkbenchDragControllerValue>(DEFAULT_CONTROLLER);
const WorkbenchDragStateContext = createContext<WorkbenchDragState | null>(null);

const DRAG_THRESHOLD = 5;
const CANCEL_DURATION_MS = 180;

function escapeCss(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function getActiveViewportElement(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return (
    document.querySelector<HTMLElement>(".workbench-viewport[data-tab-active='true']") ??
    document.querySelector<HTMLElement>(".workbench-viewport")
  );
}

function rectFromElement(element: Element | null): WorkbenchRect | null {
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
}

function elementForTarget(target: ViewDropTarget): Element | null {
  if (typeof document === "undefined") return null;
  if (target.kind === "pane") {
    const pane = document.querySelector<HTMLElement>(
      `[data-workbench-pane-drop][data-pane-id="${escapeCss(target.paneId)}"]`,
    );
    if (pane !== null) return pane;
  }
  if (target.kind === "existingTab") {
    const tab = document.querySelector<HTMLElement>(
      `[data-workbench-tab-drop="${escapeCss(target.tabId)}"]`,
    );
    if (tab !== null) return tab;
  }
  if (target.kind === "newTab") {
    return document.querySelector<HTMLElement>("[data-workbench-new-tab-drop]");
  }
  return null;
}

/** Resolve the semantic Workbench drop target under a viewport point. */
export function resolveWorkbenchDropTargetAtPoint(
  x: number,
  y: number,
  resolver?: WorkbenchDropResolver,
): ViewDropTarget | null {
  const resolved =
    resolver ??
    (typeof document === "undefined"
      ? null
      : {
          elementFromPoint: (pointX: number, pointY: number) =>
            document.elementFromPoint(pointX, pointY),
          tabCount: () => document.querySelectorAll("[data-workbench-tab-drop]").length,
        });
  if (resolved === null) return null;
  const element = resolved.elementFromPoint(x, y);
  if (element === null) return null;

  const newTabButton = element.closest<HTMLElement>("[data-workbench-new-tab-drop]");
  if (newTabButton !== null) {
    const rawIndex = newTabButton.dataset.workbenchNewTabDrop;
    const index = rawIndex === undefined || rawIndex === "end" ? Number.NaN : Number(rawIndex);
    const tabCount = resolved.tabCount();
    return { kind: "newTab", index: Number.isFinite(index) ? index : tabCount };
  }

  const existingTab = element.closest<HTMLElement>("[data-workbench-tab-drop]");
  const existingTabId = existingTab?.dataset.workbenchTabDrop;
  if (existingTabId !== undefined) return { kind: "existingTab", tabId: existingTabId };

  const pane = element.closest<HTMLElement>("[data-workbench-pane-drop]");
  const paneId = pane?.dataset.paneId;
  const tabId = pane?.dataset.workbenchTabId;
  if (pane !== null && paneId !== undefined && tabId !== undefined) {
    return {
      kind: "pane",
      tabId,
      paneId,
      zone: paneDropZoneFromPoint(x, y, pane.getBoundingClientRect()),
    };
  }

  const strip = element.closest<HTMLElement>("[data-workbench-tab-strip-drop]");
  if (strip !== null) {
    const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-workbench-tab-drop]"));
    const index = tabs.findIndex((tab) => {
      const rect = tab.getBoundingClientRect();
      return x < rect.left + rect.width / 2;
    });
    return { kind: "newTab", index: index < 0 ? tabs.length : index };
  }

  return null;
}

function targetDestinationRect(
  target: ViewDropTarget,
): { readonly rect: WorkbenchRect; readonly paneId?: string } | null {
  const element = elementForTarget(target);
  const rect = rectFromElement(element);
  if (rect === null) return null;
  if (target.kind !== "pane") return { rect };
  if (target.zone === "replace") return { rect, paneId: target.paneId };
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const edgeRect: WorkbenchRect =
    target.zone === "left"
      ? { left: rect.left, top: rect.top, width: halfWidth, height: rect.height }
      : target.zone === "right"
        ? { left: rect.left + halfWidth, top: rect.top, width: halfWidth, height: rect.height }
        : target.zone === "top"
          ? { left: rect.left, top: rect.top, width: rect.width, height: halfHeight }
          : { left: rect.left, top: rect.top + halfHeight, width: rect.width, height: halfHeight };
  return { rect: edgeRect, paneId: target.paneId };
}

function sameTarget(a: ViewDropTarget | null, b: ViewDropTarget | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === "pane" && b.kind === "pane") {
    return a.tabId === b.tabId && a.paneId === b.paneId && a.zone === b.zone;
  }
  if (a.kind === "existingTab" && b.kind === "existingTab") return a.tabId === b.tabId;
  if (a.kind === "newTab" && b.kind === "newTab") return a.index === b.index;
  return false;
}

export function resolveSidebarDropTargetAtPoint(
  x: number,
  y: number,
  sourceWorkspaceKey: string,
  sourceSessionId: string,
  resolver?: {
    readonly isOverSidebar: (x: number, y: number) => boolean;
    readonly elementFromPoint: (x: number, y: number) => Element | null;
  },
): { readonly isOverSidebar: boolean; readonly sidebarDropTarget: SidebarDropTarget | null } {
  const isOver =
    resolver?.isOverSidebar(x, y) ??
    (() => {
      if (typeof document === "undefined") return false;
      const sidebarElement =
        document.querySelector<HTMLElement>("[data-app-sidebar]") ??
        document.querySelector<HTMLElement>('[data-slot="sidebar"]');
      const rect = sidebarElement?.getBoundingClientRect();
      return (
        rect !== undefined && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
      );
    })();

  if (!isOver) return { isOverSidebar: false, sidebarDropTarget: null };

  const element =
    resolver?.elementFromPoint(x, y) ??
    (typeof document === "undefined" ? null : document.elementFromPoint(x, y));
  const rowElement = element?.closest<HTMLElement>("[data-sidebar-session-row]");
  if (rowElement) {
    if (rowElement.dataset.sessionClosed === "true") {
      return { isOverSidebar: true, sidebarDropTarget: null };
    }
    const rowWorkspaceKey = rowElement.dataset.workspaceKey;
    const rowSessionId = rowElement.dataset.sessionId;
    if (
      rowWorkspaceKey === sourceWorkspaceKey &&
      rowSessionId &&
      rowSessionId !== sourceSessionId
    ) {
      const rowRect = rowElement.getBoundingClientRect();
      const position = y < rowRect.top + rowRect.height / 2 ? "before" : "after";
      return {
        isOverSidebar: true,
        sidebarDropTarget: {
          workspaceKey: rowWorkspaceKey,
          sessionId: rowSessionId,
          position,
        },
      };
    }
  }

  return { isOverSidebar: true, sidebarDropTarget: null };
}

export interface VirtualPaneRegion {
  readonly tabId: string;
  readonly paneId: string;
  readonly rect: WorkbenchRect;
}

/** Compute virtual pane screen rectangles from a base tab and viewport dimensions. */
export function computeVirtualPaneRegions(
  baseTab: WorkbenchTab | null,
  viewportRect: WorkbenchRect,
  paneGap: number,
  scrollOffset?: { readonly left: number; readonly top: number },
): ReadonlyArray<VirtualPaneRegion> {
  if (baseTab === null) return [];
  const layout = computePaneLayoutRects(
    baseTab,
    { width: viewportRect.width, height: viewportRect.height },
    paneGap,
  );
  const scrollLeft = baseTab.layoutMode === "scrolling" ? (scrollOffset?.left ?? 0) : 0;
  const scrollTop = scrollOffset?.top ?? 0;
  const regions: VirtualPaneRegion[] = [];
  for (const [paneId, rect] of layout.rects.entries()) {
    regions.push({
      tabId: baseTab.id,
      paneId,
      rect: {
        left: viewportRect.left + rect.left - scrollLeft,
        top: viewportRect.top + rect.top - scrollTop,
        width: rect.width,
        height: rect.height,
      },
    });
  }
  return regions;
}

/** Resolve drop target against virtual pane regions within a viewport. */
export function resolveVirtualPaneDropTargetAtPoint(
  x: number,
  y: number,
  viewportRect: WorkbenchRect,
  regions: ReadonlyArray<VirtualPaneRegion>,
  paneGap = 0,
  directionalOnly = false,
  layoutMode?: LayoutMode,
): ViewDropTarget | null {
  if (
    x < viewportRect.left ||
    x > viewportRect.left + viewportRect.width ||
    y < viewportRect.top ||
    y > viewportRect.top + viewportRect.height
  ) {
    return null;
  }
  const halfGap = Math.max(0, paneGap) / 2;
  const hit = regions.find(
    ({ rect }) =>
      x >= rect.left - halfGap &&
      x <= rect.left + rect.width + halfGap &&
      y >= rect.top - halfGap &&
      y <= rect.top + rect.height + halfGap,
  );
  if (!hit) {
    if (layoutMode === "scrolling" && regions.length > 0) {
      let rightmostRegion: VirtualPaneRegion | null = null;
      let maxRight = -Infinity;
      for (const region of regions) {
        const right = region.rect.left + region.rect.width;
        if (right > maxRight) {
          maxRight = right;
          rightmostRegion = region;
        }
      }
      if (rightmostRegion !== null && x > maxRight + halfGap) {
        return {
          kind: "pane",
          tabId: rightmostRegion.tabId,
          paneId: rightmostRegion.paneId,
          zone: "right",
        };
      }
    }
    return null;
  }
  const zone = directionalOnly
    ? paneDirectionalZoneFromPoint(x, y, hit.rect)
    : paneDropZoneFromPoint(x, y, hit.rect);
  return {
    kind: "pane",
    tabId: hit.tabId,
    paneId: hit.paneId,
    zone,
  };
}

export const AUTO_SCROLL_EDGE_THRESHOLD = 56;
export const AUTO_SCROLL_MIN_SPEED = 3;
export const AUTO_SCROLL_MAX_SPEED = 20;

/** Compute horizontal auto-scroll velocity when dragging near viewport edges (ADR 0015). */
export function computeEdgeAutoScrollVelocity(
  x: number,
  viewportRect: WorkbenchRect,
  threshold = AUTO_SCROLL_EDGE_THRESHOLD,
  minSpeed = AUTO_SCROLL_MIN_SPEED,
  maxSpeed = AUTO_SCROLL_MAX_SPEED,
): number {
  if (x < viewportRect.left || x > viewportRect.left + viewportRect.width) {
    return 0;
  }
  const leftZone = viewportRect.left + threshold;
  if (x < leftZone) {
    const depth = Math.max(0, Math.min(1, (leftZone - x) / threshold));
    return -(minSpeed + depth * (maxSpeed - minSpeed));
  }
  const rightZone = viewportRect.left + viewportRect.width - threshold;
  if (x > rightZone) {
    const depth = Math.max(0, Math.min(1, (x - rightZone) / threshold));
    return minSpeed + depth * (maxSpeed - minSpeed);
  }
  return 0;
}

export function WorkbenchDragProvider({ children }: { readonly children: ReactNode }) {
  const [state, setState] = useState<WorkbenchDragState | null>(null);
  const paneGap = usePrimarySettings((s) => s.paneGap);
  const paneGapRef = useRef(paneGap);
  useEffect(() => {
    paneGapRef.current = paneGap;
  }, [paneGap]);
  const suppressClickRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const stabilizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finishTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeRef = useRef(false);
  const cleanupDragRef = useRef<(() => void) | null>(null);

  const consumeSuppressedClick = useCallback(() => {
    const suppressed = suppressClickRef.current;
    suppressClickRef.current = false;
    return suppressed;
  }, []);

  const clearFrame = useCallback(() => {
    if (frameRef.current === null) return;
    cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  const beginDrag = useCallback(
    (
      source: ViewDragSource,
      label: string,
      event: ReactPointerEvent<HTMLElement> | PointerEvent,
    ) => {
      if (event.button !== 0 || event.defaultPrevented) return;
      cleanupDragRef.current?.();
      const rawHandle =
        "currentTarget" in event && event.currentTarget
          ? event.currentTarget
          : "target" in event
            ? event.target
            : null;
      const handle =
        rawHandle !== null && typeof (rawHandle as Element).getBoundingClientRect === "function"
          ? (rawHandle as HTMLElement)
          : null;
      const sourceElement =
        source.kind === "pane"
          ? document.querySelector<HTMLElement>(
              `[data-workbench-pane-drop][data-pane-id="${escapeCss(source.paneId)}"]`,
            )
          : source.kind === "tab"
            ? document.querySelector<HTMLElement>(`[data-tab-id="${escapeCss(source.tabId)}"]`)
            : handle;
      const startRect = rectFromElement(sourceElement) ?? rectFromElement(handle);
      if (startRect === null) return;
      document.documentElement.dataset.workbenchDragging = "pending";

      if (finishTimerRef.current !== null) {
        clearTimeout(finishTimerRef.current);
        finishTimerRef.current = null;
      }
      if (settleTimerRef.current !== null) {
        clearTimeout(settleTimerRef.current);
        settleTimerRef.current = null;
      }
      clearFrame();
      activeRef.current = false;
      suppressClickRef.current = false;
      const startPointer = { x: event.clientX, y: event.clientY };
      let lastX = event.clientX;
      let lastY = event.clientY;
      let lastTarget: ViewDropTarget | null = null;
      let lastResult: ViewDropResult | null = null;
      let lastIsOverSidebar = false;
      let lastSidebarDropTarget: SidebarDropTarget | null = null;
      let publishedTarget: ViewDropTarget | null = null;

      const currentStore = useWorkbenchStore.getState();
      const activeTab =
        currentStore.tabs.find((t) => t.id === currentStore.activeTabId) ?? currentStore.tabs[0];
      const viewportEl = getActiveViewportElement();
      const viewportRect = rectFromElement(viewportEl);

      let baseTab: WorkbenchTab | null = null;
      let sourceTab: WorkbenchTab | undefined;
      if (source.kind === "pane") {
        sourceTab = currentStore.tabs.find((t) => t.id === source.tabId);
        baseTab = sourceTab ? computeBaseTab(sourceTab, source.paneId) : null;
      } else if (source.kind === "sidebar" && activeTab) {
        baseTab = activeTab;
      } else if (source.kind === "tab" && activeTab && source.tabId !== activeTab.id) {
        sourceTab = currentStore.tabs.find((t) => t.id === source.tabId);
        if (sourceTab && sourceTab.panes.size === 1) {
          baseTab = activeTab;
        }
      }

      const initialTarget =
        source.kind === "pane" && sourceTab
          ? initialPaneDropTarget(sourceTab, source.paneId)
          : null;

      const initialResult: ViewDropResult | null =
        source.kind === "pane" && sourceTab
          ? {
              snapshot: currentStore,
              tabId: sourceTab.id,
              paneId: source.paneId,
            }
          : null;

      const getVirtualRegions = () => {
        if (!viewportRect || !baseTab) return [];
        return computeVirtualPaneRegions(baseTab, viewportRect, paneGapRef.current, {
          left: viewportEl?.scrollLeft ?? 0,
          top: viewportEl?.scrollTop ?? 0,
        });
      };

      const resolveTarget = (x: number, y: number) => {
        const actual = resolveWorkbenchDropTargetAtPoint(x, y);
        if (actual && actual.kind !== "pane") {
          lastTarget = actual;
          return actual;
        }
        if (!viewportRect) {
          lastTarget = actual;
          return actual;
        }
        const regions = getVirtualRegions();
        const hit = resolveVirtualPaneDropTargetAtPoint(
          x,
          y,
          viewportRect,
          regions,
          paneGapRef.current,
          source.kind === "pane" || source.kind === "tab",
          baseTab?.layoutMode,
        );
        lastTarget = hit ?? initialTarget;
        return lastTarget;
      };

      const previewFor = (target: ViewDropTarget | null) => {
        if (target === null) {
          lastResult = null;
          return null;
        }
        if (initialTarget && sameTarget(target, initialTarget) && initialResult) {
          lastResult = initialResult;
          return lastResult;
        }
        lastResult = useWorkbenchStore.getState().previewDrop(source, target);
        return lastResult;
      };

      const publishPointer = () => {
        frameRef.current = null;
        const target = lastIsOverSidebar ? null : lastTarget;
        setState((current) => {
          if (current === null) return current;
          if (
            sameTarget(current.target, target) &&
            current.isOverSidebar === lastIsOverSidebar &&
            current.sidebarDropTarget === lastSidebarDropTarget
          ) {
            return current.pointer.x === lastX && current.pointer.y === lastY
              ? current
              : { ...current, pointer: { x: lastX, y: lastY } };
          }
          const result = previewFor(target);
          return {
            ...current,
            pointer: { x: lastX, y: lastY },
            target,
            result,
            valid: target !== null && result !== null,
            isOverSidebar: lastIsOverSidebar,
            sidebarDropTarget: lastSidebarDropTarget,
          };
        });
      };

      let autoScrollRaf: number | null = null;

      const stopAutoScroll = () => {
        if (autoScrollRaf !== null) {
          cancelAnimationFrame(autoScrollRaf);
          autoScrollRaf = null;
        }
      };

      // Single source of truth for the auto-scroll preconditions; also narrows the
      // viewport element and rect that the RAF loop needs to be non-null.
      const autoScrollSurface = (): {
        readonly element: HTMLElement;
        readonly rect: WorkbenchRect;
      } | null => {
        if (
          !activeRef.current ||
          viewportEl === null ||
          viewportRect === null ||
          lastIsOverSidebar ||
          baseTab?.layoutMode !== "scrolling"
        ) {
          return null;
        }
        return { element: viewportEl, rect: viewportRect };
      };

      const stepAutoScroll = () => {
        autoScrollRaf = null;
        const surface = autoScrollSurface();
        if (surface === null) {
          return;
        }
        const velocity = computeEdgeAutoScrollVelocity(lastX, surface.rect);
        if (velocity === 0) return;

        const maxScroll = Math.max(0, surface.element.scrollWidth - surface.element.clientWidth);
        const prevScrollLeft = surface.element.scrollLeft;
        surface.element.scrollLeft = Math.max(0, Math.min(maxScroll, prevScrollLeft + velocity));

        if (surface.element.scrollLeft !== prevScrollLeft) {
          resolveTarget(lastX, lastY);
          if (frameRef.current === null) {
            frameRef.current = requestAnimationFrame(publishPointer);
          }
        }

        if (computeEdgeAutoScrollVelocity(lastX, surface.rect) !== 0) {
          autoScrollRaf = requestAnimationFrame(stepAutoScroll);
        }
      };

      const updateAutoScroll = () => {
        const surface = autoScrollSurface();
        if (surface === null) {
          stopAutoScroll();
          return;
        }
        const velocity = computeEdgeAutoScrollVelocity(lastX, surface.rect);
        if (velocity !== 0 && autoScrollRaf === null) {
          autoScrollRaf = requestAnimationFrame(stepAutoScroll);
        } else if (velocity === 0) {
          stopAutoScroll();
        }
      };

      const cleanup = () => {
        stopAutoScroll();
        clearFrame();
        if (stabilizeTimerRef.current !== null) {
          clearTimeout(stabilizeTimerRef.current);
          stabilizeTimerRef.current = null;
        }
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onCancel);
        window.removeEventListener("keydown", onKeyDown);
        cleanupDragRef.current = null;
      };
      cleanupDragRef.current = cleanup;

      const finish = (cancelled: boolean) => {
        const wasActive = activeRef.current;
        const currentSidebarDropTarget = lastSidebarDropTarget;
        const currentIsOverSidebar = lastIsOverSidebar;
        cleanup();
        if (!wasActive) {
          delete document.documentElement.dataset.workbenchDragging;
          return;
        }
        activeRef.current = false;
        suppressClickRef.current = true;

        document.documentElement.dataset.workbenchDragging = "settling";
        if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
        settleTimerRef.current = setTimeout(() => {
          settleTimerRef.current = null;
          delete document.documentElement.dataset.workbenchDragging;
        }, 240);

        if (
          !cancelled &&
          source.kind === "sidebar" &&
          currentIsOverSidebar &&
          (source.target.kind === "agentSession" || source.target.kind === "workspaceTerminal")
        ) {
          const sourceSessionId =
            source.target.kind === "agentSession"
              ? source.target.agentSessionId
              : source.target.terminalSessionId;
          const workspaceKey = `${source.target.environmentId}:${source.workspaceId ?? (source.target.kind === "workspaceTerminal" ? source.target.workspaceId : "")}`;
          const allSessionRows = Array.from(
            document.querySelectorAll<HTMLElement>(
              `[data-sidebar-session-row][data-workspace-key="${escapeCss(workspaceKey)}"]:not([data-session-closed="true"])`,
            ),
          )
            .map((el) => el.dataset.sessionId)
            .filter((id): id is string => Boolean(id));

          if (allSessionRows.length > 1) {
            const containerEl = document.querySelector<HTMLElement>(
              `[data-sidebar-active-sessions="${escapeCss(workspaceKey)}"]`,
            );
            if (containerEl) {
              const containerRect = containerEl.getBoundingClientRect();
              const rowHeight = 25;
              const deltaY = lastY - startPointer.y;
              const currentCenterY = startRect.top + deltaY + rowHeight / 2 - containerRect.top;
              const targetIndex = Math.max(
                0,
                Math.min(Math.floor(currentCenterY / rowHeight), allSessionRows.length - 1),
              );
              const fromIndex = allSessionRows.indexOf(sourceSessionId);
              if (fromIndex >= 0 && fromIndex !== targetIndex) {
                const targetSessionId = allSessionRows[targetIndex];
                if (targetSessionId) {
                  const position = targetIndex > fromIndex ? "after" : "before";
                  useUiStateStore
                    .getState()
                    .reorderWorkspaceSessions(
                      workspaceKey,
                      allSessionRows,
                      sourceSessionId,
                      targetSessionId,
                      position,
                    );
                }
              }
            } else if (currentSidebarDropTarget) {
              useUiStateStore
                .getState()
                .reorderWorkspaceSessions(
                  workspaceKey,
                  allSessionRows,
                  sourceSessionId,
                  currentSidebarDropTarget.sessionId,
                  currentSidebarDropTarget.position,
                );
            }
          }
          setState(null);
          return;
        }

        if (!cancelled && source.kind === "tab") {
          const stripEl = document.querySelector<HTMLElement>("[data-workbench-tab-strip-drop]");
          if (stripEl) {
            const stripRect = stripEl.getBoundingClientRect();
            const isOutsideY = lastY > stripRect.bottom + 12 || lastY < stripRect.top - 12;
            const isOutsideX = lastX < stripRect.left - 20 || lastX > stripRect.right + 20;
            if (!isOutsideY && !isOutsideX) {
              const currentStore = useWorkbenchStore.getState();
              const fromIndex = currentStore.tabs.findIndex((t) => t.id === source.tabId);
              if (fromIndex >= 0) {
                const firstTabEl = stripEl.querySelector<HTMLElement>("[data-tab-id]");
                const tabWidth = firstTabEl?.getBoundingClientRect().width || 176;
                const deltaX = lastX - startPointer.x;
                const scrollLeft = stripEl.scrollLeft;
                const currentCenter =
                  startRect.left + deltaX + tabWidth / 2 - stripRect.left + scrollLeft;
                const toIndex = Math.max(
                  0,
                  Math.min(Math.floor(currentCenter / tabWidth), currentStore.tabs.length - 1),
                );
                if (fromIndex !== toIndex) {
                  currentStore.moveTab(fromIndex, toIndex);
                }
                currentStore.activateTab(source.tabId);
              }
              setState(null);
              return;
            }
          }
        }

        const liveTarget = cancelled || currentIsOverSidebar ? null : resolveTarget(lastX, lastY);
        const target = liveTarget;
        const result =
          target === null ? null : useWorkbenchStore.getState().previewDrop(source, target);
        if (!cancelled && target !== null && result !== null) {
          // A drop that replaces a dirty Pane first runs that Pane's close
          // guard; the Sidebar's own commit only follows an accepted drop.
          void (async () => {
            try {
              const accepted = await useWorkbenchStore.getState().commitDrop(result);
              if (accepted && source.kind === "sidebar") {
                source.onCommit?.(result);
              }
            } finally {
              setState(null);
            }
          })();
          return;
        }
        const phase: WorkbenchDragPhase = cancelled ? "canceling" : "rejected";
        setState((current) =>
          current === null
            ? current
            : {
                ...current,
                phase,
                target,
                result: null,
                valid: false,
                isOverSidebar: currentIsOverSidebar,
                sidebarDropTarget: null,
              },
        );
        finishTimerRef.current = setTimeout(() => {
          finishTimerRef.current = null;
          setState(null);
        }, CANCEL_DURATION_MS);
      };

      const checkSidebarState = (x: number, y: number) => {
        if (source.kind !== "sidebar") {
          return { isOverSidebar: false, sidebarDropTarget: null };
        }
        if (source.target.kind !== "agentSession" && source.target.kind !== "workspaceTerminal") {
          lastIsOverSidebar = false;
          lastSidebarDropTarget = null;
          return { isOverSidebar: false, sidebarDropTarget: null };
        }
        const sourceWorkspaceKey = `${source.target.environmentId}:${source.workspaceId ?? (source.target.kind === "workspaceTerminal" ? source.target.workspaceId : "")}`;
        const sourceSessionId =
          source.target.kind === "agentSession"
            ? source.target.agentSessionId
            : source.target.terminalSessionId;
        const res = resolveSidebarDropTargetAtPoint(x, y, sourceWorkspaceKey, sourceSessionId);
        lastIsOverSidebar = res.isOverSidebar;
        lastSidebarDropTarget = res.sidebarDropTarget;
        return res;
      };

      const onMove = (moveEvent: PointerEvent) => {
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
        const { isOverSidebar, sidebarDropTarget } = checkSidebarState(lastX, lastY);

        if (!activeRef.current) {
          if (Math.hypot(lastX - event.clientX, lastY - event.clientY) < DRAG_THRESHOLD) {
            return;
          }
          activeRef.current = true;
          dismissContextMenu();
          document.documentElement.dataset.workbenchDragging = "active";
          window.getSelection()?.removeAllRanges();
          const target = isOverSidebar ? null : resolveTarget(lastX, lastY);
          const result = isOverSidebar ? null : previewFor(target);
          publishedTarget = target;
          setState({
            phase: "dragging",
            label,
            source,
            pointer: { x: lastX, y: lastY },
            startPointer,
            startRect,
            target,
            result,
            valid: target !== null && result !== null,
            isOverSidebar,
            sidebarDropTarget,
          });
          updateAutoScroll();
          return;
        }

        const target = isOverSidebar ? null : resolveTarget(lastX, lastY);
        if (!sameTarget(publishedTarget, target)) publishedTarget = target;
        updateAutoScroll();
        if (frameRef.current === null) frameRef.current = requestAnimationFrame(publishPointer);
        if (stabilizeTimerRef.current !== null) clearTimeout(stabilizeTimerRef.current);
        stabilizeTimerRef.current = setTimeout(() => {
          stabilizeTimerRef.current = null;
          if (!lastIsOverSidebar) resolveTarget(lastX, lastY);
          publishPointer();
        }, 180);
      };
      const onUp = () => finish(false);
      const onCancel = () => finish(true);
      const onKeyDown = (keyEvent: KeyboardEvent) => {
        if (keyEvent.key !== "Escape") return;
        keyEvent.preventDefault();
        finish(true);
      };

      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onCancel);
      window.addEventListener("keydown", onKeyDown);
    },
    [clearFrame],
  );

  useEffect(
    () => () => {
      cleanupDragRef.current?.();
      clearFrame();
      if (finishTimerRef.current !== null) clearTimeout(finishTimerRef.current);
      if (stabilizeTimerRef.current !== null) clearTimeout(stabilizeTimerRef.current);
      if (settleTimerRef.current !== null) clearTimeout(settleTimerRef.current);
      delete document.documentElement.dataset.workbenchDragging;
    },
    [clearFrame],
  );

  const controllerValue = useMemo(
    () => ({ beginDrag, consumeSuppressedClick }),
    [beginDrag, consumeSuppressedClick],
  );

  return (
    <WorkbenchDragControllerContext.Provider value={controllerValue}>
      <WorkbenchDragStateContext.Provider value={state}>
        {children}
      </WorkbenchDragStateContext.Provider>
    </WorkbenchDragControllerContext.Provider>
  );
}

export function useWorkbenchDragController(): WorkbenchDragControllerValue {
  return useContext(WorkbenchDragControllerContext);
}

export function useWorkbenchDragState(): WorkbenchDragState | null {
  return useContext(WorkbenchDragStateContext);
}

export function useWorkbenchDragSource(source: ViewDragSource, label: string) {
  const controller = useWorkbenchDragController();
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement> | PointerEvent) =>
      controller.beginDrag(source, label, event),
    [controller, label, source],
  );
  return { onPointerDown, consumeSuppressedClick: controller.consumeSuppressedClick };
}

function targetFallbackRect(target: ViewDropTarget): WorkbenchRect | null {
  const element = elementForTarget(target);
  const rect = rectFromElement(element);
  if (rect === null) return null;
  return rect.width < 120 || rect.height < 40
    ? rect
    : (targetDestinationRect(target)?.rect ?? rect);
}

function tabInsertionMarker(target: ViewDropTarget): WorkbenchRect | null {
  if (typeof document === "undefined" || target.kind !== "newTab") return null;
  const strip = document.querySelector<HTMLElement>("[data-workbench-tab-strip-drop]");
  if (strip === null) return null;
  const tabs = Array.from(strip.querySelectorAll<HTMLElement>("[data-workbench-tab-drop]"));
  const index = Math.max(0, Math.min(target.index, tabs.length));
  const tabRect =
    index < tabs.length
      ? tabs[index]?.getBoundingClientRect()
      : tabs.at(-1)?.getBoundingClientRect();
  if (tabRect === undefined) return null;
  return {
    left: index < tabs.length ? tabRect.left - 1 : tabRect.right + 1,
    top: tabRect.top + 3,
    width: 2,
    height: Math.max(0, tabRect.height - 6),
  };
}

function ghostInfoForView(
  target: ViewTarget,
  definitionId?: string,
): { readonly icon: ReactNode; readonly typeLabel: string } {
  if (target.kind === "agentSession") {
    return {
      icon: <MessageSquarePlusIcon className="size-5 text-primary" />,
      typeLabel: "Agent Session",
    };
  }
  if (target.kind === "workspaceTerminal") {
    return {
      icon: <TerminalIcon className="size-5 text-primary" />,
      typeLabel: "Terminal Session",
    };
  }
  if (target.kind === "workspace") {
    const isGit = (target.definitionId ?? definitionId) === "gitView";
    if (isGit) {
      return {
        icon: <GitBranchIcon className="size-5 text-primary" />,
        typeLabel: "Review Changes",
      };
    }
    return {
      icon: <FolderIcon className="size-5 text-primary" />,
      typeLabel: "Browse Files",
    };
  }
  return {
    icon: <MoveIcon className="size-5 text-primary" />,
    typeLabel: "View",
  };
}

function dragGhostInfo(source: ViewDragSource): {
  readonly icon: ReactNode;
  readonly typeLabel: string;
} {
  if (source.kind === "sidebar") {
    return ghostInfoForView(source.target);
  }
  if (source.kind === "pane") {
    const tab = useWorkbenchStore.getState().tabs.find((t) => t.id === source.tabId);
    const pane = tab?.panes.get(source.paneId);
    if (pane) {
      return ghostInfoForView(pane.target, pane.definitionId);
    }
  } else if (source.kind === "tab") {
    const tab = useWorkbenchStore.getState().tabs.find((t) => t.id === source.tabId);
    if (tab && tab.panes.size === 1) {
      const paneId = firstLeafId(tab.layout);
      const pane = tab.panes.get(paneId);
      if (pane) {
        return ghostInfoForView(pane.target, pane.definitionId);
      }
    }
    return {
      icon: <MoveIcon className="size-5 text-primary" />,
      typeLabel: "Tab",
    };
  }
  return {
    // ADR-0010: dragging a View moves it; no drag gesture copies one.
    icon: <MoveIcon className="size-5 text-primary" />,
    typeLabel: "View",
  };
}

export function WorkbenchDropOverlay() {
  const state = useWorkbenchDragState();
  const paneGap = usePrimarySettings((s) => s.paneGap);
  const paneRadius = usePrimarySettings((s) => s.paneRadius);
  const isDragging = state !== null;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [surfaceRect, setSurfaceRect] = useState<WorkbenchRect | null>(null);

  const isTabInTopbar =
    state?.source.kind === "tab" &&
    (() => {
      if (typeof document === "undefined") return false;
      const stripEl = document.querySelector<HTMLElement>("[data-workbench-tab-strip-drop]");
      if (!stripEl) return false;
      const stripRect = stripEl.getBoundingClientRect();
      return state.pointer.y <= stripRect.bottom + 12 && state.pointer.y >= stripRect.top - 12;
    })();

  // Refs attach before layout effects in the same commit, so keying this on
  // isOverSidebar and isTabInTopbar ensures we measure whenever the overlay mounts or transitions.
  useLayoutEffect(() => {
    if (!isDragging || state?.isOverSidebar || surfaceRef.current === null) {
      setSurfaceRect(null);
      return;
    }
    setSurfaceRect(rectFromElement(surfaceRef.current));
  }, [isDragging, state?.isOverSidebar, isTabInTopbar]);

  const preview = state === null || state.phase === "canceling" ? null : state.result;
  const previewTabId =
    state === null || preview === null || state.target === null
      ? null
      : state.target.kind === "newTab"
        ? preview.tabId
        : state.target.tabId;
  const previewTab =
    previewTabId === null
      ? null
      : (preview?.snapshot.tabs.find((tab) => tab.id === previewTabId) ?? null);

  const previewLayout = useMemo(() => {
    if (!previewTab || !surfaceRect) return null;
    return computePaneLayoutRects(previewTab, surfaceRect, paneGap);
  }, [previewTab, surfaceRect, paneGap]);

  if (state === null || state.isOverSidebar) return null;

  const viewport = getActiveViewportElement();
  const scrollLeft = previewTab?.layoutMode === "scrolling" ? (viewport?.scrollLeft ?? 0) : 0;
  const scrollTop = viewport?.scrollTop ?? 0;

  const destRect =
    !isTabInTopbar && state.target?.kind === "pane" && preview && previewLayout
      ? previewLayout.rects.get(preview.paneId)
      : null;

  let destinationRect: WorkbenchRect | null = null;
  if (destRect && surfaceRect) {
    destinationRect = {
      left: surfaceRect.left + destRect.left - scrollLeft,
      top: surfaceRect.top + destRect.top - scrollTop,
      width: destRect.width,
      height: destRect.height,
    };
  }
  if (!destinationRect && state.target !== null) {
    destinationRect = targetFallbackRect(state.target);
  }

  const GHOST_WIDTH = 156;
  const GHOST_HEIGHT = 84;
  const ghostRect =
    state.phase === "canceling"
      ? {
          left: state.startRect.left,
          top: state.startRect.top,
          width: GHOST_WIDTH,
          height: GHOST_HEIGHT,
        }
      : {
          left: state.pointer.x - GHOST_WIDTH / 2,
          top: state.pointer.y - GHOST_HEIGHT / 2,
          width: GHOST_WIDTH,
          height: GHOST_HEIGHT,
        };
  const invalid = state.phase === "rejected" || (state.target !== null && !state.valid);
  const tabMarker = state.target === null ? null : tabInsertionMarker(state.target);
  const ghostInfo = dragGhostInfo(state.source);

  return (
    <>
      <div
        ref={surfaceRef}
        className={
          "pointer-events-none absolute inset-0 z-40 transition-colors [transition-duration:calc(150ms*var(--motion-duration-scale,1))] " +
          (isTabInTopbar ? "bg-transparent" : "bg-background/15")
        }
        data-workbench-drop-preview
        data-drop-phase={state.phase}
        data-drop-target-kind={state.target?.kind ?? "none"}
        data-drop-target-tab-id={
          state.target?.kind === "pane" || state.target?.kind === "existingTab"
            ? state.target.tabId
            : undefined
        }
      >
        {destRect && (
          <div
            key="workbench-drop-destination-indicator"
            data-workbench-preview-pane
            data-pane-id={preview?.paneId}
            data-destination="true"
            className="workbench-drop-destination-indicator"
            style={{
              left: `${destRect.left - scrollLeft}px`,
              top: `${destRect.top - scrollTop}px`,
              width: `${destRect.width}px`,
              height: `${destRect.height}px`,
              borderRadius: `${paneRadius}px`,
            }}
          />
        )}
      </div>
      {typeof document !== "undefined" && document.body
        ? createPortal(
            <>
              {tabMarker === null ? null : (
                <div
                  data-workbench-tab-drop-marker
                  className="pointer-events-none fixed z-[99] rounded-full bg-primary shadow-[0_0_8px_var(--color-primary)]"
                  style={{
                    left: tabMarker.left,
                    top: tabMarker.top,
                    width: tabMarker.width,
                    height: tabMarker.height,
                  }}
                />
              )}
              {!isTabInTopbar && (
                <div
                  data-workbench-drag-ghost
                  data-phase={state.phase}
                  data-valid={invalid ? "false" : "true"}
                  className={
                    "pointer-events-none fixed z-[160] flex flex-col items-center justify-center overflow-hidden rounded-xl border p-2.5 shadow-2xl backdrop-blur-md will-change-transform " +
                    "transition-[opacity,border-color] ease-out motion-reduce:transition-none " +
                    (invalid
                      ? "border-destructive/80 bg-destructive/15 text-destructive "
                      : "border-border/80 bg-background/85 text-foreground ") +
                    (state.phase === "canceling"
                      ? "opacity-0 [transition-duration:calc(180ms*var(--motion-duration-scale,1))]"
                      : "opacity-100 [transition-duration:calc(75ms*var(--motion-duration-scale,1))]")
                  }
                  style={{
                    left: 0,
                    top: 0,
                    width: `${ghostRect.width}px`,
                    height: `${ghostRect.height}px`,
                    transform: `translate3d(${ghostRect.left}px, ${ghostRect.top}px, 0)`,
                  }}
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    {ghostInfo.icon}
                  </div>
                  <div className="flex flex-col items-center min-w-0 max-w-full mt-1.5">
                    <span className="truncate max-w-[136px] text-xs font-semibold text-foreground leading-tight text-center">
                      {state.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground font-medium leading-tight mt-0.5 text-center">
                      {ghostInfo.typeLabel}
                    </span>
                  </div>
                </div>
              )}
            </>,
            document.body,
          )
        : null}
    </>
  );
}
