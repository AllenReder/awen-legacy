export interface PaneCloseGuard {
  readonly isDirty: () => boolean;
  readonly confirmClose: (reason?: "close" | "switch") => Promise<boolean>;
  /** Explicit close collects the choice before mutating a draft. */
  readonly prepareClose?: () => Promise<{
    readonly commit: () => Promise<boolean> | boolean;
  } | null>;
  readonly revision?: () => unknown;
}
export interface PaneCloseAdapter {
  /** Changes while a confirmation is open invalidate its decision. */
  readonly revision?: (target: ViewTarget) => unknown;
  readonly confirm?: (target: ViewTarget) => Promise<boolean>;
  readonly cleanup?: (target: ViewTarget) => Promise<void>;
}
export interface CloseOutcome {
  readonly paneId: string;
  readonly status: "closed" | "retained" | "failed";
  readonly error?: string;
}
export interface CloseResult {
  readonly outcomes: readonly CloseOutcome[];
}
import { type LayoutMode } from "./scrollingLayout";
import { create } from "zustand";

import {
  findResourcePane,
  getPanePresentation,
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
import { targetKey, type ViewTarget } from "./viewRegistry";
import { readWorkbenchSnapshot, writeWorkbenchSnapshot } from "./workbenchPersistence";
import { FLUID_MOTION_DURATION_MS, scaledMotionDuration } from "./workbenchMotion";

export type ViewClosureListener = (targets: readonly ViewTarget[]) => void;

/** Workbench commands and the explicit Pane/Tab close coordinator. */
export interface WorkbenchStore extends WorkbenchSnapshot {
  readonly focusRequestId: number;
  /** Tabs currently animating their 220ms fluid collapse before removal. */
  readonly closingTabIds: ReadonlySet<string>;
  readonly closeErrors: ReadonlyMap<string, string>;
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
  openTarget: (target: ViewTarget) => Promise<boolean>;
  openFromPane: (paneId: string, target: ViewTarget) => Promise<boolean>;
  setPanePresentation: (paneId: string, presentation: Readonly<Record<string, unknown>>) => void;
  openDeepLinkTarget: (target: ViewTarget) => Promise<boolean>;
  pruneWorkspaceViews: (
    workspaces: ReadonlyArray<{ readonly environmentId: string; readonly workspaceId: string }>,
    observedEnvironmentIds?: ReadonlyArray<string>,
  ) => void;
  splitFocused: (target: ViewTarget, dir: SplitDir) => void;
  splitPane: (paneId: string, target: ViewTarget, dir: SplitDir) => void;
  setFocused: (paneId: string) => void;
  setSplitRatio: (splitId: string, index: number, ratio: number) => void;
  registerCloseGuard: (paneId: string, guard: PaneCloseGuard) => () => void;
  registerCloseAdapter: (definitionId: string, adapter: PaneCloseAdapter) => () => void;
  requestClosePane: (paneId: string) => Promise<CloseResult>;
  requestCloseTab: (tabId: string) => Promise<CloseResult>;
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
  const closeAdapters = new Map<string, PaneCloseAdapter>();
  const pendingCloses = new Map<string, Promise<CloseResult>>();
  const activePaneRequests = new Set<string>();
  const pendingCleanup = new Map<string, Promise<void>>();
  const closureListeners = new Set<ViewClosureListener>();
  const guardWaiters = new Map<string, Set<(guard: PaneCloseGuard | null) => void>>();
  const waitForFileGuard = (paneId: string): Promise<PaneCloseGuard | null> => {
    const guard = closeGuards.get(paneId);
    if (guard) return Promise.resolve(guard);
    return new Promise((resolve) => {
      const waiters = guardWaiters.get(paneId) ?? new Set();
      waiters.add(resolve);
      guardWaiters.set(paneId, waiters);
    });
  };
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
    const pendingFileNavigations = new Map<string, Promise<boolean>>();
    const navigate = (
      target: ViewTarget,
      transition: (snapshot: WorkbenchSnapshot) => WorkbenchSnapshot,
    ): Promise<boolean> => {
      const commit = () => {
        set((snapshot) => ({
          ...transition(snapshot),
          focusRequestId: snapshot.focusRequestId + 1,
        }));
        return true;
      };
      if (
        target.kind !== "workspace" ||
        target.definitionId !== "fileView" ||
        target.initialPath === undefined
      ) {
        return Promise.resolve(commit());
      }
      const location = findResourcePane(get(), target);
      if (!location) return Promise.resolve(commit());
      const pending = pendingFileNavigations.get(location.paneId);
      if (pending)
        return pending.then(() =>
          findResourcePane(get(), target)?.paneId === location.paneId
            ? navigate(target, transition)
            : false,
        );
      const presentation = getPanePresentation(get(), location.paneId);
      if (presentation?.selectedPath === target.initialPath) return Promise.resolve(commit());
      const guard = closeGuards.get(location.paneId);
      if (!guard?.isDirty() && !presentation?.fileDraft) return Promise.resolve(commit());
      // Make the existing Files Pane and its decision dialog visible across Tabs.
      set((snapshot) =>
        applySetFocused(applyActivateTab(snapshot, location.tabId), location.paneId),
      );
      const confirmNavigation = async (mountedGuard: PaneCloseGuard | null): Promise<boolean> => {
        let current = getPanePresentation(get(), location.paneId);
        if (
          !mountedGuard ||
          !current ||
          current.selectedPath !== presentation?.selectedPath ||
          findResourcePane(get(), target)?.paneId !== location.paneId
        )
          return false;
        if (mountedGuard.isDirty() || current.fileDraft) {
          if (!(await mountedGuard.confirmClose("switch"))) return false;
        }
        current = getPanePresentation(get(), location.paneId);
        if (
          !current ||
          current.selectedPath !== presentation?.selectedPath ||
          findResourcePane(get(), target)?.paneId !== location.paneId
        )
          return false;
        return commit();
      };
      const operation = (
        guard ? confirmNavigation(guard) : waitForFileGuard(location.paneId).then(confirmNavigation)
      ).finally(() => pendingFileNavigations.delete(location.paneId));
      pendingFileNavigations.set(location.paneId, operation);
      return operation;
    };

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

    const requestClose = (key: string, paneIds: readonly string[], tabId?: string) => {
      const existing = pendingCloses.get(key);
      if (existing) return existing;
      const captured = paneIds.flatMap((paneId) => {
        const tab = get().tabs.find((item) => item.panes.has(paneId));
        const view = tab?.panes.get(paneId);
        if (!tab || !view) return [];
        const guard = closeGuards.get(paneId);
        const adapter = closeAdapters.get(view.definitionId);
        return [
          {
            paneId,
            tabId: tab.id,
            target: view.target,
            selectedPath: view.presentation?.selectedPath,
            guard,
            guardRevision: guard?.revision?.(),
            adapter,
            revision: adapter?.revision?.(view.target),
            dirty: guard?.isDirty() ?? Boolean(view.presentation?.fileDraft),
          },
        ];
      });
      if (captured.some(({ paneId }) => activePaneRequests.has(paneId))) {
        return Promise.resolve({
          outcomes: captured.map(({ paneId }) => ({ paneId, status: "retained" as const })),
        });
      }
      for (const { paneId } of captured) activePaneRequests.add(paneId);
      const stillCurrent = (entry: (typeof captured)[number]) => {
        const tab = get().tabs.find((item) => item.id === entry.tabId);
        const view = tab?.panes.get(entry.paneId);
        return Boolean(
          view &&
          (tabId === undefined || tabId === entry.tabId) &&
          targetKey(view.target) === targetKey(entry.target) &&
          view.presentation?.selectedPath === entry.selectedPath &&
          entry.adapter?.revision?.(entry.target) === entry.revision,
        );
      };
      const operation = (async (): Promise<CloseResult> => {
        const preparations = new Map<
          string,
          { readonly commit: () => Promise<boolean> | boolean }
        >();
        // Finish every reversible decision before touching any resource.
        for (const entry of captured) {
          try {
            if (entry.dirty) {
              const guard = entry.guard ?? (await waitForFileGuard(entry.paneId));
              if (!guard) {
                return { outcomes: captured.map(({ paneId }) => ({ paneId, status: "retained" })) };
              }
              if (!entry.guard) {
                entry.guard = guard;
                entry.guardRevision = guard.revision?.();
              }
              if (guard.prepareClose) {
                const preparation = await guard.prepareClose();
                if (!preparation) {
                  return {
                    outcomes: captured.map(({ paneId }) => ({ paneId, status: "retained" })),
                  };
                }
                preparations.set(entry.paneId, preparation);
              } else if (!(await guard.confirmClose("close"))) {
                return { outcomes: captured.map(({ paneId }) => ({ paneId, status: "retained" })) };
              }
            }
            if (entry.adapter?.confirm && !(await entry.adapter.confirm(entry.target))) {
              return { outcomes: captured.map(({ paneId }) => ({ paneId, status: "retained" })) };
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            set((state) => ({
              closeErrors: new Map(state.closeErrors).set(entry.paneId, message),
            }));
            return {
              outcomes: captured.map(({ paneId }) =>
                paneId === entry.paneId
                  ? { paneId, status: "failed", error: message }
                  : { paneId, status: "retained" },
              ),
            };
          }
        }
        const outcomes: CloseOutcome[] = [];
        for (const entry of captured) {
          const currentView = get()
            .tabs.find((tab) => tab.id === entry.tabId)
            ?.panes.get(entry.paneId);
          if (
            !stillCurrent(entry) ||
            (preparations.has(entry.paneId)
              ? entry.guard?.revision?.() !== entry.guardRevision
              : entry.guard?.isDirty() || Boolean(currentView?.presentation?.fileDraft))
          ) {
            outcomes.push({ paneId: entry.paneId, status: "retained" });
            continue;
          }
          const preparation = preparations.get(entry.paneId);
          if (preparation) {
            try {
              if (!(await preparation.commit())) {
                outcomes.push({ paneId: entry.paneId, status: "retained" });
                continue;
              }
              if (
                !stillCurrent(entry) ||
                entry.guard?.isDirty() ||
                Boolean(getPanePresentation(get(), entry.paneId)?.fileDraft)
              ) {
                outcomes.push({ paneId: entry.paneId, status: "retained" });
                continue;
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              set((state) => ({
                closeErrors: new Map(state.closeErrors).set(entry.paneId, message),
              }));
              outcomes.push({ paneId: entry.paneId, status: "failed", error: message });
              continue;
            }
          }
          if (entry.target.kind === "workspaceTerminal" && !entry.adapter?.cleanup) {
            const error = "Terminal close is unavailable.";
            set((state) => ({ closeErrors: new Map(state.closeErrors).set(entry.paneId, error) }));
            outcomes.push({ paneId: entry.paneId, status: "failed", error });
            continue;
          }
          try {
            if (entry.adapter?.cleanup) {
              const resourceKey = targetKey(entry.target);
              let cleanup = pendingCleanup.get(resourceKey);
              if (!cleanup) {
                cleanup = entry.adapter.cleanup(entry.target);
                pendingCleanup.set(resourceKey, cleanup);
              }
              try {
                await cleanup;
              } finally {
                if (pendingCleanup.get(resourceKey) === cleanup) pendingCleanup.delete(resourceKey);
              }
            }
            if (entry.target.kind === "welcome" && tabId !== undefined) {
              get().closeTab(entry.tabId);
            } else if (
              get().tabs.some(
                (tab) =>
                  tab.panes.get(entry.paneId) &&
                  targetKey(tab.panes.get(entry.paneId)!.target) === targetKey(entry.target),
              )
            ) {
              // Cleanup has committed: even a Pane moved during the RPC cannot
              // keep presenting a terminated resource.
              get().closeView(entry.paneId);
            }
            set((state) => {
              const closeErrors = new Map(state.closeErrors);
              closeErrors.delete(entry.paneId);
              return { closeErrors };
            });
            outcomes.push({ paneId: entry.paneId, status: "closed" });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            set((state) => ({
              closeErrors: new Map(state.closeErrors).set(entry.paneId, message),
            }));
            outcomes.push({ paneId: entry.paneId, status: "failed", error: message });
          }
        }
        return { outcomes };
      })();
      pendingCloses.set(key, operation);
      const clearPending = () => {
        if (pendingCloses.get(key) === operation) pendingCloses.delete(key);
        for (const { paneId } of captured) activePaneRequests.delete(paneId);
      };
      void operation.then(clearPending, clearPending);
      return operation;
    };

    return {
      ...initialSnapshot,
      focusRequestId: 0,
      closingTabIds: new Set<string>(),
      closeErrors: new Map<string, string>(),
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
        for (const resolve of guardWaiters.get(paneId) ?? []) resolve(guard);
        guardWaiters.delete(paneId);
        return () => {
          if (closeGuards.get(paneId) === guard) {
            closeGuards.delete(paneId);
          }
        };
      },
      registerCloseAdapter: (definitionId, adapter) => {
        closeAdapters.set(definitionId, adapter);
        return () => {
          if (closeAdapters.get(definitionId) === adapter) closeAdapters.delete(definitionId);
        };
      },
      requestClosePane: (paneId) => requestClose(`pane:${paneId}`, [paneId]),
      requestCloseTab: (tabId) => {
        const tab = get().tabs.find((candidate) => candidate.id === tabId);
        return requestClose(`tab:${tabId}`, tab ? [...tab.panes.keys()] : [], tabId);
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
        navigate(target, (snapshot) => applyOpenFromPane(snapshot, paneId, target, generateId)),
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
        navigate(target, (snapshot) => applyOpenTarget(snapshot, target, generateId)),
      openDeepLinkTarget: (target) =>
        navigate(target, (snapshot) => applyOpenDeepLinkTarget(snapshot, target, generateId)),
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
    for (const [paneId, waiters] of guardWaiters) {
      if (getPanePresentation(snapshot, paneId)) continue;
      for (const resolve of waiters) resolve(null);
      guardWaiters.delete(paneId);
    }
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
    closeErrors: new Map<string, string>(),
  });
}
