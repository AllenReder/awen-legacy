import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { SidebarProvider } from "../components/ui/sidebar";
import { WorkbenchWindowChrome } from "./WorkbenchWindowChrome";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useTabIndicator } from "./useTabIndicator";
import {
  beginTabTransition,
  setTabTransitionProgress,
  endTabTransition,
  resetTabTransitionForTest,
} from "./tabTransition";
import { applyCreateTab, emptyWorkbenchSnapshot } from "./workbenchState";
import { resetWorkbenchStore } from "./workbenchStore";
import { publishViewportMetrics, resetViewportMetricsForTest } from "./viewportTracking";

beforeEach(() => {
  resetWorkbenchStore();
  resetTabTransitionForTest();
  resetViewportMetricsForTest();
  // The hook reads `matchMedia`; every case here runs motion that asks for it.
});

it("renders a shared theme underbar and drops bold from the active Tab", () => {
  let n = 0;
  const ids = () => `id-${++n}`;
  const snapshot = applyCreateTab(emptyWorkbenchSnapshot(ids), ids);

  const html = renderToStaticMarkup(
    <SidebarProvider defaultOpen>
      <WorkbenchWindowChrome snapshot={snapshot} projects={[]} />
    </SidebarProvider>,
  );

  expect(html).toContain("data-tab-indicator");
  expect(html).toContain("workbench-tab-indicator");
  expect(html).not.toContain("font-medium");
  expect(html).toContain('data-active-tab="true"');
});

// Exercise the actual hook across a gesture's final frame and completion.

let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  resetTabTransitionForTest();
  vi.unstubAllGlobals();
});

it("lands the underbar without replaying the animation when a gesture finishes", async () => {
  const animate = vi.fn(() => ({ cancel: vi.fn() }));
  const indicator = { style: { transform: "", width: "" }, animate };
  const tabs = [0, 1].map((index) => ({
    dataset: { tabId: String(index) },
    getBoundingClientRect: () => ({ left: index * 100, width: index === 0 ? 100 : 80 }),
  }));
  const strip = {
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0 }),
    querySelectorAll: () => tabs,
    querySelector: (selector: string) => tabs[selector.includes('"1"') ? 1 : 0],
  };
  const ref = { current: strip as unknown as HTMLElement };
  function Indicator({ active }: { active: string }) {
    const indicatorRef = useTabIndicator({
      stripRef: ref,
      activeTabId: active,
      revision: "0,1",
      dragging: false,
    });
    return <span ref={indicatorRef} />;
  }
  await act(() => {
    renderer = create(<Indicator active="0" />, { createNodeMock: () => indicator });
  });
  await act(() =>
    beginTabTransition({ fromTabId: "0", toTabId: "1", fromIndex: 0, toIndex: 1, dir: 1 }),
  );
  await act(() => setTabTransitionProgress(0.5));
  expect(indicator.style.transform).toBe("translateX(50px)");
  // Width interpolates between the two endpoints' own widths (100 -> 80), so a
  // switch onto a narrower resting bar grows or shrinks into it.
  expect(indicator.style.width).toBe("90px");
  await act(() => renderer!.update(<Indicator active="1" />));
  await act(() => {
    setTabTransitionProgress(1);
    endTabTransition();
  });
  expect(indicator.style.transform).toBe("translateX(100px)");
  expect(indicator.style.width).toBe("80px");
  expect(animate).not.toHaveBeenCalled();
});

/** A strip holding one 200px Tab at offset 40, for Viewport-driven geometry. */
function viewportStrip() {
  const element = {
    dataset: { tabId: "a" },
    getBoundingClientRect: () => ({ left: 140, width: 200 }),
  };
  return {
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 100 }),
    querySelectorAll: () => [element],
    querySelector: () => element,
  };
}

/** Drive the real indicator hook against one fixed 200px Tab. */
function viewportIndicator(strip: unknown, activeTabId = "a") {
  const ref = { current: strip as HTMLElement };
  function Indicator({ active = activeTabId }: { active?: string }) {
    const indicatorRef = useTabIndicator({
      stripRef: ref,
      activeTabId: active,
      revision: "a,b,s",
      dragging: false,
    });
    return <span ref={indicatorRef} />;
  }
  return { Indicator, ref };
}

it("spans the whole active Tab when the Scrolling canvas does not overflow", async () => {
  const indicator = { style: { transform: "", width: "" } };
  publishViewportMetrics("a", { clientWidth: 800, scrollWidth: 800, scrollLeft: 0 });
  const { Indicator } = viewportIndicator(viewportStrip());
  await act(() => {
    renderer = create(<Indicator />, { createNodeMock: () => indicator });
  });
  expect(indicator.style.transform).toBe("translateX(40px)");
  expect(indicator.style.width).toBe("200px");
});

