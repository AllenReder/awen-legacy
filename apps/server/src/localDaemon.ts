// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
// This module is also the small standalone launcher called by the native
// desktop shell. Keep its process and filesystem boundary on Node built-ins so
// it can start the server before the rest of the server runtime is loadable.
// Its one non-built-in import is the dependency-free port contract in
// `@awen/shared/daemonPort`: the desktop dev wrapper resolves the same daemon
// port for the web dev proxy, so a second copy here silently disagreed with it
// (issue #87). Keep that import free of transitive runtime dependencies.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

import {
  describeInvalidDaemonPort,
  resolveDaemonPortRequest,
  type DaemonPortRequest,
} from "@awen/shared/daemonPort";

import {
  LOCAL_DAEMON_HANDSHAKE_PATH,
  LOCAL_DAEMON_OWNER,
  LOCAL_DAEMON_PROTOCOL_VERSION,
  type LocalDaemonHandshake,
} from "./localDaemonProtocol.ts";

export {
  LOCAL_DAEMON_HANDSHAKE_PATH,
  LOCAL_DAEMON_OWNER,
  LOCAL_DAEMON_PROTOCOL_VERSION,
} from "./localDaemonProtocol.ts";

const DISCOVERY_VERSION = 1 as const;
const LOCK_WAIT_MS = 25;
const LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_START_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 750;
const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

export interface LocalDaemonPaths {
  readonly stateDir: string;
  readonly runtimeStatePath: string;
  readonly credentialPath: string;
  readonly launchLockPath: string;
  readonly logPath: string;
}

export interface LocalDaemonDiscovery {
  readonly version: typeof DISCOVERY_VERSION;
  readonly daemonProtocolVersion: typeof LOCAL_DAEMON_PROTOCOL_VERSION;
  readonly daemonId: string;
  readonly daemonOwner: typeof LOCAL_DAEMON_OWNER;
  readonly daemonWorkingDirectory: string;
  readonly daemonManaged: true;
  readonly pid: number;
  readonly origin: string;
  readonly startedAt: string;
}

export interface LocalDaemonDescriptor {
  readonly daemonId: string;
  readonly pid: number;
  readonly origin: string;
  readonly protocolVersion: typeof LOCAL_DAEMON_PROTOCOL_VERSION;
}

export type LocalDaemonInspection =
  | { readonly status: "absent" }
  | { readonly status: "invalid"; readonly detail: string }
  | { readonly status: "stale"; readonly state: LocalDaemonDiscovery }
  | {
      readonly status: "unreachable";
      readonly state: LocalDaemonDiscovery;
      readonly detail: string;
    }
  | { readonly status: "foreign"; readonly state: LocalDaemonDiscovery; readonly detail: string }
  | { readonly status: "auth-missing"; readonly state: LocalDaemonDiscovery }
  | { readonly status: "auth-invalid"; readonly state: LocalDaemonDiscovery }
  | {
      readonly status: "auth-unavailable";
      readonly state: LocalDaemonDiscovery;
      readonly detail: string;
    }
  | {
      readonly status: "ready";
      readonly state: LocalDaemonDiscovery;
      readonly activeWork?: boolean;
    };

