import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";

const make = (client: HttpClient.HttpClient, enabled = true) =>
  DesktopUpdates.make.pipe(
    Effect.provide(DesktopConfig.layerTest({})),
    Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
      isPackaged: enabled,
      isDevelopment: false,
      appVersion: "0.1.0-alpha.3",
      runtimeInfo: { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Effect.provideService(DesktopAppSettings.DesktopAppSettings, {
      get: Effect.succeed({
        ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
        updateChannel: "prerelease",
      }),
      setUpdateChannel: () =>
        Effect.succeed({ settings: DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS, changed: true }),
    } as unknown as DesktopAppSettings.DesktopAppSettings["Service"]),
    Effect.provideService(ElectronWindow.ElectronWindow, {
      sendAll: () => Effect.void,
    } as unknown as ElectronWindow.ElectronWindow["Service"]),
    Effect.provideService(HttpClient.HttpClient, client),
  );

describe("desktop manual version checks", () => {
  it.effect("coalesces concurrent checks and blocks channel changes until they finish", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let count = 0;
      const service = yield* make(
        HttpClient.make((request) =>
          Effect.gen(function* () {
            count += 1;
            yield* Deferred.succeed(entered, undefined);
            yield* Deferred.await(release);
            return HttpClientResponse.fromWeb(
              request,
              Response.json([{ tag_name: "v0.1.0-alpha.4", body: "- New version" }]),
            );
          }),
        ),
      );
      const first = yield* service.check("manual").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      const second = yield* service.check("menu").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.equal(
        (yield* service.setChannel("stable").pipe(Effect.flip))._tag,
        "DesktopUpdateActionInProgressError",
      );
      yield* Deferred.succeed(release, undefined);
      const a = yield* Fiber.join(first);
      assert.deepEqual(yield* Fiber.join(second), a);
      assert.equal(count, 1);
      assert.equal(a.state.status, "available");
      assert.equal(
        a.state.releaseUrl,
        "https://github.com/AllenReder/awen/releases/tag/v0.1.0-alpha.4",
      );
      assert.isFalse(yield* service.isActionActive);
    }),
  );
  it.effect("does not contact GitHub for development builds", () =>
    Effect.gen(function* () {
      const service = yield* make(
        HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        false,
      );
      assert.isFalse((yield* service.check("manual")).checked);
      assert.equal((yield* service.getState).status, "disabled");
    }),
  );
  it.effect("exposes retryable HTTP errors without claiming the app is current", () =>
    Effect.gen(function* () {
      const service = yield* make(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("limited", { status: 403 })),
          ),
        ),
      );
      const result = yield* service.check("manual");
      assert.isFalse(result.checked);
      assert.equal(result.state.status, "error");
      assert.isTrue(result.state.canRetry);
    }),
  );
  it.effect("releases cancelled checks and lets a later check run", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      let requests = 0;
      const service = yield* make(
        HttpClient.make((request) =>
          Effect.gen(function* () {
            requests += 1;
            if (requests === 1) {
              yield* Deferred.succeed(entered, undefined);
              return yield* Effect.never;
            }
            return HttpClientResponse.fromWeb(request, Response.json([]));
          }),
        ),
      );
      const first = yield* service.check("manual").pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(first);
      assert.isFalse(yield* service.isActionActive);
      assert.equal((yield* service.getState).status, "idle");
      assert.isTrue((yield* service.check("retry")).checked);
      assert.equal(requests, 2);
    }),
  );
});
