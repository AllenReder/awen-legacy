// @effect-diagnostics nodeBuiltinImport:off - builds real worktree layouts on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NetService from "@awen/shared/Net";
import { resolveDesktopDevPorts } from "@awen/shared/daemonPort";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@awen/shared/hostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  acknowledgeDevRunnerStop,
  devRunnerStopAckPath,
  devRunnerStopRequestPath,
  requestDevRunnerStop,
} from "./lib/dev-runner-stop.ts";
import {
  checkPortAvailabilityOnHosts,
  createDevRunnerEnv,
  devPortProbeHosts,
  findFirstAvailableOffset,
  getDevRunnerModeArgs,
  isBrowserAllowedPort,
  resolveDevHome,
  resolveModePortOffsets,
  resolveOffset,
  runDevRunnerWithInput,
} from "./dev-runner.ts";

const emptyConfigLayer = ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }));
const netServiceLayer = Layer.succeed(NetService.NetService, {
  canListenOnHost: () => Effect.succeed(true),
  isPortAvailableOnLoopback: () => Effect.succeed(true),
  hasListenerOnHost: () => Effect.succeed(false),
  reserveLoopbackPort: () => Effect.succeed(49_152),
  findAvailablePort: (port) => Effect.succeed(port),
});

function mockProcess(exit: number | PlatformError.PlatformError) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode:
      typeof exit === "number"
        ? Effect.succeed(ChildProcessSpawner.ExitCode(exit))
        : Effect.fail(exit),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockPendingProcess() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.never,
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const devServerInput = {
  mode: "dev:server",
  awenHome: "/tmp/awen-dev-runner",
  browser: undefined,
  autoBootstrapProjectFromCwd: undefined,
  logWebSocketEvents: undefined,
  host: undefined,
  port: 13_773,
  devUrl: undefined,
  dryRun: false,
  share: false,
  runArgs: ["--inspect", "secret-token-value"],
} as const;

