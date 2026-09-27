import type { TabIndicatorGeometry } from "./tabTransition";

/**
 * Narrowest the Viewport bar may get, so an extremely wide Scrolling canvas
 * still reads as a grabbable mark rather than vanishing.
 */
export const MIN_VIEWPORT_BAR_WIDTH = 12;

/**
 * Physical scroll readings of one Scrolling Tab's Workbench Viewport. Published
 * by the Viewport owner and consumed by the Tab indicator.
 */
export interface ViewportMetrics {
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly scrollLeft: number;
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

/**
 * Map a Scrolling Tab's Viewport position onto the Tab indicator underbar.
 *
 * The underbar stops spanning the whole active Tab and instead shows how much
 * of the Scrolling canvas is currently visible and where in it the Viewport
 * sits: its width is the visible share of the canvas, and it travels the
 * active Tab's box from the left edge (canvas start) to the right edge
 * (canvas end) as the Viewport scrolls.
 *
 * `tabGeometry` is the underbar's resting geometry, so the input and output are
 * the same shape: this is one more producer of a Tab indicator geometry.
 *
 * Returns `null` when the canvas does not overflow the Viewport — no scroll
 * position to express — so the caller falls back to the resting Tab geometry.
 * That covers BSP (whose Viewport never scrolls), an empty Tab, and the
 * Trailing Canvas Area of a strip narrower than the Viewport.
 */
export function resolveViewportIndicatorGeometry(
  tabGeometry: TabIndicatorGeometry,
  metrics: ViewportMetrics,
): TabIndicatorGeometry | null {
  const { clientWidth, scrollWidth, scrollLeft } = metrics;
  const maxScrollLeft = scrollWidth - clientWidth;
  if (maxScrollLeft <= 0) return null;

  const width = clamp(
    (tabGeometry.width * clientWidth) / scrollWidth,
    MIN_VIEWPORT_BAR_WIDTH,
    tabGeometry.width,
  );
  const travel = tabGeometry.width - width;
  const progress = clamp(scrollLeft, 0, maxScrollLeft) / maxScrollLeft;

  return { left: tabGeometry.left + travel * progress, width };
}
