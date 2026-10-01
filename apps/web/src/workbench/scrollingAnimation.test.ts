import { describe, expect, it, vi } from "vite-plus/test";
import {
  appleEaseOut,
  computeScrollingRevealTarget,
  animateScrollTo,
  settleEaseOut,
  type ScrollRevealInput,
} from "./scrollingAnimation";

describe("appleEaseOut", () => {
  it("starts at 0 and ends at 1", () => {
    expect(appleEaseOut(0)).toBe(0);
    expect(appleEaseOut(1)).toBe(1);
  });

  it("is strictly monotonic and follows cubic-bezier(0.22, 1, 0.36, 1)", () => {
    let previous = -1;
    for (let t = 0; t <= 1; t += 0.05) {
      const val = appleEaseOut(t);
      expect(val).toBeGreaterThanOrEqual(previous);
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1);
      previous = val;
    }
    // High initial acceleration: at t=0.5 it should cover over 80% of the distance
    expect(appleEaseOut(0.5)).toBeGreaterThan(0.8);
  });
});

describe("settleEaseOut", () => {
  it("starts at 0 and ends at 1", () => {
    expect(settleEaseOut(0)).toBe(0);
    expect(settleEaseOut(1)).toBe(1);
  });

  it("starts from rest, unlike the front-loaded Apple curve", () => {
    // cubic-bezier(0.4, 0, 0.2, 1) barely moves at the very start, so a paused
    // release does not snap forward the way the Apple curve does.
    expect(settleEaseOut(0.1)).toBeLessThan(0.1);
    expect(settleEaseOut(0.1)).toBeLessThan(appleEaseOut(0.1));
    expect(settleEaseOut(0.5)).toBeLessThan(appleEaseOut(0.5));
  });
});

describe("computeScrollingRevealTarget", () => {
  it("centers a single column when its width is smaller than the viewport", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: true,
      rect: { left: 16, top: 16, width: 600, height: 800 },
      paneGap: 16,
      canvasWidth: 632,
      viewportWidth: 1000,
      currentScrollLeft: 0,
    };
    const result = computeScrollingRevealTarget(input);
    // Canvas is smaller than viewport, maxScrollLeft is 0, so targetLeft clamped to 0
    expect(result.targetLeft).toBe(0);

    // If canvas has room to scroll and rect is smaller than viewport:
    const wideCanvasInput: ScrollRevealInput = {
      ...input,
      rect: { left: 300, top: 16, width: 400, height: 800 },
      canvasWidth: 1400,
      viewportWidth: 600,
    };
    // Center of rect = 300 + 200 = 500. Viewport width 600 => desired = 500 - 300 = 200
    const wideResult = computeScrollingRevealTarget(wideCanvasInput);
    expect(wideResult.targetLeft).toBe(200);
  });

  it("does not scroll if the pane and its gaps are already fully visible in multi-column mode", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 100, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 50,
    };
    // Safe bounds are [100 - 16, 100 + 560 + 16] = [84, 676]
    // Current viewport window is [50, 1050] -> 84 >= 50 and 676 <= 1050 -> already visible!
    const result = computeScrollingRevealTarget(input);
    expect(result.needsScroll).toBe(false);
    expect(result.targetLeft).toBe(50);
  });

  it("scrolls with exact gap padding when a pane is partially clipped on the right", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 600, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 0,
    };
    // Safe right is 600 + 560 + 16 = 1176. Viewport right is 0 + 1000 = 1000.
    // Must scroll right so right edge + gap aligns with viewport right edge:
    // targetLeft = 1176 - 1000 = 176
    const result = computeScrollingRevealTarget(input);
    expect(result.needsScroll).toBe(true);
    expect(result.targetLeft).toBe(176);
  });

  it("scrolls with exact gap padding when a pane is partially clipped on the left", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 300, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 400,
    };
    // Safe left is 300 - 16 = 284. Current scrollLeft is 400.
    // Must scroll left so left edge - gap aligns with viewport left edge:
    // targetLeft = 284
    const result = computeScrollingRevealTarget(input);
    expect(result.needsScroll).toBe(true);
    expect(result.targetLeft).toBe(284);
  });

  it("enters at the left edge when arriving from a Tab on the left", () => {
    // The focused Pane sits mid-canvas, so reveal alone would scroll inward.
    // Arriving from the left enters at the edge the user was travelling away
    // from, so the strip reads as continuing rather than jumping.
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 900, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 0,
      entryDir: 1,
    };
    const result = computeScrollingRevealTarget(input);
    expect(result.targetLeft).toBe(0);
  });

  it("enters at the right edge when arriving from a Tab on the right", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 100, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 0,
      entryDir: -1,
    };
    const result = computeScrollingRevealTarget(input);
    // The horizontal limit is the canvas minus the viewport.
    expect(result.targetLeft).toBe(1000);
  });

  it("enters at the edge even when the focused Pane is already visible", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 100, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 0,
      entryDir: -1,
    };
    // Reveal alone would report no scroll needed; entering still moves.
    expect(computeScrollingRevealTarget(input).needsScroll).toBe(true);
  });

  it("enters at the edge in a single-Column Tab too", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: true,
      rect: { left: 100, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 700,
      entryDir: -1,
    };
    const result = computeScrollingRevealTarget(input);
    // Centering the single Column would land at 0 - 500 + 100 = -400 -> 0,
    // so the entry edge must win over the single-Column centering rule.
    expect(result.targetLeft).toBe(1000);
  });

  it("keeps the reveal behaviour when no entry direction is given", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 600, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 0,
    };
    expect(computeScrollingRevealTarget(input).targetLeft).toBe(176);
  });

  it("reports no scroll for an entry edge the Viewport is already at", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 900, top: 16, width: 560, height: 800 },
      paneGap: 16,
      canvasWidth: 2000,
      viewportWidth: 1000,
      currentScrollLeft: 0,
      entryDir: 1,
    };
    expect(computeScrollingRevealTarget(input).needsScroll).toBe(false);
  });

  it("keeps targetTop at 0 because Workbench Viewport never scrolls vertically (ADR 0015)", () => {
    const input: ScrollRevealInput = {
      isSingleColumn: false,
      rect: { left: 16, top: 500, width: 560, height: 400 },
      paneGap: 16,
      canvasWidth: 1000,
      viewportWidth: 1000,
      currentScrollLeft: 0,
    };
    const result = computeScrollingRevealTarget(input);
    expect(result.targetTop).toBe(0);
  });
});

