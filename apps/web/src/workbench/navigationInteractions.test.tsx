import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useWorkbenchNavigation } from "./useWorkbenchNavigation";
import type { DesktopTrackpadInput } from "@awen/contracts";
import { TabTransitionController } from "./tabTransitionReact";
import { getTabTransitionFrame, resetTabTransitionForTest } from "./tabTransition";
import { emptyWorkbenchSnapshot, applyCreateTab } from "./workbenchState";
import { resetWorkbenchStore, useWorkbenchStore } from "./workbenchStore";

vi.mock("../contextMenuFallback", () => ({ dismissContextMenu: vi.fn() }));
let nativePhase: ((input: DesktopTrackpadInput) => void) | null = null;
const desktopBridge = {
  onTrackpadInput: (listener: (input: DesktopTrackpadInput) => void) => {
    nativePhase = listener;
    return () => {
      nativePhase = null;
    };
  },
};

class Surface extends EventTarget {
  clientWidth = 800;
  scrollWidth = 800;
  scrollLeft = 0;
  parentElement: Surface | null = null;
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  matches(selector: string) {
    return selector === ".workbench-viewport" && this === viewport;
  }
  querySelectorAll() {
    return [viewport];
  }
  contains() {
    return true;
  }
  closest() {
    return null;
  }
  querySelector() {
    return viewport;
  }
}
let viewport: Surface;
let stage: Surface;
let windowEvents: EventTarget;
let renderer: ReactTestRenderer;
let now: number;
let frames: Map<number, FrameRequestCallback>;
let reduced: boolean;
const menu = vi.fn();
function Probe() {
  const ref = { current: stage as unknown as HTMLElement };
  useWorkbenchNavigation({ stageRef: ref, onPaneContextMenu: menu });
  return <TabTransitionController />;
}
function event(target: EventTarget, name: string, values: Record<string, unknown>) {
  const input = new Event(name, { cancelable: true });
  for (const [key, value] of Object.entries(values)) Object.defineProperty(input, key, { value });
  target.dispatchEvent(input);
  return input;
}
function pointer(name: string, x: number) {
  event(windowEvents, name, {
    pointerId: 1,
    button: 2,
    clientX: x,
    clientY: 0,
    target: viewport,
  });
}
async function mount(count = 2) {
  let i = 0;
  const ids = () => `nav-${++i}`;
  let state = emptyWorkbenchSnapshot(ids);
  for (let index = 1; index < count; index++) state = applyCreateTab(state, ids);
  useWorkbenchStore.setState(state);
  viewport.dataset.tabId = state.activeTabId;
  await act(() => {
    renderer = create(<Probe />);
  });
}
async function settle() {
  now += 400;
  await act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(now);
  });
}
beforeEach(() => {
  now = 0;
  reduced = false;
  frames = new Map();
  stage = new Surface();
  viewport = new Surface();
  viewport.parentElement = stage;
  viewport.dataset.layoutMode = "bsp";
  windowEvents = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: reduced }) });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("document", { elementFromPoint: () => viewport });
  vi.stubGlobal("Element", Surface);
  vi.stubGlobal("getComputedStyle", () => ({ overflowX: "auto" }));
  vi.spyOn(performance, "now").mockImplementation(() => now);
  let handle = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++handle, callback);
    return handle;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  resetTabTransitionForTest();
  resetWorkbenchStore();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  nativePhase = null;
});
it("pans a single Scrolling Tab without trying to switch", async () => {
  viewport.dataset.layoutMode = "scrolling";
  viewport.scrollWidth = 1200;
  await mount(1);
  await act(() => {
    pointer("pointerdown", 500);
    now = 10;
    pointer("pointermove", 400);
  });
  expect(viewport.scrollLeft).toBe(100);
  expect(getTabTransitionFrame()).toBeNull();
});

it("leaves a text selection right-click to the content menu instead of navigating", async () => {
  Object.assign(windowEvents, {
    getSelection: () => ({ isCollapsed: false, anchorNode: viewport, focusNode: viewport }),
  });
  await mount();
  const activeTab = useWorkbenchStore.getState().activeTabId;
  await act(() => {
    pointer("pointerdown", 700);
    pointer("pointermove", 100);
    pointer("pointerup", 100);
  });
  expect(useWorkbenchStore.getState().activeTabId).toBe(activeTab);
  expect(getTabTransitionFrame()).toBeNull();
  expect(event(stage, "contextmenu", {}).defaultPrevented).toBe(false);
});

