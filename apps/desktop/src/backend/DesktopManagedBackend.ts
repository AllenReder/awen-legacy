// @effect-diagnostics nodeBuiltinImport:off
// Reuse the daemon launcher: ownership, lock, detached spawn and credentials
// are shared with the CLI. Electron owns the connection, not the process.
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as NodeFSP from "node:fs/promises";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import {
  deriveLocalDaemonPaths,
  startLocalDaemon,
  stopLocalDaemon,
} from "../../../server/src/localDaemon.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import type {
  BackendInstanceSpec,
  DesktopBackendInstance,
  DesktopBackendSnapshot,
  DesktopBackendStartConfig,
} from "./DesktopBackendManager.ts";

export const make = Effect.fn("desktop.managedBackend.make")(function* (spec: BackendInstanceSpec) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const exposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wsl = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const parentScope = yield* Scope.Scope;
  const httpClient = yield* HttpClient.HttpClient;
  const { logError } = makeComponentLogger(`desktop-managed-backend:${spec.id}`);
  let wslLaunch:
    | { config: DesktopBackendStartConfig; prefix: string[]; baseDir: string }
    | undefined;
  const exec = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) =>
    Effect.tryPromise<string>(
      (signal) =>
        new Promise((resolve, reject) => {
          NodeChildProcess.execFile(
            command,
            [...args],
            { env, windowsHide: true, timeout: 120_000, signal },
            (error, stdout) => (error ? reject(error) : resolve(stdout)),
          );
        }),
    ).pipe(Effect.orDie);
  const descriptorSchema = Schema.fromJsonString(
    Schema.Struct({ ok: Schema.Literal(true), pid: Schema.Int, origin: Schema.String }),
  );
  const mutex = yield* Semaphore.make(1);
  const configRef = yield* Ref.make(Option.none<DesktopBackendStartConfig>());
  const state = yield* Ref.make<DesktopBackendSnapshot>({
    desiredRunning: false,
    ready: false,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  });
  let preflightFailures = 0;
  const handshakeSchema = Schema.Struct({
    protocolVersion: Schema.Literal(1),
    owner: Schema.Literal("awen-local-daemon"),
    managed: Schema.Literal(true),
    pid: Schema.Int,
  });
  const healthy = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const config = yield* Ref.get(configRef);
    if (Option.isNone(config) || Option.isNone(current.activePid)) return false;
    const response = yield* httpClient.get(
      new URL("/.well-known/awen/daemon", config.value.httpBaseUrl).href,
    );
    if (response.status !== 200) return false;
    const handshake = yield* HttpClientResponse.schemaBodyJson(handshakeSchema)(response);
    return handshake.pid === current.activePid.value;
  }).pipe(
    Effect.timeoutOption(Duration.seconds(2)),
    Effect.map(Option.getOrElse(() => false)),
    Effect.catchCause(() => Effect.succeed(false)),
  );

  // Called only under the mutex. Re-resolve configuration on every recovery.
  const launch = Effect.gen(function* () {
    let config = yield* spec.configResolve.pipe(Effect.orDie);
    if (Option.isSome(config.preflightFailure)) {
      if (
        spec.onPreflightFailed &&
        (yield* spec.onPreflightFailed(config.preflightFailure.value))
      ) {
        config = yield* spec.configResolve.pipe(Effect.orDie);
      }
      if (Option.isSome(config.preflightFailure)) {
        const failure = config.preflightFailure.value;
        preflightFailures += 1;
        if (failure.fatal || preflightFailures >= (failure.retryLimit ?? 5))
          yield* Ref.update(state, (current) => ({ ...current, desiredRunning: false }));
        return yield* Effect.die(failure);
      }
    }
    if (config.bootstrapDelivery === "stdin") {
      const index = config.args.indexOf("--bootstrap-fd");
      if (index < 0)
        return yield* Effect.die("WSL runtime invocation is missing its bootstrap boundary.");
      const prefix = config.args.slice(0, index);
      const home = Option.getOrThrow(yield* wsl.getUserHome(config.runningDistro ?? null));
      const baseDir = `${home}/.awen${environment.isDevelopment ? "-dev" : ""}`;
      const raw = yield* exec(
        config.executablePath,
        [
          ...prefix,
          "daemon",
          "start",
          "--json",
          "--base-dir",
          baseDir,
          "--expected-server-version",
          environment.appVersion,
          "--host",
          "0.0.0.0",
        ],
        config.env,
      );
      const descriptor = yield* Schema.decodeUnknownEffect(descriptorSchema)(raw.trim()).pipe(
        Effect.orDie,
      );
      const distroArgs = config.runningDistro ? ["-d", config.runningDistro] : [];
      const credential = yield* exec(
        config.executablePath,
        [...distroArgs, "--exec", "cat", `${baseDir}/userdata/secrets/desktop-bootstrap.token`],
        config.env,
      );
      const httpBaseUrl = new URL(descriptor.origin);
      // The daemon advertises loopback inside Linux; preserve the preflight's
      // reachable distro address when Windows accesses that daemon.
      httpBaseUrl.hostname = config.httpBaseUrl.hostname;
      wslLaunch = { config, prefix: [...prefix], baseDir };
      yield* Ref.set(
        configRef,
        Option.some({
          ...config,
          httpBaseUrl,
          bootstrap: { ...config.bootstrap, desktopBootstrapToken: credential.trim() },
        }),
      );
      preflightFailures = 0;
      yield* Ref.update(state, (current) => ({
        ...current,
        ready: true,
        activePid: Option.some(descriptor.pid),
        restartAttempt: 0,
        restartScheduled: false,
      }));
      if (spec.onReady) yield* spec.onReady(httpBaseUrl);
      return;
    }
    const daemon = yield* Effect.promise(() =>
      startLocalDaemon({
        baseDir: environment.baseDir,
        expectedServerVersion: environment.appVersion,
        serverInvocation: {
          command: environment.backendNodePath,
          args: [environment.backendEntryPath],
        },
        currentDirectory: environment.backendCwd,
        bindHost: config.bootstrap.host,
        environment: {
          ...config.env,
          ELECTRON_RUN_AS_NODE: undefined,
          AWEN_TAILSCALE_SERVE: config.bootstrap.tailscaleServeEnabled ? "1" : "0",
          AWEN_TAILSCALE_SERVE_PORT: String(config.bootstrap.tailscaleServePort),
        },
        timeoutMs: 120_000,
        reservePort: async () => Number(config.httpBaseUrl.port),
      }),
    );
    const credential = yield* Effect.promise(() =>
      NodeFSP.readFile(deriveLocalDaemonPaths(environment.baseDir).credentialPath, "utf8"),
    );
    const httpBaseUrl = new URL(daemon.origin);
    yield* exposure.configureFromSettings({ port: Number(httpBaseUrl.port) });
    yield* Ref.set(
      configRef,
      Option.some({
        ...config,
        httpBaseUrl,
        bootstrap: { ...config.bootstrap, desktopBootstrapToken: credential.trim() },
      }),
    );
    preflightFailures = 0;
    yield* Ref.update(state, (current) => ({
      ...current,
      ready: true,
      activePid: Option.some(daemon.pid),
      restartAttempt: 0,
      restartScheduled: false,
    }));
    if (spec.onReady) yield* spec.onReady(httpBaseUrl);
  });
  const unavailable = Effect.gen(function* () {
    const wasReady = (yield* Ref.get(state)).ready;
    yield* Ref.update(state, (current) => ({
      ...current,
      ready: false,
      activePid: Option.none(),
      restartScheduled: false,
    }));
    if (wasReady && spec.onShutdown) yield* spec.onShutdown();
  });
  const recover = launch.pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* unavailable;
        yield* logError("managed daemon launch failed; retrying while the shell is running", {
          cause,
        });
      }),
    ),
  );
  const start = mutex.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* Ref.get(state);
      if (current.ready && (yield* healthy)) return;
      yield* unavailable;
      yield* Ref.update(state, (current) => ({
        ...current,
        desiredRunning: true,
        restartAttempt: 0,
      }));
      yield* recover;
    }),
  );

  // Supervise the connection without owning the detached process lifetime.
  // Scope closure interrupts checks and backoff; only explicit stop kills it.
  yield* Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep(Duration.seconds(1));
      const retryDelay = yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (!current.desiredRunning || (current.ready && (yield* healthy)))
            return Option.none<Duration.Duration>();
          yield* unavailable;
          const delay = Duration.millis(
            Math.min(500 * 2 ** Math.min(current.restartAttempt, 5), 10_000),
          );
          yield* Ref.update(state, (current) => ({
            ...current,
            restartAttempt: current.restartAttempt + 1,
            restartScheduled: true,
          }));
          return Option.some(delay);
        }),
      );
      if (Option.isNone(retryDelay)) continue;
      yield* Effect.sleep(retryDelay.value);
      yield* mutex.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (!current.desiredRunning || current.ready) return;
          yield* Ref.update(state, (current) => ({ ...current, restartScheduled: false }));
          yield* recover;
        }),
      );
    }
  }).pipe(Effect.forkIn(parentScope));

  const stop: DesktopBackendInstance["stop"] = (options) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        // Disable recovery before stopping, including when a launch failed.
        yield* Ref.update(state, (current) => ({
          ...current,
          desiredRunning: false,
          restartScheduled: false,
        }));
        if (Option.isNone(yield* Ref.get(configRef))) return;
        if (wslLaunch) {
          const { config, prefix, baseDir } = wslLaunch;
          yield* exec(
            config.executablePath,
            [...prefix, "daemon", "stop", "--confirm", "--json", "--base-dir", baseDir],
            config.env,
          );
          wslLaunch = undefined;
        } else {
          yield* Effect.promise(() =>
            stopLocalDaemon({
              baseDir: environment.baseDir,
              confirm: true,
              stopTimeoutMs: Duration.toMillis(options?.timeout ?? Duration.seconds(5)),
            }),
          );
        }
        yield* Ref.set(configRef, Option.none());
        yield* unavailable;
      }),
    );
  // No stop finalizer: ordinary app shutdown must leave Sessions running.
  return {
    id: spec.id,
    label: spec.label,
    start,
    stop,
    currentConfig: Ref.get(configRef),
    snapshot: Ref.get(state),
    waitForReady: (timeout) =>
      Ref.get(state).pipe(
        Effect.repeat({
          until: (current) => current.ready || !current.desiredRunning,
          schedule: Schedule.spaced(Duration.millis(100)),
        }),
        Effect.map((current) => current.ready),
        Effect.timeoutOption(timeout),
        Effect.map(Option.getOrElse(() => false)),
      ),
  } satisfies DesktopBackendInstance;
});
