import { useLayoutEffect } from "react";

import type { ViewportMetrics } from "./viewportMetrics";

/**
 * Every rendered Scrolling Tab's Viewport readings, published by the Viewport
 * owner and consumed by the Topbar Tab indicator (ADR-0025).
 *
 * Keyed by Tab rather than holding only the active reading: a Sliding Tab
 * switch interpolates the underbar between the source and target Tabs' resting
 * geometry, so the target's reading is needed while it is still the incoming
 * Tab. A Tab that is not laid out (display-none, so a zero-width box) publishes
 * nothing and keeps its last real reading.
 */
const published = new Map<string, ViewportMetrics>();
const listeners = new Set<() => void>();

export function getViewportMetrics(tabId: string): ViewportMetrics | null {
  return published.get(tabId) ?? null;
}

export function subscribeViewportMetrics(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishViewportMetrics(tabId: string, metrics: ViewportMetrics): void {
  const current = published.get(tabId);
  if (
    current !== undefined &&
    current.clientWidth === metrics.clientWidth &&
    current.scrollWidth === metrics.scrollWidth &&
    current.scrollLeft === metrics.scrollLeft
  ) {
    return;
  }
  published.set(tabId, metrics);
  for (const listener of listeners) listener();
}

export function forgetViewportMetrics(tabId: string): void {
  if (published.delete(tabId)) for (const listener of listeners) listener();
}

export function resetViewportMetricsForTest(): void {
  published.clear();
}

/**
 * Publish one Scrolling Tab's Viewport readings for as long as it is mounted.
 *
 * Mount-scoped rather than gated on the active Tab: a Tab is laid out again when
 * a switch makes it visible, and the `ResizeObserver` reports that zero-to-real
 * box change, so visibility needs no extra dependency. Reading layout per frame
 * here would force a synchronous reflow of the pane subtree on every wheel tick,
 * so only `scrollLeft` is re-read per scroll and the box is re-read on resize.
 */
export function usePublishViewportMetrics(options: {
  readonly ref: React.RefObject<HTMLElement | null>;
  readonly tabId: string;
  /** False for a Tab whose layout cannot scroll (BSP), so nothing is published. */
  readonly enabled: boolean;
}): void {
  const { ref, tabId, enabled } = options;
  // A layout effect measures in the commit's own layout pass, before paint, so
  // a Tab made visible by a switch publishes its real box in the same commit.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || element === null || typeof element.getBoundingClientRect !== "function") {
      return;
    }

    const box = { clientWidth: element.clientWidth, scrollWidth: element.scrollWidth };
    const publish = () => {
      // A Tab that is not laid out has no scroll position to express; keeping
      // the previous reading means its last real position survives being hidden.
      if (box.clientWidth <= 0) return;
      publishViewportMetrics(tabId, {
        clientWidth: box.clientWidth,
        scrollWidth: box.scrollWidth,
        scrollLeft: element.scrollLeft,
      });
    };

    const rebox = () => {
      box.clientWidth = element.clientWidth;
      box.scrollWidth = element.scrollWidth;
      publish();
    };

    rebox();
    const onScroll = () => publish();
    element.addEventListener("scroll", onScroll, { passive: true });

    // A Column resize changes the canvas size, not the scroll offset, so watch
    // the canvas itself as well as the Viewport.
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(rebox);
    observer?.observe(element);
    const canvas = element.firstElementChild;
    if (canvas !== null) observer?.observe(canvas);

    return () => {
      element.removeEventListener("scroll", onScroll);
      observer?.disconnect();
      forgetViewportMetrics(tabId);
    };
  }, [ref, tabId, enabled]);
}
