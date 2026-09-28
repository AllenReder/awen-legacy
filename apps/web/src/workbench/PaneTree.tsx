import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import type { EnvironmentId } from "@awen/contracts";
import { useEnvironment } from "../state/environments";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import type { PaneShadow } from "@awen/contracts/settings";
import { usePrimarySettings } from "../hooks/useSettings";
import type { SplitDir } from "./layout";
import { computePaneLayoutRects } from "./layoutGeometry";
import { createPaneRectMotion } from "./paneRectMotion";
import { skipAutomaticWorkbenchMotion } from "./workbenchMotion";
import { MIN_PANE_HEIGHT } from "./scrollingLayout";
import { resolveViewDefinition, type ViewTarget } from "./viewRegistry";
import { useWorkbenchStore } from "./workbenchStore";
import type { WorkbenchSnapshot, WorkbenchTab } from "./workbenchState";
import { useWorkbenchDragState, useWorkbenchDragSource } from "./workbenchDrag";
import { resolveTargetBreadcrumbs } from "./workbenchTitles";
import {
  PaneMenuRegistryContext,
  usePaneMenuRegistry,
  type MenuAnchorPosition,
  type PaneMenuRegistry,
} from "./paneMenuRegistry";
import { useTabTransition } from "./tabTransitionReact";
import { useTabSwitchGesture } from "./useTabSwitchGesture";
import { useTabSwitchWheel } from "./useTabSwitchWheel";
import {
  getTabTransitionCards,
  getTabTransitionFrame,
  subscribeTabTransitionFrame,
  type TabTransitionFrame,
} from "./tabTransition";
import {
  animateScrollTo,
  cancelActiveScrollAnimation,
  computeScrollingRevealTarget,
  holdTabEntry,
  type TabEntry,
} from "./scrollingAnimation";
import { usePublishViewportMetrics } from "./viewportTracking";

interface PaneTreeProps {
  readonly snapshot: WorkbenchSnapshot;
  readonly projects?: ReadonlyArray<EnvironmentAwenProject>;
}

const EMPTY_PROJECTS: ReadonlyArray<EnvironmentAwenProject> = [];

function resolvePaneBoxShadow(paneGap: number, paneShadow: PaneShadow): string {
  if (paneGap === 0) return "none";
  switch (paneShadow) {
    case "subtle":
      return "0 1px 3px rgba(0, 0, 0, 0.08), 0 1px 2px rgba(0, 0, 0, 0.04)";
    case "medium":
      return "0 4px 14px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.06)";
    case "elevated":
      return "0 14px 32px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08)";
    case "none":
    default:
      return "none";
  }
}

/** Write one card's slot transform for the current Sliding Tab switch frame. */
function writeTransitionCardTransform(
  element: HTMLElement,
  tabId: string,
  frame: TabTransitionFrame | null,
): void {
  const style = (element as { style?: CSSStyleDeclaration }).style;
  if (!style) return;
  if (frame === null) {
    style.transform = "";
    return;
  }
  const slot = frame.cards.find((card) => card.tabId === tabId)?.slot;
  if (slot === undefined) return;
  const offset = slot - frame.position;
  // A 2D translate keeps the card off the 3D/backdrop-root path so descendant
  // `backdrop-filter` glass keeps its mask while the strip moves.
  style.transform = `translate(${(offset * 100).toFixed(4)}%, 0)`;
}

/** Whether a Tab card is moving in the current strip. */
function isSwitchParticipant(role: TabTransitionRole): boolean {
  return role === "to" || role === "from" || role === "participant";
}

/**
 * Workbench canvas host that maintains Keep-Alive viewports across all tabs.
 * At rest only the active Tab is shown; during a Sliding Tab switch the source
 * and target Tabs are laid out as two cards and driven by transition progress.
 */
