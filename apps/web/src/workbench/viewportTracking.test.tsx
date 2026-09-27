import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  getViewportMetrics,
  publishViewportMetrics,
  resetViewportMetricsForTest,
  subscribeViewportMetrics,
  usePublishViewportMetrics,
} from "./viewportTracking";

/** Observed ResizeObserver stubs, so a test can drive a canvas resize. */
const observers: Array<{ callback: () => void }> = [];

function makeResizeObserverStub() {
  return class {
    callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
      observers.push({ callback });
    }
    observe() {}
    disconnect() {}
  };
}

/** A fake Scrolling Viewport whose readings the test drives directly. */
function fakeViewport(input: { clientWidth: number; scrollWidth: number; scrollLeft: number }) {
  const scrollListeners = new Set<() => void>();
  const element = {
    clientWidth: input.clientWidth,
    scrollWidth: input.scrollWidth,
    scrollLeft: input.scrollLeft,
    firstElementChild: null,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
    addEventListener: (type: string, listener: () => void) => {
      if (type === "scroll") scrollListeners.add(listener);
    },
    removeEventListener: (type: string, listener: () => void) => {
      if (type === "scroll") scrollListeners.delete(listener);
    },
  };
  return {
    element: element as unknown as HTMLElement,
    scrollTo(scrollLeft: number) {
      element.scrollLeft = scrollLeft;
      for (const listener of scrollListeners) listener();
    },
    resize(next: { clientWidth: number; scrollWidth: number }) {
      element.clientWidth = next.clientWidth;
      element.scrollWidth = next.scrollWidth;
      for (const observer of observers) observer.callback();
    },
  };
}

let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  observers.length = 0;
  vi.stubGlobal("ResizeObserver", makeResizeObserverStub());
  resetViewportMetricsForTest();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

/** Mount one Tab's publisher and return its Viewport's readings when asked. */
async function mount(viewport: ReturnType<typeof fakeViewport>, tabId: string, enabled: boolean) {
  await act(() => {
    renderer = create(<Host viewport={viewport.element} tabId={tabId} enabled={enabled} />, {
      createNodeMock: () => null,
    });
  });
}

function Host(props: { viewport: HTMLElement; tabId: string; enabled: boolean }) {
  usePublishViewportMetrics({
    ref: { current: props.viewport },
    tabId: props.tabId,
    enabled: props.enabled,
  });
  return null;
}

it("publishes a mounted Scrolling Viewport under its Tab", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  await mount(viewport, "a", true);
  expect(getViewportMetrics("a")).toEqual({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
});

it("publishes every mounted Scrolling Tab, not just one", async () => {
  const a = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  const b = fakeViewport({ clientWidth: 400, scrollWidth: 900, scrollLeft: 300 });
  await act(() => {
    renderer = create(
      <>
        <Host viewport={a.element} tabId="a" enabled />
        <Host viewport={b.element} tabId="b" enabled />
      </>,
      { createNodeMock: () => null },
    );
  });
  expect(getViewportMetrics("a")?.scrollLeft).toBe(0);
  expect(getViewportMetrics("b")?.scrollLeft).toBe(300);
});

it("updates the published scroll offset as the Viewport scrolls", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  await mount(viewport, "a", true);
  const seen: number[] = [];
  const unsubscribe = subscribeViewportMetrics(() => {
    seen.push(getViewportMetrics("a")?.scrollLeft ?? -1);
  });
  await act(() => viewport.scrollTo(250));
  expect(getViewportMetrics("a")?.scrollLeft).toBe(250);
  expect(seen).toEqual([250]);
  unsubscribe();
});

it("does not notify when a scroll event reports the same offset", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 120 });
  await mount(viewport, "a", true);
  let notifications = 0;
  const unsubscribe = subscribeViewportMetrics(() => {
    notifications += 1;
  });
  await act(() => viewport.scrollTo(120));
  expect(notifications).toBe(0);
  unsubscribe();
});

it("publishes nothing for a Tab whose layout cannot scroll", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 90 });
  await mount(viewport, "a", false);
  expect(getViewportMetrics("a")).toBeNull();
});

it("keeps the last real reading while a Tab is not laid out", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 240 });
  await mount(viewport, "a", true);
  // A hidden Tab is display-none, so a resize reports a zero-width box.
  viewport.resize({ clientWidth: 0, scrollWidth: 0 });
  expect(getViewportMetrics("a")?.scrollLeft).toBe(240);
});

it("withdraws a Tab's reading when it unmounts", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  await mount(viewport, "a", true);
  expect(getViewportMetrics("a")).not.toBeNull();
  await act(() => renderer!.update(<Host viewport={viewport.element} tabId="a" enabled={false} />));
  expect(getViewportMetrics("a")).toBeNull();
});

it("stops listening once the Tab no longer publishes", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  await mount(viewport, "a", true);
  await act(() => renderer!.update(<Host viewport={viewport.element} tabId="a" enabled={false} />));
  await act(() => viewport.scrollTo(400));
  expect(getViewportMetrics("a")).toBeNull();
});

it("re-reads the Viewport's box when the canvas resizes", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  await mount(viewport, "a", true);
  // A Column resize widens the canvas without scrolling.
  viewport.resize({ clientWidth: 500, scrollWidth: 1400 });
  expect(getViewportMetrics("a")?.scrollWidth).toBe(1400);
});

it("forgets a Tab's reading when it unmounts entirely", async () => {
  const viewport = fakeViewport({ clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  await mount(viewport, "a", true);
  await act(() => renderer!.unmount());
  renderer = undefined;
  expect(getViewportMetrics("a")).toBeNull();
});

it("replaces a Tab's reading rather than appending a second one", async () => {
  publishViewportMetrics("a", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  publishViewportMetrics("a", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 750 });
  expect(getViewportMetrics("a")?.scrollLeft).toBe(750);
});
