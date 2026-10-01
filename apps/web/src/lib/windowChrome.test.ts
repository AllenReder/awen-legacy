import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { WindowChromeMetrics } from "@awen/contracts";
import { createWindowChromeStore, initializeWindowChrome } from "./windowChrome";

function fixture(isMac = true, withBridge = true) {
  const properties = new Map<string, string | null>();
  let metrics = { zoomFactor: 1, fullscreen: false };
  let listener: ((value: WindowChromeMetrics) => void) | undefined;
  const unsubscribe = vi.fn(() => {
    listener = undefined;
  });
  const bridge = {
    getWindowChromeMetrics: vi.fn(() => metrics),
    onWindowChromeMetricsChange: vi.fn((callback: typeof listener) => {
      listener = callback;
      return unsubscribe;
    }),
  };
  const store = createWindowChromeStore({
    isMac,
    ...(withBridge ? { bridge } : {}),
    style: {
      setProperty: (key, value) => {
        properties.set(key, value);
        return undefined;
      },
      removeProperty: (key) => {
        const previous = properties.get(key) ?? "";
        properties.delete(key);
        return previous;
      },
    },
  });
  return {
    store,
    properties,
    bridge,
    unsubscribe,
    emit(value: WindowChromeMetrics) {
      metrics = value;
      listener?.(value);
    },
  };
}

describe("window chrome store", () => {
  it("writes CSS before notifying React and keeps identical snapshots stable", () => {
    const { store, properties, emit } = fixture();
    store.initialize();
    expect(properties.get("--sidebar-trigger-left")).toBe("76px");
    expect(properties.get("--workspace-titlebar-control-size")).toBe("28px");
    expect(properties.get("--sidebar-edge-width")).toBe("1px");
    expect(properties.get("--chrome-titlebar-base-height")).toBe("36px");
    const initial = store.getSnapshot();
    emit({ zoomFactor: 1, fullscreen: false });
    expect(store.getSnapshot()).toBe(initial);
    const notify = vi.fn(() => expect(properties.get("--sidebar-trigger-left")).toBe("60.8px"));
    const stop = store.subscribe(notify);
    emit({ zoomFactor: 1.25, fullscreen: false });
    expect(store.getSnapshot().minimumSidebarWidth).toBe(124.8);
    expect(notify).toHaveBeenCalledTimes(1);
    stop();
    emit({ zoomFactor: 2, fullscreen: false });
    expect(notify).toHaveBeenCalledTimes(1);
    store.dispose();
  });

  it("removes native reservations in fullscreen and restores them on exit", () => {
    const { store, properties, emit } = fixture();
    store.initialize();
    emit({ zoomFactor: 2, fullscreen: true });
    expect(store.getSnapshot().triggerLeft).toBe(6);
    expect(properties.get("--chrome-native-controls-left")).toBe("0px");
    emit({ zoomFactor: 2, fullscreen: false });
    expect(properties.get("--chrome-native-controls-left")).toBe("38px");
    store.dispose();
  });

  it.each([
    [true, false],
    [false, true],
  ])("does not reserve native space for isMac=%s bridge=%s", (isMac, withBridge) => {
    const { store, properties } = fixture(isMac, withBridge);
    store.initialize();
    expect(store.getSnapshot().triggerLeft).toBe(6);
    expect(properties.get("--chrome-native-controls-left")).toBe("0px");
    store.dispose();
  });

  it("re-reads after subscribing and cleans up repeated initialization", () => {
    const { store, bridge, unsubscribe } = fixture();
    bridge.getWindowChromeMetrics.mockReturnValueOnce({ zoomFactor: 1, fullscreen: false });
    bridge.getWindowChromeMetrics.mockReturnValue({ zoomFactor: 1.25, fullscreen: false });
    store.initialize();
    expect(store.getSnapshot().triggerLeft).toBe(60.8);
    store.initialize();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    store.dispose();
    store.dispose();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it("refreshes zoom changes made outside the menu", () => {
    const { store, bridge } = fixture();
    store.initialize();
    bridge.getWindowChromeMetrics.mockReturnValue({ zoomFactor: 2, fullscreen: false });
    store.refresh();
    expect(store.getSnapshot().triggerLeft).toBe(38);
    store.dispose();
  });
});

afterEach(() => vi.unstubAllGlobals());

it("recognizes Electron's darwin platform name for the native reservation", () => {
  const properties = new Map<string, string>();
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("document", {
    documentElement: {
      style: {
        setProperty: (key: string, value: string) => properties.set(key, value),
        removeProperty: (key: string) => properties.delete(key),
      },
    },
  });
  vi.stubGlobal("window", {
    desktopBridge: {
      getClientPlatform: () => "darwin",
      getWindowChromeMetrics: () => ({ zoomFactor: 1, fullscreen: false }),
      onWindowChromeMetricsChange: () => () => {},
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });
  const dispose = initializeWindowChrome();
  expect(properties.get("--sidebar-trigger-left")).toBe("76px");
  dispose();
});