export function PaneTree({ snapshot, projects = EMPTY_PROJECTS }: PaneTreeProps) {
  const transition = useTabTransition();
  const stageRef = useRef<HTMLDivElement>(null);
  const menuOpenersRef = useRef(new Map<string, (position: MenuAnchorPosition) => void>());

  const registry = useMemo<PaneMenuRegistry>(
    () => ({
      register(paneId, open) {
        menuOpenersRef.current.set(paneId, open);
        return () => {
          if (menuOpenersRef.current.get(paneId) === open) menuOpenersRef.current.delete(paneId);
        };
      },
      open(paneId, position) {
        const open = menuOpenersRef.current.get(paneId);
        if (open === undefined) return false;
        open(position);
        return true;
      },
    }),
    [],
  );

  useTabSwitchGesture({ stageRef, onPaneContextMenu: registry.open });
  useTabSwitchWheel(stageRef);

  const activeTransition =
    transition !== null &&
    snapshot.tabs.some((tab) => tab.id === transition.fromTabId) &&
    snapshot.tabs.some((tab) => tab.id === transition.toTabId)
      ? transition
      : null;

  const roleFor = (tabId: string): TabTransitionRole => {
    if (activeTransition === null) return tabId === snapshot.activeTabId ? "active" : "inactive";
    if (tabId === activeTransition.toTabId) return "to";
    if (tabId === activeTransition.fromTabId) return "from";
    if (getTabTransitionCards().some((card) => card.tabId === tabId)) return "participant";
    return "hidden";
  };

  return (
    <PaneMenuRegistryContext.Provider value={registry}>
      <div
        ref={stageRef}
        className="workbench-viewport-container relative flex flex-1 min-h-0 min-w-0 flex-col"
        data-tab-transition={activeTransition !== null ? "true" : undefined}
      >
        {snapshot.tabs.map((tab) => (
          <TabPaneTree
            key={tab.id}
            tab={tab}
            projects={projects}
            isActive={tab.id === snapshot.activeTabId}
            transitionRole={roleFor(tab.id)}
            // A Sliding Tab switch is a navigation, so its incoming Tab knows
            // which side it was entered from (ADR-0025). Structural activation
            // — creating a Tab, or one closing onto another — ends the switch
            // instead of running one, so it carries no direction and keeps
            // ordinary reveal.
            {...(activeTransition?.toTabId === tab.id ? { entryDir: activeTransition.dir } : {})}
          />
        ))}
      </div>
    </PaneMenuRegistryContext.Provider>
  );
}

type TabTransitionRole = "active" | "inactive" | "to" | "from" | "participant" | "hidden";

interface TabPaneTreeProps {
  readonly tab: WorkbenchTab;
  readonly projects: ReadonlyArray<EnvironmentAwenProject>;
  readonly isActive: boolean;
  readonly transitionRole: TabTransitionRole;
  /** Direction this Tab was entered from, only on the commit it became active. */
  readonly entryDir?: -1 | 1;
}

