import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import { Columns3Icon, PanelsTopLeftIcon, PlusIcon, XIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { cn } from "../lib/utils";
import { MaterialSurface } from "../components/MaterialSurface";
import { WindowControls } from "../components/desktop/WindowControls";
import { handleTopbarDoubleClick } from "../lib/windowControls";
import { TopbarInset } from "./TopbarInset";
import { firstLeafId } from "./layout";
import { targetKey, type ViewTarget } from "./viewRegistry";
import { tabDisplayTitle, type WorkbenchSnapshot, type WorkbenchTab } from "./workbenchState";
import { useWorkbenchDragSource, useWorkbenchDragState } from "./workbenchDrag";
import { useWorkbenchStore } from "./workbenchStore";
import { useTabIndicator } from "./useTabIndicator";
import { tabIdsKey } from "./tabTransition";
import { resolveTargetContext, resolveTargetTitle } from "./workbenchTitles";

interface WorkbenchWindowChromeProps {
  readonly snapshot: WorkbenchSnapshot;
  readonly projects: ReadonlyArray<EnvironmentAwenProject>;
}

const TAB_ACCENTS = ["#38bdf8", "#a78bfa", "#34d399", "#fb7185", "#fbbf24"] as const;

function accentForTarget(target: ViewTarget): string {
  const key = targetKey(target);
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return TAB_ACCENTS[Math.abs(hash) % TAB_ACCENTS.length] ?? TAB_ACCENTS[0];
}

/** The frameless Workbench title strip shared by native and browser shells. */
export function WorkbenchWindowChrome({ snapshot, projects }: WorkbenchWindowChromeProps) {
  const setLayoutMode = useWorkbenchStore((state) => state.setLayoutMode);
  const activeTab = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId)!;
  const createTab = useWorkbenchStore((state) => state.createTab);
  const activateTab = useWorkbenchStore((state) => state.activateTab);
  const requestCloseTab = useWorkbenchStore((state) => state.requestCloseTab);
  const closingTabIds = useWorkbenchStore((state) => state.closingTabIds);
  const renameTab = useWorkbenchStore((state) => state.renameTab);
  const dragState = useWorkbenchDragState();
  const stripRef = useRef<HTMLDivElement>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const remainingTabsCount = snapshot.tabs.length - closingTabIds.size;

  const handleCloseTab = useCallback(
    async (tabId: string) => {
      if (snapshot.tabs.length - closingTabIds.size <= 1) return;
      if (closingTabIds.has(tabId)) return;

      await requestCloseTab(tabId);
    },
    [requestCloseTab, closingTabIds, snapshot.tabs],
  );

  const isAnyTabDragged = dragState?.phase === "dragging" && dragState.source.kind === "tab";
  const draggedTabId = isAnyTabDragged && dragState ? dragState.source.tabId : null;
  const draggedSourceIndex = draggedTabId
    ? snapshot.tabs.findIndex((t) => t.id === draggedTabId)
    : -1;

  let targetIndex = draggedSourceIndex;
  let deltaX = 0;
  let isSlidOut = false;
  let tabWidth = 176;

  if (isAnyTabDragged && dragState && draggedSourceIndex >= 0) {
    tabWidth = dragState.startRect.width || 176;
    deltaX = dragState.pointer.x - dragState.startPointer.x;
    isSlidOut =
      dragState.pointer.y > dragState.startRect.top + dragState.startRect.height + 12 ||
      dragState.pointer.y < dragState.startRect.top - 12;
    if (!isSlidOut)
      targetIndex = Math.max(
        0,
        Math.min(draggedSourceIndex + Math.round(deltaX / tabWidth), snapshot.tabs.length - 1),
      );
  }

  const tabsKey = tabIdsKey(snapshot.tabs);
  const indicatorRevision = isAnyTabDragged
    ? `${tabsKey}|${targetIndex}|${Math.round(deltaX)}|${isSlidOut}`
    : tabsKey;
  const indicatorRef = useTabIndicator({
    stripRef,
    activeTabId: snapshot.activeTabId,
    revision: indicatorRevision,
    dragging: isAnyTabDragged,
  });

  const lastDragInfoRef = useRef<{
    tabId: string;
    fromIndex: number;
    toIndex: number;
    deltaX: number;
    tabWidth: number;
  } | null>(null);

  const [settlingTab, setSettlingTab] = useState<{
    tabId: string;
    offset: number;
  } | null>(null);

  useLayoutEffect(() => {
    if (isAnyTabDragged && draggedTabId && draggedSourceIndex >= 0) {
      lastDragInfoRef.current = {
        tabId: draggedTabId,
        fromIndex: draggedSourceIndex,
        toIndex: targetIndex,
        deltaX,
        tabWidth,
      };
    } else if (lastDragInfoRef.current) {
      const prev = lastDragInfoRef.current;
      lastDragInfoRef.current = null;
      const cancelled = dragState?.phase === "canceling" || dragState?.phase === "rejected";
      const offset = cancelled
        ? prev.deltaX
        : (prev.fromIndex - prev.toIndex) * prev.tabWidth + prev.deltaX;
      if (Math.abs(offset) > 2) setSettlingTab({ tabId: prev.tabId, offset });
    }
  }, [
    isAnyTabDragged,
    draggedTabId,
    draggedSourceIndex,
    targetIndex,
    deltaX,
    tabWidth,
    dragState?.phase,
  ]);

  useEffect(() => {
    if (!settlingTab) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      if (cancelled) return;
      requestAnimationFrame(() => {
        if (cancelled) return;
        setSettlingTab(null);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [settlingTab]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.workbenchWindowChrome = "true";
    return () => {
      delete root.dataset.workbenchWindowChrome;
    };
  }, []);

  const titleFor = useMemo(
    () => (tab: WorkbenchTab) =>
      tabDisplayTitle(tab, (target) => resolveTargetTitle(target, projects)),
    [projects],
  );

  const commitRename = (tabId: string) => {
    renameTab(tabId, draftTitle);
    setEditingTabId(null);
    setDraftTitle("");
  };

  return (
    <MaterialSurface
      kind="topbar"
      className="wco:pr-[var(--workspace-native-controls-inset)] drag-region flex h-[var(--workspace-topbar-height)] w-full shrink-0 items-center border-b border-[var(--material-edge)] z-30"
      data-workbench-window-chrome=""
      onDoubleClick={handleTopbarDoubleClick}
    >
      <TopbarInset />

      <div className="flex h-full min-w-0 flex-1 items-center gap-2 pr-3">
        <div
          ref={stripRef}
          className="relative flex h-full min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          data-workbench-tab-strip-drop=""
          role="tablist"
          aria-label="Workbench tabs"
        >
          {snapshot.tabs.map((tab, index) => {
            const active = tab.id === snapshot.activeTabId;
            const title = titleFor(tab);
            const target = tab.panes.get(firstLeafId(tab.layout))?.target ?? {
              kind: "welcome" as const,
            };
            const accent = accentForTarget(target);
            return (
              <WorkbenchTabItem
                key={tab.id}
                tab={tab}
                index={index}
                active={active}
                title={title}
                target={target}
                accent={accent}
                projects={projects}
                editingTabId={editingTabId}
                draftTitle={draftTitle}
                setDraftTitle={setDraftTitle}
                setEditingTabId={setEditingTabId}
                commitRename={commitRename}
                activateTab={activateTab}
                onClose={() => handleCloseTab(tab.id)}
                isClosing={closingTabIds.has(tab.id)}
                isAnyTabDragged={isAnyTabDragged}
                draggedTabId={draggedTabId}
                draggedSourceIndex={draggedSourceIndex}
                targetIndex={targetIndex}
                deltaX={deltaX}
                isSlidOut={isSlidOut}
                tabWidth={tabWidth}
                remainingTabsCount={remainingTabsCount}
                isAnyTabClosing={closingTabIds.size > 0}
                settlingTab={settlingTab}
                snapshot={snapshot}
              />
            );
          })}
          <span
            ref={indicatorRef}
            aria-hidden="true"
            data-tab-indicator=""
            className="workbench-tab-indicator"
          >
            <span className="absolute inset-y-0 left-0 rounded-full bg-primary" />
          </span>
        </div>

        <div
          className="workbench-layout-switch shrink-0 [-webkit-app-region:no-drag]"
          data-layout={activeTab.layoutMode ?? "bsp"}
          role="group"
          aria-label="Tab layout"
        >
          <button
            type="button"
            aria-label="BSP layout"
            aria-pressed={activeTab.layoutMode !== "scrolling"}
            onClick={() => setLayoutMode("bsp")}
          >
            <PanelsTopLeftIcon />
          </button>
          <button
            type="button"
            aria-label="Scrolling layout"
            aria-pressed={activeTab.layoutMode === "scrolling"}
            onClick={() => setLayoutMode("scrolling")}
          >
            <Columns3Icon />
          </button>
        </div>
        <button
          type="button"
          aria-label="New tab"
          data-workbench-new-tab-drop="end"
          className="flex size-7 shrink-0 items-center justify-center rounded-[var(--control-radius)] border border-border/70 bg-muted/25 text-muted-foreground hover:bg-muted/60 hover:text-foreground [-webkit-app-region:no-drag]"
          onClick={createTab}
        >
          <PlusIcon className="size-4" />
        </button>
      </div>

      <WindowControls />
    </MaterialSurface>
  );
}

interface WorkbenchTabItemProps {
  readonly tab: WorkbenchTab;
  readonly index: number;
  readonly active: boolean;
  readonly title: string;
  readonly target: ViewTarget;
  readonly accent: string;
  readonly projects: ReadonlyArray<EnvironmentAwenProject>;
  readonly editingTabId: string | null;
  readonly draftTitle: string;
  readonly setDraftTitle: (title: string) => void;
  readonly setEditingTabId: (tabId: string | null) => void;
  readonly commitRename: (tabId: string) => void;
  readonly activateTab: (tabId: string) => void;
  readonly onClose: () => void;
  readonly isClosing: boolean;
  readonly isAnyTabDragged: boolean;
  readonly draggedTabId: string | null;
  readonly draggedSourceIndex: number;
  readonly targetIndex: number;
  readonly deltaX: number;
  readonly isSlidOut: boolean;
  readonly tabWidth: number;
  readonly remainingTabsCount: number;
  readonly isAnyTabClosing: boolean;
  readonly settlingTab: { readonly tabId: string; readonly offset: number } | null;
  readonly snapshot: WorkbenchSnapshot;
}

function WorkbenchTabItem({
  tab,
  index,
  active,
  title,
  target,
  accent,
  projects,
  editingTabId,
  draftTitle,
  setDraftTitle,
  setEditingTabId,
  commitRename,
  activateTab,
  onClose,
  isClosing,
  isAnyTabDragged,
  draggedTabId,
  draggedSourceIndex,
  targetIndex,
  deltaX,
  isSlidOut,
  tabWidth,
  remainingTabsCount,
  isAnyTabClosing,
  settlingTab,
  snapshot,
}: WorkbenchTabItemProps) {
  const drag = useWorkbenchDragSource({ kind: "tab", tabId: tab.id }, title);
  const isDragged = isAnyTabDragged && draggedTabId === tab.id;

  let tabStyle: CSSProperties | undefined;
  if (isClosing) {
    tabStyle = undefined;
  } else if (isAnyTabDragged && draggedSourceIndex >= 0) {
    if (isDragged) {
      if (isSlidOut) {
        tabStyle = {
          opacity: 0.4,
          pointerEvents: "none",
          transition: "opacity calc(150ms * var(--motion-duration-scale, 1)) ease",
        };
      } else {
        tabStyle = {
          transform: `translate3d(${deltaX}px, 0, 0)`,
          zIndex: 40,
          opacity: 0.95,
          pointerEvents: "none",
          boxShadow: "0 4px 16px rgba(0, 0, 0, 0.25)",
          transition: "none",
        };
      }
    } else if (!isSlidOut) {
      let shift = 0;
      if (targetIndex > draggedSourceIndex) {
        if (index > draggedSourceIndex && index <= targetIndex) {
          shift = -tabWidth;
        }
      } else if (targetIndex < draggedSourceIndex) {
        if (index >= targetIndex && index < draggedSourceIndex) {
          shift = tabWidth;
        }
      }
      tabStyle = {
        transform: shift !== 0 ? `translate3d(${shift}px, 0, 0)` : undefined,
        transition:
          "transform calc(220ms * var(--motion-duration-scale, 1)) cubic-bezier(0.22, 1, 0.36, 1)",
      };
    }
  } else if (settlingTab) {
    if (settlingTab.tabId === tab.id) {
      tabStyle = {
        transform: `translate3d(${settlingTab.offset}px, 0, 0)`,
        transition: "none",
      };
    } else {
      tabStyle = {
        transition: "none",
      };
    }
  } else {
    tabStyle = {
      transition:
        "transform calc(220ms * var(--motion-duration-scale, 1)) cubic-bezier(0.22, 1, 0.36, 1)",
    };
  }

  return (
    <div
      role="tab"
      aria-selected={active}
      aria-label={`Open ${title}`}
      tabIndex={active ? 0 : -1}
      data-tab-id={tab.id}
      data-workbench-tab-drop={tab.id}
      data-workbench-drag-source="tab"
      data-active-tab={active ? "true" : "false"}
      data-tab-closing={isClosing ? "true" : undefined}
      style={tabStyle}
      className={cn(
        "workbench-tab-item group relative flex h-full w-44 min-w-28 shrink cursor-pointer items-center gap-2 border-r border-border/60 px-3 text-left select-none [-webkit-app-region:no-drag] will-change-transform",
        active
          ? "bg-foreground/5 text-foreground"
          : "bg-transparent text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
      )}
      onClick={() => {
        if (drag.consumeSuppressedClick()) return;
        if (!active) activateTab(tab.id);
      }}
      onAuxClick={(event) => {
        if (event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          const targetElement = event.target as HTMLElement;
          if (targetElement.closest("input") !== null) {
            return;
          }
          if (editingTabId === tab.id) {
            return;
          }
          if (remainingTabsCount > 1 && !isClosing) {
            onClose();
          }
        }
      }}
      onPointerDown={(event) => {
        const targetElement = event.target as HTMLElement;
        if (targetElement.closest("button, input") !== null) {
          return;
        }
        if (event.button === 1) {
          event.preventDefault();
          return;
        }
        if (event.button === 0) {
          if (!isAnyTabClosing) {
            drag.onPointerDown(event);
          }
        }
      }}
      onMouseDown={(event) => {
        if (event.button === 1) {
          event.preventDefault();
        }
      }}
      onDoubleClick={() => {
        if (!active) return;
        setEditingTabId(tab.id);
        setDraftTitle(title);
      }}
      onKeyDown={(event) => {
        const currentIndex = snapshot.tabs.findIndex((candidate) => candidate.id === tab.id);
        if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
          event.preventDefault();
          const direction = event.key === "ArrowRight" ? 1 : -1;
          const next =
            snapshot.tabs[(currentIndex + direction + snapshot.tabs.length) % snapshot.tabs.length];
          if (next !== undefined) activateTab(next.id);
        }
        if (event.key === "F2" && active) {
          event.preventDefault();
          setEditingTabId(tab.id);
          setDraftTitle(title);
        }
      }}
    >
      <span className="size-2 shrink-0 rounded-full" style={{ background: accent }} />
      {active && editingTabId === tab.id ? (
        <input
          autoFocus
          value={draftTitle}
          aria-label="Tab title"
          className="mx-1 min-w-0 flex-1 rounded border border-border bg-background/20 px-1.5 py-0.5 text-xs outline-none focus:ring-1 focus:ring-ring"
          onChange={(event) => setDraftTitle(event.target.value)}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onBlur={() => commitRename(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitRename(tab.id);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setEditingTabId(null);
              setDraftTitle("");
            }
          }}
        />
      ) : (
        <div className="min-w-0 flex-1 block">
          <div className="truncate text-xs leading-none">{title}</div>
          <div className="truncate text-[9px] text-muted-foreground leading-none mt-0.5">
            {resolveTargetContext(target, projects)}
          </div>
        </div>
      )}
      {remainingTabsCount > 1 && !isClosing ? (
        <button
          type="button"
          aria-label={`Close ${title}`}
          className="opacity-0 group-hover:opacity-100 flex size-5 shrink-0 items-center justify-center rounded hover:bg-muted/80 text-muted-foreground hover:text-foreground transition-opacity [transition-duration:calc(150ms*var(--motion-duration-scale,1))]"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </div>
  );
}
