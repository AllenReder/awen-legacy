import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@awen/contracts";
import {
  canCheckForUpdate,
  getArm64IntelBuildWarningDescription,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";
const state: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "prerelease",
  currentVersion: "0.1.0-alpha.3",
  hostArch: "arm64",
  appArch: "x64",
  runningUnderArm64Translation: true,
  availableVersion: null,
  releaseUrl: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};
describe("manual desktop update actions", () => {
  it("opens a Release only when a newer version and its page are available", () => {
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
    expect(resolveDesktopUpdateButtonAction({ ...state, status: "available" })).toBe("none");
    const available = {
      ...state,
      status: "available" as const,
      availableVersion: "0.1.0-alpha.4",
      releaseUrl: getDesktopUpdateReleaseUrl("0.1.0-alpha.4"),
    };
    expect(resolveDesktopUpdateButtonAction(available)).toBe("release");
    expect(getDesktopUpdateButtonTooltip(available)).toContain("install manually");
    expect(available.releaseUrl).toBe(
      "https://github.com/AllenReder/awen/releases/tag/v0.1.0-alpha.4",
    );
  });
  it("allows retries after errors but prevents simultaneous checks", () => {
    expect(canCheckForUpdate({ ...state, status: "error", canRetry: true })).toBe(true);
    expect(canCheckForUpdate({ ...state, status: "checking" })).toBe(false);
    expect(canCheckForUpdate({ ...state, enabled: false })).toBe(false);
    expect(canCheckForUpdate(null)).toBe(false);
  });
  it("directs Rosetta users to choose arm64 manually", () => {
    expect(getArm64IntelBuildWarningDescription(state)).toContain(
      "Choose the macOS arm64 installer",
    );
  });
});