it("narrows the active Tab's underbar to the Viewport's share of the canvas", async () => {
  const indicator = { style: { transform: "", width: "" } };
  publishViewportMetrics("a", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  const { Indicator } = viewportIndicator(viewportStrip());
  await act(() => {
    renderer = create(<Indicator />, { createNodeMock: () => indicator });
  });
  // Half the canvas is visible, so the bar is half the 200px Tab, at its left edge.
  expect(indicator.style.transform).toBe("translateX(40px)");
  expect(indicator.style.width).toBe("100px");
});

it("travels the underbar across the active Tab as the Viewport scrolls", async () => {
  const indicator = { style: { transform: "", width: "" } };
  publishViewportMetrics("a", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  const { Indicator } = viewportIndicator(viewportStrip());
  await act(() => {
    renderer = create(<Indicator />, { createNodeMock: () => indicator });
  });
  await act(() =>
    publishViewportMetrics("a", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 500 }),
  );
  // Fully scrolled right: the 100px bar ends flush with the Tab's right edge.
  expect(indicator.style.transform).toBe("translateX(140px)");
  expect(indicator.style.width).toBe("100px");
});

it("ignores metrics published by a different Tab", async () => {
  const indicator = { style: { transform: "", width: "" } };
  publishViewportMetrics("other", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  const { Indicator } = viewportIndicator(viewportStrip());
  await act(() => {
    renderer = create(<Indicator />, { createNodeMock: () => indicator });
  });
  expect(indicator.style.transform).toBe("translateX(40px)");
  expect(indicator.style.width).toBe("200px");
});

/**
 * A strip of two 200px Tabs: "s" at offset 0 is Scrolling and scrolled to its
 * right end, "b" at offset 200 is BSP. So "s" rests as a 100px bar at x=100 and
 * "b" rests as its full 200px box.
 */
function mixedLayoutStrip() {
  const elements = [
    { dataset: { tabId: "s" }, getBoundingClientRect: () => ({ left: 0, width: 200 }) },
    { dataset: { tabId: "b" }, getBoundingClientRect: () => ({ left: 200, width: 200 }) },
  ];
  return {
    scrollLeft: 0,
    getBoundingClientRect: () => ({ left: 0 }),
    querySelectorAll: () => elements,
    querySelector: (selector: string) => elements[selector.includes('"s"') ? 0 : 1],
  };
}

function publishScrolledToEnd() {
  publishViewportMetrics("s", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 500 });
}

it("grows the bar out of the Scrolling Tab's resting position when switching to BSP", async () => {
  const indicator = { style: { transform: "", width: "" } };
  publishScrolledToEnd();
  const { Indicator } = viewportIndicator(mixedLayoutStrip(), "s");
  await act(() => {
    renderer = create(<Indicator active="s" />, { createNodeMock: () => indicator });
  });
  // At rest on the Scrolling Tab: the short bar sits at its right edge.
  expect(indicator.style.transform).toBe("translateX(100px)");
  expect(indicator.style.width).toBe("100px");

  await act(() =>
    beginTabTransition({ fromTabId: "s", toTabId: "b", fromIndex: 0, toIndex: 1, dir: 1 }),
  );
  // The switch must start where the bar actually is, not snap to the Tab's
  // left edge (the bug this covers).
  expect(indicator.style.transform).toBe("translateX(100px)");
  expect(indicator.style.width).toBe("100px");

  await act(() => setTabTransitionProgress(0.5));
  // Halfway: partway right and grown to 150px.
  expect(indicator.style.transform).toBe("translateX(150px)");
  expect(indicator.style.width).toBe("150px");

  await act(() => renderer!.update(<Indicator active="b" />));
  await act(() => {
    setTabTransitionProgress(1);
    endTabTransition();
  });
  // Lands exactly on the BSP Tab's full box, with no width snap.
  expect(indicator.style.transform).toBe("translateX(200px)");
  expect(indicator.style.width).toBe("200px");
});

it("shrinks the bar into the Scrolling Tab's resting position when switching from BSP", async () => {
  const indicator = { style: { transform: "", width: "" } };
  publishScrolledToEnd();
  const { Indicator } = viewportIndicator(mixedLayoutStrip(), "b");
  await act(() => {
    renderer = create(<Indicator active="b" />, { createNodeMock: () => indicator });
  });
  // At rest on the BSP Tab: the full box.
  expect(indicator.style.transform).toBe("translateX(200px)");
  expect(indicator.style.width).toBe("200px");

  await act(() =>
    beginTabTransition({ fromTabId: "b", toTabId: "s", fromIndex: 1, toIndex: 0, dir: -1 }),
  );
  await act(() => setTabTransitionProgress(0.5));
  // Halfway left: already shrinking toward the 100px resting bar.
  expect(indicator.style.transform).toBe("translateX(150px)");
  expect(indicator.style.width).toBe("150px");

  await act(() => renderer!.update(<Indicator active="s" />));
  await act(() => {
    setTabTransitionProgress(1);
    endTabTransition();
  });
  // Ends as the short bar at the Scrolling Tab's right edge, not its left.
  expect(indicator.style.transform).toBe("translateX(100px)");
  expect(indicator.style.width).toBe("100px");
});

it("re-places the bar when the incoming Tab's Viewport scrolls mid-switch", async () => {
  const indicator = { style: { transform: "", width: "" } };
  // The Scrolling Tab's Viewport starts at the left of its canvas, so its
  // resting bar is the short one at its left edge.
  publishViewportMetrics("s", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 0 });
  const { Indicator } = viewportIndicator(mixedLayoutStrip(), "b");
  await act(() => {
    renderer = create(<Indicator active="b" />, { createNodeMock: () => indicator });
  });

  await act(() =>
    beginTabTransition({ fromTabId: "b", toTabId: "s", fromIndex: 1, toIndex: 0, dir: -1 }),
  );
  await act(() => setTabTransitionProgress(0.5));
  // Halfway between the Scrolling Tab's bar at x=0 and the BSP Tab's at x=200.
  expect(indicator.style.transform).toBe("translateX(100px)");
  expect(indicator.style.width).toBe("150px");

  // Committing the switch reveals the incoming Tab's focused Pane, scrolling
  // its Viewport. That publish arrives on its own, with no transition frame
  // behind it, so a bar subscribed only to frames keeps the stale endpoint and
  // then jumps when the switch settles.
  await act(() =>
    publishViewportMetrics("s", { clientWidth: 500, scrollWidth: 1000, scrollLeft: 500 }),
  );
  // The Scrolling Tab's bar now rests at x=100, so halfway is x=150.
  expect(indicator.style.transform).toBe("translateX(150px)");
  expect(indicator.style.width).toBe("150px");

  await act(() => renderer!.update(<Indicator active="s" />));
  await act(() => {
    setTabTransitionProgress(1);
    endTabTransition();
  });
  // Settles on the moved reading, with no second jump.
  expect(indicator.style.transform).toBe("translateX(100px)");
  expect(indicator.style.width).toBe("100px");
});

