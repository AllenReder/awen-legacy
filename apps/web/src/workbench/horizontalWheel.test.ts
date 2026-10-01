import { describe, expect, it } from "vite-plus/test";

import {
  findHorizontalScroller,
  hasHorizontalScrollRoom,
  normalizeWheelDelta,
  resolveHorizontalIntent,
  resolveHorizontalWheelDelta,
  resolveWheelSwitchDirection,
} from "./horizontalWheel";

describe("resolveHorizontalIntent", () => {
  it("prefers deltaX", () => {
    expect(resolveHorizontalIntent({ deltaX: 40, deltaY: 0, shiftKey: false })).toBe(40);
    expect(resolveHorizontalIntent({ deltaX: 40, deltaY: 10, shiftKey: true })).toBe(40);
  });

  it("maps shift+vertical wheel to horizontal intent", () => {
    expect(resolveHorizontalIntent({ deltaX: 0, deltaY: 120, shiftKey: true })).toBe(120);
    expect(resolveHorizontalIntent({ deltaX: 0, deltaY: 120, shiftKey: false })).toBe(0);
  });
});

describe("normalizeWheelDelta", () => {
  it("scales line and page delta modes", () => {
    expect(normalizeWheelDelta(3, 0, 800)).toBe(3);
    expect(normalizeWheelDelta(3, 1, 800)).toBe(48);
    expect(normalizeWheelDelta(2, 2, 800)).toBe(1600);
  });
});

describe("resolveHorizontalWheelDelta", () => {
  it("returns the horizontal delta for a horizontal wheel", () => {
    expect(
      resolveHorizontalWheelDelta(
        { deltaX: 40, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: false },
        800,
      ),
    ).toBe(40);
  });

  it("ignores a mostly-vertical wheel without shift", () => {
    expect(
      resolveHorizontalWheelDelta(
        { deltaX: 4, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false },
        800,
      ),
    ).toBe(0);
  });

  it("maps shift+vertical wheel to horizontal intent", () => {
    expect(
      resolveHorizontalWheelDelta(
        { deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true, ctrlKey: false },
        800,
      ),
    ).toBe(100);
  });

  it("ignores zoom and normalizes line and page delta modes", () => {
    expect(
      resolveHorizontalWheelDelta(
        { deltaX: 40, deltaY: 0, deltaMode: 0, shiftKey: false, ctrlKey: true },
        800,
      ),
    ).toBe(0);
    expect(
      resolveHorizontalWheelDelta(
        { deltaX: 3, deltaY: 0, deltaMode: 1, shiftKey: false, ctrlKey: false },
        800,
      ),
    ).toBe(48);
    expect(
      resolveHorizontalWheelDelta(
        { deltaX: 2, deltaY: 0, deltaMode: 2, shiftKey: false, ctrlKey: false },
        800,
      ),
    ).toBe(1600);
  });
});

describe("resolveWheelSwitchDirection", () => {
  it("advances on positive deltas and reverses on negative", () => {
    expect(resolveWheelSwitchDirection(10)).toBe(1);
    expect(resolveWheelSwitchDirection(-10)).toBe(-1);
  });
});

describe("hasHorizontalScrollRoom", () => {
  it("reports room only in the requested direction", () => {
    const middle = { scrollLeft: 50, clientWidth: 100, scrollWidth: 300 };
    expect(hasHorizontalScrollRoom(middle, 1)).toBe(true);
    expect(hasHorizontalScrollRoom(middle, -1)).toBe(true);
    expect(hasHorizontalScrollRoom({ ...middle, scrollLeft: 0 }, -1)).toBe(false);
    expect(hasHorizontalScrollRoom({ ...middle, scrollLeft: 200 }, 1)).toBe(false);
  });

  it("never has room without overflow", () => {
    expect(hasHorizontalScrollRoom({ scrollLeft: 0, clientWidth: 100, scrollWidth: 100 }, 1)).toBe(
      false,
    );
  });
});

describe("findHorizontalScroller", () => {
  const scroller = (parent: unknown, metrics: { left: number; max: number }) =>
    ({
      scrollLeft: metrics.left,
      clientWidth: 100,
      scrollWidth: 100 + metrics.max,
      parentElement: parent,
    }) as unknown as Element;

  it("finds a nested scroller with room", () => {
    const root = {} as Element;
    const inner = scroller(root, { left: 0, max: 200 });
    expect(findHorizontalScroller(inner, root, 5)).toBe(inner);
  });

  it("ignores a nested scroller that is already at the requested edge", () => {
    const root = {} as Element;
    const inner = scroller(root, { left: 200, max: 200 });
    expect(findHorizontalScroller(inner, root, 5)).toBeNull();
  });

  it("stops at the root", () => {
    const root = scroller(null, { left: 0, max: 200 });
    expect(findHorizontalScroller(root, root, 5)).toBeNull();
  });
});
