import { describe, expect, it } from "vite-plus/test";

import {
  resolveWorkbenchDropTargetAtPoint,
  resolveSidebarDropTargetAtPoint,
  computeVirtualPaneRegions,
  resolveVirtualPaneDropTargetAtPoint,
  computeEdgeAutoScrollVelocity,
} from "./workbenchDrag";
import { leaf, splitPane } from "./layout";
import { computeBaseTab, type WorkbenchTab, type PaneView } from "./workbenchState";

const dummyView = (_id: string): PaneView => ({
  presentation: {},
  definitionId: "agent",
  target: { kind: "welcome" },
});

function fakeElement(input: {
  readonly dataset?: Record<string, string>;
  readonly rect?: { left: number; top: number; width: number; height: number };
  readonly closest?: (selector: string) => Element | null;
  readonly descendants?: ReadonlyArray<Element>;
}): Element {
  return {
    dataset: input.dataset ?? {},
    getBoundingClientRect: () => input.rect ?? { left: 0, top: 0, width: 0, height: 0 },
    closest: input.closest ?? (() => null),
    querySelectorAll: () => input.descendants ?? [],
  } as unknown as Element;
}

it("resolves Pane edge and replacement zones from the element under the pointer", () => {
  const pane = fakeElement({
    dataset: { workbenchPaneDrop: "", workbenchTabId: "tab-a", paneId: "pane-a" },
    rect: { left: 100, top: 100, width: 200, height: 200 },
  });
  pane.closest = ((selector: string) =>
    selector === "[data-workbench-pane-drop]" ? pane : null) as Element["closest"];
  const resolve = (x: number, y: number) =>
    resolveWorkbenchDropTargetAtPoint(x, y, {
      elementFromPoint: () => pane,
      tabCount: () => 0,
    });

  expect(resolve(110, 200)).toEqual({
    kind: "pane",
    tabId: "tab-a",
    paneId: "pane-a",
    zone: "left",
  });
  expect(resolve(200, 200)).toEqual({
    kind: "pane",
    tabId: "tab-a",
    paneId: "pane-a",
    zone: "replace",
  });
});

it("resolves existing Tabs and blank tab-strip drops", () => {
  const first = fakeElement({
    dataset: { workbenchTabDrop: "tab-a" },
    rect: { left: 0, top: 0, width: 100, height: 32 },
  });
  const second = fakeElement({
    dataset: { workbenchTabDrop: "tab-b" },
    rect: { left: 100, top: 0, width: 100, height: 32 },
  });
  const strip = fakeElement({
    dataset: { workbenchTabStripDrop: "" },
    descendants: [first, second],
  });
  strip.closest = ((selector: string) => {
    if (selector === "[data-workbench-tab-strip-drop]") return strip;
    if (selector === "[data-workbench-tab-drop]") return null;
    return null;
  }) as Element["closest"];
  second.closest = ((selector: string) =>
    selector === "[data-workbench-tab-drop]" ? second : null) as Element["closest"];
  let hit: Element = second;
  const resolver = {
    elementFromPoint: () => hit,
    tabCount: () => 2,
  };

  expect(resolveWorkbenchDropTargetAtPoint(120, 16, resolver)).toEqual({
    kind: "existingTab",
    tabId: "tab-b",
  });

  hit = strip;
  expect(resolveWorkbenchDropTargetAtPoint(80, 16, resolver)).toEqual({
    kind: "newTab",
    index: 1,
  });
  expect(resolveWorkbenchDropTargetAtPoint(240, 16, resolver)).toEqual({
    kind: "newTab",
    index: 2,
  });
});

