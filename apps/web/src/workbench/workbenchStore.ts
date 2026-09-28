export interface PaneCloseGuard {
  readonly isDirty: () => boolean;
  readonly confirmClose: () => Promise<boolean>;
}
import { type LayoutMode } from "./scrollingLayout";
import { create } from "zustand";

import {
  applySetLayoutMode,
  applyColumnChange,
  applyMoveInColumn,
  applyCreateTab,
  applyMoveTab,
  applyActivateTab,
  activeTabIdAfterClose,
  applyClosePane,
  applyRemoveSessionViews,
  applyRenameTab,
  applyOpenDeepLinkTarget,
  applyOpenTarget,
  applyOpenFromPane,
  applyPruneWorkspaceViews,
  applySetFocused,
  applySetSplitRatio,
  applySplitPane,
  applySplitFocused,
  applyViewDrop,
  clearedTab,
  emptyWorkbenchSnapshot,
  type ViewDragSource,
  type ViewDropTarget,
  type ViewDropResult,
  type WorkbenchSnapshot,
} from "./workbenchState";
import type { SplitDir } from "./layout";
import type { ViewTarget } from "./viewRegistry";
import { readWorkbenchSnapshot, writeWorkbenchSnapshot } from "./workbenchPersistence";
import { FLUID_MOTION_DURATION_MS, scaledMotionDuration } from "./workbenchMotion";

export type ViewClosureListener = (targets: readonly ViewTarget[]) => void;

/** Public presentation commands; lifecycle observers own any Session cleanup. */
export interface WorkbenchStore extends WorkbenchSnapshot {
  readonly focusRequestId: number;
  /** Tabs currently animating their 220ms fluid collapse before removal. */
  readonly closingTabIds: ReadonlySet<string>;
  setLayoutMode: (mode: LayoutMode) => void;
  changeColumn: (
    id: string,
    change: { width?: number; direction?: -1 | 1; shares?: readonly number[] },
  ) => void;
  moveInColumn: (paneId: string, direction: -1 | 1) => void;
  createTab: () => void;
  activateTab: (tabId: string) => void;
  /**
   * Close a Tab with the 220ms fluid collapse animation (ADR-0013): the Tab is
   * marked as closing first and only removed from `tabs` once the animation
   * has settled. Closing the active Tab activates its survivor immediately.
   */
  closeTab: (tabId: string) => void;
  moveTab: (fromIndex: number, toIndex: number) => void;
  renameTab: (tabId: string, title: string | null) => void;
  closeView: (paneId: string) => void;
  removeSessionViews: (target: ViewTarget) => void;
  previewDrop: (source: ViewDragSource, target: ViewDropTarget) => ViewDropResult | null;
  commitDrop: (result: ViewDropResult) => void;
  openTarget: (target: ViewTarget) => void;
  openFromPane: (paneId: string, target: ViewTarget) => void;
  setPanePresentation: (paneId: string, presentation: Readonly<Record<string, unknown>>) => void;
  openDeepLinkTarget: (target: ViewTarget) => void;
  pruneWorkspaceViews: (
    workspaces: ReadonlyArray<{ readonly environmentId: string; readonly workspaceId: string }>,
    observedEnvironmentIds?: ReadonlyArray<string>,
  ) => void;
  splitFocused: (target: ViewTarget, dir: SplitDir) => void;
  splitPane: (paneId: string, target: ViewTarget, dir: SplitDir) => void;
  setFocused: (paneId: string) => void;
  setSplitRatio: (splitId: string, index: number, ratio: number) => void;
  registerCloseGuard: (paneId: string, guard: PaneCloseGuard) => () => void;
  requestClosePane: (paneId: string) => Promise<boolean>;
  canCloseTab: (tabId: string) => Promise<boolean>;
  subscribeViewClosures: (listener: ViewClosureListener) => () => void;
}

const defaultGenerateId = (): string => {
  const random = Math.random().toString(36).slice(2, 10);
  const stamp = Date.now().toString(36);
  return `id-${stamp}-${random}`;
};

export interface WorkbenchStoreOptions {
  readonly initialSnapshot?: WorkbenchSnapshot;
  readonly generateId?: () => string;
  readonly persist?: (snapshot: WorkbenchSnapshot) => void;
}

/**
 * Timers for delayed Tab removals, keyed by store instance so
 * `resetWorkbenchStore` can cancel the singleton's pending work between tests.
 */