it("suppresses the native menu after a right drag, then releases content right-clicks", async () => {
  await mount();
  await act(() => {
    pointer("pointerdown", 700);
    pointer("pointermove", 100);
    pointer("pointerup", 100);
  });
  expect(event(stage, "contextmenu", {}).defaultPrevented).toBe(true);
  await act(() => {
    pointer("pointerdown", 100);
    pointer("pointerup", 100);
  });
  expect(event(stage, "contextmenu", {}).defaultPrevented).toBe(false);
});
it("cancels below-halfway travel when the pointer pauses before release", async () => {
  await mount();
  const active = useWorkbenchStore.getState().activeTabId;
  await act(() => {
    pointer("pointerdown", 500);
    now = 10;
    pointer("pointermove", 400);
  });
  now = 1010;
  await act(() => pointer("pointerup", 400));
  await settle();
  expect(useWorkbenchStore.getState().activeTabId).toBe(active);
  expect(getTabTransitionFrame()).toBeNull();
});
it.each(["pointercancel", "blur", "Escape"])(
  "%s never commits a gesture beyond halfway",
  async (cancel) => {
    await mount();
    const active = useWorkbenchStore.getState().activeTabId;
    await act(() => {
      pointer("pointerdown", 700);
      now = 10;
      pointer("pointermove", 100);
    });
    await act(() => {
      if (cancel === "Escape") event(windowEvents, "keydown", { key: "Escape" });
      else event(windowEvents, cancel, { pointerId: 1 });
    });
    await settle();
    expect(useWorkbenchStore.getState().activeTabId).toBe(active);
  },
);
it("an interrupted gesture settle cannot end a later click transition", async () => {
  await mount(3);
  const tabs = useWorkbenchStore.getState().tabs;
  await act(() => {
    pointer("pointerdown", 700);
    now = 10;
    pointer("pointermove", 100);
    now = 100;
    pointer("pointerup", 100);
  });
  now = 200;
  await act(() => useWorkbenchStore.getState().activateTab(tabs[1]!.id));
  now = 360;
  await act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(now));
  });
  expect(getTabTransitionFrame()?.toTabId).toBe(tabs[1]!.id);
});
it("keeps a Tab settle running when the next trackpad gesture scrolls content", async () => {
  Object.assign(windowEvents, { desktopBridge });
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  const inner = new Surface();
  inner.scrollWidth = 1200;
  inner.parentElement = viewport;
  await mount(2);
  const target = useWorkbenchStore.getState().tabs[0]!.id;
  await act(() => useWorkbenchStore.getState().activateTab(target));
  now = 100;
  await act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(now));
  });
  expect(getTabTransitionFrame()).not.toBeNull();
  vi.stubGlobal("document", { elementFromPoint: () => inner });
  nativePhase!({
    phase: "begin",
    gestureId: 1,
    sequence: 1,
    deltaX: 0,
    deltaY: 0,
    time: now,
    x: 0,
    y: 0,
  });
  const wheel = event(stage, "wheel", {
    target: inner,
    deltaX: 30,
    deltaY: 0,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
  });
  expect(wheel.defaultPrevented).toBe(false);
  await settle();
  expect(getTabTransitionFrame()).toBeNull();
});