const TabPaneTree = memo(
  function TabPaneTree({ tab, projects, isActive, transitionRole, entryDir }: TabPaneTreeProps) {
    const dragState = useWorkbenchDragState();
    const previewTab =
      isActive && dragState?.phase === "dragging" && dragState.valid
        ? dragState.result?.snapshot.tabs.find((candidate) => candidate.id === tab.id)
        : undefined;
    const scrolling = tab.layoutMode === "scrolling";
    const viewportRef = useRef<HTMLDivElement>(null);
    const [size, setSize] = useState({ width: 0, height: 0 });
    const changeColumn = useWorkbenchStore((s) => s.changeColumn);
    const setFocused = useWorkbenchStore((s) => s.setFocused);
    const paneMotions = useRef(new Map<string, ReturnType<typeof createPaneRectMotion>>());
    const paneMotionSize = useRef({ width: 0, height: 0 });
    // An entry holds the Tab at the edge it was entered from. It outlives the
    // commit that activates the Tab — later reveals would otherwise pull the
    // Viewport inward — and ends when the user picks a Pane, which is the point
    // ordinary reveal speaks for.
    const entryRef = useRef<TabEntry | null>(null);

    const paneGap = usePrimarySettings((s) => s.paneGap);
    const paneRadius = usePrimarySettings((s) => s.paneRadius);
    const paneShadow = usePrimarySettings((s) => s.paneShadow);

    useEffect(() => {
      const element = viewportRef.current;
      if (!element) return;
      const update = () => {
        if (element.clientWidth > 0 && element.clientHeight > 0) {
          setSize({ width: element.clientWidth, height: element.clientHeight });
        }
      };
      update();
      const observer = new ResizeObserver(update);
      observer.observe(element);
      return () => observer.disconnect();
    }, [isActive]);

    const previousTabIdRef = useRef(tab.id);
    const previousSizeRef = useRef(size);
    const isInitialMountRef = useRef(true);

    const layout = useMemo(() => computePaneLayoutRects(tab, size, paneGap), [tab, size, paneGap]);

    // The Topbar Tab indicator expresses this Tab's Viewport position
    // (ADR-0025). Every Scrolling Tab publishes, not just the active one: a
    // switch interpolates the underbar toward the incoming Tab's resting
    // position, which is its Viewport's scroll position. A BSP Viewport never
    // overflows, so it has nothing to publish.
    usePublishViewportMetrics({ ref: viewportRef, tabId: tab.id, enabled: scrolling });

    const previewLayout = useMemo(
      () => (previewTab ? computePaneLayoutRects(previewTab, size, paneGap) : undefined),
      [previewTab, size, paneGap],
    );

    useLayoutEffect(() => {
      if (!isActive) return;
      const viewport = viewportRef.current;
      if (!viewport?.querySelectorAll) return;
      const targets = previewLayout?.rects ?? layout.rects;
      const viewportSizeChanged =
        paneMotionSize.current.width !== size.width ||
        paneMotionSize.current.height !== size.height;
      paneMotionSize.current = size;
      const dataset =
        typeof document === "undefined" ? undefined : document.documentElement?.dataset;
      const direct = Boolean(
        viewportSizeChanged ||
        dataset?.workbenchResizing ||
        dataset?.sidebarMotion ||
        dataset?.workbenchDragging ||
        skipAutomaticWorkbenchMotion(),
      );
      const seen = new Set<string>();
      for (const frame of viewport.querySelectorAll<HTMLElement>(".workbench-pane-frame")) {
        const id = frame.dataset.paneId;
        if (!id) continue;
        const target = targets.get(id);
        if (!target) continue;
        seen.add(id);
        let controller = paneMotions.current.get(id);
        if (!controller) {
          controller = createPaneRectMotion(frame, target);
          paneMotions.current.set(id, controller);
        }
        controller.retarget(target, direct);
      }
      for (const [id, controller] of paneMotions.current) {
        if (seen.has(id)) continue;
        controller.stop();
        paneMotions.current.delete(id);
      }
    }, [isActive, layout, previewLayout, size]);

    useEffect(
      () => () => {
        for (const controller of paneMotions.current.values()) controller.stop();
        paneMotions.current.clear();
      },
      [],
    );

    useLayoutEffect(() => {
      if (!isActive) return;
      const viewport = viewportRef.current;
      if (!scrolling || !viewport) return;

      if (dragState?.phase === "dragging" || document.documentElement.dataset.workbenchResizing) {
        return;
      }

      // Scrolling away from where the entry left the Viewport is direct
      // manipulation, and outranks the entry, so this yields on its own.
      entryRef.current = holdTabEntry(
        entryRef.current,
        entryDir,
        tab.focusedPaneId,
        viewport.scrollLeft,
      );
      const heldEntry = entryRef.current;

      const rect = layout.rects.get(tab.focusedPaneId);
      if (!rect) return;

      const target = computeScrollingRevealTarget({
        isSingleColumn: (tab.columns ?? []).length <= 1,
        rect,
        paneGap,
        canvasWidth: layout.canvasWidth,
        viewportWidth: viewport.clientWidth,
        currentScrollLeft: viewport.scrollLeft,
        ...(heldEntry === null ? {} : { entryDir: heldEntry.dir }),
      });

      if (!target) return;

      const isTabSwitch = previousTabIdRef.current !== tab.id;
      previousTabIdRef.current = tab.id;

      const isWindowResize =
        previousSizeRef.current.width !== size.width ||
        previousSizeRef.current.height !== size.height;
      previousSizeRef.current = size;

      const isInitialMount = isInitialMountRef.current;
      isInitialMountRef.current = false;

      if (!target.needsScroll) {
        // The Viewport is already where it belongs, but the entry must record
        // that offset, or the next pass reads the entry as abandoned.
        if (heldEntry !== null) {
          entryRef.current = { ...heldEntry, settledAt: viewport.scrollLeft };
        }
        return;
      }

      if (
        isInitialMount ||
        isTabSwitch ||
        heldEntry !== null ||
        isWindowResize ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
      ) {
        cancelActiveScrollAnimation(viewport);
        viewport.scrollLeft = target.targetLeft;
        viewport.scrollTop = target.targetTop;
        if (entryRef.current !== null) {
          entryRef.current = { ...entryRef.current, settledAt: target.targetLeft };
        }
        return;
      }

      return animateScrollTo(viewport, target.targetLeft, target.targetTop);
    }, [
      isActive,
      scrolling,
      tab.id,
      tab.focusedPaneId,
      tab.columns,
      layout,
      size,
      paneGap,
      dragState?.phase,
      entryDir,
    ]);

    useEffect(() => {
      if (!isActive) return;
      const viewport = viewportRef.current;
      if (!viewport?.querySelector) return;
      const pane = viewport.querySelector<HTMLElement>(
        `[data-pane-id="${tab.focusedPaneId}"] .workbench-pane`,
      );
      pane?.focus({ preventScroll: true });
    }, [isActive, tab.focusedPaneId]);

    useLayoutEffect(() => {
      if (!isSwitchParticipant(transitionRole)) return;
      const viewport = viewportRef.current;
      if (viewport === null) return;
      const apply = (frame: TabTransitionFrame | null) =>
        writeTransitionCardTransform(viewport, tab.id, frame);
      apply(getTabTransitionFrame());
      const unsubscribe = subscribeTabTransitionFrame(apply);
      return () => {
        unsubscribe();
        writeTransitionCardTransform(viewport, tab.id, null);
      };
    }, [transitionRole, tab.id]);

    const activeLayout = previewLayout ?? layout;
    const canvasStyle = {
      width: Math.max(activeLayout.canvasWidth, size.width),
      height: activeLayout.canvasHeight,
      "--pane-gap": `${paneGap}px`,
      "--pane-radius": `${paneRadius}px`,
      "--pane-shadow": resolvePaneBoxShadow(paneGap, paneShadow),
    } as React.CSSProperties;

    const hidden = transitionRole === "inactive" || transitionRole === "hidden";

    return (
      <div
        ref={viewportRef}
        className="workbench-viewport"
        style={{ display: hidden ? "none" : undefined }}
        data-tab-id={tab.id}
        data-tab-active={isActive ? "true" : "false"}
        data-tab-transition-role={transitionRole}
        data-layout-mode={scrolling ? "scrolling" : "bsp"}
        aria-hidden={!isActive}
      >
        <div className="workbench-canvas" style={canvasStyle}>
          {[...tab.panes.keys()].map((paneId) => {
            const current = layout.rects.get(paneId);
            const preview = previewLayout?.rects.get(paneId);
            const targetRect = preview ?? current;
            const isDraggedPane =
              dragState?.phase === "dragging" &&
              dragState.source.kind === "pane" &&
              dragState.source.paneId === paneId;
            return (
              <div
                key={paneId}
                className="workbench-pane-frame"
                data-pane-id={paneId}
                style={targetRect}
                onMouseDownCapture={(event) => {
                  if (paneId !== tab.focusedPaneId) {
                    setFocused(paneId);
                    if (typeof document !== "undefined") {
                      const activeEl = document.activeElement;
                      if (
                        activeEl &&
                        typeof (activeEl as { blur?: unknown }).blur === "function" &&
                        typeof (activeEl as { closest?: unknown }).closest === "function"
                      ) {
                        const activePane = (activeEl as HTMLElement).closest<HTMLElement>(
                          ".workbench-pane",
                        );
                        if (activePane && activePane.dataset.paneId !== paneId) {
                          (activeEl as HTMLElement).blur();
                          if (typeof window !== "undefined") {
                            window.getSelection()?.removeAllRanges();
                          }
                        }
                      }
                    }
                    const targetElement = event?.target as HTMLElement | null | undefined;
                    const isInteractive = Boolean(
                      targetElement?.closest?.(
                        'input, textarea, [contenteditable="true"], button, a, select, [role="button"], [role="menuitem"]',
                      ),
                    );
                    if (!isInteractive && event?.currentTarget?.querySelector) {
                      const pane =
                        event.currentTarget.querySelector<HTMLElement>(".workbench-pane");
                      pane?.focus({ preventScroll: true });
                    }
                  }
                }}
              >
                <div
                  className="workbench-pane-preview"
                  data-previewing={Boolean(previewTab)}
                  style={{
                    opacity: previewTab && !preview ? 0.2 : isDraggedPane ? 0.5 : undefined,
                  }}
                >
                  <Pane
                    tab={tab}
                    projects={projects}
                    paneId={paneId}
                    focused={isActive && paneId === tab.focusedPaneId}
                  />
                </div>
              </div>
            );
          })}

          {layout.sashes.map((sash) => {
            if (sash.isColumnWidth) {
              const column = (tab.columns ?? []).find((c) => c.id === sash.columnId);
              if (!column) return null;
              return (
                <ResizeHandle
                  key={sash.id}
                  label={sash.label}
                  dir={sash.dir}
                  style={{
                    left: sash.left,
                    top: sash.top,
                    width: sash.width,
                    height: sash.height,
                  }}
                  onDelta={(delta) => changeColumn(column.id, { width: column.width + delta })}
                />
              );
            }
            if (sash.isPaneHeight) {
              const column = (tab.columns ?? []).find((c) => c.id === sash.columnId);
              if (!column || sash.paneIndex === undefined) return null;
              const index = sash.paneIndex;
              return (
                <ResizeHandle
                  key={sash.id}
                  label={sash.label}
                  dir={sash.dir}
                  style={{
                    left: sash.left,
                    top: sash.top,
                    width: sash.width,
                    height: sash.height,
                  }}
                  onDelta={(delta) => {
                    const shares = [...column.shares];
                    const a = shares[index]!;
                    const b = shares[index + 1]!;
                    const totalPx = sash.totalPx ?? layout.canvasHeight;
                    if (totalPx <= 0) return;
                    const min = Math.min(MIN_PANE_HEIGHT / totalPx, (a + b) / 2);
                    const next = Math.max(min, Math.min(a + b - min, a + delta / totalPx));
                    shares[index] = next;
                    shares[index + 1] = a + b - next;
                    changeColumn(column.id, { shares });
                  }}
                />
              );
            }
            if (sash.splitId && sash.index !== undefined && sash.sizes) {
              return (
                <SashHandle
                  key={sash.id}
                  splitId={sash.splitId}
                  index={sash.index}
                  dir={sash.dir}
                  sizes={sash.sizes}
                  style={{
                    left: sash.left,
                    top: sash.top,
                    width: sash.width,
                    height: sash.height,
                  }}
                  totalPx={sash.totalPx ?? layout.canvasWidth}
                />
              );
            }
            return null;
          })}
        </div>
      </div>
    );
  },
  (prev, next) => {
    if (prev.isActive !== next.isActive) return false;
    if (prev.transitionRole !== next.transitionRole) return false;
    if (prev.tab !== next.tab) return false;
    if (prev.projects !== next.projects) return false;
    return true;
  },
);