export interface LocalDaemonLaunchOptions {
  readonly baseDir: string;
  readonly timeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly reservePort?: () => Promise<number>;
  readonly serverInvocation?: LocalDaemonServerInvocation;
  readonly currentDirectory?: string;
  readonly expectedServerVersion?: string;
  readonly bindHost?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export interface LocalDaemonServerInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface LocalDaemonStopOptions {
  readonly baseDir: string;
  readonly confirm: boolean;
  readonly requestTimeoutMs?: number;
  readonly stopTimeoutMs?: number;
}

export type LocalDaemonStopResult =
  | { readonly status: "absent" | "stale"; readonly daemonId?: string }
  | {
      readonly status: "confirmation-required";
      readonly daemonId: string;
      readonly pid: number;
      readonly activeWork: boolean | "unknown";
    }
  | { readonly status: "stopped"; readonly daemonId: string; readonly pid: number };

export class LocalDaemonError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "LocalDaemonError";
    this.code = code;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isLoopbackOrigin = (rawOrigin: unknown): rawOrigin is string => {
  if (!isNonEmptyString(rawOrigin)) return false;
  try {
    const url = new URL(rawOrigin);
    return (
      url.protocol === "http:" &&
      url.username === "" &&
      url.password === "" &&
      LOOPBACK_HOSTNAMES.has(url.hostname.toLowerCase()) &&
      url.port.length > 0 &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
};

const normalizeOrigin = (rawOrigin: string): string => {
  const url = new URL(rawOrigin);
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
};

export function deriveLocalDaemonPaths(baseDir: string): LocalDaemonPaths {
  const stateDir = NodePath.join(baseDir, "userdata");
  return {
    stateDir,
    runtimeStatePath: NodePath.join(stateDir, "server-runtime.json"),
    credentialPath: NodePath.join(stateDir, "secrets", "desktop-bootstrap.token"),
    launchLockPath: NodePath.join(stateDir, "daemon-launch.lock"),
    logPath: NodePath.join(stateDir, "logs", "daemon.log"),
  };
}

export function makeLocalDaemonDiscovery(input: {
  readonly daemonId: string;
  readonly pid: number;
  readonly origin: string;
  readonly startedAt: string;
  readonly workingDirectory?: string;
}): LocalDaemonDiscovery {
  return {
    version: DISCOVERY_VERSION,
    daemonProtocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
    daemonId: input.daemonId,
    daemonOwner: LOCAL_DAEMON_OWNER,
    daemonWorkingDirectory: input.workingDirectory ?? process.cwd(),
    daemonManaged: true,
    pid: input.pid,
    origin: normalizeOrigin(input.origin),
    startedAt: input.startedAt,
  };
}

export function parseLocalDaemonDiscovery(value: unknown): LocalDaemonDiscovery | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== DISCOVERY_VERSION) return undefined;
  if (value.daemonProtocolVersion !== LOCAL_DAEMON_PROTOCOL_VERSION) return undefined;
  if (value.daemonManaged !== true) return undefined;
  if (!isNonEmptyString(value.daemonId)) return undefined;
  if (value.daemonOwner !== LOCAL_DAEMON_OWNER) return undefined;
  if (!isNonEmptyString(value.daemonWorkingDirectory)) return undefined;
  if (!Number.isInteger(value.pid) || Number(value.pid) <= 0) return undefined;
  if (!isLoopbackOrigin(value.origin)) return undefined;
  if (!isNonEmptyString(value.startedAt)) return undefined;

  return {
    version: DISCOVERY_VERSION,
    daemonProtocolVersion: LOCAL_DAEMON_PROTOCOL_VERSION,
    daemonId: value.daemonId.trim(),
    daemonOwner: LOCAL_DAEMON_OWNER,
    daemonWorkingDirectory: value.daemonWorkingDirectory.trim(),
    daemonManaged: true,
    pid: Number(value.pid),
    origin: normalizeOrigin(value.origin),
    startedAt: value.startedAt,
  };
}

const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause instanceof Error && "code" in cause && cause.code === "EPERM";
  }
};

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });

interface LockRecord {
  readonly ownerId: string;
  readonly pid: number;
}

async function readLockRecord(path: string): Promise<LockRecord | undefined> {
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    if (!isRecord(value) || !isNonEmptyString(value.ownerId) || !Number.isInteger(value.pid)) {
      return undefined;
    }
    return { ownerId: value.ownerId, pid: Number(value.pid) };
  } catch {
    return undefined;
  }
}

