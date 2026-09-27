import { describe, expect, it } from "vite-plus/test";

import { holdTabEntry, type TabEntry } from "./scrollingAnimation";

const at = (dir: -1 | 1, focusedPaneId: string, settledAt: number): TabEntry => ({
  dir,
  focusedPaneId,
  settledAt,
});

describe("holdTabEntry", () => {
  it("records the direction an incoming Tab was entered from", () => {
    expect(holdTabEntry(null, 1, "p1", 0)).toEqual({ dir: 1, focusedPaneId: "p1", settledAt: 0 });
    expect(holdTabEntry(null, -1, "p1", 400)).toEqual({
      dir: -1,
      focusedPaneId: "p1",
      settledAt: 400,
    });
  });

  it("keeps the entry through the commits that follow activation", () => {
    // A Tab gains its real size and may change Columns right after activating;
    // reveal re-runs each time and must still see the entry.
    const entered = holdTabEntry(null, -1, "p1", 0);
    expect(holdTabEntry(entered, undefined, "p1", 0)).toEqual({
      dir: -1,
      focusedPaneId: "p1",
      settledAt: 0,
    });
  });

  it("has no entry for a Tab that was never entered", () => {
    expect(holdTabEntry(null, undefined, "p1", 0)).toBeNull();
  });

  it("yields once the user scrolls the Viewport away", () => {
    // The entry left the Viewport at 0; the user has since scrolled to 180.
    // Holding on would write the edge back over the user's own scroll.
    expect(holdTabEntry(at(1, "p1", 0), undefined, "p1", 180)).toBeNull();
  });

  it("tolerates sub-pixel drift", () => {
    expect(holdTabEntry(at(1, "p1", 100), undefined, "p1", 100.4)).not.toBeNull();
  });

  it("yields when the user focuses another Pane", () => {
    expect(holdTabEntry(at(1, "p1", 0), undefined, "p2", 0)).toBeNull();
  });

  it("lets a new entry supersede the old one", () => {
    expect(holdTabEntry(at(1, "p1", 0), -1, "p2", 0)).toEqual({
      dir: -1,
      focusedPaneId: "p2",
      settledAt: 0,
    });
  });
});
