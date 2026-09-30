import { useLayoutEffect, useSyncExternalStore } from "react";

import {
  animateTabTransitionTo,
  deriveTabDirection,
  endTabTransition,
  getTabTransition,
  nextTabIndex,
  retargetTabTransition,
  subscribeTabTransition,
  tabIdsKey,
} from "./tabTransition";
import { skipAutomaticWorkbenchMotion } from "./workbenchMotion";
import { useWorkbenchStore } from "./workbenchStore";

export function useTabTransition() {
  return useSyncExternalStore(subscribeTabTransition, getTabTransition, getTabTransition);
}

let directActivation = false;

/** A fully aligned gesture checkpoint already has its presentation in place. */
export function activateNavigationCheckpoint(tabId: string): void {
  directActivation = true;
  try {
    useWorkbenchStore.getState().activateTab(tabId);
  } finally {
    directActivation = false;
  }
}

/** Direction is intent, including when navigation wraps past the last Tab. */
export function switchAdjacentTab(dir: -1 | 1): void {
  const store = useWorkbenchStore.getState();
  if (store.tabs.length <= 1) return;
  const fromIndex = store.tabs.findIndex((tab) => tab.id === store.activeTabId);
  const toIndex = nextTabIndex(store.tabs.length, fromIndex, dir);
  const target = store.tabs[toIndex];
  if (fromIndex < 0 || target === undefined) return;
  retargetTabTransition({
    fromTabId: store.activeTabId,
    toTabId: target.id,
    fromIndex,
    toIndex,
    dir,
  });
  finishTabSwitch(true);
}

/** All input paths settle through the same animation owner. */
export function finishTabSwitch(commit: boolean): void {
  const transition = getTabTransition();
  if (transition === null) return;
  if (commit) useWorkbenchStore.getState().activateTab(transition.toTabId);
  animateTabTransitionTo(commit ? 1 : 0);
}

/**
 * Observe navigation synchronously, before consumers render the new active Tab.
 * Structural changes land instantly; a gesture/wheel already carries its direction.
 */
export function TabTransitionController() {
  useLayoutEffect(() => {
    const unsubscribe = useWorkbenchStore.subscribe((state, previous) => {
      if (tabIdsKey(state.tabs) !== tabIdsKey(previous.tabs)) {
        endTabTransition();
        return;
      }
      if (state.activeTabId === previous.activeTabId) return;
      if (directActivation) return;
      const inFlight = getTabTransition();
      if (inFlight?.toTabId === state.activeTabId) return;
      if (state.tabs.length <= 1 || skipAutomaticWorkbenchMotion()) {
        endTabTransition();
        return;
      }
      const fromIndex = state.tabs.findIndex((tab) => tab.id === previous.activeTabId);
      const toIndex = state.tabs.findIndex((tab) => tab.id === state.activeTabId);
      const dir = deriveTabDirection(fromIndex, toIndex);
      if (fromIndex < 0 || toIndex < 0 || dir === 0) {
        endTabTransition();
        return;
      }
      retargetTabTransition({
        fromTabId: previous.activeTabId,
        toTabId: state.activeTabId,
        fromIndex,
        toIndex,
        dir,
      });
      animateTabTransitionTo(1);
    });
    return () => {
      unsubscribe();
      endTabTransition();
    };
  }, []);
  return null;
}