export async function withLocalDaemonLaunchLock<A>(
  baseDir: string,
  operation: () => Promise<A>,
): Promise<A> {
  const paths = deriveLocalDaemonPaths(baseDir);
  await NodeFSP.mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  const ownerId = NodeCrypto.randomUUID();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;

  // Publish a complete owner record atomically. Opening the shared path with
  // "wx" first leaves an empty, unrecoverable lock if the launcher is killed
  // before writeFile. A crash before link leaves only a private candidate;
  // a crash after link leaves a valid PID record that dead-owner recovery handles.
  const candidatePath = `${paths.launchLockPath}.${ownerId}`;
  try {
    const handle = await NodeFSP.open(candidatePath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ ownerId, pid: process.pid })}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    for (;;) {
      try {
        await NodeFSP.link(candidatePath, paths.launchLockPath);
        break;
      } catch (cause) {
        if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) {
          throw cause;
        }

        const existing = await readLockRecord(paths.launchLockPath);
        if (existing === undefined && Date.now() >= deadline) {
          throw new LocalDaemonError(
            "launch-lock-timeout",
            "The local daemon launch lock is invalid and did not clear; refusing to start another daemon.",
          );
        }
        if (existing && !isProcessAlive(existing.pid)) {
          await NodeFSP.rm(paths.launchLockPath, { force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new LocalDaemonError(
            "launch-lock-timeout",
            "Another local daemon operation did not finish before the launch lock expired.",
          );
        }
        await delay(LOCK_WAIT_MS);
      }
    }
  } finally {
    await NodeFSP.rm(candidatePath, { force: true });
  }

  try {
    return await operation();
  } finally {
    const current = await readLockRecord(paths.launchLockPath);
    if (current?.ownerId === ownerId) {
      await NodeFSP.rm(paths.launchLockPath, { force: true });
    }
  }
}

async function readDiscovery(
  paths: LocalDaemonPaths,
): Promise<{ readonly state: LocalDaemonDiscovery | undefined; readonly detail?: string }> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(paths.runtimeStatePath, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return { state: undefined };
    }
    return { state: undefined, detail: "Could not read the local daemon discovery record." };
  }

  try {
    const parsed = parseLocalDaemonDiscovery(JSON.parse(raw));
    return parsed
      ? { state: parsed }
      : {
          state: undefined,
          detail: "The local daemon discovery record is invalid or unsupported.",
        };
  } catch {
    return { state: undefined, detail: "The local daemon discovery record is not valid JSON." };
  }
}

interface JsonResponse {
  readonly status: number;
  readonly body: unknown;
}

const requestJson = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<JsonResponse> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown;
    try {
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
};

const expectedHandshake = (value: unknown): value is LocalDaemonHandshake => {
  if (!isRecord(value)) return false;
  return (
    value.protocolVersion === LOCAL_DAEMON_PROTOCOL_VERSION &&
    value.owner === LOCAL_DAEMON_OWNER &&
    (typeof value.daemonId === "string" || value.daemonId === null) &&
    Number.isInteger(value.pid) &&
    typeof value.managed === "boolean"
  );
};

const describeRequestFailure = (cause: unknown): string => {
  if (cause instanceof Error && cause.name === "AbortError") {
    return "The local daemon did not answer its handshake in time.";
  }
  return "The local daemon endpoint could not be reached.";
};

export async function inspectLocalDaemon(
  baseDir: string,
  options?: {
    readonly verifyCredential?: boolean;
    readonly requestTimeoutMs?: number | undefined;
  },
): Promise<LocalDaemonInspection> {
  const paths = deriveLocalDaemonPaths(baseDir);
  const discovery = await readDiscovery(paths);
  if (discovery.detail !== undefined) {
    return { status: "invalid", detail: discovery.detail };
  }
  if (discovery.state === undefined) return { status: "absent" };

  const state = discovery.state;
  if (!isProcessAlive(state.pid)) return { status: "stale", state };

  const requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  let handshakeResponse: JsonResponse;
  try {
    handshakeResponse = await requestJson(
      new URL(LOCAL_DAEMON_HANDSHAKE_PATH, state.origin).toString(),
      { method: "GET", headers: { accept: "application/json" } },
      requestTimeoutMs,
    );
  } catch (cause) {
    return { status: "unreachable", state, detail: describeRequestFailure(cause) };
  }

  if (handshakeResponse.status !== 200 || !expectedHandshake(handshakeResponse.body)) {
    return {
      status: "foreign",
      state,
      detail: "The process at the recorded endpoint did not provide the Awen daemon handshake.",
    };
  }
  const handshake = handshakeResponse.body;
  if (!handshake.managed || handshake.daemonId !== state.daemonId || handshake.pid !== state.pid) {
    return {
      status: "foreign",
      state,
      detail: "The recorded process identity does not match the Awen daemon handshake.",
    };
  }

  const activeWork = typeof handshake.activeWork === "boolean" ? handshake.activeWork : undefined;
  if (options?.verifyCredential === false) {
    return activeWork === undefined
      ? { status: "ready", state }
      : { status: "ready", state, activeWork };
  }

  let credential: string;
  try {
    credential = (await NodeFSP.readFile(paths.credentialPath, "utf8")).trim();
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return { status: "auth-missing", state };
    }
    return { status: "auth-unavailable", state, detail: "Could not read the daemon credential." };
  }
  if (credential.length === 0) return { status: "auth-invalid", state };

  let authResponse: JsonResponse;
  try {
    authResponse = await requestJson(
      new URL("/api/auth/browser-session", state.origin).toString(),
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ credential }),
      },
      requestTimeoutMs,
    );
  } catch {
    return {
      status: "auth-unavailable",
      state,
      detail: "The daemon handshake succeeded, but its authentication endpoint is unavailable.",
    };
  }
  if (authResponse.status === 401 || authResponse.status === 403) {
    return { status: "auth-invalid", state };
  }
  if (authResponse.status < 200 || authResponse.status >= 300) {
    return {
      status: "auth-unavailable",
      state,
      detail: "The daemon rejected its local authentication check unexpectedly.",
    };
  }
  return activeWork === undefined
    ? { status: "ready", state }
    : { status: "ready", state, activeWork };
}

