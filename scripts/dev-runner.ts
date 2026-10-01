#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@awen/shared/Net";
import { BASE_DAEMON_PORT, BASE_WEB_DEV_PORT, resolveDevPortOffset } from "@awen/shared/daemonPort";
import { resolveGitWorktreePath } from "@awen/shared/devHome";
import {
  HostProcessEnvironment,
  HostProcessPlatform,
  HostProcessWorkingDirectory,
} from "@awen/shared/hostProcess";
import { resolveSpawnCommand } from "@awen/shared/shell";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

import { type DevShareError, shareDevServer, unshareDevServer } from "./lib/dev-share.ts";
import { devRunnerStopAckPath, devRunnerStopRequestPath } from "./lib/dev-runner-stop.ts";
import { loadRepoEnv } from "./lib/public-config.ts";

Object.assign(process.env, loadRepoEnv());

// Base ports come from the shared daemon-port contract: the desktop dev wrapper
// derives the same pair for the window URL and the daemon port, so a number that
// changed here alone would desynchronize them.
const BASE_SERVER_PORT = BASE_DAEMON_PORT;
const BASE_WEB_PORT = BASE_WEB_DEV_PORT;
const MAX_PORT = 65535;
const DEV_RUNNER_STOP_POLL_INTERVAL = "100 millis" as const;
const DEV_RUNNER_STOP_ACK_TIMEOUT = "5 seconds" as const;
// HTTP(S) requests to these ports are blocked by the Fetch standard before a
// browser reaches the network. Keep the complete list here so explicit or
// future wider offsets cannot produce a URL that curl accepts but browsers
// reject. https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);
// Dev servers bind loopback, so loopback is the only interface whose
// availability decides whether we can use a port. Probing wildcards too made
// the runner walk away from a perfectly free port whenever something else held
// the same number on another interface — `tailscale serve` does exactly that,
// which silently moved the ports out from under a URL that had just been shared.
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "::1"] as const;

/**
 * Bind hosts on which a backend still answers `http://localhost:<port>`, which
 * is where single-origin browser dev proxies to. Loopback and the wildcards
 * qualify; a specific interface (e.g. a LAN IP) does not — the OS binds only
 * that address and the proxy target goes dark.
 */
export function isProxiableBindHost(host: string): boolean {
  const normalized = host.trim();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  );
}

export const DEFAULT_AWEN_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.resolve(path.join(import.meta.dirname, "..", ".awen")),
);

export interface DevHomeResolutionInput {
  readonly checkoutRoot: string;
  readonly explicitHome: string | undefined;
  readonly worktreeRoot: string | undefined;
  readonly ambientHome: string | undefined;
}

/**
 * Keep development state inside the checkout by default. An explicit home or
 * a linked worktree still wins, while an ambient AWEN_HOME remains an
 * intentional override for developers who need it.
 */
export function resolveDevHome(input: DevHomeResolutionInput): string {
  return (
    input.explicitHome?.trim() ||
    (input.worktreeRoot?.trim() && `${input.worktreeRoot.trim()}/.awen`) ||
    input.ambientHome?.trim() ||
    `${input.checkoutRoot}/.awen`
  );
}

