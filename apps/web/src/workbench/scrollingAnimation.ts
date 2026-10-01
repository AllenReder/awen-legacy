import { scaledMotionDuration } from "./workbenchMotion";

export interface ScrollRevealInput {
  readonly isSingleColumn: boolean;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly paneGap: number;
  readonly canvasWidth: number;
  readonly viewportWidth: number;
  readonly currentScrollLeft: number;
  /**
   * Set on the commit that makes this Tab active, to the direction the incoming
   * Tab sits in: `+1` arriving from a Tab on the left, `-1` from one on the
   * right. The Viewport then enters at the edge the user was travelling away
   * from, so the strip reads as continuing rather than jumping inward to the
   * focused Pane. Absent everywhere else, leaving ordinary reveal in charge.
   */
  readonly entryDir?: -1 | 1;
  /** Continuous navigation may already have panned beyond the entry edge. */
  readonly entryOffset?: number;
}

export interface ScrollRevealTarget {
  readonly targetLeft: number;
  readonly targetTop: number;
  readonly needsScroll: boolean;
}

/**
 * Cubic-bezier easing evaluated by solving x(u) = t with Newton-Raphson.
 * Control points mirror a CSS `cubic-bezier(x1, y1, x2, y2)`.
 */
export function cubicBezierEase(t: number, x1: number, y1: number, x2: number, y2: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;

  // Solve x(u) = t using Newton-Raphson
  let u = t;
  for (let i = 0; i < 6; i++) {
    const oneMinusU = 1 - u;
    const currentX = 3 * oneMinusU * oneMinusU * u * x1 + 3 * oneMinusU * u * u * x2 + u * u * u;
    const diff = currentX - t;
    if (Math.abs(diff) < 1e-5) break;

    const slope =
      3 * oneMinusU * oneMinusU * x1 + 6 * oneMinusU * u * (x2 - x1) + 3 * u * u * (1 - x2);
    if (Math.abs(slope) < 1e-5) break;
    u -= diff / slope;
    u = Math.max(0, Math.min(1, u));
  }

  const oneMinusU = 1 - u;
  return 3 * oneMinusU * oneMinusU * u * y1 + 3 * oneMinusU * u * u * y2 + u * u * u;
}

/**
 * Apple-style fluid ease-out: cubic-bezier(0.22, 1, 0.36, 1).
 * High initial velocity for immediate responsiveness, settling into a silky soft stop.
 */
export function appleEaseOut(t: number): number {
  return cubicBezierEase(t, 0.22, 1, 0.36, 1);
}

/**
 * Standard settle ease: cubic-bezier(0.4, 0, 0.2, 1). Unlike {@link appleEaseOut}
 * it starts from rest, so continuing a paused interactive gesture on release does
 * not snap forward.
 */
export function settleEaseOut(t: number): number {
  return cubicBezierEase(t, 0.4, 0, 0.2, 1);
}

/**
 * Reveal an interval [itemStart, itemStart + itemSize] with outer gap padding along one axis.
 */
function computeEdgeRevealTarget(
  itemStart: number,
  itemSize: number,
  gap: number,
  currentScroll: number,
  viewportSize: number,
  maxScroll: number,
): number {
  const safeStart = itemStart - gap;
  const safeEnd = itemStart + itemSize + gap;
  const isBiggerThanViewport = itemSize + 2 * gap >= viewportSize;

  if (isBiggerThanViewport) {
    return Math.max(0, Math.min(maxScroll, Math.round(safeStart)));
  }
  if (safeStart >= currentScroll && safeEnd <= currentScroll + viewportSize) {
    return currentScroll;
  }
  if (safeStart < currentScroll) {
    return Math.max(0, Math.min(maxScroll, Math.round(safeStart)));
  }
  if (safeEnd > currentScroll + viewportSize) {
    return Math.max(0, Math.min(maxScroll, Math.round(safeEnd - viewportSize)));
  }
  return currentScroll;
}

/**
 * Compute the ideal scroll position to reveal the focused pane:
 * - Entering an incoming Tab: the edge the user was travelling away from.
 * - Single column: horizontally centered within the viewport when smaller than viewport.
 * - Multiple columns: edge reveal with exact paneGap padding on left/right.
 * - Vertical axis: reveals stacked panes when canvas overflows vertically.
 */
export function computeScrollingRevealTarget(input: ScrollRevealInput): ScrollRevealTarget {
  const { isSingleColumn, rect, paneGap, canvasWidth, viewportWidth, entryDir } = input;
  const { currentScrollLeft } = input;

  const maxScrollLeft = Math.max(0, canvasWidth - viewportWidth);

  // Entering a Tab takes priority over revealing its focused Pane: the Viewport
  // starts at the edge matching the travel direction, so a Tab entered from the
  // left shows its leftmost Columns first.
  const targetTop = 0;
  if (entryDir !== undefined) {
    const entryLeft = Math.max(
      0,
      Math.min(maxScrollLeft, input.entryOffset ?? (entryDir === 1 ? 0 : maxScrollLeft)),
    );
    return {
      targetLeft: entryLeft,
      targetTop,
      needsScroll: Math.abs(entryLeft - currentScrollLeft) >= 1,
    };
  }

  let targetLeft = currentScrollLeft;

  // Horizontal reveal
  if (isSingleColumn) {
    if (rect.width < viewportWidth) {
      const center = rect.left + rect.width / 2;
      const desired = center - viewportWidth / 2;
      targetLeft = Math.max(0, Math.min(maxScrollLeft, Math.round(desired)));
    } else {
      targetLeft = Math.max(0, Math.min(maxScrollLeft, Math.round(rect.left - paneGap)));
    }
  } else {
    targetLeft = computeEdgeRevealTarget(
      rect.left,
      rect.width,
      paneGap,
      currentScrollLeft,
      viewportWidth,
      maxScrollLeft,
    );
  }

  // Viewport never scrolls vertically (ADR 0015), hence the constant targetTop.
  const needsScroll = Math.abs(targetLeft - currentScrollLeft) >= 1;

  return {
    targetLeft,
    targetTop,
    needsScroll,
  };
}

