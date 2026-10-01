import type { DesktopUpdateState } from "@awen/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleSidebarUpdateReleaseNotesPopoverOpenChange,
  openSidebarUpdateReleaseNotesPopoverOnForwardTab,
  shouldUseSidebarUpdateReleaseNotesPopover,
} from "./SidebarUpdatePill";

const prereleaseState: DesktopUpdateState = {
  enabled: true,
  status: "available",
  channel: "prerelease",
  currentVersion: "0.0.35",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "0.1.0-alpha.1",
  releaseUrl: null,
  releaseNotes: [{ version: "0.1.0-alpha.1", items: ["Newest change"], totalItems: 1 }],
  omittedReleaseCount: 0,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("sidebar update release notes popover", () => {
  it("uses the popover only for visible prerelease release notes", () => {
    expect(shouldUseSidebarUpdateReleaseNotesPopover(true, prereleaseState)).toBe(true);
    expect(shouldUseSidebarUpdateReleaseNotesPopover(false, prereleaseState)).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...prereleaseState,
        channel: "stable",
      }),
    ).toBe(false);
    expect(
      shouldUseSidebarUpdateReleaseNotesPopover(true, {
        ...prereleaseState,
        releaseNotes: [],
      }),
    ).toBe(false);
  });

  it("cancels trigger presses without canceling other open reasons", () => {
    const cancelTriggerPress = vi.fn();
    const cancelHover = vi.fn();

    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-press",
      cancel: cancelTriggerPress,
    });
    handleSidebarUpdateReleaseNotesPopoverOpenChange(true, {
      reason: "trigger-hover",
      cancel: cancelHover,
    });

    expect(cancelTriggerPress).toHaveBeenCalledOnce();
    expect(cancelHover).not.toHaveBeenCalled();
  });

  it("promotes forward Tab without preventing native navigation", () => {
    const open = vi.fn();
    const preventDefault = vi.fn();
    const event = { key: "Tab", shiftKey: false, preventDefault };

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(event, { open }, "prerelease-release-notes");

    expect(open).toHaveBeenCalledWith("prerelease-release-notes");
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("does not promote backward Tab", () => {
    const open = vi.fn();

    openSidebarUpdateReleaseNotesPopoverOnForwardTab(
      { key: "Tab", shiftKey: true },
      { open },
      "prerelease-release-notes",
    );

    expect(open).not.toHaveBeenCalled();
  });
});
