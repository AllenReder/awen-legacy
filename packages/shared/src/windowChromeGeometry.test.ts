import { describe, expect, it } from "vite-plus/test";
import { resolveWindowChromeGeometry } from "./windowChromeGeometry.ts";

const desktopMac = { hasDesktopBridge: true, isMac: true, fullscreen: false, zoomFactor: 1 };

describe("window chrome geometry", () => {
  it("keeps the rendered macOS toggle at 76 with a real 2px button gap", () => {
    expect(resolveWindowChromeGeometry(desktopMac)).toEqual({
      titlebarHeight: 36,
      buttonSize: 28,
      triggerLeft: 76,
      actionRightGap: 6,
      sidebarEdgeWidth: 1,
      collapsedActionLeft: 106,
      collapsedTabsInset: 153,
      minimumSidebarWidth: 140,
      separatorRightGap: 12,
    });
  });

  it.each([
    { ...desktopMac, hasDesktopBridge: false },
    { ...desktopMac, fullscreen: true },
    { ...desktopMac, isMac: false },
  ])("removes native reservations when native macOS controls are absent: %j", (input) => {
    const geometry = resolveWindowChromeGeometry(input);
    expect(geometry.triggerLeft).toBe(6);
    expect(geometry.collapsedActionLeft).toBe(36);
    expect(geometry.minimumSidebarWidth).toBe(70);
    expect(geometry.collapsedTabsInset).toBe(83);
  });

  it.each([0.8, 1, 1.25, 2])(
    "converts native points at zoom %s without scaling application gaps",
    (zoomFactor) => {
      const geometry = resolveWindowChromeGeometry({ ...desktopMac, zoomFactor });
      expect(geometry.triggerLeft * zoomFactor).toBeCloseTo(76);
      expect(geometry.collapsedActionLeft - geometry.triggerLeft - geometry.buttonSize).toBeCloseTo(
        2,
      );
      expect(
        geometry.minimumSidebarWidth - geometry.collapsedActionLeft - geometry.buttonSize,
      ).toBe(6);
      expect(geometry.minimumSidebarWidth).toBeCloseTo(76 / zoomFactor + 64);
      expect(geometry.buttonSize).toBe(28);
    },
  );

  it.each([0, -1, NaN, Infinity, -Infinity])("treats invalid zoom %s as 100%%", (zoomFactor) => {
    expect(resolveWindowChromeGeometry({ ...desktopMac, zoomFactor })).toEqual(
      resolveWindowChromeGeometry(desktopMac),
    );
  });
});