it("a new right drag takes over the visible position of a settling Tab", async () => {
  await mount(2);
  await act(() => {
    pointer("pointerdown", 700);
    now = 10;
    pointer("pointermove", 100);
    now = 100;
    pointer("pointerup", 100);
  });
  now = 100;
  await act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(now));
  });
  const before = getTabTransitionFrame()!.position;
  await act(() => pointer("pointerdown", 400));
  expect(getTabTransitionFrame()!.position).toBeCloseTo(before);
  await act(() => pointer("pointermove", 420));
  const after = getTabTransitionFrame()!.position;
  expect(after).toBeLessThan(before);
  expect(after).toBeGreaterThan(0);
});
it("routes Shift+wheel through inner scroller, layout, then cyclic Tab navigation", async () => {
  viewport.dataset.layoutMode = "scrolling";
  viewport.scrollWidth = 1000;
  const inner = new Surface();
  inner.scrollWidth = 900;
  inner.parentElement = viewport;
  await mount(3);
  const tabs = useWorkbenchStore.getState().tabs;
  const wheel = () =>
    event(stage, "wheel", {
      target: inner,
      deltaX: 0,
      deltaY: 100,
      deltaMode: 0,
      shiftKey: true,
      ctrlKey: false,
    });
  await act(() => {
    wheel();
  });
  expect(inner.scrollLeft).toBe(100);
  expect(viewport.scrollLeft).toBe(0);
  expect(useWorkbenchStore.getState().activeTabId).toBe(tabs[2]!.id);
  await act(() => {
    wheel();
    wheel();
  });
  expect(viewport.scrollLeft).toBe(200);
  await act(() => {
    wheel();
  });
  expect(getTabTransitionFrame()).toMatchObject({ toTabId: tabs[0]!.id, dir: 1 });
  await act(() => {
    wheel();
  });
  await settle();
  expect(getTabTransitionFrame()).toMatchObject({ toTabId: tabs[1]!.id, dir: 1 });
});
it("does not turn a macOS-style stream of unmodified deltas into Tab switches", async () => {
  await mount(3);
  const initialActive = useWorkbenchStore.getState().activeTabId;
  for (let index = 0; index < 40; index++) {
    await act(() => {
      event(stage, "wheel", {
        target: stage,
        deltaX: 15,
        deltaY: 0,
        deltaMode: 0,
        shiftKey: false,
        ctrlKey: false,
      });
    });
  }
  expect(useWorkbenchStore.getState().activeTabId).toBe(initialActive);
  expect(getTabTransitionFrame()).toBeNull();
});

