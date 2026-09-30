import type { DesktopUpdateChannel } from "@awen/contracts";

// Preview builds are the maintainers' test train, cut by hand from unreleased
// branches to exercise the release flow. They share nightly's branding but
// are packaged without an update feed (see
// isDesktopPreviewVersion in scripts/build-desktop-artifact.ts), so the
// channel a preview install reports is cosmetic: it never checks for updates
// and no updater feed ever lists a preview release.
const PRERELEASE_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function isNightlyDesktopVersion(version: string): boolean {
  return PRERELEASE_VERSION_PATTERN.test(version);
}

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return /^[^-+]+-(?:alpha|beta|nightly)(?:\.|$)/.test(appVersion) ? "prerelease" : "stable";
}

/** UI labels differ from electron-updater's GitHub release channels. */
export function resolveElectronUpdaterChannel(
  channel: DesktopUpdateChannel,
  appVersion: string,
): string {
  if (channel === "stable") return "latest";
  return /^[^-+]+-(alpha|beta|nightly)(?:\.|$)/.exec(appVersion)?.[1] ?? "alpha";
}
