import type { DesktopUpdateChannel } from "@awen/contracts";
import {
  cliReleaseIndexPageUrl,
  parseReleaseTagVersion,
  RELEASE_REPOSITORY,
} from "@awen/shared/cliRelease";
import { compareSemverVersions } from "@awen/shared/semver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

const ReleaseIndex = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    draft: Schema.optional(Schema.Boolean),
    body: Schema.optional(Schema.NullOr(Schema.String)),
  }),
);
type Release = (typeof ReleaseIndex.Type)[number];
export interface AvailableRelease {
  readonly version: string;
  readonly releaseUrl: string;
  readonly body: string;
}

export function selectNewestRelease(
  releases: ReadonlyArray<Release>,
  channel: DesktopUpdateChannel,
  currentVersion: string,
): AvailableRelease | null {
  let newest: AvailableRelease | null = null;
  for (const release of releases) {
    const version = parseReleaseTagVersion(release.tag_name);
    if (
      release.draft ||
      version === undefined ||
      (version.includes("-") ? "prerelease" : "stable") !== channel ||
      compareSemverVersions(version, currentVersion) <= 0
    )
      continue;
    if (newest === null || compareSemverVersions(version, newest.version) > 0) {
      newest = {
        version,
        releaseUrl: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`,
        body: release.body ?? "",
      };
    }
  }
  return newest;
}

export class GitHubReleaseCheckError extends Schema.TaggedError<GitHubReleaseCheckError>()(
  "GitHubReleaseCheckError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not check Awen releases. Please try again later.";
  }
}

/** Read public metadata only. No access token or update asset download is needed. */
export const checkGitHubRelease = Effect.fn("desktop.releases.check")(
  function* (channel: DesktopUpdateChannel, currentVersion: string) {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const releases: Release[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = yield* client.execute(
        HttpClientRequest.get(cliReleaseIndexPageUrl(page)).pipe(
          HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
        ),
      );
      const batch = yield* response.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ReleaseIndex)),
      );
      releases.push(...batch);
      if (batch.length < 100) return selectNewestRelease(releases, channel, currentVersion);
    }
    // A truncated list cannot prove that the app is current.
    return yield* new GitHubReleaseCheckError({
      cause: "The release index exceeded the lookup limit.",
    });
  },
  Effect.timeout("10 seconds"),
  Effect.mapError((cause) => new GitHubReleaseCheckError({ cause })),
);