let sequence = 0;
function packet(phase: DesktopTrackpadInput["phase"], deltaX = 0, gestureId = 1, deltaY = 0) {
  nativePhase!({ phase, gestureId, sequence: ++sequence, deltaX, deltaY, time: now, x: 0, y: 0 });
}
it.each([
  ["right-drag", 400, true],
  ["trackpad", 400, true],
  ["right-drag", 100, false],
  ["trackpad", 100, false],
] as const)(
  "%s reverses a settling crossing with %i px of reverse travel (paused: %s)",
  async (source, reverseTravel, paused) => {
    Object.assign(windowEvents, { desktopBridge });
    await mount();
    const original = useWorkbenchStore.getState().activeTabId;
    await act(() => {
      if (source === "right-drag") {
        pointer("pointerdown", 700);
        now = 10;
        pointer("pointermove", 100);
        pointer("pointerup", 100);
      } else {
        packet("begin");
        now = 10;
        packet("update", 600);
        packet("end");
      }
    });
    expect(useWorkbenchStore.getState().activeTabId).not.toBe(original);
    expect(getTabTransitionFrame()).not.toBeNull();
    await act(() => {
      now = 20;
      if (source === "right-drag") {
        pointer("pointerdown", 100);
        now = 30;
        pointer("pointermove", 100 + reverseTravel);
        if (paused) now = 130;
        else expect(getTabTransitionFrame()!.progress).toBeGreaterThan(0.5);
        pointer("pointerup", 100 + reverseTravel);
      } else {
        packet("begin", 0, 2);
        now = 30;
        packet("update", -reverseTravel, 2);
        if (paused) now = 130;
        else expect(getTabTransitionFrame()!.progress).toBeGreaterThan(0.5);
        packet("end", 0, 2);
      }
    });
    await settle();
    expect(getTabTransitionFrame()).toBeNull();
    expect(useWorkbenchStore.getState().activeTabId).toBe(original);
  },
);
it("native displacement is consumed once and DOM wheel supplies no second movement", async () => {
  Object.assign(windowEvents, { desktopBridge });
  viewport.dataset.layoutMode = "scrolling";
  viewport.scrollWidth = 1200;
  await mount(1);
  await act(() => {
    packet("begin");
    now = 10;
    packet("update", 100);
  });
  const wheel = event(stage, "wheel", {
    target: viewport,
    deltaX: 100,
    deltaY: 0,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
  });
  expect(wheel.defaultPrevented).toBe(true);
  expect(viewport.scrollLeft).toBe(100);
  await act(() => {
    packet("end");
    now = 20;
    packet("momentum", 1000);
  });
  expect(viewport.scrollLeft).toBe(400);
  expect(getTabTransitionFrame()).toBeNull();
});
it("native vertical gestures and nested horizontal scrollers retain content ownership", async () => {
  Object.assign(windowEvents, { desktopBridge });
  const inner = new Surface();
  inner.parentElement = viewport;
  inner.scrollWidth = 1200;
  await mount();
  vi.stubGlobal("document", { elementFromPoint: () => inner });
  await act(() => {
    packet("begin");
    packet("update", 500);
  });
  expect(getTabTransitionFrame()).toBeNull();
  expect(
    event(stage, "wheel", { target: inner, deltaX: 500, deltaY: 0, shiftKey: false })
      .defaultPrevented,
  ).toBe(false);
  vi.stubGlobal("document", { elementFromPoint: () => viewport });
  await act(() => {
    packet("begin", 0, 2);
    packet("update", 10, 2, 100);
    packet("update", 500, 2);
  });
  expect(getTabTransitionFrame()).toBeNull();
});
it("a full native crossing activates immediately and stale momentum cannot cross another Tab", async () => {
  Object.assign(windowEvents, { desktopBridge });
  await mount(3);
  const before = useWorkbenchStore.getState().activeTabId;
  await act(() => {
    packet("begin");
    now = 10;
    packet("update", 800);
  });
  const arrived = useWorkbenchStore.getState().activeTabId;
  expect(arrived).not.toBe(before);
  await act(() => {
    packet("end");
    packet("momentum", 3000);
  });
  expect(useWorkbenchStore.getState().activeTabId).toBe(arrived);
  expect(getTabTransitionFrame()).toBeNull();
});
it("an outside pointer press cancels a preview and rejects the old native stream", async () => {
  Object.assign(windowEvents, { desktopBridge });
  await mount();
  const before = useWorkbenchStore.getState().activeTabId;
  await act(() => {
    packet("begin");
    now = 10;
    packet("update", 600);
  });
  expect(getTabTransitionFrame()).not.toBeNull();
  await act(() => {
    event(windowEvents, "pointerdown", { button: 0 });
    packet("update", 600);
    packet("end");
    packet("momentum", 600);
  });
  expect(getTabTransitionFrame()).toBeNull();
  expect(useWorkbenchStore.getState().activeTabId).toBe(before);
  await act(() => packet("finish"));
  expect(
    event(stage, "wheel", { target: viewport, deltaX: 20, deltaY: 0, shiftKey: false })
      .defaultPrevented,
  ).toBe(false);
});
it("drains queued wheel switches with reduced motion without a timeout", async () => {
  reduced = true;
  await mount(3);
  const tabs = useWorkbenchStore.getState().tabs;
  await act(() => {
    for (let i = 0; i < 2; i++)
      event(stage, "wheel", {
        deltaX: 100,
        deltaY: 0,
        deltaMode: 0,
        shiftKey: true,
        ctrlKey: false,
      });
  });
  expect(useWorkbenchStore.getState().activeTabId).toBe(tabs[1]!.id);
  expect(getTabTransitionFrame()).toBeNull();
});
it("retargets immediately for every discrete Shift+wheel notch", async () => {
  await mount(3);
  const tabs = useWorkbenchStore.getState().tabs;
  const wheel = () =>
    event(stage, "wheel", {
      deltaX: 100,
      deltaY: 0,
      deltaMode: 0,
      shiftKey: true,
      ctrlKey: false,
    });
  // Ten notches from the last of three Tabs lands at the first Tab.
  await act(() => {
    for (let index = 0; index < 10; index++) wheel();
  });
  expect(useWorkbenchStore.getState().activeTabId).toBe(tabs[0]!.id);
  expect(getTabTransitionFrame()).toMatchObject({ toTabId: tabs[0]!.id, dir: 1 });
  await settle();
  expect(getTabTransitionFrame()).toBeNull();
  expect(useWorkbenchStore.getState().activeTabId).toBe(tabs[0]!.id);
});

it("completed momentum relinquishes DOM wheel ownership", async () => {
  Object.assign(windowEvents, { desktopBridge });
  await mount(1);
  await act(() => {
    packet("begin");
    packet("end");
    packet("momentum", 20);
    packet("finish");
  });
  expect(
    event(stage, "wheel", { target: viewport, deltaX: 20, deltaY: 0, shiftKey: false })
      .defaultPrevented,
  ).toBe(false);
});
