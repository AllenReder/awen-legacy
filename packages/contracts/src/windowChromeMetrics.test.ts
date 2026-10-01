import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { WindowChromeMetricsSchema } from "./ipc.ts";

const decode = Schema.decodeUnknownSync(WindowChromeMetricsSchema);
describe("window chrome metrics", () => {
  it("accepts finite positive zoom and fullscreen", () => {
    expect(decode({ zoomFactor: 1.25, fullscreen: true })).toEqual({
      zoomFactor: 1.25,
      fullscreen: true,
    });
  });
  it.each([0, -1, NaN, Infinity, "1.25"])("rejects invalid zoom %s", (zoomFactor) => {
    expect(() => decode({ zoomFactor, fullscreen: false })).toThrow();
  });
  it("rejects non-boolean fullscreen", () => {
    expect(() => decode({ zoomFactor: 1, fullscreen: "false" })).toThrow();
  });
});
