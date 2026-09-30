// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import { PRIMARY_INSTANCE_ID, type DesktopBackendStartConfig } from "./DesktopBackendManager.ts";
import { make } from "./DesktopManagedBackend.ts";

const launcher = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock("../../../server/src/localDaemon.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../server/src/localDaemon.ts")>()),
  startLocalDaemon: launcher.start,
  stopLocalDaemon: launcher.stop,
}));

const fixture = Effect.gen(function* () {
  const root = yield* Effect.promise(() =>
    NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "awen-managed-backend-test-")),
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => NodeFSP.rm(root, { force: true, recursive: true })),
  );
  yield* Effect.promise(async () => {
    await NodeFSP.mkdir(NodePath.join(root, "userdata/secrets"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(root, "userdata/secrets/desktop-bootstrap.token"),
      "test-credential",
    );
  });
  launcher.start
    .mockReset()
    .mockResolvedValue({ pid: 123, origin: "http://127.0.0.1:3773/", daemonId: "test-daemon" });
  launcher.stop.mockReset().mockResolvedValue({ stopped: true });
  let healthy = true;
  const events: string[] = [];
  const recovered = yield* Deferred.make<void>();
  const config: DesktopBackendStartConfig = {
    executablePath: "/node",
    entryPath: "/server/bin.mjs",
    cwd: root,
    args: [],
    env: {},
    bootstrap: {
      mode: "desktop",
      noBrowser: true,
      port: 3773,
      awenHome: root,
      host: "127.0.0.1",
      desktopBootstrapToken: "test-credential",
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    },
    bootstrapDelivery: "fd3",
    extendEnv: true,
    httpBaseUrl: new URL("http://127.0.0.1:3773/"),
    captureOutput: true,
    preflightFailure: Option.none(),
  };
  const layer = Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, {
      baseDir: root,
      backendNodePath: "/node",
      backendEntryPath: "/server/bin.mjs",
      backendCwd: root,
      appVersion: "1.0.0",
    } as DesktopEnvironment.DesktopEnvironment["Service"]),
    Layer.mock(DesktopServerExposure.DesktopServerExposure, {
      configureFromSettings: () => Effect.succeed({} as never),
    }),
    DesktopWslEnvironment.layerTest(),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                protocolVersion: 1,
                owner: "awen-local-daemon",
                daemonId: "test-daemon",
                pid: healthy ? 123 : 456,
                managed: true,
              }),
              { status: healthy ? 200 : 503, headers: { "content-type": "application/json" } },
            ),
          ),
        ),
      ),
    ),
  );
  const instance = yield* make({
    id: PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Local"),
    configResolve: Effect.succeed(config),
    onReady: () =>
      Effect.gen(function* () {
        events.push("ready");
        if (events.filter((event) => event === "ready").length > 1)
          yield* Deferred.succeed(recovered, undefined);
      }),
    onShutdown: () =>
      Effect.sync(() => {
        events.push("shutdown");
      }),
  }).pipe(Effect.provide(layer));
  return {
    instance,
    events,
    recovered,
    setHealthy: (value: boolean) => {
      healthy = value;
    },
  };
});

describe("managed desktop daemon supervision", () => {
  it.effect("marks a lost daemon unavailable and reconnects after a backoff", () =>
    Effect.gen(function* () {
      const { instance, events, recovered, setHealthy } = yield* fixture;
      yield* instance.start;
      setHealthy(false);
      yield* TestClock.adjust(Duration.seconds(1));
      assert.isFalse((yield* instance.snapshot).ready);
      assert.deepEqual(events, ["ready", "shutdown"]);
      const waiting = yield* instance.waitForReady(Duration.millis(200)).pipe(Effect.forkScoped);
      yield* TestClock.adjust(Duration.millis(200));
      assert.isFalse(yield* Fiber.join(waiting));
      setHealthy(true);
      yield* TestClock.adjust(Duration.millis(300));
      yield* Deferred.await(recovered);
      assert.isTrue((yield* instance.snapshot).ready);
      assert.equal(launcher.start.mock.calls.length, 2);
      assert.deepEqual(events, ["ready", "shutdown", "ready"]);
    }),
  );

  it.effect("keeps retrying launch failures and cancels recovery on explicit stop", () =>
    Effect.gen(function* () {
      const { instance, setHealthy } = yield* fixture;
      yield* instance.start;
      launcher.start.mockRejectedValue(new Error("backend unavailable"));
      setHealthy(false);
      yield* TestClock.adjust(Duration.millis(1500));
      assert.isFalse((yield* instance.snapshot).ready);
      assert.isAtLeast((yield* instance.snapshot).restartAttempt, 1);
      yield* instance.stop();
      const attempts = launcher.start.mock.calls.length;
      yield* TestClock.adjust(Duration.seconds(30));
      assert.equal(launcher.start.mock.calls.length, attempts);
      assert.isFalse((yield* instance.snapshot).desiredRunning);
      assert.isFalse(yield* instance.waitForReady(Duration.seconds(1)));
    }),
  );

  it.effect("ends supervision at app shutdown without stopping the detached daemon", () =>
    Effect.gen(function* () {
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { instance } = yield* fixture;
          yield* instance.start;
        }),
      );
      const attempts = launcher.start.mock.calls.length;
      yield* TestClock.adjust(Duration.seconds(30));
      assert.equal(launcher.start.mock.calls.length, attempts);
      assert.equal(launcher.stop.mock.calls.length, 0);
    }),
  );
});