export interface AnimateScrollOptions {
  readonly duration?: number;
  readonly onComplete?: () => void;
  readonly onCancel?: () => void;
}

const activeAnimations = new WeakMap<HTMLElement, () => void>();

export function cancelActiveScrollAnimation(element: HTMLElement): void {
  const cancel = activeAnimations.get(element);
  if (cancel) {
    activeAnimations.delete(element);
    cancel();
  }
}

/**
 * Animate viewport scroll with Apple cubic-bezier damping.
 * User gestures (wheel/touch) cancel the animation immediately to ensure zero resistance.
 */
export function animateScrollTo(
  element: HTMLElement,
  targetLeft: number,
  targetTop: number,
  options: AnimateScrollOptions = {},
): () => void {
  cancelActiveScrollAnimation(element);

  const startLeft = element.scrollLeft;
  const startTop = element.scrollTop;
  const dx = targetLeft - startLeft;
  const dy = targetTop - startTop;

  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
    element.scrollLeft = targetLeft;
    element.scrollTop = targetTop;
    options.onComplete?.();
    return () => {};
  }

  if (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  ) {
    element.scrollLeft = targetLeft;
    element.scrollTop = targetTop;
    options.onComplete?.();
    return () => {};
  }

  const distance = Math.hypot(dx, dy);
  const duration = scaledMotionDuration(
    options.duration ?? Math.min(320, Math.max(180, Math.round(distance * 0.35))),
  );
  if (duration === 0) {
    element.scrollLeft = targetLeft;
    element.scrollTop = targetTop;
    options.onComplete?.();
    return () => {};
  }

  let frameId: number | null = null;
  let startTime: number | null = null;
  let cancelled = false;

  const cleanup = () => {
    if (cancelled) return;
    cancelled = true;
    if (frameId !== null) {
      cancelAnimationFrame(frameId);
      frameId = null;
    }
    element.removeEventListener("wheel", onUserScroll, { capture: true });
    element.removeEventListener("touchmove", onUserScroll, { capture: true });
    if (activeAnimations.get(element) === cancel) {
      activeAnimations.delete(element);
    }
  };

  const cancel = () => {
    cleanup();
    options.onCancel?.();
  };

  const initTime = typeof performance !== "undefined" ? performance.now() : Date.now();
  const onUserScroll = (event: Event) => {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (now - initTime < 100) return;
    if (event instanceof WheelEvent && Math.hypot(event.deltaX, event.deltaY) < 3) return;
    cancel();
  };

  element.addEventListener("wheel", onUserScroll, { capture: true, passive: true });
  element.addEventListener("touchmove", onUserScroll, { capture: true, passive: true });

  activeAnimations.set(element, cancel);

  const step = (now: number) => {
    if (cancelled) return;
    if (startTime === null) startTime = now;
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / duration);
    const ease = appleEaseOut(progress);

    element.scrollLeft = Math.round(startLeft + dx * ease);
    element.scrollTop = Math.round(startTop + dy * ease);

    if (progress < 1) {
      frameId = requestAnimationFrame(step);
    } else {
      element.scrollLeft = targetLeft;
      element.scrollTop = targetTop;
      cleanup();
      options.onComplete?.();
    }
  };

  frameId = requestAnimationFrame(step);
  return cancel;
}

/**
 * One Tab's live entry, holding it at the edge it was entered from.
 * `focusedPaneId` is the Pane focused when the entry began, and `settledAt` the
 * Viewport offset the entry last wrote: the entry ends when the user focuses a
 * different Pane or scrolls the Viewport away from where it was left.
 */
export interface TabEntry {
  readonly dir: -1 | 1;
  readonly focusedPaneId: string;
  readonly settledAt: number;
  readonly offset?: number;
}

/**
 * Advance a Tab's entry for one reveal pass, returning the entry that still
 * owns the Viewport, or `null` when reveal should speak for itself (ADR-0025).
 *
 * `entryDir` is present only on the commit that activates the Tab, but the
 * entry must outlive that commit: the Tab re-runs reveal as it gains its real
 * size and as its Columns change, and each of those would otherwise pull the
 * Viewport inward to the focused Pane.
 *
 * The entry speaks only for that focused-Pane reveal, which it exists to
 * suppress. It therefore ends when the user takes over — focusing another Pane,
 * or scrolling the Viewport away from where the entry left it, since direct
 * manipulation outranks the entry. Without the scroll check the entry would
 * keep writing the edge back over the user's own scroll.
 */
export function holdTabEntry(
  current: TabEntry | null,
  entryDir: -1 | 1 | undefined,
  focusedPaneId: string,
  scrollLeft: number,
): TabEntry | null {
  if (entryDir !== undefined) return { dir: entryDir, focusedPaneId, settledAt: scrollLeft };
  if (current === null || current.focusedPaneId !== focusedPaneId) return null;
  return Math.abs(scrollLeft - current.settledAt) < 1 ? current : null;
}