it("resolves sidebar session reorder target when dragging inside sidebar within same workspace", () => {
  const rowA = fakeElement({
    dataset: {
      sidebarSessionRow: "true",
      workspaceKey: "local:ws1",
      sessionId: "s1",
    },
    rect: { left: 10, top: 50, width: 200, height: 30 },
  });
  rowA.closest = ((selector: string) =>
    selector === "[data-sidebar-session-row]" ? rowA : null) as Element["closest"];

  const resolver = {
    isOverSidebar: (x: number, y: number) => x >= 0 && x <= 250 && y >= 0 && y <= 600,
    elementFromPoint: (x: number, y: number) => (y >= 50 && y <= 80 ? rowA : null),
  };

  // Dragging s2 over top half of s1 (y = 55, top is 50, height is 30 -> 55 < 65 -> before)
  const beforeRes = resolveSidebarDropTargetAtPoint(50, 55, "local:ws1", "s2", resolver);
  expect(beforeRes).toEqual({
    isOverSidebar: true,
    sidebarDropTarget: {
      workspaceKey: "local:ws1",
      sessionId: "s1",
      position: "before",
    },
  });

  // Dragging s2 over bottom half of s1 (y = 70 -> 70 >= 65 -> after)
  const afterRes = resolveSidebarDropTargetAtPoint(50, 70, "local:ws1", "s2", resolver);
  expect(afterRes).toEqual({
    isOverSidebar: true,
    sidebarDropTarget: {
      workspaceKey: "local:ws1",
      sessionId: "s1",
      position: "after",
    },
  });

  // Dragging s1 over itself: no reorder target
  const selfRes = resolveSidebarDropTargetAtPoint(50, 55, "local:ws1", "s1", resolver);
  expect(selfRes).toEqual({
    isOverSidebar: true,
    sidebarDropTarget: null,
  });

  // Dragging s2 from different workspace: no reorder target
  const otherWsRes = resolveSidebarDropTargetAtPoint(50, 55, "local:ws2", "s2", resolver);
  expect(otherWsRes).toEqual({
    isOverSidebar: true,
    sidebarDropTarget: null,
  });

  // Dragging s2 over a closed (history) session: no reorder target
  const closedRow = fakeElement({
    dataset: {
      sidebarSessionRow: "true",
      workspaceKey: "local:ws1",
      sessionId: "s_closed",
      sessionClosed: "true",
    },
    rect: { left: 10, top: 90, width: 200, height: 30 },
  });
  closedRow.closest = ((selector: string) =>
    selector === "[data-sidebar-session-row]" ? closedRow : null) as Element["closest"];
  const closedResolver = {
    isOverSidebar: (x: number, y: number) => x >= 0 && x <= 250 && y >= 0 && y <= 600,
    elementFromPoint: () => closedRow,
  };
  const closedRes = resolveSidebarDropTargetAtPoint(50, 95, "local:ws1", "s2", closedResolver);
  expect(closedRes).toEqual({
    isOverSidebar: true,
    sidebarDropTarget: null,
  });

  // Dragging outside sidebar: isOverSidebar is false
  const outsideRes = resolveSidebarDropTargetAtPoint(300, 55, "local:ws1", "s2", resolver);
  expect(outsideRes).toEqual({
    isOverSidebar: false,
    sidebarDropTarget: null,
  });
});

