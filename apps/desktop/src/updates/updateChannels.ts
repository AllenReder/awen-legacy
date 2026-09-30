import type { DesktopUpdateChannel } from "@awen/contracts";

export function resolveDefaultDesktopUpdateChannel(appVersion: string): DesktopUpdateChannel {
  return appVersion.includes("-") ? "prerelease" : "stable";
}
