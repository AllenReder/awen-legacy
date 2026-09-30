import { useSyncExternalStore } from "react";
import type { DesktopBridge, WindowChromeMetrics } from "@awen/contracts";
import {
  WINDOW_CHROME,
  resolveWindowChromeGeometry,
  type WindowChromeGeometry,
} from "@awen/shared/windowChromeGeometry";
import { isMacPlatform } from "./utils";

type ChromeBridge = Pick<DesktopBridge, "getWindowChromeMetrics" | "onWindowChromeMetricsChange">;

/** The same snapshot drives CSS, width constraints, and Sidebar presentation. */
export function createWindowChromeStore(input: {
  readonly isMac: boolean;
  readonly bridge?: ChromeBridge;
  readonly style: Pick<CSSStyleDeclaration, "setProperty" | "removeProperty">;
}) {
  const listeners = new Set<() => void>();
  let snapshot = resolveWindowChromeGeometry({
    isMac: input.isMac,
    hasDesktopBridge: Boolean(input.bridge),
    fullscreen: false,
    zoomFactor: 1,
  });
  let unsubscribe: (() => void) | undefined;
  let nativeInset: number | undefined;
  let initialized = false;
  const write = (metrics: WindowChromeMetrics) => {
    const next = resolveWindowChromeGeometry({
      isMac: input.isMac,
      hasDesktopBridge: Boolean(input.bridge),
      ...metrics,
    });
    const nextNativeInset =
      input.bridge && input.isMac && !metrics.fullscreen ? next.triggerLeft : 0;
    const geometryChanged = Object.keys(next).some(
      (key) =>
        next[key as keyof WindowChromeGeometry] !== snapshot[key as keyof WindowChromeGeometry],
    );
    if (initialized && !geometryChanged && nextNativeInset === nativeInset) return;
    input.style.setProperty("--chrome-titlebar-base-height", `${next.titlebarHeight}px`);
    input.style.setProperty("--workspace-titlebar-control-size", `${next.buttonSize}px`);
    input.style.setProperty("--workspace-titlebar-control-gap", `${WINDOW_CHROME.controlGap}px`);
    input.style.setProperty("--sidebar-trigger-left", `${next.triggerLeft}px`);
    input.style.setProperty("--sidebar-action-right-gap", `${next.actionRightGap}px`);
    input.style.setProperty("--sidebar-edge-width", `${next.sidebarEdgeWidth}px`);
    input.style.setProperty("--sidebar-collapsed-action-left", `${next.collapsedActionLeft}px`);
    input.style.setProperty("--sidebar-collapsed-tabs-inset", `${next.collapsedTabsInset}px`);
    input.style.setProperty("--sidebar-separator-right-gap", `${next.separatorRightGap}px`);
    input.style.setProperty("--chrome-native-controls-left", `${nextNativeInset}px`);
    nativeInset = nextNativeInset;
    initialized = true;
    if (!geometryChanged) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    refresh() {
      write(input.bridge?.getWindowChromeMetrics() ?? { zoomFactor: 1, fullscreen: false });
    },
    initialize() {
      unsubscribe?.();
      const read = () =>
        input.bridge?.getWindowChromeMetrics() ?? { zoomFactor: 1, fullscreen: false };
      write(read());
      unsubscribe = input.bridge?.onWindowChromeMetricsChange(write);
      // Re-read after subscribing: the shell may have changed during setup.
      write(read());
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
      listeners.clear();
    },
  };
}

const browserGeometry = resolveWindowChromeGeometry({
  isMac: false,
  hasDesktopBridge: false,
  fullscreen: false,
  zoomFactor: 1,
});
let store: ReturnType<typeof createWindowChromeStore> | undefined;
let disposeCurrent: (() => void) | undefined;
const subscribe = (listener: () => void) => store?.subscribe(listener) ?? (() => {});
const getSnapshot = () => store?.getSnapshot() ?? browserGeometry;

/** Called before the first React commit, including auth and error routes. */
export function initializeWindowChrome(): () => void {
  disposeCurrent?.();
  const bridge = window.desktopBridge;
  const platform = bridge?.getClientPlatform?.() ?? navigator.platform;
  store = createWindowChromeStore({
    isMac: platform === "darwin" || isMacPlatform(platform),
    ...(bridge ? { bridge } : {}),
    style: document.documentElement.style,
  });
  const initializedStore = store;
  initializedStore.initialize();
  // Also covers direct Chromium zoom changes outside the application's menu.
  window.addEventListener("resize", initializedStore.refresh);
  const dispose = () => {
    window.removeEventListener("resize", initializedStore.refresh);
    initializedStore.dispose();
    if (store === initializedStore) {
      store = undefined;
      disposeCurrent = undefined;
    }
  };
  disposeCurrent = dispose;
  return dispose;
}

export function useWindowChromeGeometry(): WindowChromeGeometry {
  return useSyncExternalStore(subscribe, getSnapshot, () => browserGeometry);
}