const MODE_ARGS = {
  dev: [
    "run",
    "--filter=@awen/contracts",
    "--filter=@awen/web",
    "--filter=@awen/server",
    "--parallel",
    "dev",
  ],
  "dev:server": ["run", "--filter=@awen/server", "dev"],
  "dev:web": ["run", "--filter=@awen/web", "dev"],
  "dev:desktop": [
    "run",
    "--filter=@awen/desktop",
    "--filter=@awen/web",
    "--filter=@awen/server",
    "--parallel",
    "dev:desktop",
  ],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
/**
 * `role` matters because only the backend honours `--host`/`AWEN_HOST`; the
 * web port is always loopback. Passed explicitly rather than inferred from the
 * port number, which stops distinguishing them under a large port offset.
 */
type PortAvailabilityCheck<R = never> = (
  port: number,
  role?: "server" | "web",
) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

export function getDevRunnerModeArgs(mode: DevMode): ReadonlyArray<string> {
  return MODE_ARGS[mode];
}

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export class DevRunnerConfigurationError extends Schema.TaggedError<DevRunnerConfigurationError>()(
  "DevRunnerConfigurationError",
  {
    configKeys: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read dev-runner configuration: ${this.configKeys.join(", ")}.`;
  }
}

export class DevRunnerInvalidPortOffsetError extends Schema.TaggedError<DevRunnerInvalidPortOffsetError>()(
  "DevRunnerInvalidPortOffsetError",
  {
    configKey: Schema.Literal("AWEN_PORT_OFFSET"),
    portOffset: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.configKey} must be at least ${this.minimum}; received ${this.portOffset}.`;
  }
}

export class DevRunnerPortExhaustedError extends Schema.TaggedError<DevRunnerPortExhaustedError>()(
  "DevRunnerPortExhaustedError",
  {
    startOffset: Schema.Number,
    requireServerPort: Schema.Boolean,
    requireWebPort: Schema.Boolean,
    baseServerPort: Schema.Number,
    baseWebPort: Schema.Number,
    maximumPort: Schema.Number,
  },
) {
  override get message(): string {
    return `No required dev ports were available from offset ${this.startOffset} through maximum port ${this.maximumPort}.`;
  }
}

/**
 * Raised instead of silently moving to a neighbouring port.
 *
 * The Electron dev window and the Vite proxy use pinned ports. The desktop
 * development origin is a literal web URL and the proxy target is a
 * literal backend port. Walking to the next free number therefore does not
 * "just work" — the window keeps loading the old URL and quietly attaches to
 * whatever already listens there, which reads as a broken backend rather than a
 * port conflict.
 */
export class DevRunnerPortUnavailableError extends Schema.TaggedError<DevRunnerPortUnavailableError>()(
  "DevRunnerPortUnavailableError",
  {
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    role: Schema.Literals(["server", "web"]),
    port: Schema.Number,
    pinSource: Schema.String,
  },
) {
  override get message(): string {
    return `Port ${this.port} (${this.role}) is already in use while ${this.mode} runs with pinned ports (${this.pinSource}). The desktop dev window loads a fixed web URL and the web dev server proxies to a fixed backend port, so a different number would not be reachable — another dev session is the usual cause. Free the port (\`lsof -nP -iTCP:${this.port} -sTCP:LISTEN\`) or run without the pin (\`pnpm dev:web\`) to let the runner pick free ports.`;
  }
}

export class DevRunnerProcessError extends Schema.TaggedError<DevRunnerProcessError>()(
  "DevRunnerProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner process operation "${this.operation}" failed for mode "${this.mode}".`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedError<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev-runner process exited with code ${this.exitCode} in mode "${this.mode}".`;
  }
}

export class DevRunnerHostNotProxiableError extends Schema.TaggedError<DevRunnerHostNotProxiableError>()(
  "DevRunnerHostNotProxiableError",
  {
    mode: Schema.Literals(["dev", "dev:web"]),
    host: Schema.String,
  },
) {
  override get message(): string {
    return `--host ${this.host} cannot be combined with ${this.mode}: single-origin browser dev proxies the backend at localhost, and a backend bound only to ${this.host} leaves localhost unanswered, so every proxied request fails. Use a wildcard (0.0.0.0 or ::) to serve that interface and loopback together, or --share for remote access.`;
  }
}

export const DevRunnerError = Schema.Union([
  DevRunnerConfigurationError,
  DevRunnerHostNotProxiableError,
  DevRunnerInvalidPortOffsetError,
  DevRunnerPortExhaustedError,
  DevRunnerPortUnavailableError,
  DevRunnerProcessError,
  DevRunnerProcessExitError,
]);
export type DevRunnerError = typeof DevRunnerError.Type;
export const isDevRunnerError = Schema.is(DevRunnerError);

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("AWEN_PORT_OFFSET"),
  devInstance: optionalStringConfig("AWEN_DEV_INSTANCE"),
  // Set by the desktop dev wrapper: its window URL and the backend port it
  // proxies to are pinned development inputs, so the runner must not move
  // off them. Absent for `pnpm dev`/`dev:web`, which stay free to walk ports.
  strictPorts: optionalBooleanConfig("AWEN_STRICT_DEV_PORTS"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
  readonly worktreePath?: string | undefined;
}): Effect.Effect<
  { readonly offset: number; readonly source: string },
  DevRunnerInvalidPortOffsetError