const descriptorFromState = (state: LocalDaemonDiscovery): LocalDaemonDescriptor => ({
  daemonId: state.daemonId,
  pid: state.pid,
  origin: state.origin,
  protocolVersion: state.daemonProtocolVersion,
});

const inspectionError = (inspection: Exclude<LocalDaemonInspection, { status: "ready" }>) => {
  switch (inspection.status) {
    case "absent":
      return new LocalDaemonError("daemon-absent", "The local daemon is not running.");
    case "invalid":
      return new LocalDaemonError("discovery-invalid", inspection.detail);
    case "stale":
      return new LocalDaemonError(
        "discovery-stale",
        "The local daemon discovery record is stale; refusing to guess which process owns the data root.",
      );
    case "unreachable":
      return new LocalDaemonError("daemon-unreachable", inspection.detail);
    case "foreign":
      return new LocalDaemonError("daemon-ownership-mismatch", inspection.detail);
    case "auth-missing":
      return new LocalDaemonError(
        "credential-missing",
        "The local daemon credential is missing; refusing to reset it or create a second daemon.",
      );
    case "auth-invalid":
      return new LocalDaemonError(
        "credential-invalid",
        "The local daemon credential was rejected; refusing to reset data or start another daemon.",
      );
    case "auth-unavailable":
      return new LocalDaemonError("credential-check-failed", inspection.detail);
  }
};