it.layer(NodeServices.layer)("dev-runner", (it) => {
  it.effect("accepts a dry run without the optional browser flag", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const output = yield* spawner.string(
        ChildProcess.make(process.execPath, ["scripts/dev-runner.ts", "dev", "--dry-run"], {
          cwd: path.resolve(import.meta.dirname, ".."),
        }),
      );

      assert.include(output, "[dev-runner] mode=dev");
    }),
  );

  describe("getDevRunnerModeArgs", () => {
    it("starts all desktop watchers together", () => {
      assert.deepStrictEqual(getDevRunnerModeArgs("dev:desktop"), [
        "run",
        "--filter=@awen/desktop",
        "--filter=@awen/web",
        "--filter=@awen/server",
        "--parallel",
        "dev:desktop",
      ]);
    });
    it.effect("places Vite+ run flags before the task name", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(getDevRunnerModeArgs("dev"), [
          "run",
          "--filter=@awen/contracts",
          "--filter=@awen/web",
          "--filter=@awen/server",
          "--parallel",
          "dev",
        ]);
      }),
    );
  });

  describe("resolveOffset", () => {
    it.effect("uses explicit AWEN_PORT_OFFSET when provided", () =>
      Effect.gen(function* () {
        const result = yield* resolveOffset({ portOffset: 12, devInstance: undefined });
        assert.deepStrictEqual(result, {
          offset: 12,
          source: "AWEN_PORT_OFFSET=12",
        });
      }),
    );

    it.effect("hashes non-numeric instance values", () =>
      Effect.gen(function* () {
        const result = yield* resolveOffset({
          portOffset: undefined,
          devInstance: "feature-branch",
        });
        assert.ok(result.offset >= 1);
        assert.ok(result.offset <= 3000);
      }),
    );

    // The wrapper and the runner must resolve the same offset for one checkout,
    // or the desktop window and the web proxy address a port nothing serves
    // (issue #129).
    it.effect("agrees with the desktop wrapper on a checkout-derived offset", () =>
      Effect.gen(function* () {
        const byRunner = yield* resolveOffset({
          portOffset: undefined,
          devInstance: undefined,
          worktreePath: "/work/awen",
        });
        const desktop = resolveDesktopDevPorts({}, "/work/awen");
        assert.strictEqual(desktop._tag, "set");
        if (desktop._tag !== "set") return;
        assert.strictEqual(desktop.ports.offset, byRunner.offset);
        assert.ok(byRunner.offset >= 1);
        assert.ok(byRunner.offset <= 3000);
      }),
    );

    it.effect("returns structured context for a negative port offset", () =>
      Effect.gen(function* () {
        const error = yield* resolveOffset({ portOffset: -1, devInstance: undefined }).pipe(
          Effect.flip,
        );

        assert.equal(error._tag, "DevRunnerInvalidPortOffsetError");
        assert.equal(error.configKey, "AWEN_PORT_OFFSET");
        assert.equal(error.portOffset, -1);
        assert.equal(error.minimum, 0);
        assert.ok(!("cause" in error));
      }),
    );
  });

  describe("resolveDevHome", () => {
    it.effect("defaults to a checkout-local Awen directory", () =>
      Effect.sync(() => {
        assert.equal(
          resolveDevHome({
            checkoutRoot: "/work/awen",
            explicitHome: undefined,
            worktreeRoot: undefined,
            ambientHome: undefined,
          }),
          "/work/awen/.awen",
        );
      }),
    );

    it.effect("honors an explicit home before checkout defaults", () =>
      Effect.sync(() => {
        assert.equal(
          resolveDevHome({
            checkoutRoot: "/work/awen",
            explicitHome: " /tmp/awen-test ",
            worktreeRoot: "/work/awen/.worktree",
            ambientHome: "/Users/example/.awen",
          }),
          "/tmp/awen-test",
        );
      }),
    );
  });

  describe("createDevRunnerEnv", () => {
    it.effect("forwards the reusable auth token to web dev", () =>
      Effect.gen(function* () {
        const input = {
          baseEnv: { AWEN_DEV_AUTH_TOKEN: "reusable-dev-auth-token-that-is-long-enough" },
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        } as const;
        const web = yield* createDevRunnerEnv({ ...input, mode: "dev" });

        assert.equal(web.AWEN_DEV_AUTH_TOKEN, input.baseEnv.AWEN_DEV_AUTH_TOKEN);
      }),
    );
    it.effect("leaves the shared home implicit and disables browser auto-open", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_HOME, undefined);
        assert.equal(env.AWEN_NO_BROWSER, "1");
      }),
    );

    it.effect("allows browser auto-open to be explicitly enabled", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: true,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_NO_BROWSER, "0");
      }),
    );

    it.effect("requires the browser flag even when the environment enables auto-open", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { AWEN_NO_BROWSER: "0" },
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: false,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_NO_BROWSER, "1");
      }),
    );

    it.effect("supports explicit typed overrides", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          awenHome: "/tmp/custom-awen",
          browser: false,
          autoBootstrapProjectFromCwd: false,
          logWebSocketEvents: true,
          host: "0.0.0.0",
          port: 4222,
          devUrl: new URL("http://localhost:7331"),
        });

        assert.equal(env.AWEN_HOME, path.resolve("/tmp/custom-awen"));
        assert.equal(env.AWEN_PORT, "4222");
        assert.equal(env.VITE_HTTP_URL, "http://localhost:4222");
        assert.equal(env.VITE_WS_URL, "ws://localhost:4222");
        assert.equal(env.AWEN_NO_BROWSER, "1");
        assert.equal(env.AWEN_AUTO_BOOTSTRAP_PROJECT_FROM_CWD, "0");
        assert.equal(env.AWEN_LOG_WS_EVENTS, "1");
        assert.equal(env.AWEN_HOST, "0.0.0.0");
        assert.equal(env.VITE_DEV_SERVER_URL, "http://localhost:7331/");
      }),
    );

    it.effect("strips inherited service-launcher context", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            AWEN_SERVICE_LAUNCHER_CONTEXT: '{"childVersion":"9.9.9"}',
            AWEN_BOOT_SERVICE_UNIT: "awen.service",
          },
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_SERVICE_LAUNCHER_CONTEXT, undefined);
        assert.equal(env.AWEN_BOOT_SERVICE_UNIT, undefined);
      }),
    );

    it.effect("does not force websocket logging on in dev mode when unset", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            AWEN_LOG_WS_EVENTS: "keep-me-out",
          },
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_MODE, "web");
        assert.equal(env.AWEN_LOG_WS_EVENTS, undefined);
      }),
    );

    it.effect("forwards explicit websocket logging false without coercing it away", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {
            AWEN_LOG_WS_EVENTS: "1",
          },
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: false,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_LOG_WS_EVENTS, "0");
      }),
    );

    it.effect("uses custom awenHome when provided", () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          awenHome: "/tmp/my-awen",
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_HOME, path.resolve("/tmp/my-awen"));
      }),
    );

    it.effect("defaults dev server mode to the higher backend port range", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: {},
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_PORT, "13773");
        assert.equal(env.PORT, "5733");
      }),
    );

    // Browser dev is single-origin: Vite proxies the backend, and the client
    // resolves it from window.location.origin. Baking a localhost URL here is
    // what breaks sharing a dev server to another device.
    for (const mode of ["dev", "dev:web"] as const) {
      it.effect(`leaves the client backend URLs unset in ${mode} mode`, () =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: {
              VITE_HTTP_URL: "http://localhost:1234",
              VITE_WS_URL: "ws://localhost:1234",
            },
            serverOffset: 0,
            webOffset: 0,
            awenHome: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.VITE_HTTP_URL, undefined);
          assert.equal(env.VITE_WS_URL, undefined);
          assert.equal(env.AWEN_PORT, "13773");
          // Deleting the keys is not sufficient — vite.config.ts merges
          // `.env`/`.env.local` underneath this env and would revive them, so
          // the intent has to be stated positively.
          assert.equal(env.AWEN_SINGLE_ORIGIN_DEV, "1");
        }),
      );
    }

    it.effect("clears the single-origin marker in dev:server mode", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev:server",
          baseEnv: { AWEN_SINGLE_ORIGIN_DEV: "1" },
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_SINGLE_ORIGIN_DEV, undefined);
        assert.equal(env.VITE_HTTP_URL, "http://localhost:13773");
      }),
    );

    // HOST is Vite's bind address and gates the HMR pin in vite.config.ts. An
    // inherited one would survive into browser dev and point HMR at the wrong
    // interface — invisible over a shared origin, since the page still loads.
    for (const mode of ["dev", "dev:web"] as const) {
      it.effect(`drops an inherited HOST in ${mode} mode`, () =>
        Effect.gen(function* () {
          const env = yield* createDevRunnerEnv({
            mode,
            baseEnv: { HOST: "0.0.0.0" },
            serverOffset: 0,
            webOffset: 0,
            awenHome: undefined,
            browser: undefined,
            autoBootstrapProjectFromCwd: undefined,
            logWebSocketEvents: undefined,
            host: undefined,
            port: undefined,
            devUrl: undefined,
          });

          assert.equal(env.HOST, undefined);
        }),
      );
    }

    // --host configures the *backend* (AWEN_HOST). It must not become Vite's
    // bind address by way of an inherited HOST that happens to agree with it.
    it.effect("drops an inherited HOST even when --host is given", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { HOST: "0.0.0.0" },
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: "0.0.0.0",
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.HOST, undefined);
        assert.equal(env.AWEN_HOST, "0.0.0.0");
      }),
    );
  });

  describe("findFirstAvailableOffset", () => {
    it.effect("returns the starting offset when required ports are available", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 0);
      }),
    );

    it.effect("advances until all required ports are available", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733, 13774, 5734]);
        const offset = yield* findFirstAvailableOffset({
          startOffset: 0,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.equal(offset, 2);
      }),
    );

    it.effect("skips browser-blocked web ports before probing availability", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];
        const offset = yield* findFirstAvailableOffset({
          // 5733 + 833 = 6566, which browsers block as sane-port.
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: true,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.equal(offset, 834);
        assert.deepStrictEqual(probed, [
          { port: 14_607, role: "server" },
          { port: 6567, role: "web" },
        ]);
      }),
    );

    it.effect("does not reject a server-only offset because its unused web port is blocked", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 833,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 833);
      }),
    );

    it.effect("allows offsets where the non-required server port exceeds max", () =>
      Effect.gen(function* () {
        const offset = yield* findFirstAvailableOffset({
          startOffset: 59_802,
          requireServerPort: false,
          requireWebPort: true,
          checkPortAvailability: () => Effect.succeed(true),
        });

        assert.equal(offset, 59_802);
      }),
    );

    it.effect("reports the exhausted range and required port set", () =>
      Effect.gen(function* () {
        const error = yield* findFirstAvailableOffset({
          startOffset: 51_763,
          requireServerPort: true,
          requireWebPort: false,
          checkPortAvailability: () => Effect.succeed(true),
        }).pipe(Effect.flip);

        if (error._tag !== "DevRunnerPortExhaustedError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.startOffset, 51_763);
        assert.equal(error.requireServerPort, true);
        assert.equal(error.requireWebPort, false);
        assert.equal(error.baseServerPort, 13_773);
        assert.equal(error.baseWebPort, 5_733);
        assert.equal(error.maximumPort, 65_535);
        assert.ok(!("cause" in error));
      }),
    );
  });

  describe("isBrowserAllowedPort", () => {
    it.each([6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697])(
      "rejects Fetch-blocked web port %s from the worktree offset range",
      (port) => {
        assert.equal(isBrowserAllowedPort(port), false);
      },
    );

    it.each([5733, 5900, 6567, 6670, 8733])("allows browser-safe web port %s", (port) => {
      assert.equal(isBrowserAllowedPort(port), true);
    });
  });

  describe("checkPortAvailabilityOnHosts", () => {
    it.effect("checks overlapping hosts sequentially to avoid self-interference", () =>
      Effect.gen(function* () {
        let inFlightCount = 0;
        const calls: Array<[number, string]> = [];

        const available = yield* checkPortAvailabilityOnHosts(
          13_773,
          ["127.0.0.1", "0.0.0.0", "::"],
          (port, host) =>
            Effect.promise(async () => {
              calls.push([port, host]);
              inFlightCount += 1;
              const overlapped = inFlightCount > 1;
              await Promise.resolve();
              inFlightCount -= 1;
              return !overlapped;
            }),
        );

        assert.equal(available, true);
        assert.deepStrictEqual(calls, [
          [13_773, "127.0.0.1"],
          [13_773, "0.0.0.0"],
          [13_773, "::"],
        ]);
      }),
    );
  });

  describe("devPortProbeHosts", () => {
    it.effect("probes loopback only when no bind host is configured", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts(undefined), ["127.0.0.1", "::1"]);
        assert.deepStrictEqual(devPortProbeHosts("  "), ["127.0.0.1", "::1"]);
      }),
    );

    // A port free on loopback can be taken on the interface the server will
    // actually bind, so --host/AWEN_HOST has to be probed as well.
    it.effect("adds a non-loopback bind host to the probe list", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts("0.0.0.0"), ["127.0.0.1", "::1", "0.0.0.0"]);
        assert.deepStrictEqual(devPortProbeHosts("192.168.1.10"), [
          "127.0.0.1",
          "::1",
          "192.168.1.10",
        ]);
      }),
    );

    it.effect("does not probe loopback twice when it is the configured host", () =>
      Effect.sync(() => {
        assert.deepStrictEqual(devPortProbeHosts("127.0.0.1"), ["127.0.0.1", "::1"]);
      }),
    );

    // Only the backend honours --host/AWEN_HOST. The Web server stays on
    // loopback, so judging its port against the backend's interface
    // would reject ports for a server that never binds there.
    it.effect("passes the port role so only the server port sees the bind host", () =>
      Effect.gen(function* () {
        const probed: Array<{ port: number; role: string | undefined }> = [];

        yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port, role) => {
            probed.push({ port, role });
            return Effect.succeed(true);
          },
        });

        assert.deepStrictEqual(probed, [
          { port: 13_773, role: "server" },
          { port: 5733, role: "web" },
        ]);
      }),
    );
  });

  describe("resolveModePortOffsets", () => {
    it.effect("uses a shared fallback offset for dev mode", () =>
      Effect.gen(function* () {
        const taken = new Set([13773, 5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("keeps server offset stable for dev:web and only shifts web offset", () =>
      Effect.gen(function* () {
        const taken = new Set([5733]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 1 });
      }),
    );

    it.effect("shifts only server offset for dev:server", () =>
      Effect.gen(function* () {
        const taken = new Set([13773]);
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          checkPortAvailability: (port) => Effect.succeed(!taken.has(port)),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 1, webOffset: 1 });
      }),
    );

    it.effect("respects explicit dev-url override for dev:web", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: true,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );

    it.effect("respects explicit server port override for dev:server", () =>
      Effect.gen(function* () {
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:server",
          startOffset: 0,
          hasExplicitServerPort: true,
          hasExplicitDevUrl: false,
          checkPortAvailability: () => Effect.succeed(false),
        });

        assert.deepStrictEqual(offsets, { serverOffset: 0, webOffset: 0 });
      }),
    );

    // Pinned ports are what the desktop dev app addresses: the Tauri window URL
    // and the backend its Vite proxy dials are literals. Walking to the next free
    // number there does not "just work" — the window keeps loading the configured
    // URL and silently attaches to whatever already serves it, which reads as a
    // broken backend instead of a port conflict.
    it.effect("refuses to walk off a pinned web port for dev:web", () =>
      Effect.gen(function* () {
        const error = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          strictPorts: true,
          checkPortAvailability: (port) => Effect.succeed(port !== 5733),
        }).pipe(Effect.flip);

        if (error._tag !== "DevRunnerPortUnavailableError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.port, 5733);
        assert.equal(error.role, "web");
        assert.equal(error.mode, "dev:web");
      }),
    );

    it.effect("keeps pinned ports when they are free and follows the offset", () =>
      Effect.gen(function* () {
        const probed: number[] = [];
        const offsets = yield* resolveModePortOffsets({
          mode: "dev:web",
          startOffset: 2,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          strictPorts: true,
          checkPortAvailability: (port) => {
            probed.push(port);
            return Effect.succeed(true);
          },
        });

        assert.deepStrictEqual(offsets, { serverOffset: 2, webOffset: 2 });
        assert.deepStrictEqual(probed, [5735]);
      }),
    );

    it.effect("checks both pinned ports for dev mode", () =>
      Effect.gen(function* () {
        const error = yield* resolveModePortOffsets({
          mode: "dev",
          startOffset: 0,
          hasExplicitServerPort: false,
          hasExplicitDevUrl: false,
          strictPorts: true,
          checkPortAvailability: (_port, role) => Effect.succeed(role === "web"),
        }).pipe(Effect.flip);

        if (error._tag !== "DevRunnerPortUnavailableError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.port, 13_773);
        assert.equal(error.role, "server");
      }),
    );
  });

  describe("runDevRunnerWithInput", () => {
    it.effect("preserves invalid configuration as the exact cause", () =>
      Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({ ...devServerInput, dryRun: true }).pipe(
          Effect.provide(
            Layer.merge(
              netServiceLayer,
              ConfigProvider.layer(
                ConfigProvider.fromEnv({ env: { AWEN_PORT_OFFSET: "not-an-integer" } }),
              ),
            ),
          ),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerConfigurationError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.deepStrictEqual(error.configKeys, [
          "AWEN_PORT_OFFSET",
          "AWEN_DEV_INSTANCE",
          "AWEN_STRICT_DEV_PORTS",
        ]);
        assert.ok(error.cause !== undefined);
        assert.ok(!error.message.includes(String((error.cause as Error).message)));
      }),
    );

    it.effect("preserves process spawn context and the exact platform cause", () => {
      const cause = PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        description: "vp was not found",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(cause)),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.operation, "spawn");
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes(cause.message));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    // `tailscale serve` config outlives the process, so a dry run that shared
    // would replace and then tear down whatever mapping the port already had.
    // Base-dir precedence (--home-dir > worktree .awen > ambient AWEN_HOME)
    // lives in runDevRunnerWithInput; the env builder must not consult the
    // ambient variable on its own, or it would silently outrank the worktree
    // default and land dev state on the user's real database.
    it.effect("ignores an ambient AWEN_HOME when no home is resolved", () =>
      Effect.gen(function* () {
        const env = yield* createDevRunnerEnv({
          mode: "dev",
          baseEnv: { AWEN_HOME: "/home/user/.awen" },
          serverOffset: 0,
          webOffset: 0,
          awenHome: undefined,
          browser: undefined,
          autoBootstrapProjectFromCwd: undefined,
          logWebSocketEvents: undefined,
          host: undefined,
          port: undefined,
          devUrl: undefined,
        });

        assert.equal(env.AWEN_HOME, undefined);
      }),
    );

    // Single-origin browser dev proxies the backend at localhost, so a backend
    // bound only to a specific interface breaks every proxied request in a way
    // that looks like a broken server. Reject the combination up front.
    it.effect("rejects a specific non-loopback --host for browser dev modes", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(0))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          host: "192.168.1.10",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerHostNotProxiableError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev");
        assert.equal(error.host, "192.168.1.10");
        assert.include(error.message, "0.0.0.0");
        assert.include(error.message, "--share");
      });
    });

    // Wildcards keep loopback answering, so the proxy target stays valid and
    // the combination must keep working — it is the documented way to serve a
    // LAN interface and the browser proxy at once.
    it.effect("still spawns the stack for a wildcard --host in dev mode", () => {
      let spawnCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(mockProcess(0));
        }),
      );

      return Effect.gen(function* () {
        yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          host: "0.0.0.0",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        assert.equal(spawnCount, 1);
      });
    });

    // dev:server does not proxy — the client talks to the backend directly —
    // so a specific interface bind stays legitimate there.
    it.effect("keeps a specific --host working for dev:server", () => {
      let spawnCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(mockProcess(0));
        }),
      );

      return Effect.gen(function* () {
        yield* runDevRunnerWithInput({
          ...devServerInput,
          host: "192.168.1.10",
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        assert.equal(spawnCount, 1);
      });
    });

    // A shared origin means a remote browser, where unbundled dev's
    // per-module waterfall pays a tailnet round trip per import level. The
    // runner defaults bundled dev on for the spawned stack, but only
    // defaults: an explicit AWEN_BUNDLED_DEV (even "0") must pass through.
    describe("--share bundled dev default", () => {
      const shareSpawnedEnv = (input: { readonly ambientBundledDev: string | undefined }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              const spawned = command as unknown as {
                readonly command: string;
                readonly args: ReadonlyArray<string>;
                readonly options?: { readonly env?: Record<string, string | undefined> };
              };
              if (spawned.command === "vp") {
                captured = spawned.options?.env;
                return Effect.succeed(mockProcess(0));
              }
              // tailscale: answer `status --json` with a valid tailnet name,
              // succeed the `serve`/`off` calls.
              return Effect.succeed(
                ChildProcessSpawner.makeHandle({
                  pid: ChildProcessSpawner.ProcessId(2),
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
                  isRunning: Effect.succeed(false),
                  kill: () => Effect.void,
                  unref: Effect.succeed(Effect.void),
                  stdin: Sink.drain,
                  stdout: spawned.args.includes("status")
                    ? Stream.make(
                        new TextEncoder().encode(
                          JSON.stringify({ Self: { DNSName: "host.example.ts.net." } }),
                        ),
                      )
                    : Stream.empty,
                  stderr: Stream.empty,
                  all: Stream.empty,
                  getInputFd: () => Sink.drain,
                  getOutputFd: () => Stream.empty,
                }),
              );
            }),
          );

          yield* runDevRunnerWithInput({
            ...devServerInput,
            mode: "dev",
            port: undefined,
            share: true,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(
              HostProcessEnvironment,
              input.ambientBundledDev === undefined
                ? {}
                : { AWEN_BUNDLED_DEV: input.ambientBundledDev },
            ),
          );

          return captured;
        });

      it.effect("defaults AWEN_BUNDLED_DEV=1 for a shared run", () =>
        Effect.gen(function* () {
          const env = yield* shareSpawnedEnv({ ambientBundledDev: undefined });
          assert.equal(env?.AWEN_BUNDLED_DEV, "1");
        }),
      );

      it.effect("keeps an explicit AWEN_BUNDLED_DEV=0 opt-out", () =>
        Effect.gen(function* () {
          const env = yield* shareSpawnedEnv({ ambientBundledDev: "0" });
          assert.equal(env?.AWEN_BUNDLED_DEV, "0");
        }),
      );

      it.effect("leaves AWEN_BUNDLED_DEV unset without --share", () =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              captured = (
                command as {
                  readonly options?: { readonly env?: Record<string, string | undefined> };
                }
              ).options?.env;
              return Effect.succeed(mockProcess(0));
            }),
          );

          yield* runDevRunnerWithInput({
            ...devServerInput,
            mode: "dev",
            port: undefined,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(HostProcessEnvironment, {}),
          );

          assert.equal(captured?.AWEN_BUNDLED_DEV, undefined);
        }),
      );
    });

    it.effect("spawns nothing when --dry-run is combined with --share", () => {
      let spawnCount = 0;
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => {
          spawnCount += 1;
          return Effect.succeed(mockProcess(0));
        }),
      );

      return Effect.gen(function* () {
        yield* runDevRunnerWithInput({
          ...devServerInput,
          mode: "dev",
          port: undefined,
          dryRun: true,
          share: true,
        }).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
        );

        assert.equal(spawnCount, 0);
      });
    });

    it.effect("reports non-zero exits without manufacturing a cause", () => {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(17))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessExitError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.exitCode, 17);
        assert.ok(!("cause" in error));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    it.effect("preserves wait-for-exit failures as the exact cause", () => {
      const cause = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "exitCode",
        description: "process status became unavailable",
      });
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.succeed(mockProcess(cause))),
      );

      return Effect.gen(function* () {
        const error = yield* runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, "linux"),
          Effect.flip,
        );

        if (error._tag !== "DevRunnerProcessError") {
          assert.fail(`Unexpected error: ${error._tag}`);
        }
        assert.equal(error.operation, "wait-for-exit");
        assert.equal(error.mode, "dev:server");
        assert.equal(error.executable, "vp");
        assert.equal(error.argumentCount, 5);
        assert.equal(error.shell, false);
        assert.equal(error.cause, cause);
        assert.ok(!error.message.includes(cause.message));
        assert.notProperty(error, "args");
        assert.notInclude(error.message, "secret-token-value");
      });
    });

    it.effect("stops through the pid-scoped request file", () => {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-dev-runner-stop-"));

      return Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Deferred.succeed(started, undefined).pipe(Effect.as(mockPendingProcess())),
          ),
        );

        const completed = yield* Effect.raceFirst(
          runDevRunnerWithInput({
            ...devServerInput,
            awenHome: root,
          }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcessPlatform, "win32"),
          ),
          Effect.gen(function* () {
            yield* Deferred.await(started);
            const stopRequestPath = yield* Effect.tryPromise(() =>
              requestDevRunnerStop(root, process.pid),
            );
            yield* Effect.tryPromise(() => acknowledgeDevRunnerStop(stopRequestPath));
            yield* TestClock.adjust("100 millis");
            return yield* Effect.never;
          }),
        );

        assert.equal(completed, undefined);
        assert.isFalse(NodeFS.existsSync(devRunnerStopRequestPath(root, process.pid)));
        assert.isFalse(
          NodeFS.existsSync(devRunnerStopAckPath(devRunnerStopRequestPath(root, process.pid))),
        );
      }).pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { force: true, recursive: true }))),
      );
    });

    it.effect("keeps POSIX children attached and detaches Windows children", () => {
      const captured: Array<{
        readonly detached: boolean | undefined;
        readonly platform: "linux" | "win32";
        readonly windowsHide: boolean | undefined;
      }> = [];

      const run = (platform: "linux" | "win32") => {
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const options = (
              command as {
                readonly options?: { readonly detached?: boolean; readonly windowsHide?: boolean };
              }
            ).options;
            captured.push({
              detached: options?.detached,
              platform,
              windowsHide: options?.windowsHide,
            });
            return Effect.succeed(mockProcess(0));
          }),
        );

        return runDevRunnerWithInput(devServerInput).pipe(
          Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
          Effect.provideService(HostProcessPlatform, platform),
        );
      };

      return Effect.gen(function* () {
        yield* run("linux");
        yield* run("win32");

        assert.deepStrictEqual(captured, [
          { detached: false, platform: "linux", windowsHide: undefined },
          { detached: true, platform: "win32", windowsHide: true },
        ]);
      });
    });

    describe("awen home precedence", () => {
      const makeWorktree = Effect.acquireRelease(
        Effect.sync(() => {
          const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-devrunner-"));
          NodeFS.writeFileSync(
            NodePath.join(root, ".git"),
            "gitdir: /elsewhere/.git/worktrees/x\n",
          );
          return root;
        }),
        (root) => Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
      );

      const spawnedHome = (input: {
        readonly awenHome: string | undefined;
        readonly cwd: string;
        readonly ambientHome: string | undefined;
      }) =>
        Effect.gen(function* () {
          let captured: Record<string, string | undefined> | undefined;
          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make((command) => {
              captured = (
                command as {
                  readonly options?: { readonly env?: Record<string, string | undefined> };
                }
              ).options?.env;
              return Effect.succeed(mockProcess(0));
            }),
          );

          yield* runDevRunnerWithInput({ ...devServerInput, awenHome: input.awenHome }).pipe(
            Effect.provide(Layer.mergeAll(emptyConfigLayer, netServiceLayer, spawnerLayer)),
            Effect.provideService(HostProcessPlatform, "linux"),
            Effect.provideService(HostProcessWorkingDirectory, input.cwd),
            Effect.provideService(
              HostProcessEnvironment,
              input.ambientHome === undefined ? {} : { AWEN_HOME: input.ambientHome },
            ),
          );

          return captured?.AWEN_HOME;
        });

      it.effect("prefers an explicit --home-dir over the worktree default", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            awenHome: "/tmp/explicit-home",
            cwd: root,
            ambientHome: "/home/user/.awen",
          });
          assert.equal(home, path.resolve("/tmp/explicit-home"));
        }).pipe(Effect.scoped),
      );

      it.effect("treats a blank --home-dir as unset rather than as a selection", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            awenHome: "   ",
            cwd: root,
            ambientHome: "/home/user/.awen",
          });
          assert.equal(home, path.join(path.resolve(root), ".awen"));
        }).pipe(Effect.scoped),
      );

      it.effect("prefers the worktree .awen over an ambient AWEN_HOME", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const root = yield* makeWorktree;
          const home = yield* spawnedHome({
            awenHome: undefined,
            cwd: root,
            ambientHome: "/home/user/.awen",
          });
          assert.equal(home, path.join(path.resolve(root), ".awen"));
        }).pipe(Effect.scoped),
      );

      it.effect("falls back to an ambient AWEN_HOME outside a worktree", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const home = yield* spawnedHome({
            awenHome: undefined,
            cwd: NodeOS.tmpdir(),
            ambientHome: "/home/user/.awen",
          });
          assert.equal(home, path.resolve("/home/user/.awen"));
        }),
      );

      it.effect("leaves the home implicit with no worktree and no ambient value", () =>
        Effect.gen(function* () {
          const path = yield* Path.Path;
          const home = yield* spawnedHome({
            awenHome: undefined,
            cwd: NodeOS.tmpdir(),
            ambientHome: undefined,
          });
          assert.equal(home, path.resolve(path.join(import.meta.dirname, "..", ".awen")));
        }),
      );
    });
  });
});