> {
  // The rule itself lives in `@awen/shared/daemonPort`, because the desktop
  // wrapper must resolve the very same offset for its window URL and proxy
  // target. Two copies silently disagreed; this module only maps the shared
  // result onto its own error type. `AWEN_PORT_OFFSET` is validated by the CLI
  // config, so the numeric path here is the only one that can fail.
  const env: Record<string, string | undefined> = {};
  if (config.portOffset !== undefined) env.AWEN_PORT_OFFSET = String(config.portOffset);
  if (config.devInstance !== undefined) env.AWEN_DEV_INSTANCE = config.devInstance;

  const resolved = resolveDevPortOffset({ env, worktreePath: config.worktreePath });
  if (resolved._tag === "invalid") {
    return Effect.fail(
      new DevRunnerInvalidPortOffsetError({
        configKey: "AWEN_PORT_OFFSET",
        portOffset: Number(resolved.raw),
        minimum: 0,
      }),
    );
  }

  return Effect.succeed({ offset: resolved.offset, source: resolved.source });
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_AWEN_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly awenHome: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  awenHome,
  browser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    // Precedence (--home-dir > worktree .awen > ambient AWEN_HOME) is resolved
    // by the caller; an unset awenHome here genuinely means "use the default".
    const configuredBaseDir = awenHome?.trim() || undefined;
    const resolvedBaseDir = yield* resolveBaseDir(configuredBaseDir);

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL: devUrl?.toString() ?? `http://localhost:${webPort}`,
    };

    if (configuredBaseDir !== undefined) {
      output.AWEN_HOME = resolvedBaseDir;
    } else {
      delete output.AWEN_HOME;
    }

    // A dev-runner server is never launcher-managed. When the shell that runs
    // this script was itself spawned by the machine's managed awen service (an
    // agent working inside Awen), these leak through and the child server
    // fails startup with "The service launcher started a different awen version"
    // (serviceLauncherClient.ts resolveStartup).
    delete output.AWEN_SERVICE_LAUNCHER_CONTEXT;
    delete output.AWEN_BOOT_SERVICE_UNIT;

    const isDesktopMode = mode === "dev:desktop";

    output.AWEN_PORT = String(serverPort);
    // Browser dev is single-origin: everything (including /ws) is proxied
    // through Vite, so the client must resolve its backend from
    // window.location.origin rather than a baked-in localhost URL. See
    // resolveConfiguredPrimaryTarget in apps/web/src/environments/primary/target.ts
    // — it only defers to the origin when both of these are absent. Baking
    // localhost here is what breaks any non-localhost origin (tailnet, LAN,
    // phone): the remote browser dials its own machine.
    delete output.HOST;
    if (!isDesktopMode) {
      if (mode === "dev" || mode === "dev:web") {
        // Deleting is not enough on its own: vite.config.ts calls loadRepoEnv,
        // which merges `.env`/`.env.local` under this env, so a developer
        // with either URL in their `.env` would get it back and silently lose
        // single-origin mode. This states the intent positively so Vite can
        // ignore those values rather than infer from their absence.
        delete output.VITE_HTTP_URL;
        delete output.VITE_WS_URL;
        output.AWEN_SINGLE_ORIGIN_DEV = "1";
      } else {
        output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
        output.VITE_WS_URL = `ws://localhost:${serverPort}`;
        delete output.AWEN_SINGLE_ORIGIN_DEV;
      }
    } else {
      output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
      delete output.AWEN_SINGLE_ORIGIN_DEV;
      delete output.AWEN_MODE;
      delete output.AWEN_NO_BROWSER;
      delete output.AWEN_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.AWEN_HOST = host;
    }

    if (!isDesktopMode) {
      output.AWEN_NO_BROWSER = browser === true ? "0" : "1";
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.AWEN_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.AWEN_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.AWEN_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.AWEN_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.AWEN_MODE = "web";
      delete output.AWEN_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.AWEN_MODE = "web";
      delete output.AWEN_DESKTOP_WS_URL;
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export function checkPortAvailabilityOnHosts<R>(
  port: number,
  hosts: ReadonlyArray<string>,
  canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Hosts to probe for a dev server bound to `configuredHost`.
 *
 * Loopback is always checked because the Web client proxies through it. When
 * `--host`/`AWEN_HOST` moves the backend onto
 * another interface, that interface decides whether the bind actually
 * succeeds — probing only loopback would hand back a port that is free here
 * and taken there, and the server would fail to start.
 *
 * `configuredHost` applies to the *backend* only. The Web dev server stays on
 * loopback and must not be judged against the backend's interface —
 * a port free on loopback but busy on that interface would otherwise be
 * rejected for a server that was never going to bind there.
 */
export function devPortProbeHosts(configuredHost: string | undefined): ReadonlyArray<string> {
  const host = configuredHost?.trim();
  if (!host || DEV_PORT_PROBE_HOSTS.includes(host as (typeof DEV_PORT_PROBE_HOSTS)[number])) {
    return DEV_PORT_PROBE_HOSTS;
  }
  return [...DEV_PORT_PROBE_HOSTS, host];
}

const makeDefaultCheckPortAvailability =
  (configuredHost: string | undefined): PortAvailabilityCheck<NetService.NetService> =>
  (port, role) =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const hosts = role === "web" ? DEV_PORT_PROBE_HOSTS : devPortProbeHosts(configuredHost);
      return yield* checkPortAvailabilityOnHosts(port, hosts, (candidatePort, host) =>
        net.canListenOnHost(candidatePort, host),
      );
    });

