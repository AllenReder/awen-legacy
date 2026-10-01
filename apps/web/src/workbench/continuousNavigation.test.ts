import { describe, expect, it } from "vite-plus/test";
import {
  createContinuousNavigation,
  type NavigationPreview,
  type NavigationInput,
} from "./continuousNavigation";

function fixture(source: NavigationInput["source"] = "right-drag", limits = [200, 300, 0]) {
  const offsets = limits.map(() => 0);
  let active = "0";
  let preview: NavigationPreview | null = null;
  let id = 1;
  const navigation = createContinuousNavigation({
    tabs: () => limits.map((_, index) => String(index)),
    activeTab: () => active,
    width: () => 100,
    viewport(tab) {
      const index = Number(tab);
      return {
        maxScrollLeft: limits[index]!,
        get scrollLeft() {
          return offsets[index]!;
        },
        setScrollLeft(value) {
          offsets[index] = value;
        },
      };
    },
    preview: () => preview,
    beginPreview(value) {
      preview = value;
    },
    present(progress) {
      preview = { ...preview!, progress };
    },
    arrive(tab) {
      active = tab;
      preview = null;
    },
    cancelPreview(tab) {
      active = tab;
      preview = null;
    },
    settle(commit) {
      if (commit) active = preview!.toTabId;
      preview = null;
    },
    hold() {},
  });
  const send = (phase: NavigationInput["phase"], deltaX = 0, time = 0, gestureId = id) =>
    navigation.dispatch({ phase, deltaX, time, gestureId, source });
  send("begin");
  return {
    send,
    offsets,
    active: () => active,
    preview: () => preview,
    next() {
      send("begin", 0, 200, ++id);
    },
  };
}

describe("continuous Workbench navigation", () => {
  it.each(["trackpad", "right-drag"] as const)(
    "%s spends remaining travel on the incoming layout",
    (source) => {
      const f = fixture(source);
      f.send("update", 450, 20);
      expect(f.active()).toBe("1");
      expect(f.offsets).toEqual([200, 150, 0]);
      expect(f.preview()).toBeNull();
    },
  );
  it("traverses multiple layouts and BSP Tabs without losing distance", () => {
    const f = fixture();
    f.send("update", 750, 20);
    expect(f.active()).toBe("2");
    expect(f.offsets).toEqual([0, 300, 0]);
    expect(f.preview()).toMatchObject({ fromTabId: "2", toTabId: "0", progress: 0.5 });
  });
  it("reverses through the incoming layout and returns at the correct edge", () => {
    const f = fixture();
    f.send("update", 450, 20);
    f.send("update", -300, 40);
    expect(f.active()).toBe("0");
    expect(f.offsets[0]).toBe(150);
  });
  it("restores a cancelled incoming preview's previous scroll position", () => {
    const f = fixture();
    f.offsets[1] = 170;
    f.send("update", 225, 20);
    f.send("cancel");
    expect(f.active()).toBe("0");
    expect(f.offsets[1]).toBe(170);
    expect(f.preview()).toBeNull();
  });
  it("keeps the completed checkpoint when the final crossing is cancelled", () => {
    const f = fixture();
    f.send("update", 650, 20);
    f.send("cancel");
    expect(f.active()).toBe("1");
    expect(f.offsets[1]).toBe(300);
  });
  it("adds resistance only to trackpad crossings, never pointer travel", () => {
    const pointer = fixture("right-drag", [0, 0]);
    const trackpad = fixture("trackpad", [0, 0]);
    pointer.send("update", 25, 20);
    trackpad.send("update", 25, 20);
    expect(pointer.preview()?.progress).toBe(0.25);
    expect(trackpad.preview()?.progress).toBeCloseTo(0.25 - 0.2 / (2 * Math.PI));
  });
  it("does not cross a Tab boundary with layout momentum", () => {
    const f = fixture("trackpad");
    f.send("update", 150, 20);
    f.send("end", 0, 120);
    f.send("momentum", 1000, 130);
    expect(f.active()).toBe("0");
    expect(f.offsets[0]).toBe(200);
    expect(f.preview()).toBeNull();
  });
  it("absorbs momentum after releasing a Tab crossing", () => {
    const f = fixture("trackpad");
    f.send("update", 275, 20);
    f.send("end", 0, 120);
    f.send("momentum", 1000, 130);
    expect(f.active()).toBe("1");
    expect(f.offsets[1]).toBe(0);
  });
  it("ignores old end and momentum packets after a new gesture", () => {
    const f = fixture("trackpad");
    f.send("update", 100, 20);
    f.send("end", 0, 120);
    f.next();
    f.send("update", 20, 220);
    f.send("end", 0, 230, 1);
    f.send("momentum", 1000, 240, 1);
    expect(f.offsets[0]).toBe(120);
  });
  it("pans a single Tab without a self transition", () => {
    const f = fixture("right-drag", [200]);
    f.send("update", 500, 20);
    expect(f.offsets[0]).toBe(200);
    expect(f.preview()).toBeNull();
  });
  it("returns a paused short preview and commits a quick directional flick", () => {
    const slow = fixture("right-drag", [0, 0]);
    slow.send("update", 20, 20);
    slow.send("end", 0, 120);
    expect(slow.active()).toBe("0");
    const fast = fixture("right-drag", [0, 0]);
    fast.send("update", 20, 20);
    fast.send("end", 0, 21);
    expect(fast.active()).toBe("1");
  });
  it.each(["trackpad", "right-drag"] as const)(
    "%s lets a reverse flick override halfway in either direction",
    (source) => {
      for (const dir of [-1, 1]) {
        const f = fixture(source, [0, 0]);
        f.send("update", 75 * dir, 20);
        f.send("update", -10 * dir, 120);
        f.send("update", -5 * dir, 130);
        expect(f.preview()!.progress).toBeGreaterThan(0.5);
        f.send("end", 0, 130);
        expect(f.active()).toBe("0");
      }
    },
  );
  it("uses distance after a reverse flick has paused", () => {
    const f = fixture("right-drag", [0, 0]);
    f.send("update", 75, 20);
    f.send("update", -10, 120);
    f.send("update", -5, 130);
    f.send("end", 0, 230);
    expect(f.active()).toBe("1");
  });
});
