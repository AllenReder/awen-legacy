import { describe, expect, it } from "vite-plus/test";
import { resolveDefaultDesktopUpdateChannel } from "./updateChannels.ts";
describe("release channels", () => {
  it("checks prereleases by default only for prerelease app versions", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.1.0-alpha.3")).toBe("prerelease");
    expect(resolveDefaultDesktopUpdateChannel("0.1.0-beta.1")).toBe("prerelease");
    expect(resolveDefaultDesktopUpdateChannel("0.1.0")).toBe("stable");
  });
});