const defaultCheckPortAvailability = makeDefaultCheckPortAvailability(undefined);

interface FindFirstAvailableOffsetInput<R = NetService.NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService.NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerPortExhaustedError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      if (requireWebPort && !isBrowserAllowedPort(webPort)) {
        continue;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort, "server"));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort, "web"));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerPortExhaustedError({
      startOffset,
      requireServerPort,
      requireWebPort,
      baseServerPort: BASE_SERVER_PORT,
      baseWebPort: BASE_WEB_PORT,
      maximumPort: MAX_PORT,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService.NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  /**
   * Refuse to move off the ports implied by `startOffset`. Set for the desktop
   * dev app, where the window URL and the proxy target are literals.
   */
  readonly strictPorts?: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService.NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  strictPorts = false,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerPortExhaustedError | DevRunnerPortUnavailableError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;
    // Name the knob, not a `key=value` pair: the value comes from a boolean
    // config, so quoting "=1" would misreport a run that set it to "true".
    const pinSource = "AWEN_STRICT_DEV_PORTS";

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      if (strictPorts) {
        const { webPort } = portPairForOffset(startOffset);
        if (!isBrowserAllowedPort(webPort) || !(yield* checkPort(webPort, "web"))) {
          return yield* new DevRunnerPortUnavailableError({
            mode,
            role: "web",
            port: webPort,
            pinSource,
          });
        }
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      if (strictPorts) {
        const { serverPort } = portPairForOffset(startOffset);
        if (!(yield* checkPort(serverPort, "server"))) {
          return yield* new DevRunnerPortUnavailableError({
            mode,
            role: "server",
            port: serverPort,
            pinSource,
          });
        }
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    if (strictPorts) {
      const { serverPort, webPort } = portPairForOffset(startOffset);
      if (
        !hasExplicitDevUrl &&
        (!isBrowserAllowedPort(webPort) || !(yield* checkPort(webPort, "web")))
      ) {
        return yield* new DevRunnerPortUnavailableError({
          mode,
          role: "web",
          port: webPort,
          pinSource,
        });
      }
      if (!hasExplicitServerPort && !(yield* checkPort(serverPort, "server"))) {
        return yield* new DevRunnerPortUnavailableError({
          mode,
          role: "server",
          port: serverPort,
          pinSource,
        });
      }
      return { serverOffset: startOffset, webOffset: startOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

/**
 * Poll for one control file.
 *
 * Polling rather than watching avoids platform-specific filesystem event
 * behavior and is cheap for one small path while the dev stack runs.
 */
function waitForDevRunnerFile(filePath: string) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    for (;;) {
      if (yield* fileSystem.exists(filePath)) return;
      yield* Effect.sleep(DEV_RUNNER_STOP_POLL_INTERVAL);
    }
  });
}

/**
 * Wait for a stop request and, when the daemon participates, its release ack.
 *
 * The request file stays visible while the daemon drains so both processes can
 * observe the same signal. The ack is written after the daemon scope closes
 * SQLite; waiting for it prevents the child-process finalizer from racing the
 * graceful shutdown. A timeout keeps a missing or unhealthy daemon bounded.
 */
function waitForDevRunnerStopRequest(stopRequestPath: string, stopRequestAckPath: string) {
  return Effect.gen(function* () {
    yield* waitForDevRunnerFile(stopRequestPath);
    const acknowledged = yield* waitForDevRunnerFile(stopRequestAckPath).pipe(
      Effect.timeoutOption(DEV_RUNNER_STOP_ACK_TIMEOUT),
    );
    if (Option.isNone(acknowledged)) {
      yield* Effect.logWarning(
        `[dev-runner] daemon did not acknowledge ${stopRequestAckPath}; forcing the child tree to stop`,
      );
    } else {
      yield* Effect.logInfo(`[dev-runner] daemon released ${stopRequestAckPath}`);
    }
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.remove(stopRequestPath, { force: true }).pipe(Effect.ignore);
        yield* fileSystem.remove(stopRequestAckPath, { force: true }).pipe(Effect.ignore);
      }),
    ),
  );
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly awenHome: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly share: boolean;
  readonly runArgs: ReadonlyArray<string>;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance, strictPorts } = yield* OffsetConfig.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerConfigurationError({
            configKeys: ["AWEN_PORT_OFFSET", "AWEN_DEV_INSTANCE", "AWEN_STRICT_DEV_PORTS"],
            cause,
          }),
      ),
    );

    // Single-origin browser dev proxies the backend at localhost. A wildcard
    // bind still answers there; a specific non-loopback interface does not,
    // which breaks every proxied request in a way that reads as "server is
    // broken" rather than "flag combination is unsupported". Reject it up
    // front instead. dev:server does not proxy — it talks to the daemon directly.
    if (
      (input.mode === "dev" || input.mode === "dev:web") &&
      input.host !== undefined &&
      !isProxiableBindHost(input.host)
    ) {
      return yield* new DevRunnerHostNotProxiableError({ mode: input.mode, host: input.host });
    }

    const path = yield* Path.Path;
    const hostPlatform = yield* HostProcessPlatform;
    const workingDirectory = yield* HostProcessWorkingDirectory;
    const worktreePath = yield* resolveGitWorktreePath(workingDirectory);
    const checkoutRoot = worktreePath ?? path.resolve(path.join(import.meta.dirname, ".."));

    const { offset, source } = yield* resolveOffset({
      portOffset,
      devInstance,
      worktreePath: checkoutRoot,
    });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      strictPorts: strictPorts ?? false,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
      // A non-loopback bind host decides whether the backend can actually take
      // the port, so it has to be probed alongside loopback.
      checkPortAvailability: makeDefaultCheckPortAvailability(input.host),
    });

    const hostEnvironment = yield* HostProcessEnvironment;
    const resolvedAwenHome = resolveDevHome({
      checkoutRoot,
      explicitHome: input.awenHome,
      worktreeRoot: worktreePath,
      ambientHome: hostEnvironment.AWEN_HOME,
    });
    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: hostEnvironment,
      serverOffset,
      webOffset,
      awenHome: resolvedAwenHome,
      browser: input.browser,
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
      logWebSocketEvents: input.logWebSocketEvents,
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";
    const baseDir = env.AWEN_HOME ?? (yield* DEFAULT_AWEN_HOME);
    const stopRequestPath =
      hostPlatform === "win32" ? devRunnerStopRequestPath(baseDir, process.pid) : undefined;
    const stopRequestAckPath =
      stopRequestPath === undefined ? undefined : devRunnerStopAckPath(stopRequestPath);
    if (stopRequestPath !== undefined && stopRequestAckPath !== undefined) {
      env.AWEN_DEV_RUNNER_STOP_FILE = stopRequestPath;
      env.AWEN_DEV_RUNNER_STOP_ACK_FILE = stopRequestAckPath;
    }
    const stopFileLog = stopRequestPath === undefined ? "" : ` stopFile=${String(stopRequestPath)}`;

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.AWEN_PORT)} webPort=${String(env.PORT)} baseDir=${baseDir}${stopFileLog}`,
    );

    // Before the share block: --dry-run only resolves and prints. Sharing would
    // replace, then tear down, whatever mapping the port already had — a
    // surprising side effect from a command documented as inert.
    if (input.dryRun) {
      return;
    }

    if (stopRequestPath !== undefined && stopRequestAckPath !== undefined) {
      const fileSystem = yield* FileSystem.FileSystem;
      yield* fileSystem.remove(stopRequestPath, { force: true }).pipe(Effect.ignore);
      yield* fileSystem.remove(stopRequestAckPath, { force: true }).pipe(Effect.ignore);
    }

    const sharedWebPort = BASE_WEB_PORT + webOffset;
    if (input.share) {
      if (input.mode === "dev:server") {
        yield* Effect.logInfo("[dev-runner] --share has no effect for dev:server (no web server).");
      } else {
        // acquireRelease, not share-then-addFinalizer: the mapping outlives this
        // process (and reboots), so the cleanup has to be registered atomically
        // with creating it. An interrupt landing in between would otherwise
        // leave a mapping pointing at a port nothing is listening on.
        //
        // Deliberately no ownership tracking beyond that: if a second runner
        // takes this port during a fast restart, the first's exit can briefly
        // tear down the new mapping — visible (the URL stops working) and fixed
        // by re-running --share. A lease protocol closing that window existed
        // and was removed as more machinery than a dev convenience warrants.
        //
        // A tailnet that isn't up shouldn't stop the dev server from starting —
        // warn, and carry on serving locally.
        const shared = yield* Effect.acquireRelease(
          shareDevServer({ webPort: sharedWebPort }),
          () =>
            // Serve config outlives this process, so a cleanup that did not
            // take leaves a tailnet URL pointing at a port nothing serves.
            unshareDevServer(sharedWebPort).pipe(
              Effect.flatMap((result) =>
                result.cleared
                  ? Effect.void
                  : Effect.logWarning(
                      `[dev-runner] could not remove the tailnet mapping for port ${String(sharedWebPort)}${
                        result.explanation ? `: ${result.explanation}` : ""
                      }. Remove it with \`tailscale serve --https=${String(sharedWebPort)} off\`.`,
                    ),
              ),
            ),
        ).pipe(
          Effect.tapError((error: DevShareError) =>
            Effect.logWarning(
              `[dev-runner] could not share on the tailnet: ${error.message}${
                error.hint ? ` — ${error.hint}` : ""
              }`,
            ),
          ),
          Effect.option,
          Effect.map(Option.getOrUndefined),
        );

        if (shared) {
          // The app is reached from the tailnet origin. Vite already allows
          // *.ts.net hosts; the backend needs the origin for credentialed
          // requests that bypass the proxy (for example, direct calls).
          env.AWEN_DEV_ALLOWED_ORIGINS = [env.AWEN_DEV_ALLOWED_ORIGINS, new URL(shared.url).origin]
            .filter((entry) => entry && entry.length > 0)
            .join(",");
          // The server builds its pairing URL from this, so the URL printed at
          // startup is already the shareable one — no rewriting by hand. An
          // explicit --dev-url still wins.
          if (input.devUrl === undefined) {
            env.VITE_DEV_SERVER_URL = shared.url;
          }
          // A shared origin serves a remote browser, where unbundled dev's
          // per-module requests each pay a tailnet round trip — a cold module
          // graph takes minutes to first paint. Bundled dev collapses that to
          // a few chunk requests. Only defaulted, so AWEN_BUNDLED_DEV=0
          // still opts a --share run back out.
          if (env.AWEN_BUNDLED_DEV === undefined) {
            env.AWEN_BUNDLED_DEV = "1";
          }
          yield* Effect.logInfo(`[dev-runner] shared on tailnet: ${shared.url}`);
        }
      }
    }

    const spawnCommand = yield* resolveSpawnCommand(
      "vp",
      [...MODE_ARGS[input.mode], ...input.runArgs],
      { env },
    );
    const processContext = {
      mode: input.mode,
      executable: "vp" as const,
      argumentCount: spawnCommand.args.length,
      shell: spawnCommand.shell,
    } as const;
    const child = yield* ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
      shell: spawnCommand.shell,
      // POSIX keeps Vite+ in the runner process group so terminal Ctrl+C
      // reaches the whole stack directly. Windows has no equivalent process
      // group: isolate Vite+ from the console event, let the runner handle the
      // interrupt, and rely on Effect finalization to run taskkill /T /F while
      // the Vite+ tree is still addressable.
      ...(hostPlatform === "win32" ? { detached: true, windowsHide: true } : { detached: false }),
      forceKillAfter: "1500 millis",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            ...processContext,
            operation: "spawn",
            cause,
          }),
      ),
    );

    const waitForStopRequest =
      stopRequestPath === undefined || stopRequestAckPath === undefined
        ? Effect.never
        : waitForDevRunnerStopRequest(stopRequestPath, stopRequestAckPath);
    const exitCode = yield* Effect.raceFirst(
      child.exitCode.pipe(Effect.map((code) => Option.some(Number(code)))),
      waitForStopRequest.pipe(Effect.as(Option.none<number>())),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            ...processContext,
            operation: "wait-for-exit",
            cause,
          }),
      ),
    );

    if (Option.isNone(exitCode)) {
      yield* Effect.logInfo("[dev-runner] stop requested; draining the child process tree");
      return;
    }
    if (exitCode.value !== 0) {
      return yield* new DevRunnerProcessExitError({
        ...processContext,
        exitCode: exitCode.value,
      });
    }
  });
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  awenHome: Flag.string("home-dir").pipe(
    Flag.withDescription(
      "Explicit Awen data directory; runtime state is stored under userdata (equivalent to AWEN_HOME). By default this checkout uses its own .awen directory so development state stays isolated.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  browser: Flag.boolean("browser").pipe(
    Flag.withDescription("Open a browser automatically (disabled by default for web dev)."),
    Flag.withDefault(false),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to AWEN_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("AWEN_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to AWEN_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("AWEN_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to AWEN_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("AWEN_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to AWEN_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("AWEN_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription(
      "Explicit web dev URL override (forwards to VITE_DEV_SERVER_URL). Ambient VITE_DEV_SERVER_URL values are ignored so a parent dev app cannot redirect the child runner.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn Vite+."),
    Flag.withDefault(false),
  ),
  share: Flag.boolean("share").pipe(
    Flag.withDescription(
      "Publish the web dev server on this machine's tailnet over HTTPS (via `tailscale serve`) and print the pairing URL for it. Removed again on exit.",
    ),
    Flag.withDefault(false),
  ),
  runArgs: Argument.string("run-arg").pipe(
    Argument.withDescription("Additional Vite+ run args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
