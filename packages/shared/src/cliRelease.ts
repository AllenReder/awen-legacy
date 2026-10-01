/** Shared naming and release lookup for the published Linux x64 daemon runtime. */

export const RELEASE_REPOSITORY = "AllenReder/awen";
export const CLI_RELEASE_CHECKSUMS_FILE = "SHA256SUMS";
export const CLI_RELEASE_BASE_URL_ENV = "AWEN_SERVER_RELEASE_BASE_URL";

export const CLI_ARCHIVE_PLATFORM_KEYS = ["linux-x64"] as const;
export type CliArchivePlatformKey = (typeof CLI_ARCHIVE_PLATFORM_KEYS)[number];

export function cliArchivePlatformKey(
  platform: NodeJS.Platform,
  arch: string,
): CliArchivePlatformKey | undefined {
  return platform === "linux" && arch === "x64" ? "linux-x64" : undefined;
}

export function cliArchiveTarCommand(
  _platform: NodeJS.Platform,
  _env: Readonly<Record<string, string | undefined>>,
): string {
  return "tar";
}

export function cliArchiveFileName(version: string, _platformKey: CliArchivePlatformKey): string {
  return `awen-server-${version}-linux-x64.tar.gz`;
}

const RELEASE_DEFAULT_BASE_URL = `https://github.com/${RELEASE_REPOSITORY}/releases/download`;
const SEMVER_CORE = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const RELEASE_TAG_VERSION = new RegExp(
  `^v(${SEMVER_CORE}\\.${SEMVER_CORE}\\.${SEMVER_CORE}(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?)$`,
  "u",
);

export function parseReleaseTagVersion(tag: string): string | undefined {
  return RELEASE_TAG_VERSION.exec(tag)?.[1];
}

export function cliReleaseDownloadBaseUrl(
  version: string,
  baseUrl: string | undefined = RELEASE_DEFAULT_BASE_URL,
): string {
  return `${(baseUrl?.trim() || RELEASE_DEFAULT_BASE_URL).replace(/\/+$/, "")}/v${version}`;
}

export type CliReleaseChannel = "stable" | "prerelease";
export const CLI_RELEASE_CHANNELS: ReadonlyArray<CliReleaseChannel> = ["stable", "prerelease"];

export function cliReleaseChannelOf(version: string): CliReleaseChannel {
  return version.includes("-") ? "prerelease" : "stable";
}

export function cliReleaseIndexPageUrl(page: number): string {
  return `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases?per_page=100&page=${page}`;
}

export function newestCliReleaseVersion(
  releases: ReadonlyArray<{
    readonly tag_name: string;
    readonly draft?: boolean | undefined;
  }>,
  channel: CliReleaseChannel,
): string | undefined {
  for (const release of releases) {
    if (release.draft) continue;
    const version = RELEASE_TAG_VERSION.exec(release.tag_name)?.[1];
    if (version !== undefined && cliReleaseChannelOf(version) === channel) return version;
  }
  return undefined;
}

export function parseChecksums(text: string): ReadonlyMap<string, string> {
  const checksums = new Map<string, string>();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(\S.*)$/u.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      checksums.set(match[2], match[1].toLowerCase());
    }
  }
  return checksums;
}
