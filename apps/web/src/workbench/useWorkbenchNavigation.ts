import { useEffect, useLayoutEffect, useRef } from "react";
import { dismissContextMenu } from "../contextMenuFallback";
import type { MenuAnchorPosition } from "./paneMenuRegistry";
import { createContinuousNavigation } from "./continuousNavigation";
import {
  findHorizontalScroller,
  resolveHorizontalWheelDelta,
  resolveWheelSwitchDirection,
} from "./horizontalWheel";
import {
  beginTabTransition,
  endTabTransition,
  getTabTransitionFrame,
  interruptTabSettle,
  setTabTransitionPosition,
  setTabTransitionProgress,
} from "./tabTransition";
import {
  activateNavigationCheckpoint,
  finishTabSwitch,
  switchAdjacentTab,
} from "./tabTransitionReact";
import { cancelActiveScrollAnimation } from "./scrollingAnimation";
import { publishViewportMetrics } from "./viewportTracking";
import { useWorkbenchStore } from "./workbenchStore";

export function useWorkbenchNavigation(options: {
  stageRef: React.RefObject<HTMLElement | null>;
  onPaneContextMenu: (paneId: string, position: MenuAnchorPosition) => unknown;
}): void {
  const menu = useRef(options.onPaneContextMenu);
  useLayoutEffect(() => {
    menu.current = options.onPaneContextMenu;
  });
  useEffect(() => {
    const stage = options.stageRef.current;
    if (!stage || typeof window === "undefined" || typeof document === "undefined") return;
    const viewportFor = (id: string) =>
      Array.from(stage.querySelectorAll<HTMLElement>(".workbench-viewport")).find(
        (element) => element.dataset.tabId === id,
      ) ?? null;
    let navigationWidth = stage.clientWidth;
    const dimensions = new Map<string, { width: number; canvas: number }>();
    const resetCards = () => {
      delete stage.dataset.tabTransition;
      for (const viewport of stage.querySelectorAll<HTMLElement>(".workbench-viewport")) {
        viewport.style.transform = "";
        viewport.style.display =
          viewport.dataset.tabId === useWorkbenchStore.getState().activeTabId ? "" : "none";
      }
    };
    const navigation = createContinuousNavigation({
      tabs: () => useWorkbenchStore.getState().tabs.map((tab) => tab.id),
      activeTab: () => useWorkbenchStore.getState().activeTabId,
      width: () => navigationWidth,
      viewport(id) {
        const element = viewportFor(id);
        if (!element || element.dataset.layoutMode !== "scrolling") return null;
        let box = dimensions.get(id);
        if (!box) {
          box = { width: element.clientWidth, canvas: element.scrollWidth };
          dimensions.set(id, box);
        }
        const maxScrollLeft = Math.max(0, box.canvas - box.width);
        return {
          maxScrollLeft,
          get scrollLeft() {
            return element.scrollLeft;
          },
          setScrollLeft(value) {
            cancelActiveScrollAnimation(element);
            element.scrollLeft = value;
            publishViewportMetrics(id, {
              clientWidth: box!.width,
              scrollWidth: box!.canvas,
              scrollLeft: element.scrollLeft,
            });
          },
        };
      },
      preview: () => getTabTransitionFrame(),
      beginPreview(preview) {
        const state = useWorkbenchStore.getState();
        beginTabTransition({
          ...preview,
          fromIndex: state.tabs.findIndex((tab) => tab.id === preview.fromTabId),
          toIndex: state.tabs.findIndex((tab) => tab.id === preview.toTabId),
        });
        // Incoming layout must be measurable before remaining input is routed to it.
        stage.dataset.tabTransition = "true";
        const incoming = viewportFor(preview.toTabId);
        if (incoming) incoming.style.display = "";
        dimensions.delete(preview.toTabId);
      },
      present(progress) {
        setTabTransitionProgress(progress);
        const frame = getTabTransitionFrame();
        if (frame)
          for (const card of frame.cards) {
            const viewport = viewportFor(card.tabId);
            if (viewport)
              viewport.style.transform = `translate(${(card.slot - frame.position) * 100}%, 0)`;
          }
      },
      arrive(id, dir) {
        const incoming = viewportFor(id);
        if (incoming) incoming.dataset.navigationEntry = String(dir);
        activateNavigationCheckpoint(id);
        endTabTransition();
        resetCards();
      },
      cancelPreview(id) {
        if (useWorkbenchStore.getState().tabs.some((tab) => tab.id === id))
          activateNavigationCheckpoint(id);
        endTabTransition();
        resetCards();
      },
      settle(commit, velocity) {
        const frame = getTabTransitionFrame();
        if (frame) {
          const incoming = viewportFor(frame.toTabId);
          if (commit && incoming) incoming.dataset.navigationEntry = String(frame.dir);
          setTabTransitionPosition(
            frame.position,
            (velocity * 1000) / Math.max(1, stage.clientWidth),
          );
        }
        finishTabSwitch(commit);
      },
      hold(active) {
        if (active) {
          interruptTabSettle();
          navigationWidth = stage.clientWidth;
          dimensions.clear();
          stage.dataset.navigationOwned = "true";
        } else delete stage.dataset.navigationOwned;
      },
    });
    let pointer: {
      id: number;
      gesture: number;
      x: number;
      y: number;
      lastX: number;
      startedAt: number;
      pane: string | null;
      dragging: boolean;
      moved: boolean;
    } | null = null;
    let nextGesture = 0;
    let suppressContextMenu = false;
    let trackpadOwner: "content" | "workbench" | null = null;
    let trackpadId = -1;
    let trackpadCancelled = false;
    let gestureOwner: "content" | "workbench" | null = null;
    const finishPointer = (cancelled: boolean, event?: PointerEvent) => {
      const current = pointer;
      if (!current) return;
      pointer = null;
      if (stage.hasPointerCapture?.(current.id)) stage.releasePointerCapture(current.id);
      if (current.dragging)
        navigation.dispatch({
          gestureId: current.gesture,
          source: "right-drag",
          phase: cancelled ? "cancel" : "end",
          deltaX: event ? current.lastX - event.clientX : 0,
          time: performance.now(),
        });
      else if (!cancelled && !current.moved && current.pane && event)
        menu.current(current.pane, { x: event.clientX, y: event.clientY });
    };
    const onDown = (event: PointerEvent) => {
      navigation.cancel();
      trackpadCancelled = true;
      suppressContextMenu = false;
      if (event.button !== 2 || !(event.target instanceof Element) || !stage.contains(event.target))
        return;
      finishPointer(true);
      // Selected text owns the right press; dragging it must not navigate Tabs.
      const selection = window.getSelection?.();
      if (
        selection &&
        !selection.isCollapsed &&
        selection.anchorNode &&
        stage.contains(selection.anchorNode) &&
        !event.target.closest("[data-workbench-pane-drag-handle]")
      )
        return;
      pointer = {
        id: event.pointerId,
        gesture: ++nextGesture,
        x: event.clientX,
        y: event.clientY,
        lastX: event.clientX,
        startedAt: performance.now(),
        pane:
          event.target
            .closest<HTMLElement>("[data-workbench-pane-drag-handle]")
            ?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId ?? null,
        dragging: false,
        moved: false,
      };
    };
    const onMove = (event: PointerEvent) => {
      const current = pointer;
      if (!current || current.id !== event.pointerId) return;
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      current.moved ||= Math.hypot(dx, dy) >= 5;
      suppressContextMenu ||= current.moved;
      if (!current.dragging) {
        if (Math.abs(dx) < 5 || Math.abs(dx) < Math.abs(dy)) return;
        current.dragging = true;
        stage.setPointerCapture?.(event.pointerId);
        dismissContextMenu();
        navigation.dispatch({
          gestureId: current.gesture,
          source: "right-drag",
          phase: "begin",
          deltaX: 0,
          time: current.startedAt,
        });
      }
      navigation.dispatch({
        gestureId: current.gesture,
        source: "right-drag",
        phase: "update",
        deltaX: current.lastX - event.clientX,
        time: performance.now(),
      });
      current.lastX = event.clientX;
    };
    const onUp = (event: PointerEvent) => {
      if (pointer?.id === event.pointerId) finishPointer(false, event);
    };
    const cancel = () => {
      finishPointer(true);
      navigation.cancel();
      trackpadCancelled = true;
    };
    const onKey = () => {
      suppressContextMenu = false;
      cancel();
    };
    const onContextMenu = (event: Event) => {
      if (suppressContextMenu || pointer?.dragging || pointer?.moved || pointer?.pane)
        event.preventDefault();
      suppressContextMenu = false;
    };
    const hasInnerScroller = (target: Element | null) => {
      let node = target;
      while (node && node !== stage && !node.matches(".workbench-viewport")) {
        if (
          node.scrollWidth > node.clientWidth + 1 &&
          /auto|scroll/.test(getComputedStyle(node).overflowX)
        )
          return true;
        node = node.parentElement;
      }
      return false;
    };
    const native = window.desktopBridge?.onTrackpadInput;
    let sequence = -1;
    let axisLocked = false;
    const unlisten = native?.((input) => {
      if (input.sequence <= sequence) return;
      sequence = input.sequence;
      if (input.phase === "finish") {
        if (input.gestureId === trackpadId) {
          trackpadOwner = null;
          trackpadId = -1;
        }
        return;
      }
      const target = document.elementFromPoint(input.x, input.y);
      if (input.phase === "begin") {
        trackpadCancelled = false;
        trackpadId = input.gestureId;
        axisLocked = Math.abs(input.deltaX) + Math.abs(input.deltaY) > 0;
        trackpadOwner =
          target && stage.contains(target) && Math.abs(input.deltaX) >= Math.abs(input.deltaY)
            ? hasInnerScroller(target)
              ? "content"
              : "workbench"
            : "content";
        gestureOwner = trackpadOwner;
      }
      if (input.phase === "momentum" && input.gestureId === trackpadId)
        trackpadOwner = gestureOwner;
      if (trackpadOwner !== "workbench" || input.gestureId !== trackpadId || pointer) return;
      if (trackpadCancelled) {
        if (input.phase === "end" || input.phase === "cancel") trackpadOwner = null;
        return;
      }
      if (
        !axisLocked &&
        input.phase === "update" &&
        Math.abs(input.deltaX) + Math.abs(input.deltaY) > 0
      ) {
        axisLocked = true;
        if (Math.abs(input.deltaY) >= Math.abs(input.deltaX)) {
          navigation.cancel();
          trackpadOwner = "content";
          gestureOwner = "content";
          return;
        }
      }
      dismissContextMenu();
      navigation.dispatch({ ...input, phase: input.phase, source: "trackpad" });
      if (input.phase === "end" || input.phase === "cancel") trackpadOwner = null;
    });
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      if (native && !event.shiftKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        if (trackpadOwner === "workbench") {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const delta = resolveHorizontalWheelDelta(event, stage.clientWidth);
      if (!delta || !event.shiftKey) return;
      const scroller = findHorizontalScroller(target, stage, delta);
      event.preventDefault();
      event.stopPropagation();
      if (scroller)
        scroller.scrollLeft = Math.max(
          0,
          Math.min(scroller.scrollWidth - scroller.clientWidth, scroller.scrollLeft + delta),
        );
      else switchAdjacentTab(resolveWheelSwitchDirection(delta));
    };
    const stopStore = useWorkbenchStore.subscribe((state, previous) => {
      if (state.tabs.map((tab) => tab.id).join() !== previous.tabs.map((tab) => tab.id).join())
        cancel();
    });
    stage.addEventListener("wheel", onWheel, { capture: true, passive: false });
    stage.addEventListener("contextmenu", onContextMenu, true);
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancel();
      unlisten?.();
      stopStore();
      navigation.dispose();
      stage.removeEventListener("wheel", onWheel, true);
      stage.removeEventListener("contextmenu", onContextMenu, true);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [options.stageRef]);
}