const closeTimersByStore = new WeakMap<object, Set<ReturnType<typeof setTimeout>>>();

function cancelPendingCloseTasks(store: object): void {
  const timers = closeTimersByStore.get(store);
  if (timers === undefined) return;
  for (const timer of timers) clearTimeout(timer);
  timers.clear();
}

export function createWorkbenchStore(options: WorkbenchStoreOptions = {}) {
  const generateId = options.generateId ?? defaultGenerateId;
  const persist = options.persist ?? ((snapshot) => writeWorkbenchSnapshot(snapshot));
  const tabCloseDelayMs = () => scaledMotionDuration(FLUID_MOTION_DURATION_MS);
  const initialSnapshot =
    options.initialSnapshot ?? readWorkbenchSnapshot() ?? emptyWorkbenchSnapshot(generateId);
  const previews = new WeakMap<ViewDropResult, WorkbenchSnapshot>();
  const closeGuards = new Map<string, PaneCloseGuard>();
  const closureListeners = new Set<ViewClosureListener>();
  const closeTimers = new Set<ReturnType<typeof setTimeout>>();
  const scheduleCloseTask = (task: () => void, delay: number) => {
    const timer = setTimeout(() => {
      closeTimers.delete(timer);
      task();
    }, delay);
    closeTimers.add(timer);
  };
  const notifyClosedViews = (before: WorkbenchSnapshot, after: WorkbenchSnapshot) => {
    const remaining = new Set(after.tabs.flatMap((tab) => [...tab.panes.keys()]));
    const removed = before.tabs
      .flatMap((tab) => [...tab.panes.entries()])
      .filter(([paneId]) => !remaining.has(paneId))
      .map(([, view]) => view.target);
    if (removed.length > 0) for (const listener of closureListeners) listener(removed);
  };
  const store = create<WorkbenchStore>((set, get) => {
    /**
     * Remove the given closing Tabs once their fluid collapse has settled.
     *
     * Every Tab passed here was marked closing at the same moment, so the
     * removal is unconditional: the caller has already cleared the Tab's dead
     * Views, and the Workbench always keeps at least one Tab by recovering
     * Welcome in place when the last Tab would otherwise disappear.
     */
    const scheduleTabRemoval = (tabIds: ReadonlySet<string>, notifyRemoved: boolean) => {
      const delay = tabCloseDelayMs();
      scheduleCloseTask(() => {
        const previous = get();
        const closing = new Set([...tabIds].filter((tabId) => previous.closingTabIds.has(tabId)));
        const closingTabIds = new Set(previous.closingTabIds);
        for (const tabId of tabIds) closingTabIds.delete(tabId);
        if (closing.size === 0) {
          if (closingTabIds.size !== previous.closingTabIds.size) {
            set({ ...previous, closingTabIds });
          }
          return;
        }
        let tabs = previous.tabs.filter((tab) => !closing.has(tab.id));
        let activeTabId = previous.activeTabId;
        if (tabs.length === 0) {
          // The Workbench keeps at least one Tab (ADR-0013): recover the
          // active closed Tab as Welcome in place instead of removing it.
          const keeper =
            previous.tabs.find((tab) => closing.has(tab.id) && tab.id === previous.activeTabId) ??
            previous.tabs.find((tab) => closing.has(tab.id))!;
          const recovered = clearedTab(keeper, generateId);
          tabs = [recovered];
          activeTabId = recovered.id;
        } else if (closing.has(activeTabId)) {
          activeTabId = activeTabIdAfterClose(previous, tabs, closing);
        }
        set({ ...previous, tabs, activeTabId, closingTabIds });
        if (notifyRemoved) notifyClosedViews(previous, get());
      }, delay);
    };

    /**
     * The active Tab after `closingTabIds` starts collapsing: the survivor at
     * the closed Tab's index, else the last survivor; unchanged when the active
     * Tab is not closing or no survivor remains.
     */
    const activeTabIdAfterMarking = (
      snapshot: WorkbenchSnapshot,
      closingTabIds: ReadonlySet<string>,
    ): string => {
      const survivors = snapshot.tabs.filter((tab) => !closingTabIds.has(tab.id));
      return closingTabIds.has(snapshot.activeTabId) && survivors.length > 0
        ? activeTabIdAfterClose(snapshot, survivors, closingTabIds)
        : snapshot.activeTabId;
    };

    /**
     * Mark the given Tabs as closing and switch the active context immediately
     * (ADR-0013 zero-latency). Returns the next state, or null when none of the
     * Tabs needed marking.
     */
    const markTabsClosing = (state: WorkbenchStore, tabIds: ReadonlySet<string>) => {
      let added = false;
      const closingTabIds = new Set(state.closingTabIds);
      for (const tabId of tabIds) {
        if (closingTabIds.has(tabId)) continue;
        if (!state.tabs.some((tab) => tab.id === tabId)) continue;
        closingTabIds.add(tabId);
        added = true;
      }
      if (!added) return null;
      return {
        ...state,
        closingTabIds,
        activeTabId: activeTabIdAfterMarking(state, closingTabIds),
      };
    };

    /**
     * Run an explicit close transition. When the transition empties one or
     * more non-final Tabs (ADR-0023), those Tabs collapse with the fluid
     * animation before being removed; every other state change commits
     * immediately.
     *
     * `notifyViewClosure` mirrors the original close path: `closeView` notifies
     * its View closure, while `removeSessionViews` leaves lifecycle cleanup to
     * its caller.
     */
    const runCloseTransition = (
      transition: (snapshot: WorkbenchSnapshot) => WorkbenchSnapshot | null,
      notifyViewClosure: boolean,
    ) => {
      const before = get();
      const base: WorkbenchSnapshot = {
        tabs: before.tabs,
        activeTabId: before.activeTabId,
      };
      const after = transition(base);
      if (after === null || after === base) return;
      const remainingIds = new Set(after.tabs.map((tab) => tab.id));
      const emptiedTabIds = new Set(
        before.tabs.filter((tab) => !remainingIds.has(tab.id)).map((tab) => tab.id),
      );
      if (emptiedTabIds.size === 0) {
        set(after);
        if (notifyViewClosure) notifyClosedViews(base, get());
        return;
      }
      // Clear the emptied Tabs to Welcome immediately so their dead Views stop
      // rendering, mark them closing, and remove them once the collapse
      // settles. Clearing keeps the Tabs addressable through the animation,
      // and `after` still reconciles any Tab the transition kept (e.g. the
      // lone recovered Welcome keeper).
      set((state) => {
        const marked = markTabsClosing(state, emptiedTabIds);
        const closingTabIds = marked?.closingTabIds ?? state.closingTabIds;
        const transitioned = new Map(after.tabs.map((tab) => [tab.id, tab]));
        const tabs = state.tabs.map((tab) => {
          if (emptiedTabIds.has(tab.id) && closingTabIds.has(tab.id)) {
            return clearedTab(tab, generateId);
          }
          return transitioned.get(tab.id) ?? tab;
        });
        return {
          ...state,
          tabs,
          activeTabId: activeTabIdAfterMarking(state, closingTabIds),
          closingTabIds,
        };
      });
      if (notifyViewClosure) notifyClosedViews(base, get());
      scheduleTabRemoval(emptiedTabIds, false);
    };

    return {
      ...initialSnapshot,
      focusRequestId: 0,
      closingTabIds: new Set<string>(),
      setLayoutMode: (mode) =>
        set((snapshot) => ({
          ...applySetLayoutMode(snapshot, mode),
          focusRequestId: snapshot.focusRequestId + 1,
        })),
      changeColumn: (id, change) => set((snapshot) => applyColumnChange(snapshot, id, change)),
      moveInColumn: (id, direction) =>
        set((snapshot) => applyMoveInColumn(snapshot, id, direction)),
      createTab: () => set((snapshot) => applyCreateTab(snapshot, generateId)),
      activateTab: (tabId) => set((snapshot) => applyActivateTab(snapshot, tabId)),
      closeTab: (tabId) => {
        const state = get();
        // Keep at least one Tab that is not already collapsing, matching the
        // Topbar's single-Tab invariant (ADR-0013).
        if (state.closingTabIds.has(tabId) || state.tabs.length - state.closingTabIds.size <= 1) {
          return;
        }
        const marked = markTabsClosing(state, new Set([tabId]));
        if (marked === null) return;
        set(marked);
        scheduleTabRemoval(new Set([tabId]), true);
      },
      subscribeViewClosures: (listener) => {
        closureListeners.add(listener);
        return () => {
          closureListeners.delete(listener);
        };
      },
      moveTab: (fromIndex, toIndex) =>
        set((snapshot) => applyMoveTab(snapshot, fromIndex, toIndex)),
      renameTab: (tabId, title) => set((snapshot) => applyRenameTab(snapshot, tabId, title)),
      registerCloseGuard: (paneId, guard) => {
        closeGuards.set(paneId, guard);
        return () => {
          if (closeGuards.get(paneId) === guard) {
            closeGuards.delete(paneId);
          }
        };
      },
      requestClosePane: async (paneId) => {
        const guard = closeGuards.get(paneId);
        if (guard && guard.isDirty()) {
          const allowed = await guard.confirmClose();
          if (!allowed) return false;
        }
        get().closeView(paneId);
        return true;
      },
      canCloseTab: async (tabId) => {
        const tab = get().tabs.find((t) => t.id === tabId);
        if (!tab) return true;
        for (const paneId of tab.panes.keys()) {
          const guard = closeGuards.get(paneId);
          if (guard && guard.isDirty()) {
            const allowed = await guard.confirmClose();
            if (!allowed) return false;
          }
        }
        return true;
      },
      closeView: (paneId) => {
        runCloseTransition((snapshot) => applyClosePane(snapshot, paneId, generateId), true);
      },
      removeSessionViews: (target) => {
        runCloseTransition(
          (snapshot) => applyRemoveSessionViews(snapshot, target, generateId),
          false,
        );
      },
      openFromPane: (paneId, target) =>
        set((snapshot) => ({
          ...applyOpenFromPane(snapshot, paneId, target, generateId),
          focusRequestId: snapshot.focusRequestId + 1,
        })),
      setPanePresentation: (paneId, presentation) =>
        set((snapshot) => ({
          tabs: snapshot.tabs.map((tab) => {
            const pane = tab.panes.get(paneId);
            if (!pane) return tab;
            const panes = new Map(tab.panes);
            panes.set(paneId, { ...pane, presentation: { ...pane.presentation, ...presentation } });
            return { ...tab, panes };
          }),
        })),
      previewDrop: (source, target) => {
        const base = get();
        const result = applyViewDrop(base, source, target, generateId);
        if (result) previews.set(result, base);
        return result;
      },
      commitDrop: (result) =>
        set((snapshot) => {
          const base = previews.get(result);
          previews.delete(result);
          if (!base || base.tabs !== snapshot.tabs || base.activeTabId !== snapshot.activeTabId)
            return snapshot;
          return { ...result.snapshot, focusRequestId: snapshot.focusRequestId + 1 };
        }),
      openTarget: (target) =>
        set((snapshot) => ({
          ...applyOpenTarget(snapshot, target, generateId),
          focusRequestId: snapshot.focusRequestId + 1,
        })),
      openDeepLinkTarget: (target) =>
        set((snapshot) => ({
          ...applyOpenDeepLinkTarget(snapshot, target, generateId),
          focusRequestId: snapshot.focusRequestId + 1,
        })),
      pruneWorkspaceViews: (workspaces, observedEnvironmentIds) =>
        set((snapshot) =>
          applyPruneWorkspaceViews(snapshot, workspaces, generateId, observedEnvironmentIds),
        ),
      splitFocused: (target, dir) =>
        set((snapshot) => ({
          ...applySplitFocused(snapshot, target, dir, generateId),
          focusRequestId: snapshot.focusRequestId + 1,
        })),
      splitPane: (paneId, target, dir) =>
        set((snapshot) => ({
          ...applySplitPane(snapshot, paneId, target, dir, generateId),
          focusRequestId: snapshot.focusRequestId + 1,
        })),
      setFocused: (paneId) => set((snapshot) => applySetFocused(snapshot, paneId)),
      setSplitRatio: (splitId, index, ratio) =>
        set((snapshot) => applySetSplitRatio(snapshot, splitId, index, ratio)),
    };
  });

  closeTimersByStore.set(store, closeTimers);
  store.subscribe((snapshot, previous) => {
    if (snapshot.tabs === previous.tabs && snapshot.activeTabId === previous.activeTabId) return;
    persist({ tabs: snapshot.tabs, activeTabId: snapshot.activeTabId });
  });
  return store;
}

export const useWorkbenchStore = createWorkbenchStore();

/**
 * Test seam. Reset the store back to an empty workbench, cancelling any
 * pending closing-animation timers so their delayed removals cannot fire into
 * a later test.
 */
export function resetWorkbenchStore(): void {
  cancelPendingCloseTasks(useWorkbenchStore);
  useWorkbenchStore.setState({
    ...emptyWorkbenchSnapshot(defaultGenerateId),
    focusRequestId: 0,
    closingTabIds: new Set<string>(),
  });
}