it.each([1, -1] as const)(
  "projects a cyclic crossing across the strip boundary (direction %s)",
  async (dir) => {
    const wrap = { style: { display: "", transform: "", width: "" } };
    const indicator = { style: { transform: "", width: "" }, firstElementChild: wrap };
    const tabs = [0, 1, 2].map((index) => ({
      dataset: { tabId: String(index) },
      getBoundingClientRect: () => ({ left: index * 100, width: 100 }),
    }));
    const strip = {
      scrollWidth: 500,
      scrollLeft: 0,
      getBoundingClientRect: () => ({ left: 0 }),
      querySelectorAll: () => tabs,
      querySelector: (selector: string) =>
        tabs.find((tab) => selector.includes(`"${tab.dataset.tabId}"`)),
    };
    const ref = { current: strip as unknown as HTMLElement };
    function Indicator() {
      const indicatorRef = useTabIndicator({
        stripRef: ref,
        activeTabId: dir === 1 ? "2" : "0",
        revision: "0,1,2",
        dragging: false,
      });
      return <span ref={indicatorRef} />;
    }
    await act(() => {
      renderer = create(<Indicator />, { createNodeMock: () => indicator });
    });
    await act(() =>
      beginTabTransition({
        fromTabId: dir === 1 ? "2" : "0",
        toTabId: dir === 1 ? "0" : "2",
        fromIndex: dir === 1 ? 2 : 0,
        toIndex: dir === 1 ? 0 : 2,
        dir,
      }),
    );
    await act(() => setTabTransitionProgress(0.5));
    expect(indicator.style.transform).toBe("translateX(250px)");
    expect(indicator.style.width).toBe("50px");
    expect(wrap.style.display).toBe("block");
    expect(wrap.style.width).toBe("50px");
  },
);
