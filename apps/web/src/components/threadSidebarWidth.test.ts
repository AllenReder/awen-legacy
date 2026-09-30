import { describe, expect, it } from "vite-plus/test";
import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
} from "./threadSidebarWidth";

describe("threadSidebarWidth", () => {
  it.each([76, 140, 159])(
    "clamps a stale stored width against the current %s minimum",
    (minimum) => {
      expect(resolveInitialThreadSidebarWidth(10, 1200, minimum)).toBe(minimum);
    },
  );
  it("uses the default only when there is no saved preference", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1200, 140)).toBe(256);
    expect(resolveInitialThreadSidebarWidth(280, 1200, 140)).toBe(280);
  });
  it("clamps to available space while preserving the requested minimum", () => {
    expect(resolveThreadSidebarMaximumWidth(1000, 140)).toBe(360);
    expect(resolveInitialThreadSidebarWidth(500, 1000, 140)).toBe(360);
    expect(resolveInitialThreadSidebarWidth(280, 700, 140)).toBe(140);
  });
  it("can restore the same preference after a temporary geometry clamp", () => {
    expect(resolveInitialThreadSidebarWidth(80, 1200, 140)).toBe(140);
    expect(resolveInitialThreadSidebarWidth(80, 1200, 76)).toBe(80);
    expect(resolveInitialThreadSidebarWidth(280, 800, 76)).toBe(160);
    expect(resolveInitialThreadSidebarWidth(280, 1200, 76)).toBe(280);
  });
});
