import { describe, expect, it } from "vite-plus/test";

import { MIN_VIEWPORT_BAR_WIDTH, resolveViewportIndicatorGeometry } from "./viewportMetrics";

/** A 200px-wide active Tab box sitting 100px into the strip's content. */
const TAB = { left: 100, width: 200 };

describe("resolveViewportIndicatorGeometry", () => {
  it("keeps the full Tab geometry when the canvas does not overflow", () => {
    expect(
      resolveViewportIndicatorGeometry(TAB, {
        clientWidth: 800,
        scrollWidth: 800,
        scrollLeft: 0,
      }),
    ).toBeNull();
  });

  it("keeps the full Tab geometry when the canvas is narrower than the Viewport", () => {
    // The Trailing Canvas Area: Columns end short of the Viewport edge.
    expect(
      resolveViewportIndicatorGeometry(TAB, {
        clientWidth: 600,
        scrollWidth: 400,
        scrollLeft: 0,
      }),
    ).toBeNull();
  });

  it("renders the Viewport's share of the canvas as the bar width", () => {
    // Half the canvas is visible, so the bar is half the Tab wide.
    const geometry = resolveViewportIndicatorGeometry(TAB, {
      clientWidth: 500,
      scrollWidth: 1000,
      scrollLeft: 0,
    });
    expect(geometry).toEqual({ left: 100, width: 100 });
  });

  it("starts the bar at the Tab's left edge when scrolled fully left", () => {
    expect(
      resolveViewportIndicatorGeometry(TAB, {
        clientWidth: 500,
        scrollWidth: 1000,
        scrollLeft: 0,
      }),
    ).toEqual({ left: 100, width: 100 });
  });

  it("ends the bar at the Tab's right edge when scrolled fully right", () => {
    const geometry = resolveViewportIndicatorGeometry(TAB, {
      clientWidth: 500,
      scrollWidth: 1000,
      scrollLeft: 500,
    });
    expect(geometry).toEqual({ left: 200, width: 100 });
    expect(geometry!.left + geometry!.width).toBe(TAB.left + TAB.width);
  });

  it("interpolates linearly between the two edges", () => {
    expect(
      resolveViewportIndicatorGeometry(TAB, {
        clientWidth: 500,
        scrollWidth: 1000,
        scrollLeft: 250,
      }),
    ).toEqual({ left: 150, width: 100 });
  });

  it("clamps the bar to a visible minimum on a very wide canvas", () => {
    // 500/100000 of a 200px Tab rounds to 1px; the floor keeps it grabbable.
    const left = resolveViewportIndicatorGeometry(TAB, {
      clientWidth: 500,
      scrollWidth: 100_000,
      scrollLeft: 0,
    });
    expect(left).toEqual({ left: 100, width: MIN_VIEWPORT_BAR_WIDTH });

    const right = resolveViewportIndicatorGeometry(TAB, {
      clientWidth: 500,
      scrollWidth: 100_000,
      scrollLeft: 99_500,
    });
    expect(right!.width).toBe(MIN_VIEWPORT_BAR_WIDTH);
    expect(right!.left + right!.width).toBe(TAB.left + TAB.width);
  });

  it("never renders the bar wider than the Tab", () => {
    const geometry = resolveViewportIndicatorGeometry(TAB, {
      clientWidth: 999,
      scrollWidth: 1000,
      scrollLeft: 0,
    });
    expect(geometry!.width).toBeLessThanOrEqual(TAB.width);
  });

  it("ignores a degenerate zero-width canvas", () => {
    expect(
      resolveViewportIndicatorGeometry(TAB, {
        clientWidth: 0,
        scrollWidth: 0,
        scrollLeft: 0,
      }),
    ).toBeNull();
  });
});
