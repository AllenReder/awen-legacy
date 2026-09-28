import { describe, expect, it } from "vite-plus/test";
import { computePaneLayoutRects, SCROLLING_TRAILING_PADDING } from "./layoutGeometry";
import { leaf, type LayoutNode } from "./layout";
import type { WorkbenchTab } from "./workbenchState";
import type { ViewTarget } from "./viewRegistry";
import type { EnvironmentId, WorkspaceId } from "@awen/contracts";

const testTarget: ViewTarget = {
  kind: "workspace",
  definitionId: "fileView",
  environmentId: "local" as EnvironmentId,
  workspaceId: "w1" as WorkspaceId,
};

describe("layoutGeometry", () => {
  describe("scrolling mode", () => {
    it("computes seamless zero-gap rectangles when paneGap is 0", () => {
      const tab: WorkbenchTab = {
        id: "tab-1",
        layoutMode: "scrolling",
        layout: leaf("p1"),
        focusedPaneId: "p1",
        titleMode: "auto",
        titleOverride: "",
        panes: new Map([
          ["p1", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p2", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p3", { presentation: {}, definitionId: "test", target: testTarget }],
        ]),
        columns: [
          { id: "col-1", width: 500, paneIds: ["p1", "p2"], shares: [0.5, 0.5] },
          { id: "col-2", width: 600, paneIds: ["p3"], shares: [1] },
        ],
      };

      const result = computePaneLayoutRects(tab, { width: 1200, height: 800 }, 0);
      const p1 = result.rects.get("p1")!;
      const p2 = result.rects.get("p2")!;
      const p3 = result.rects.get("p3")!;

      // Column 1 starts at left 0, top 0
      expect(p1.left).toBe(0);
      expect(p1.top).toBe(0);
      expect(p1.width).toBe(500);
      expect(p1.height).toBe(400);

      // Pane 2 is immediately below Pane 1 with 0 gap
      expect(p2.left).toBe(0);
      expect(p2.top).toBe(400);
      expect(p2.width).toBe(500);
      expect(p2.height).toBe(400);

      // Column 2 starts immediately after Column 1 with 0 gap
      expect(p3.left).toBe(500);
      expect(p3.top).toBe(0);
      expect(p3.width).toBe(600);
      expect(p3.height).toBe(800);
    });

    it("computes uniform margins and exact non-doubled gaps when paneGap > 0", () => {
      const gap = 16;
      const tab: WorkbenchTab = {
        id: "tab-1",
        layoutMode: "scrolling",
        layout: leaf("p1"),
        focusedPaneId: "p1",
        titleMode: "auto",
        titleOverride: "",
        panes: new Map([
          ["p1", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p2", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p3", { presentation: {}, definitionId: "test", target: testTarget }],
        ]),
        columns: [
          { id: "col-1", width: 500, paneIds: ["p1", "p2"], shares: [0.5, 0.5] },
          { id: "col-2", width: 600, paneIds: ["p3"], shares: [1] },
        ],
      };

      // When viewport is 1000, columns overflow: 16 + 500 + 16 + 600 + 16 = 1148
      const result = computePaneLayoutRects(tab, { width: 1000, height: 800 }, gap);
      const p1 = result.rects.get("p1")!;
      const p2 = result.rects.get("p2")!;
      const p3 = result.rects.get("p3")!;

      // Outer margin: Column 1 starts at left = gap, top = gap
      expect(p1.left).toBe(gap);
      expect(p1.top).toBe(gap);
      expect(p1.width).toBe(500);

      // Gap between p1 and p2 must be exactly gap (not 2 * gap!)
      const verticalGap = p2.top - (p1.top + p1.height);
      expect(verticalGap).toBe(gap);

      // Bottom margin after p2 must equal gap
      const bottomMargin = result.canvasHeight - (p2.top + p2.height);
      expect(bottomMargin).toBe(gap);

      // Horizontal gap between col 1 and col 2 must be exactly gap (not 2 * gap!)
      const horizontalGap = p3.left - (p1.left + p1.width);
      expect(horizontalGap).toBe(gap);

      // Right margin after col 2 is only the configured outer Pane gap.
      const rightMargin = result.canvasWidth - (p3.left + p3.width);
      expect(SCROLLING_TRAILING_PADDING).toBe(0);
      expect(rightMargin).toBe(gap);
    });

    it("strictly locks canvasHeight to viewportHeight even when many panes stack (ADR 0015)", () => {
      const tab: WorkbenchTab = {
        id: "tab-1",
        layoutMode: "scrolling",
        layout: leaf("p1"),
        focusedPaneId: "p1",
        titleMode: "auto",
        titleOverride: "",
        panes: new Map([
          ["p1", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p2", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p3", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p4", { presentation: {}, definitionId: "test", target: testTarget }],
        ]),
        columns: [
          {
            id: "col-1",
            width: 500,
            paneIds: ["p1", "p2", "p3", "p4"],
            shares: [0.25, 0.25, 0.25, 0.25],
          },
        ],
      };

      const viewportHeight = 400;
      const result = computePaneLayoutRects(tab, { width: 1000, height: viewportHeight }, 16);
      expect(result.canvasHeight).toBe(viewportHeight);
      expect(result.rects.get("p1")!.height).toBeGreaterThan(0);
    });
  });

  describe("bsp mode", () => {
    it("computes seamless zero-gap rectangles when paneGap is 0", () => {
      const splitNode: LayoutNode = {
        type: "split",
        id: "s1",
        dir: "right",
        children: [leaf("p1"), leaf("p2")],
        sizes: [0.5, 0.5],
      };
      const tab: WorkbenchTab = {
        id: "tab-1",
        layoutMode: "bsp",
        layout: splitNode,
        focusedPaneId: "p1",
        titleMode: "auto",
        titleOverride: "",
        panes: new Map([
          ["p1", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p2", { presentation: {}, definitionId: "test", target: testTarget }],
        ]),
      };

      const result = computePaneLayoutRects(tab, { width: 1000, height: 600 }, 0);
      const p1 = result.rects.get("p1")!;
      const p2 = result.rects.get("p2")!;

      expect(p1).toEqual({ left: 0, top: 0, width: 500, height: 600 });
      expect(p2).toEqual({ left: 500, top: 0, width: 500, height: 600 });
    });

    it("computes uniform outer margin and exact single gap between splits when paneGap > 0", () => {
      const gap = 12;
      const splitNode: LayoutNode = {
        type: "split",
        id: "s1",
        dir: "right",
        children: [leaf("p1"), leaf("p2")],
        sizes: [0.5, 0.5],
      };
      const tab: WorkbenchTab = {
        id: "tab-1",
        layoutMode: "bsp",
        layout: splitNode,
        focusedPaneId: "p1",
        titleMode: "auto",
        titleOverride: "",
        panes: new Map([
          ["p1", { presentation: {}, definitionId: "test", target: testTarget }],
          ["p2", { presentation: {}, definitionId: "test", target: testTarget }],
        ]),
      };

      const result = computePaneLayoutRects(tab, { width: 1000, height: 600 }, gap);
      const p1 = result.rects.get("p1")!;
      const p2 = result.rects.get("p2")!;

      // Outer margins
      expect(p1.left).toBe(gap);
      expect(p1.top).toBe(gap);
      expect(p1.top + p1.height + gap).toBe(600);
      expect(p2.top).toBe(gap);
      expect(p2.left + p2.width + gap).toBe(1000);

      // Between p1 and p2, gap must be exactly gap (not 2 * gap)
      const gapBetween = p2.left - (p1.left + p1.width);
      expect(gapBetween).toBe(gap);
    });
  });
});

describe("nested splits and sashes", () => {
  it("handles complex BSP nested splits with uniform gaps", () => {
    const gap = 10;
    // Root split right: left is p1, right is split down (p2, p3)
    const layout: LayoutNode = {
      type: "split",
      id: "root",
      dir: "right",
      children: [
        leaf("p1"),
        {
          type: "split",
          id: "right-split",
          dir: "down",
          children: [leaf("p2"), leaf("p3")],
          sizes: [0.5, 0.5],
        },
      ],
      sizes: [0.5, 0.5],
    };
    const tab: WorkbenchTab = {
      id: "tab-nested",
      layoutMode: "bsp",
      layout,
      focusedPaneId: "p1",
      titleMode: "auto",
      titleOverride: "",
      panes: new Map([
        ["p1", { presentation: {}, definitionId: "test", target: testTarget }],
        ["p2", { presentation: {}, definitionId: "test", target: testTarget }],
        ["p3", { presentation: {}, definitionId: "test", target: testTarget }],
      ]),
    };

    const result = computePaneLayoutRects(tab, { width: 1000, height: 800 }, gap);
    const p1 = result.rects.get("p1")!;
    const p2 = result.rects.get("p2")!;
    const p3 = result.rects.get("p3")!;

    // Left margin p1
    expect(p1.left).toBe(gap);
    // Gap between p1 and right split
    expect(p2.left - (p1.left + p1.width)).toBe(gap);
    // Right margin p2
    expect(p2.left + p2.width + gap).toBe(1000);

    // Vertical gap between p2 and p3
    expect(p3.top - (p2.top + p2.height)).toBe(gap);
    // Top and bottom margins
    expect(p2.top).toBe(gap);
    expect(p3.top + p3.height + gap).toBe(800);

    // Verify sashes are generated
    expect(result.sashes.length).toBe(2);
    const verticalSash = result.sashes.find((s) => s.dir === "right")!;
    const horizontalSash = result.sashes.find((s) => s.dir === "down")!;
    expect(verticalSash).toBeDefined();
    expect(horizontalSash).toBeDefined();
  });
});
