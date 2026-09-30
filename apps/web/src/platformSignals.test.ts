import { describe, expect, it } from "vite-plus/test";
import { isWindowsPlatform, resolveClientPlatform } from "./platformSignals";

describe("resolveClientPlatform", () => {
  it("uses a known desktop-bridge platform", () => {
    expect(resolveClientPlatform({ desktopPlatform: "darwin" })).toBe("darwin");
    expect(resolveClientPlatform({ desktopPlatform: "win32" })).toBe("win32");
    expect(resolveClientPlatform({ desktopPlatform: "linux" })).toBe("linux");
  });

  it("falls through the bridge sentinel to the browser signals", () => {
    // Electron's bridge reports "other" until its runtime config resolves (and
    // forever when that config fails). Treating it as a real platform would
    // skip the navigator fallback and leave Windows on the WebGL renderer.
    expect(
      resolveClientPlatform({
        desktopPlatform: "other",
        navigatorPlatform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      }),
    ).toBe("win32");
  });

  it("classifies a plain Windows browser from navigator signals", () => {
    expect(
      resolveClientPlatform({
        navigatorPlatform: "Win32",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      }),
    ).toBe("win32");
  });

  it("does not read macOS's Darwin as Windows", () => {
    // `/win/i` would match "Darwin"; the platform check is anchored.
    expect(resolveClientPlatform({ navigatorPlatform: "Darwin" })).toBe(null);
    expect(
      resolveClientPlatform({
        navigatorPlatform: "MacIntel",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      }),
    ).toBe("darwin");
  });

  it("leaves Linux and unknown hosts unclassified", () => {
    expect(
      resolveClientPlatform({
        navigatorPlatform: "Linux x86_64",
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      }),
    ).toBe(null);
    expect(resolveClientPlatform({})).toBe(null);
  });
});

describe("isWindowsPlatform", () => {
  it("is true only for Windows", () => {
    expect(isWindowsPlatform({ desktopPlatform: "win32" })).toBe(true);
    expect(isWindowsPlatform({ desktopPlatform: "darwin" })).toBe(false);
    expect(isWindowsPlatform({ navigatorPlatform: "Darwin", userAgent: "Macintosh" })).toBe(false);
  });
});
