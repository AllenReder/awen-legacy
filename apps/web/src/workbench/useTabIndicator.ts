import { useEffect, useLayoutEffect, useRef } from "react";

import {
  FLUID_MOTION_DURATION_MS,
  FLUID_MOTION_EASING,
  scaledMotionDuration,
  skipAutomaticWorkbenchMotion,
} from "./workbenchMotion";
import {
  getTabTransition,
  getTabTransitionFrame,
  subscribeTabTransitionFrame,
} from "./tabTransition";
import type { TabIndicatorGeometry } from "./tabTransition";
import { useTabTransition } from "./tabTransitionReact";
import { getViewportMetrics, subscribeViewportMetrics } from "./viewportTracking";
import { resolveViewportIndicatorGeometry, type ViewportMetrics } from "./viewportMetrics";

function escapeSelector(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function geometryFromElement(
  stripRect: DOMRect,
  scrollLeft: number,
  element: HTMLElement,
): TabIndicatorGeometry {
  const rect = element.getBoundingClientRect();
  return { left: rect.left - stripRect.left + scrollLeft, width: rect.width };
}

function measureAllTabs(strip: HTMLElement): Map<string, TabIndicatorGeometry> {
  const map = new Map<string, TabIndicatorGeometry>();
  const stripRect = strip.getBoundingClientRect();
  const scrollLeft = strip.scrollLeft;
  for (const element of strip.querySelectorAll<HTMLElement>("[data-tab-id]")) {
    const id = element.dataset.tabId;
    if (id !== undefined) map.set(id, geometryFromElement(stripRect, scrollLeft, element));
  }
  return map;
}

function measureTabGeometry(strip: HTMLElement, tabId: string): TabIndicatorGeometry | null {
  const element = strip.querySelector<HTMLElement>(`[data-tab-id="${escapeSelector(tabId)}"]`);
  if (element === null) return null;
  return geometryFromElement(strip.getBoundingClientRect(), strip.scrollLeft, element);
}

function writeTransform(style: CSSStyleDeclaration, left: number): void {
  style.transform = `translateX(${left}px)`;
}

function writeWidth(style: CSSStyleDeclaration, width: number): void {
  style.width = `${width}px`;
}

/**
 * Replace a Tab's resting geometry with its Viewport's share of the Scrolling
 * canvas (ADR-0025). A Tab whose Viewport does not overflow — BSP, an empty
 * Tab, or a strip narrower than the Viewport — keeps spanning the whole Tab.
 */
function applyViewportGeometry(
  geometry: TabIndicatorGeometry,
  metrics: ViewportMetrics | null,
): TabIndicatorGeometry {
  if (metrics === null) return geometry;
  return resolveViewportIndicatorGeometry(geometry, metrics) ?? geometry;
}

export interface TabIndicatorOptions {
  readonly stripRef: React.RefObject<HTMLElement | null>;
  readonly activeTabId: string;
  /**
   * Changes whenever the underbar's resting geometry must be re-measured: Tab
   * reorder, create, close, or a live reorder drag frame.
   */
  readonly revision: string;
  /** True while the user is actively dragging a Tab, so the underbar follows 1:1. */
  readonly dragging: boolean;
}

/**
 * Positions the shared Topbar Tab underbar (ADR-0019). It follows Tab switch
 * progress directly and animates with Apple fluid easing on ordinary changes.
 * For a Scrolling Tab it also carries the Viewport's position and width
 * (ADR-0025), driven by the metrics the Viewport owner publishes.
 *
 * Reading layout (`getBoundingClientRect`) is what stalls a switch: the cards have
 * just been repositioned, so any read forces a synchronous reflow of the whole
 * (possibly heavy) card subtree. Tab geometry is therefore cached at rest and
 * reused for the whole switch, and only `transform` is written per frame.
 */
export function useTabIndicator(
  options: TabIndicatorOptions,
): React.RefObject<HTMLSpanElement | null> {
  const { stripRef, activeTabId, revision, dragging } = options;
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const lastGeometryRef = useRef<TabIndicatorGeometry | null>(null);
  const wasTransitioningRef = useRef(false);
  const animationRef = useRef<Animation | null>(null);
  const cacheRef = useRef<{ key: string | null; map: Map<string, TabIndicatorGeometry> }>({
    key: null,
    map: new Map(),
  });
  const transition = useTabTransition();

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const indicator = indicatorRef.current;
    const indicatorStyle = (indicator as { style?: CSSStyleDeclaration } | null)?.style;
    if (strip === null || indicator === null || !indicatorStyle) return;
    if (typeof strip.getBoundingClientRect !== "function") return;
    if (revision === "") return;

    // `getAnimations()` forces a style flush; track the one animation we start.
    const cancelIndicatorAnimation = () => {
      animationRef.current?.cancel();
      animationRef.current = null;
    };

    const write = (geometry: TabIndicatorGeometry) => {
      writeTransform(indicatorStyle, geometry.left);
      writeWidth(indicatorStyle, geometry.width);
      lastGeometryRef.current = geometry;
    };

    const animateTo = (geometry: TabIndicatorGeometry) => {
      const previous = lastGeometryRef.current;
      cancelIndicatorAnimation();
      write(geometry);
      if (
        dragging ||
        (previous?.left === geometry.left && previous.width === geometry.width) ||
        skipAutomaticWorkbenchMotion() ||
        previous === null ||
        typeof indicator.animate !== "function"
      ) {
        return;
      }
      cancelIndicatorAnimation();
      animationRef.current = indicator.animate(
        [
          { transform: `translateX(${previous.left}px)`, width: `${previous.width}px` },
          { transform: `translateX(${geometry.left}px)`, width: `${geometry.width}px` },
        ],
        { duration: scaledMotionDuration(FLUID_MOTION_DURATION_MS), easing: FLUID_MOTION_EASING },
      );
    };

    // Re-measure the strip only when its own layout changed, never per switch.
    if (!dragging && cacheRef.current.key !== revision) {
      cacheRef.current = { key: revision, map: measureAllTabs(strip) };
    }
    const geometryFor = (tabId: string): TabIndicatorGeometry | null => {
      if (dragging) return measureTabGeometry(strip, tabId);
      const cached = cacheRef.current.map.get(tabId);
      if (cached !== undefined) return cached;
      const geometry = measureTabGeometry(strip, tabId);
      if (geometry !== null) cacheRef.current.map.set(tabId, geometry);
      return geometry;
    };

    // A Tab's resting geometry is what the underbar shows for it at rest: its
    // full box, narrowed to its Viewport's share in a Scrolling layout. Both
    // ends of a switch use this, so the underbar follows the geometry it is
    // actually travelling between.
    const restingGeometryFor = (tabId: string): TabIndicatorGeometry | null => {
      const geometry = geometryFor(tabId);
      if (geometry === null) return geometry;
      return applyViewportGeometry(geometry, getViewportMetrics(tabId));
    };

    // The bar follows every Viewport reading in the frame it happens rather
    // than easing to it: a pan is pointer-driven, and a resize moves the Pane
    // rects directly too, so easing here would tear the bar away from the
    // geometry it describes.
    const followViewport = () => {
      const geometry = restingGeometryFor(activeTabId);
      if (geometry === null) return;
      cancelIndicatorAnimation();
      write(geometry);
    };

    if (transition !== null) {
      wasTransitioningRef.current = true;
      // Gesture progress drives the underbar directly; drop any in-flight ease.
      cancelIndicatorAnimation();
      const applyFrame = () => {
        const frame = getTabTransitionFrame();
        if (frame === null) return;
        const ordered = [...frame.cards].sort((a, b) => a.slot - b.slot);
        const rightIndex = ordered.findIndex((card) => card.slot >= frame.position);
        const right = ordered[Math.max(0, rightIndex < 0 ? ordered.length - 1 : rightIndex)];
        const left = ordered[Math.max(0, (rightIndex < 0 ? ordered.length - 1 : rightIndex) - 1)];
        if (!left || !right) return;
        // Interpolate the two Tabs' resting geometry — position and width
        // together. A Scrolling Tab's bar is narrower than its box and sits
        // where its Viewport was scrolled to, so travelling whole Tab boxes
        // would start the bar at the wrong edge and snap its width on landing.
        const from = restingGeometryFor(left.tabId);
        const to = restingGeometryFor(right.tabId);
        if (from === null || to === null) return;
        const progress =
          left.slot === right.slot ? 0 : (frame.position - left.slot) / (right.slot - left.slot);
        write({
          left: from.left + (to.left - from.left) * progress,
          width: from.width + (to.width - from.width) * progress,
        });
      };
      applyFrame();
      // An endpoint can move without a frame behind it: committing a switch
      // reveals the incoming Tab's focused Pane, which scrolls its Viewport.
      // Both endpoints are re-read per frame, so a reading change mid-switch
      // must re-place the bar rather than leave it on the stale endpoint and
      // jump when the switch settles.
      const stopViewport = subscribeViewportMetrics(applyFrame);
      const stopFrame = subscribeTabTransitionFrame(applyFrame);
      return () => {
        stopFrame();
        stopViewport();
      };
    }

    const wasTransitioning = wasTransitioningRef.current;
    wasTransitioningRef.current = false;
    const geometry = restingGeometryFor(activeTabId);
    if (geometry !== null) {
      if (dragging || wasTransitioning) {
        cancelIndicatorAnimation();
        write(geometry);
      } else animateTo(geometry);
    }
    return subscribeViewportMetrics(followViewport);
  }, [stripRef, activeTabId, revision, dragging, transition]);

  useEffect(
    () => () => {
      animationRef.current?.cancel();
      animationRef.current = null;
    },
    [],
  );

  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      cacheRef.current = { key: null, map: new Map() };
      if (getTabTransition() !== null) return;
      const indicator = indicatorRef.current;
      const indicatorStyle = (indicator as { style?: CSSStyleDeclaration } | null)?.style;
      if (indicator === null || !indicatorStyle) return;
      const measured = measureTabGeometry(strip, activeTabId);
      if (measured === null) return;
      const geometry = applyViewportGeometry(measured, getViewportMetrics(activeTabId));
      writeTransform(indicatorStyle, geometry.left);
      writeWidth(indicatorStyle, geometry.width);
      lastGeometryRef.current = geometry;
    });
    observer.observe(strip);
    return () => observer.disconnect();
  }, [stripRef, activeTabId]);

  return indicatorRef;
}
