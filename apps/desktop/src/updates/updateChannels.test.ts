import { describe, expect, it } from "vite-plus/test";

import {
  isNightlyDesktopVersion,
  resolveDefaultDesktopUpdateChannel,
  resolveElectronUpdaterChannel,
} from "./updateChannels.ts";

describe("updateChannels", () => {
  it("maps UI channels to GitHub updater channels and follows alpha updates by default", () => {
    expect(resolveDefaultDesktopUpdateChannel("0.1.0-alpha.3")).toBe("prerelease");
    expect(resolveDefaultDesktopUpdateChannel("0.1.0-beta.1")).toBe("prerelease");
    expect(resolveDefaultDesktopUpdateChannel("0.1.0")).toBe("stable");
    expect(resolveElectronUpdaterChannel("stable", "0.1.0-alpha.3")).toBe("latest");
    expect(resolveElectronUpdaterChannel("prerelease", "0.1.0-alpha.3")).toBe("alpha");
    expect(resolveElectronUpdaterChannel("prerelease", "0.1.0")).toBe("alpha");
    expect(resolveElectronUpdaterChannel("prerelease", "0.1.0-nightly.20260930.1")).toBe("nightly");
  });
  it("keeps preview builds branded as nightly but on the latest update channel", () => {
    expect(isNightlyDesktopVersion("0.0.41-preview.20260911.7")).toBe(true);
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-preview.20260911.7")).toBe("stable");
    expect(resolveDefaultDesktopUpdateChannel("0.0.41-nightly.20260911.7")).toBe("prerelease");
  });

  it("only matches the first prerelease identifier", () => {
    expect(isNightlyDesktopVersion("1.2.3-foo-preview.20260911.1")).toBe(false);
    expect(isNightlyDesktopVersion("1.2.3")).toBe(false);
  });
});
