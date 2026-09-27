import { describe, expect, it } from "vite-plus/test";

import { resolveSourcemapMode } from "./sourcemap-mode.ts";

describe("resolveSourcemapMode", () => {
  it("ships no source map from a production build unless one is requested", () => {
    for (const unset of [undefined, "", "  ", "yes", "hidden-ish"]) {
      expect(resolveSourcemapMode(unset)).toEqual({ build: false, cssDev: true });
    }
  });

  it("carries the full source map only when explicitly requested", () => {
    for (const requested of ["1", "true", "TRUE", " true "]) {
      expect(resolveSourcemapMode(requested)).toEqual({ build: true, cssDev: true });
    }
  });

  it("emits an unreferenced map when explicitly requested", () => {
    expect(resolveSourcemapMode("hidden")).toEqual({ build: "hidden", cssDev: true });
  });

  it("turns both the build map and the dev CSS map off when explicitly disabled", () => {
    for (const disabled of ["0", "false", "FALSE", " false "]) {
      expect(resolveSourcemapMode(disabled)).toEqual({ build: false, cssDev: false });
    }
  });
});
