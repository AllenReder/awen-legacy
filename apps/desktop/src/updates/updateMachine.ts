import type { DesktopRuntimeInfo, DesktopUpdateChannel, DesktopUpdateState } from "@awen/contracts";

export function createInitialDesktopUpdateState(
  currentVersion: string,
  runtimeInfo: DesktopRuntimeInfo,
  channel: DesktopUpdateChannel,
): DesktopUpdateState {
  return {
    enabled: false,
    status: "disabled",
    channel,
    currentVersion,
    hostArch: runtimeInfo.hostArch,
    appArch: runtimeInfo.appArch,
    runningUnderArm64Translation: runtimeInfo.runningUnderArm64Translation,
    availableVersion: null,
    releaseUrl: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}
