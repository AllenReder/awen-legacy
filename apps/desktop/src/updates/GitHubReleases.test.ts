import { assert, describe, it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { checkGitHubRelease, selectNewestRelease } from "./GitHubReleases.ts";

const release = (version: string, draft = false) => ({
  tag_name: `v${version}`,
  draft,
  body: "Changes",
});

describe("manual desktop release checks", () => {
  it("compares alpha numbers, rather than publication order or strings", () => {
    const releases = [
      release("0.1.0-alpha.9"),
      release("0.1.0-alpha.10"),
      release("0.1.0-alpha.11", true),
      release("0.1.0"),
    ];
    assert.equal(
      selectNewestRelease(releases, "prerelease", "0.1.0-alpha.3")?.version,
      "0.1.0-alpha.10",
    );
    assert.equal(selectNewestRelease(releases, "stable", "0.0.9")?.version, "0.1.0");
    assert.equal(selectNewestRelease(releases, "prerelease", "0.1.0-alpha.10"), null);
    assert.equal(
      selectNewestRelease(
        [{ tag_name: "vbroken" }, release("0.1.0-alpha.2")],
        "prerelease",
        "0.1.0-alpha.3",
      ),
      null,
    );
  });

  it.effect(
    "reads published releases without credentials and returns the exact Release page",
    () => {
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        assert.equal(request.headers.authorization, undefined);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json([release("0.1.0-alpha.4")])),
        );
      });
      return checkGitHubRelease("prerelease", "0.1.0-alpha.3").pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            assert.equal(
              result?.releaseUrl,
              "https://github.com/AllenReder/awen/releases/tag/v0.1.0-alpha.4",
            );
            assert.equal(requests.length, 1);
            assert.include(requests[0]!, "/releases?per_page=100&page=1");
          }),
        ),
        Effect.provideService(HttpClient.HttpClient, client),
      );
    },
  );

  it.effect("does not treat rate limiting as being up to date", () =>
    checkGitHubRelease("prerelease", "0.1.0-alpha.3").pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => assert.include(error.message, "Could not check Awen releases")),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("limited", { status: 403 })),
          ),
        ),
      ),
    ),
  );

  it.effect("rejects malformed release responses", () =>
    checkGitHubRelease("prerelease", "0.1.0-alpha.3").pipe(
      Effect.flip,
      Effect.tap((error) =>
        Effect.sync(() => assert.include(error.message, "Could not check Awen releases")),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ unexpected: true }))),
        ),
      ),
    ),
  );
  it.effect("times out stalled HTTP requests", () =>
    Effect.gen(function* () {
      const fiber = yield* checkGitHubRelease("prerelease", "0.1.0-alpha.3").pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.never),
        ),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "GitHubReleaseCheckError");
    }),
  );
});
