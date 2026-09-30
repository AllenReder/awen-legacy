import type { WindowChromeGeometry } from "@awen/shared/windowChromeGeometry";
import { createMotionValue } from "../../workbench/motionValue";

export interface SidebarPresentationInput {
  readonly open: boolean;
  readonly enabled: boolean;
  readonly width: number;
  readonly durationMs: number;
  readonly geometry: WindowChromeGeometry;
}

/** Keeps the Sidebar, its gap, and titlebar controls on one presentation value. */
export function createSidebarPresentation(
  wrapper: HTMLElement,
  initialGeometry: WindowChromeGeometry,
  initiallyOpen: boolean,
) {
  const spring = createMotionValue(initiallyOpen ? 1 : 0);
  let geometry = initialGeometry;
  let width = 0;
  const write = (fraction: number) => {
    if (Math.abs(fraction - spring.target) > 0.001) {
      document.documentElement.dataset.sidebarMotion = "true";
    } else {
      delete document.documentElement.dataset.sidebarMotion;
    }
    wrapper.style.setProperty("--sidebar-exposed-width", `${width * fraction}px`);
    wrapper.style.setProperty("--sidebar-motion-progress", `${fraction}`);
    wrapper.style.setProperty(
      "--sidebar-motion-tabs-inset",
      `${geometry.collapsedTabsInset * (1 - fraction)}px`,
    );
    const expandedLeft = width - geometry.buttonSize - geometry.actionRightGap;
    wrapper.style.setProperty(
      "--sidebar-motion-action-left",
      `${geometry.collapsedActionLeft + (expandedLeft - geometry.collapsedActionLeft) * fraction}px`,
    );
  };
  const unsubscribe = spring.subscribe(write);
  return {
    update(input: SidebarPresentationInput) {
      geometry = input.geometry;
      width = input.width;
      // A critically damped spring reaches about 98% at 5.83 / frequency.
      spring.setFrequency(5830 / Math.max(25, input.durationMs));
      if (input.enabled) spring.setTarget(input.open ? 1 : 0);
      else spring.setDirect(input.open ? 1 : 0);
      write(spring.value);
    },
    resize(nextWidth: number) {
      width = nextWidth;
      spring.setDirect(1);
    },
    dispose() {
      unsubscribe();
      spring.stop();
      delete document.documentElement.dataset.sidebarMotion;
    },
  };
}
