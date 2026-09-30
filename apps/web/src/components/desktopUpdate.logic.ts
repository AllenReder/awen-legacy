import type { DesktopUpdateState } from "@awen/contracts";

export type DesktopUpdateButtonAction = "release" | "none";

const DESKTOP_RELEASE_HISTORY_URL = "https://github.com/AllenReder/awen/releases";
const DESKTOP_RELEASE_TAG_URL = `${DESKTOP_RELEASE_HISTORY_URL}/tag`;

/** Release notes for an exact downloaded build; prerelease suffixes are part of the tag. */
export function getDesktopUpdateReleaseUrl(version: string | null): string | null {
  const normalizedVersion = version?.trim();
  if (!normalizedVersion) return null;
  return `${DESKTOP_RELEASE_TAG_URL}/v${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(): string {
  return DESKTOP_RELEASE_HISTORY_URL;
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  return state.status === "available" && state.releaseUrl ? "release" : "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "checking";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  return "This Mac has Apple Silicon, but Awen is running the Intel build under Rosetta. Choose the macOS arm64 installer on the Release page to install the native Apple Silicon build.";
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (state.status === "available")
    return `Open Release ${state.availableVersion ?? "page"} to download and install manually`;
  if (state.status === "checking") return "Checking for updates…";
  if (state.status === "error") return state.message ?? "Could not check for updates";
  return "Check for updates";
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return state.status !== "checking" && state.status !== "disabled";
}