describe("animateScrollTo", () => {
  it("immediately finishes if target is already reached", () => {
    const el = {
      scrollLeft: 100,
      scrollTop: 50,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;
    const onComplete = vi.fn();
    animateScrollTo(el, 100, 50, { onComplete });
    expect(onComplete).toHaveBeenCalled();
  });

  it("animates scroll position across animation frames to the target", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const el = {
      scrollLeft: 0,
      scrollTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;

    const onComplete = vi.fn();
    animateScrollTo(el, 300, 0, { duration: 200, onComplete });

    expect(callbacks.length).toBe(1);
    // Frame 0: records startTime = 1000
    callbacks[0]!(1000);

    // Frame 1: 100ms in (halfway)
    expect(callbacks.length).toBe(2);
    callbacks[1]!(1100);
    expect(el.scrollLeft).toBeGreaterThan(150); // Apple curve has high initial progress
    expect(el.scrollLeft).toBeLessThan(300);

    // Frame 2: 200ms in (complete)
    expect(callbacks.length).toBe(3);
    callbacks[2]!(1200);

    expect(el.scrollLeft).toBe(300);
    expect(onComplete).toHaveBeenCalled();
  });

  it("cancels when cancel is called", () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      callbacks.push(cb);
      return callbacks.length;
    });
    const cancelRaf = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelRaf);

    const el = {
      scrollLeft: 0,
      scrollTop: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement;

    const onCancel = vi.fn();
    const cancel = animateScrollTo(el, 300, 0, { duration: 200, onCancel });
    cancel();

    expect(cancelRaf).toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalled();
  });
});

it("keeps remaining continuous-route pan beyond the incoming Tab edge", () => {
  const target = computeScrollingRevealTarget({
    isSingleColumn: false,
    rect: { left: 0, top: 0, width: 200, height: 500 },
    paneGap: 8,
    canvasWidth: 1400,
    viewportWidth: 800,
    currentScrollLeft: 150,
    entryDir: 1,
    entryOffset: 150,
  });
  expect(target).toEqual({ targetLeft: 150, targetTop: 0, needsScroll: false });
});