const canListenOnLoopback = async (port: number): Promise<boolean> => {
  const server = NodeNet.createServer();
  return new Promise<boolean>((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
};

/**
 * The daemon port a caller asked for, and whether that request is a contract.
 *
 * The key list and its precedence live in `@awen/shared/daemonPort`, because
 * the desktop dev wrapper must resolve the very same port for the web dev proxy;
 * two copies silently disagreed and left the proxy dialing a port nothing served
 * while a healthy daemon listened elsewhere. This is the launcher's validated
 * read of that contract: the shared shape, with an unusable value already
 * reported as the launcher's own error.
 */
export function requestedDaemonPort(env: NodeJS.ProcessEnv = process.env): DaemonPortRequest {
  const request = resolveDaemonPortRequest(env);
  if (request._tag === "invalid") {
    throw new LocalDaemonError("daemon-port-invalid", describeInvalidDaemonPort(request));
  }
  return request;
}

type SetDaemonPortRequest = Extract<DaemonPortRequest, { readonly _tag: "set" }>;

const daemonPortUnavailableMessage = (key: string, port: number): string =>
  `${key}=${String(port)} is already in use, and a configured daemon port is a contract: the desktop shell and the web dev server both address the daemon there, so binding another port would leave every proxied request unanswered. Free it (\`lsof -nP -iTCP:${String(port)} -sTCP:LISTEN\`) or unset ${key} to let the launcher choose a free port.`;

const throwDaemonPortUnavailable = (requested: SetDaemonPortRequest): never => {
  throw new LocalDaemonError(
    "daemon-port-unavailable",
    daemonPortUnavailableMessage(requested.key, requested.port),
  );
};

/**
 * Refuse a start that cannot honour a *required* daemon port before it stops
 * anything.
 *
 * Reconciliation below stops the daemon that runs on a different port, and only
 * then reserves the port to replace it — where a foreign process holding that
 * number fails the start. Failing after the stop would take a working daemon
 * down and leave nothing running, so the contract is checked up front. A
 * preference port is deliberately not checked here: falling back to a free port
 * is its documented behaviour.
 */
async function assertRequestedPortAvailable(requested: DaemonPortRequest): Promise<void> {
  if (requested._tag !== "set" || !requested.required) return;
  if (await canListenOnLoopback(requested.port)) return;
  throwDaemonPortUnavailable(requested);
}

async function reserveLoopbackPort(): Promise<number> {
  const requested = requestedDaemonPort();
  if (requested._tag === "set") {
    if (await canListenOnLoopback(requested.port)) {
      return requested.port;
    }
    if (requested.required) {
      throwDaemonPortUnavailable(requested);
    }
  }

  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : undefined;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (port === undefined) {
    throw new LocalDaemonError("port-allocation-failed", "Could not reserve a local daemon port.");
  }
  return port;
}

const defaultServerInvocation = (): LocalDaemonServerInvocation => {
  const entry = process.argv[1];
  if (!entry || !/\.(?:c|m)?js$|\.ts$/u.test(entry)) {
    // A Node single-executable has no file-backed entrypoint. Re-running the
    // executable with the `serve` subcommand keeps the same bundled runtime.
    return { command: process.execPath, args: [] };
  }
  return {
    command: process.execPath,
    args: [NodePath.isAbsolute(entry) ? entry : NodePath.resolve(process.cwd(), entry)],
  };
};

async function writeCredentialIfMissing(path: string): Promise<string> {
  const directory = NodePath.dirname(path);
  await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(directory, 0o700);
  try {
    const existing = (await NodeFSP.readFile(path, "utf8")).trim();
    if (existing.length > 0) {
      await NodeFSP.chmod(path, 0o600);
      return existing;
    }
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  const credential = NodeCrypto.randomBytes(32).toString("base64url");
  const tempPath = `${path}.${process.pid}.${NodeCrypto.randomUUID()}.tmp`;
  try {
    const handle = await NodeFSP.open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${credential}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await NodeFSP.rename(tempPath, path);
    await NodeFSP.chmod(path, 0o600);
    return credential;
  } finally {
    await NodeFSP.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function spawnManagedServer(input: {
  readonly baseDir: string;
  readonly paths: LocalDaemonPaths;
  readonly daemonId: string;
  readonly credential: string;
  readonly port: number;
  readonly options: LocalDaemonLaunchOptions;
}): Promise<NodeChildProcess.ChildProcess> {
  await NodeFSP.mkdir(NodePath.dirname(input.paths.logPath), { recursive: true, mode: 0o700 });
  const logHandle = await NodeFSP.open(input.paths.logPath, "a", 0o600);
  const invocation = input.options.serverInvocation ?? defaultServerInvocation();
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...input.options.environment,
    AWEN_HOME: input.baseDir,
    AWEN_MODE: "desktop",
    AWEN_HOST: input.options.bindHost ?? "127.0.0.1",
    AWEN_PORT: String(input.port),
    AWEN_NO_BROWSER: "1",
    AWEN_DAEMON_ID: input.daemonId,
    AWEN_DAEMON_OWNER: LOCAL_DAEMON_OWNER,
    AWEN_DAEMON_WORKING_DIR: input.options.currentDirectory ?? process.cwd(),
    AWEN_DAEMON_MANAGED: "1",
    AWEN_DESKTOP_BOOTSTRAP_TOKEN: input.credential,
  };
  const child = NodeChildProcess.spawn(
    invocation.command,
    [
      ...invocation.args,
      "serve",
      "--mode",
      "desktop",
      "--host",
      input.options.bindHost ?? "127.0.0.1",
      "--port",
      String(input.port),
      "--base-dir",
      input.baseDir,
      "--no-browser",
    ],
    {
      cwd: input.options.currentDirectory ?? process.cwd(),
      env: environment,
      detached: true,
      stdio: ["ignore", logHandle.fd, logHandle.fd],
      windowsHide: true,
    },
  );
  await logHandle.close();
  child.unref();
  return child;
}

async function waitForManagedDaemon(input: {
  readonly child: NodeChildProcess.ChildProcess;
  readonly paths: LocalDaemonPaths;
  readonly daemonId: string;
  readonly port: number;
  readonly timeoutMs: number;
  readonly requestTimeoutMs: number;
}): Promise<void> {
  const origin = `http://127.0.0.1:${String(input.port)}/`;
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    if (input.child.exitCode !== null || input.child.signalCode !== null) {
      throw new LocalDaemonError(
        "daemon-start-failed",
        "The local daemon exited before completing its ownership handshake.",
      );
    }
    try {
      const response = await requestJson(
        new URL(LOCAL_DAEMON_HANDSHAKE_PATH, origin).toString(),
        { method: "GET", headers: { accept: "application/json" } },
        input.requestTimeoutMs,
      );
      if (response.status === 200 && expectedHandshake(response.body)) {
        const handshake = response.body;
        if (
          handshake.managed &&
          handshake.daemonId === input.daemonId &&
          handshake.pid === input.child.pid
        ) {
          // The handshake route is live before server activation persists the
          // runtime descriptor. Returning on the handshake alone lets the very
          // next inspection read `daemon-absent` while startup is still finishing.
          const discovery = await readDiscovery(input.paths);
          if (
            discovery.state?.daemonId === input.daemonId &&
            discovery.state.pid === input.child.pid
          ) {
            return;
          }
        } else {
          throw new LocalDaemonError(
            "daemon-ownership-mismatch",
            "A process answered on the selected port, but it is not the daemon this launcher started.",
          );
        }
      }
    } catch (cause) {
      if (cause instanceof LocalDaemonError) throw cause;
    }
    if (Date.now() >= deadline) {
      throw new LocalDaemonError(
        "daemon-start-timeout",
        "The local daemon did not become ready before the startup deadline.",
      );
    }
    await delay(50);
  }
}

async function terminateSpawnedChild(child: NodeChildProcess.ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  try {
    child.kill("SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, DEFAULT_STOP_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

const portOfOrigin = (origin: string | undefined): number | undefined => {
  if (origin === undefined) return undefined;
  try {
    const port = new URL(origin).port;
    return port.length > 0 ? Number(port) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The endpoint a leftover record points at, read without requiring daemon
 * ownership. A web-mode dev server writes `server-runtime.json` without
 * `daemonManaged`, so this is how the launcher finds the port it holds. The
 * value never becomes a reported discovery state and never authorises signalling
 * the recorded process — a pid can be reused.
 */
async function readRecordedOrigin(paths: LocalDaemonPaths): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await NodeFSP.readFile(paths.runtimeStatePath, "utf8"));
    if (!isRecord(value) || value.version !== DISCOVERY_VERSION) return undefined;
    const rawOrigin = value.origin;
    return isLoopbackOrigin(rawOrigin) ? normalizeOrigin(rawOrigin) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide what to do with a discovery record the launcher cannot attach to.
 *
 * Reconciliation is keyed on the recorded endpoint, never on the record's own
 * ownership claim: a killed daemon and a web-mode dev server both leave records
 * that do not describe a live managed daemon. A bindable port is proof the
 * writer is gone, so the record may be replaced. If something still answers on
 * the recorded port and it is not this record's managed daemon, starting a
 * second process would share one data root with a process we do not own — name
 * the conflict and leave that process alone.
 */
async function reconcileUnattachedRecord(input: {
  readonly paths: LocalDaemonPaths;
  readonly existing: Exclude<LocalDaemonInspection, { status: "ready" | "absent" }>;
}): Promise<void> {
  const { paths, existing } = input;
  const recordedOrigin =
    "state" in existing ? existing.state.origin : await readRecordedOrigin(paths);
  const recordedPort = portOfOrigin(recordedOrigin);

  if (recordedPort === undefined) {
    // A malformed or unlocatable record: refuse rather than guess whether some
    // process still owns this data root.
    throw inspectionError(existing);
  }

  if (!(await canListenOnLoopback(recordedPort))) {
    if (
      existing.status === "auth-missing" ||
      existing.status === "auth-invalid" ||
      existing.status === "auth-unavailable"
    ) {
      // Our daemon answers there; its credential problem has its own fix, and
      // resetting it or binding a second daemon is not this launcher's call.
      throw inspectionError(existing);
    }
    // Anything else on the recorded port is a process we did not start. A
    // `pnpm dev` server sharing this checkout is the usual cause; name the
    // conflict so the next step is obvious.
    throw new LocalDaemonError(
      "daemon-port-occupied",
      `A process is already listening on the recorded daemon port ${String(recordedPort)}, and it is not an Awen-managed daemon this launcher can attach to. Stop it (a \`pnpm dev\` server sharing this checkout is the usual cause) before starting the desktop daemon.`,
    );
  }

  // The port is free, so whoever wrote the record no longer serves it. Remove
  // the stale record and let the caller start a fresh managed daemon. The old
  // process is deliberately not signalled: pid liveness alone is not proof we
  // started it.
  await NodeFSP.rm(paths.runtimeStatePath, { force: true }).catch(() => undefined);
}

export async function startLocalDaemon(
  options: LocalDaemonLaunchOptions,
): Promise<LocalDaemonDescriptor> {
  return withLocalDaemonLaunchLock(options.baseDir, async () => {
    const paths = deriveLocalDaemonPaths(options.baseDir);
    const existing = await inspectLocalDaemon(options.baseDir, {
      requestTimeoutMs: options.requestTimeoutMs,
    });
    // Resolved through the same helper as `reserveLoopbackPort`, because a
    // disagreement between the two would make the launcher stop a daemon and
    // then rebind the very port it just gave up.
    const requested = requestedDaemonPort();

    if (existing.status === "ready") {
      let versionMatches = true;
      if (options.expectedServerVersion !== undefined) {
        const descriptor = await requestJson(
          new URL("/.well-known/awen/environment", existing.state.origin).href,
          { method: "GET", headers: { accept: "application/json" } },
          options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        );
        if (
          descriptor.status !== 200 ||
          !isRecord(descriptor.body) ||
          typeof descriptor.body.serverVersion !== "string"
        ) {
          throw new LocalDaemonError(
            "daemon-version-unavailable",
            "Cannot verify the running daemon version.",
          );
        }
        versionMatches = descriptor.body.serverVersion === options.expectedServerVersion;
      }
      const portMatches =
        requested._tag !== "set" || portOfOrigin(existing.state.origin) === requested.port;
      if (versionMatches && portMatches) return descriptorFromState(existing.state);
      // Version replacement is atomic under the launch lock and only signals a
      // daemon whose identity and bootstrap credential were verified above.
      if (!portMatches) await assertRequestedPortAvailable(requested);
      await stopLocalDaemonLocked({ baseDir: options.baseDir, confirm: true });
    } else if (existing.status !== "absent") {
      await reconcileUnattachedRecord({ paths, existing });
    }

    // A required daemon port that cannot be taken must fail before anything is
    // stopped or spawned. `reconcileUnattachedRecord` refuses a recorded
    // endpoint still held by a process we do not own; this covers the requested
    // port even when no record points at it.
    await assertRequestedPortAvailable(requested);

    const credential = await writeCredentialIfMissing(paths.credentialPath);
    const daemonId = NodeCrypto.randomUUID();
    const port = await (options.reservePort ?? reserveLoopbackPort)();
    const child = await spawnManagedServer({
      baseDir: options.baseDir,
      paths,
      daemonId,
      credential,
      port,
      options,
    });
    try {
      await waitForManagedDaemon({
        child,
        paths,
        daemonId,
        port,
        timeoutMs: options.timeoutMs ?? DEFAULT_START_TIMEOUT_MS,
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      });
    } catch (cause) {
      await terminateSpawnedChild(child);
      throw cause;
    }

    const running = await inspectLocalDaemon(options.baseDir, {
      requestTimeoutMs: options.requestTimeoutMs,
    });
    if (running.status !== "ready") throw inspectionError(running);
    return descriptorFromState(running.state);
  });
}

export async function inspectAndFormatLocalDaemon(baseDir: string): Promise<LocalDaemonInspection> {
  return inspectLocalDaemon(baseDir);
}

/**
 * Stop the recorded daemon, acquiring the launch lock first.
 *
 * Callers that already hold the lock for a wider sequence must use
 * {@link stopLocalDaemonLocked} instead — see startLocalDaemon.
 */
export async function stopLocalDaemon(
  options: LocalDaemonStopOptions,
): Promise<LocalDaemonStopResult> {
  return withLocalDaemonLaunchLock(options.baseDir, () => stopLocalDaemonLocked(options));
}

/**
 * Stop the recorded daemon while the caller holds the launch lock.
 *
 * `withLocalDaemonLaunchLock` is a file lock keyed on the data root, and its
 * recovery path treats a record whose pid is still alive as an owner: from
 * inside this same process that pid is *ours*, so a nested acquisition can
 * never break the lock and only ends in `launch-lock-timeout` after
 * LOCK_TIMEOUT_MS. Nesting is therefore explicit — the lock is taken once by
 * the outermost operation and the inner steps run against this variant.
 */
async function stopLocalDaemonLocked(
  options: LocalDaemonStopOptions,
): Promise<LocalDaemonStopResult> {
  const inspection = await inspectLocalDaemon(options.baseDir, {
    verifyCredential: false,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  if (inspection.status === "absent") return { status: "absent" };
  if (inspection.status === "stale")
    return { status: "stale", daemonId: inspection.state.daemonId };
  if (inspection.status !== "ready") throw inspectionError(inspection);

  const { state } = inspection;
  const revalidated = await inspectLocalDaemon(options.baseDir, {
    verifyCredential: false,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  if (
    revalidated.status !== "ready" ||
    revalidated.state.daemonId !== state.daemonId ||
    revalidated.state.pid !== state.pid
  ) {
    throw new LocalDaemonError(
      "daemon-ownership-changed",
      "The daemon identity changed before the explicit stop request; refusing to signal the recorded PID.",
    );
  }
  if (!options.confirm) {
    return {
      status: "confirmation-required",
      daemonId: revalidated.state.daemonId,
      pid: revalidated.state.pid,
      activeWork: revalidated.activeWork ?? "unknown",
    };
  }

  try {
    process.kill(state.pid, "SIGTERM");
  } catch (cause) {
    throw new LocalDaemonError(
      "daemon-stop-failed",
      cause instanceof Error ? cause.message : "Could not signal the local daemon.",
    );
  }

  const deadline = Date.now() + (options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
  while (isProcessAlive(state.pid) && Date.now() < deadline) {
    await delay(50);
  }
  if (isProcessAlive(state.pid)) {
    try {
      process.kill(state.pid, "SIGKILL");
    } catch {
      throw new LocalDaemonError(
        "daemon-stop-timeout",
        "The local daemon did not exit after the explicit stop request.",
      );
    }
  }

  const paths = deriveLocalDaemonPaths(options.baseDir);
  const after = await readDiscovery(paths);
  if (after.state?.daemonId === state.daemonId && after.state.pid === state.pid) {
    await NodeFSP.rm(paths.runtimeStatePath, { force: true });
  }
  return { status: "stopped", daemonId: state.daemonId, pid: state.pid };
}

export function localDaemonResultForJson(value: unknown): string {
  return JSON.stringify(value);
}

export function localDaemonErrorForJson(cause: unknown): string {
  const error = cause instanceof LocalDaemonError ? cause : undefined;
  return JSON.stringify({
    ok: false,
    error: {
      code: error?.code ?? "daemon-launch-failed",
      message: error?.message ?? "The local daemon operation failed.",
    },
  });
}

export function localDaemonDescriptorForJson(descriptor: LocalDaemonDescriptor): string {
  return JSON.stringify({ ok: true, ...descriptor });
}

// Keep Node's type checker aware that the standalone launcher intentionally
// uses the numeric file descriptor form for child stdio on all supported OSes.
void NodeFS;
