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
  DesktopBackendStartConfig,
} from "./DesktopBackendManager.ts";

export const make = Effect.fn("desktop.managedBackend.make")(function* (spec: BackendInstanceSpec) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const exposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wsl = yield* DesktopWslEnvironment.DesktopWslEnvironment;
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
  const pidRef = yield* Ref.make(Option.none<number>());
  const start = mutex.withPermits(1)(
    Effect.gen(function* () {
      let config = yield* spec.configResolve.pipe(Effect.orDie);
      if (Option.isSome(config.preflightFailure)) {
        if (
          spec.onPreflightFailed &&
          (yield* spec.onPreflightFailed(config.preflightFailure.value))
        ) {
          config = yield* spec.configResolve.pipe(Effect.orDie);
        }
        if (Option.isSome(config.preflightFailure))
          return yield* Effect.die(config.preflightFailure.value);
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
        yield* Ref.set(pidRef, Option.some(descriptor.pid));
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
      yield* Ref.set(pidRef, Option.some(daemon.pid));
      if (spec.onReady) yield* spec.onReady(httpBaseUrl);
    }),
  );
  const stop: DesktopBackendInstance["stop"] = (options) =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
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
        yield* Ref.set(pidRef, Option.none());
        if (spec.onShutdown) yield* spec.onShutdown();
      }),
    );
  // No stop finalizer: ordinary app shutdown must leave Sessions running.
  return {
    id: spec.id,
    label: spec.label,
    start,
    stop,
    currentConfig: Ref.get(configRef),
    snapshot: Ref.get(pidRef).pipe(
      Effect.map((activePid) => ({
        desiredRunning: Option.isSome(activePid),
        ready: Option.isSome(activePid),
        activePid,
        restartAttempt: 0,
        restartScheduled: false,
      })),
    ),
    waitForReady: () => Ref.get(pidRef).pipe(Effect.map(Option.isSome)),
  } satisfies DesktopBackendInstance;
});