describe("computeBaseTab", () => {
  it("returns null when the tab has only one pane", () => {
    const singleTab: WorkbenchTab = {
      id: "tab-1",
      layout: leaf("pane-a"),
      panes: new Map([["pane-a", dummyView("pane-a")]]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };
    expect(computeBaseTab(singleTab, "pane-a")).toBeNull();
  });

  it("returns layout without the dragged pane in BSP mode", () => {
    const tree = splitPane(leaf("pane-a"), "pane-a", "right", "pane-b");
    const twoPaneTab: WorkbenchTab = {
      id: "tab-1",
      layout: tree,
      panes: new Map([
        ["pane-a", dummyView("pane-a")],
        ["pane-b", dummyView("pane-b")],
      ]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };

    const baseTab = computeBaseTab(twoPaneTab, "pane-a");
    expect(baseTab).not.toBeNull();
    expect(baseTab?.layout).toEqual(leaf("pane-b"));
    expect(baseTab?.panes.has("pane-a")).toBe(false);
    expect(baseTab?.panes.has("pane-b")).toBe(true);
  });

  it("returns layout without the dragged pane in scrolling mode", () => {
    const scrollingTab: WorkbenchTab = {
      id: "tab-1",
      layoutMode: "scrolling",
      layout: leaf("pane-a"),
      columns: [
        { id: "col-1", width: 500, paneIds: ["pane-a"], shares: [1] },
        { id: "col-2", width: 500, paneIds: ["pane-b"], shares: [1] },
      ],
      panes: new Map([
        ["pane-a", dummyView("pane-a")],
        ["pane-b", dummyView("pane-b")],
      ]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };

    const baseTab = computeBaseTab(scrollingTab, "pane-a");
    expect(baseTab).not.toBeNull();
    expect(baseTab?.columns?.map((c) => c.paneIds)).toEqual([["pane-b"]]);
    expect(baseTab?.panes.has("pane-a")).toBe(false);
  });
});

describe("Virtual Base Layout Drag Hit-Testing", () => {
  it("maps former pane A area to the left edge of pane B when dragging pane A", () => {
    const tree = splitPane(leaf("pane-a"), "pane-a", "right", "pane-b");
    const twoPaneTab: WorkbenchTab = {
      id: "tab-1",
      layout: tree,
      panes: new Map([
        ["pane-a", dummyView("pane-a")],
        ["pane-b", dummyView("pane-b")],
      ]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };

    const viewportRect = { left: 0, top: 0, width: 1000, height: 600 };
    const baseTab = computeBaseTab(twoPaneTab, "pane-a");
    const regions = computeVirtualPaneRegions(baseTab, viewportRect, 0);

    expect(regions).toHaveLength(1);
    expect(regions[0]?.paneId).toBe("pane-b");
    expect(regions[0]?.rect).toMatchObject({ left: 0, top: 0, width: 1000, height: 600 });

    // In the former area of pane A (e.g. x = 100, y = 300, which is near the left of B):
    const hitLeft = resolveVirtualPaneDropTargetAtPoint(100, 300, viewportRect, regions, 0, true);
    expect(hitLeft).toEqual({
      kind: "pane",
      tabId: "tab-1",
      paneId: "pane-b",
      zone: "left",
    });

    // In the center of the screen for intra-workbench pane drag (directional-only, no replace):
    const hitTop = resolveVirtualPaneDropTargetAtPoint(500, 200, viewportRect, regions, 0, true);
    expect(hitTop).toEqual({
      kind: "pane",
      tabId: "tab-1",
      paneId: "pane-b",
      zone: "top",
    });

    const hitBottom = resolveVirtualPaneDropTargetAtPoint(500, 400, viewportRect, regions, 0, true);
    expect(hitBottom).toEqual({
      kind: "pane",
      tabId: "tab-1",
      paneId: "pane-b",
      zone: "bottom",
    });

    // On the far right (x = 900, y = 300):
    const hitRight = resolveVirtualPaneDropTargetAtPoint(900, 300, viewportRect, regions, 0, true);
    expect(hitRight).toEqual({
      kind: "pane",
      tabId: "tab-1",
      paneId: "pane-b",
      zone: "right",
    });

    // For sidebar drag (directionalOnly: false), center remains replace:
    const hitCenterReplace = resolveVirtualPaneDropTargetAtPoint(
      500,
      300,
      viewportRect,
      regions,
      0,
      false,
    );
    expect(hitCenterReplace).toEqual({
      kind: "pane",
      tabId: "tab-1",
      paneId: "pane-b",
      zone: "replace",
    });
  });

  it("handles sash and gap coordinates without dropping to null", () => {
    const tree = splitPane(leaf("pane-b"), "pane-b", "right", "pane-c");
    const twoPaneTab: WorkbenchTab = {
      id: "tab-1",
      layout: tree,
      panes: new Map([
        ["pane-b", dummyView("pane-b")],
        ["pane-c", dummyView("pane-c")],
      ]),
      focusedPaneId: "pane-b",
      titleMode: "auto",
      titleOverride: null,
    };

    const viewportRect = { left: 0, top: 0, width: 1000, height: 600 };
    const gap = 8;
    const regions = computeVirtualPaneRegions(twoPaneTab, viewportRect, gap);
    expect(regions).toHaveLength(2);

    // Coordinate in the sash gap between pane-b and pane-c
    const bRight = regions[0]!.rect.left + regions[0]!.rect.width;
    const gapX = bRight + gap / 2;
    const hitGap = resolveVirtualPaneDropTargetAtPoint(gapX, 300, viewportRect, regions, gap);
    expect(hitGap).not.toBeNull();
    expect(hitGap?.kind).toBe("pane");
  });

  it("returns null for canvas hit testing when dragging a single-pane tab", () => {
    const singleTab: WorkbenchTab = {
      id: "tab-1",
      layout: leaf("pane-a"),
      panes: new Map([["pane-a", dummyView("pane-a")]]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };

    const viewportRect = { left: 0, top: 0, width: 1000, height: 600 };
    const baseTab = computeBaseTab(singleTab, "pane-a");
    const regions = computeVirtualPaneRegions(baseTab, viewportRect, 0);

    expect(regions).toHaveLength(0);
    const hit = resolveVirtualPaneDropTargetAtPoint(100, 300, viewportRect, regions);
    expect(hit).toBeNull();
  });

  it("resolves trailing canvas area to the rightmost column with zone: right in scrolling mode (ADR 0015)", () => {
    const scrollingTab: WorkbenchTab = {
      id: "tab-scrolling",
      layoutMode: "scrolling",
      layout: leaf("pane-a"),
      columns: [
        { id: "col-1", width: 400, paneIds: ["pane-a"], shares: [1] },
        { id: "col-2", width: 400, paneIds: ["pane-b"], shares: [1] },
      ],
      panes: new Map([
        ["pane-a", dummyView("pane-a")],
        ["pane-b", dummyView("pane-b")],
      ]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };

    const viewportRect = { left: 0, top: 0, width: 1400, height: 800 };
    // Dragging pane-a: baseTab has col-2 (pane-b)
    const baseTab = computeBaseTab(scrollingTab, "pane-a");
    const regions = computeVirtualPaneRegions(baseTab, viewportRect, 0);

    // baseTab has pane-b at left = 0, width = 400
    expect(regions).toHaveLength(1);
    expect(regions[0]?.paneId).toBe("pane-b");
    expect(regions[0]?.rect.left).toBe(0);
    expect(regions[0]?.rect.width).toBe(400);

    // Point in the trailing canvas area (x = 800, y = 300), far to the right of col-2 (which ends at 400)
    const hitTrailing = resolveVirtualPaneDropTargetAtPoint(
      800,
      300,
      viewportRect,
      regions,
      0,
      true,
      "scrolling",
    );

    expect(hitTrailing).toEqual({
      kind: "pane",
      tabId: "tab-scrolling",
      paneId: "pane-b",
      zone: "right",
    });

    // In BSP mode, the same point outside pane regions returns null
    const hitBsp = resolveVirtualPaneDropTargetAtPoint(
      800,
      300,
      viewportRect,
      regions,
      0,
      true,
      "bsp",
    );
    expect(hitBsp).toBeNull();
  });

  it("preserves single-pane invariant in scrolling mode when dragging the sole pane (ADR 0015)", () => {
    const singleScrollingTab: WorkbenchTab = {
      id: "tab-scrolling-single",
      layoutMode: "scrolling",
      layout: leaf("pane-a"),
      columns: [{ id: "col-1", width: 400, paneIds: ["pane-a"], shares: [1] }],
      panes: new Map([["pane-a", dummyView("pane-a")]]),
      focusedPaneId: "pane-a",
      titleMode: "auto",
      titleOverride: null,
    };

    const viewportRect = { left: 0, top: 0, width: 1400, height: 800 };
    const baseTab = computeBaseTab(singleScrollingTab, "pane-a");
    expect(baseTab).toBeNull();

    const regions = computeVirtualPaneRegions(baseTab, viewportRect, 0);
    expect(regions).toHaveLength(0);

    // Hit testing in the trailing canvas area returns null because no base panes exist
    const hit = resolveVirtualPaneDropTargetAtPoint(
      800,
      300,
      viewportRect,
      regions,
      0,
      true,
      "scrolling",
    );
    expect(hit).toBeNull();
  });

  describe("computeEdgeAutoScrollVelocity (ADR 0015)", () => {
    const viewportRect = { left: 100, top: 50, width: 1000, height: 600 };

    it("returns 0 when pointer is in the central region of the viewport", () => {
      // Middle of viewport: x = 600
      expect(computeEdgeAutoScrollVelocity(600, viewportRect)).toBe(0);
      // Just inside edge zone boundary: left + 56 = 156. At x = 160:
      expect(computeEdgeAutoScrollVelocity(160, viewportRect)).toBe(0);
      // Right edge zone boundary: left + width - 56 = 1044. At x = 1040:
      expect(computeEdgeAutoScrollVelocity(1040, viewportRect)).toBe(0);
    });

    it("returns proportional negative velocity in the left edge zone", () => {
      // Just entered left edge: x = 155 (depth ~ 0.01)
      const nearThreshold = computeEdgeAutoScrollVelocity(155, viewportRect);
      expect(nearThreshold).toBeLessThan(0);
      expect(nearThreshold).toBeGreaterThanOrEqual(-4);

      // Deep into left edge: x = 100 (depth 1.0, maximum speed)
      const atEdge = computeEdgeAutoScrollVelocity(100, viewportRect);
      expect(atEdge).toBe(-20);
    });

    it("returns proportional positive velocity in the right edge zone", () => {
      // Just entered right edge: x = 1045 (depth ~ 0.01)
      const nearThreshold = computeEdgeAutoScrollVelocity(1045, viewportRect);
      expect(nearThreshold).toBeGreaterThan(0);
      expect(nearThreshold).toBeLessThanOrEqual(4);

      // Deep into right edge: x = 1100 (depth 1.0, maximum speed)
      const atEdge = computeEdgeAutoScrollVelocity(1100, viewportRect);
      expect(atEdge).toBe(20);
    });

    it("returns 0 when pointer is outside viewport bounds", () => {
      expect(computeEdgeAutoScrollVelocity(50, viewportRect)).toBe(0); // left of viewport
      expect(computeEdgeAutoScrollVelocity(1200, viewportRect)).toBe(0); // right of viewport
    });
  });
});