interface PaneProps {
  readonly tab: WorkbenchTab;
  readonly projects: ReadonlyArray<EnvironmentAwenProject>;
  readonly paneId: string;
  readonly focused: boolean;
}

function Pane({ tab, projects, paneId, focused }: PaneProps) {
  const setFocused = useWorkbenchStore((s) => s.setFocused);
  const focusRequestId = useWorkbenchStore((s) => s.focusRequestId);
  const requestClosePane = useWorkbenchStore((s) => s.requestClosePane);
  const view = tab.panes.get(paneId);
  const target = view?.target ?? null;
  const definition = target === null ? null : resolveViewDefinition(target);
  const breadcrumbs =
    target === null ? ["Unavailable View"] : resolveTargetBreadcrumbs(target, projects);
  const drag = useWorkbenchDragSource(
    { kind: "pane", tabId: tab.id, paneId },
    breadcrumbs.at(-1) ?? "View",
  );

  const onClick = useCallback(() => {
    if (!focused) setFocused(paneId);
  }, [focused, paneId, setFocused]);

  const onPaneFocus = useCallback(
    (event?: React.FocusEvent<HTMLDivElement>) => {
      if (focused) return;
      if (
        !event?.currentTarget ||
        typeof document === "undefined" ||
        (document.activeElement &&
          event.currentTarget.contains(document.activeElement) &&
          (document.activeElement as HTMLElement).closest<HTMLElement>(".workbench-pane")?.dataset
            .paneId === paneId)
      ) {
        setFocused(paneId);
      }
    },
    [focused, paneId, setFocused],
  );

  const contentRef = useRef<HTMLDivElement>(null);
  const [availableSize, setAvailableSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;
    const update = ({ width, height }: { width: number; height: number }) => {
      setAvailableSize((previous) =>
        previous.width === width && previous.height === height ? previous : { width, height },
      );
    };
    update(element.getBoundingClientRect());
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      update({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [definition]);

  return (
    <div
      role="region"
      aria-label={target !== null ? `Pane ${target.kind}` : "Unavailable View"}
      tabIndex={-1}
      onMouseDown={onClick}
      onFocus={onPaneFocus}
      className={"workbench-pane flex h-full min-h-0 min-w-0 flex-1 flex-col outline-none"}
      data-pane-id={paneId}
      data-workbench-pane-drop=""
      data-workbench-tab-id={tab.id}
      data-pane-focused={focused}
      data-pane-target-kind={target?.kind ?? "empty"}
    >
      <PaneHeader
        paneId={paneId}
        breadcrumbs={breadcrumbs}
        focused={focused}
        target={target}
        onDragStart={drag.onPointerDown}
        onClose={() => void requestClosePane(paneId)}
      />
      <div ref={contentRef} className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
          {definition === null ? (
            <EmptyPane target={target} />
          ) : (
            <definition.Component
              key={paneId}
              target={target!}
              paneId={paneId}
              focused={focused}
              focusRequestId={focusRequestId}
              availableSize={availableSize}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function PaneEnvironmentBadge({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  if (!environment) return null;

  const phase = environment.connection.phase;
  const isConnected = phase === "connected";
  const isConnecting = phase === "connecting" || phase === "reconnecting";
  const tooltipText = `Environment: ${environment.label} (${phase})`;

  const badge = (
    <div
      role="status"
      data-testid="pane-environment-badge"
      aria-label={tooltipText}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted/60 text-muted-foreground shrink-0 select-none cursor-default"
    >
      <span
        className={cn(
          "size-1.5 rounded-full shrink-0",
          isConnected ? "bg-success" : isConnecting ? "bg-warning animate-pulse" : "bg-destructive",
        )}
      />
      <span className="truncate max-w-[120px]">{environment.label}</span>
    </div>
  );

  if (typeof window === "undefined") {
    return badge;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={badge} />
      <TooltipPopup side="top">{tooltipText}</TooltipPopup>
    </Tooltip>
  );
}

function PaneHeader({
  breadcrumbs,
  focused,
  target,
  onDragStart,
  onClose,
}: {
  readonly paneId: string;
  readonly breadcrumbs: readonly string[];
  readonly focused: boolean;
  readonly target: ViewTarget | null;
  readonly onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onClose: () => void;
}) {
  return (
    <div
      tabIndex={0}
      role="toolbar"
      aria-label="Pane header"
      data-pane-header-focused={focused}
      data-workbench-pane-drag-handle=""
      className="flex select-none items-center justify-between px-3 py-1.5 text-xs touch-none cursor-grab active:cursor-grabbing"
      onMouseDown={(event) => {
        const targetElement = event.target as HTMLElement;
        if (targetElement.closest("button") === null) {
          event.preventDefault();
          event?.currentTarget
            ?.closest?.<HTMLElement>(".workbench-pane")
            ?.focus({ preventScroll: true });
        }
      }}
      onPointerDown={(event) => {
        const targetElement = event.target as HTMLElement;
        if (targetElement.closest("button") !== null) {
          return;
        }
        onDragStart(event);
      }}
      onContextMenu={(event) => {
        // Panes have no context menu; keep right-click from opening a stray one.
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {breadcrumbs.map((breadcrumb, index) => (
          <span key={`${breadcrumb}-${index}`} className="flex min-w-0 items-center gap-1.5">
            {index > 0 ? <span className="shrink-0 text-muted-foreground/50">·</span> : null}
            <span
              className={
                index === breadcrumbs.length - 1
                  ? "truncate text-foreground"
                  : "truncate text-muted-foreground"
              }
            >
              {breadcrumb}
            </span>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-1.5 shrink-0 ml-2">
        {target !== null && "environmentId" in target ? (
          <PaneEnvironmentBadge environmentId={target.environmentId} />
        ) : null}
        <button
          type="button"
          aria-label="Close pane"
          className="rounded px-1.5 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={onClose}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function EmptyPane({ target }: { readonly target: ViewTarget | null }) {
  if (target !== null) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-muted-foreground">
        Rendering view for {target.kind}...
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-muted-foreground">
      View unavailable.
    </div>
  );
}

interface ResizeHandleProps {
  readonly dir: SplitDir;
  readonly style: React.CSSProperties;
  readonly label: string;
  readonly onDelta: (delta: number) => void;
  readonly splitId?: string;
  readonly index?: number;
}

function ResizeHandle({ dir, style, label, onDelta, splitId, index }: ResizeHandleProps) {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    cleanupRef.current?.();
    const start = dir === "right" ? event.clientX : event.clientY;
    document.documentElement.dataset.workbenchResizing = "true";
    const move = (e: PointerEvent) => onDelta((dir === "right" ? e.clientX : e.clientY) - start);
    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      delete document.documentElement.dataset.workbenchResizing;
      cleanupRef.current = null;
    };
    cleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  };
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={dir === "right" ? "vertical" : "horizontal"}
      tabIndex={0}
      onPointerDown={begin}
      onKeyDown={(event) => {
        const negative = dir === "right" ? "ArrowLeft" : "ArrowUp";
        const positive = dir === "right" ? "ArrowRight" : "ArrowDown";
        if (event.key !== negative && event.key !== positive) return;
        event.preventDefault();
        onDelta((event.key === negative ? -1 : 1) * (event.shiftKey ? 64 : 16));
      }}
      className="workbench-sash"
      style={{ ...style, cursor: dir === "right" ? "col-resize" : "row-resize" }}
      data-sash-id={splitId}
      data-sash-index={index}
    />
  );
}

function SashHandle({
  splitId,
  index,
  dir,
  sizes,
  style,
  totalPx,
}: {
  splitId: string;
  index: number;
  dir: SplitDir;
  sizes: readonly number[];
  style: React.CSSProperties;
  totalPx: number;
}) {
  const setSplitRatio = useWorkbenchStore((s) => s.setSplitRatio);
  return (
    <ResizeHandle
      dir={dir}
      style={style}
      label="Pane size"
      splitId={splitId}
      index={index}
      onDelta={(delta) => {
        if (totalPx <= 0) return;
        const boundary = sizes.slice(0, index + 1).reduce((a, b) => a + b, 0);
        setSplitRatio(splitId, index, boundary + delta / totalPx);
      }}
    />
  );
}
