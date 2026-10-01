/**
 * One authority for where the Awen daemon lives in development.
 *
 * The bind side and the address side run as separate processes:
 * `apps/server/src/localDaemon.ts` binds the port, while the desktop dev wrapper
 * `scripts/dev-runner.ts` tells the web dev server which port to
 * proxy to and which URL the Electron window loads. When each carried its own copy
 * of these rules the two disagreed — the wrapper resolved only two of the four
 * keys, so a developer's `AWEN_DAEMON_PORT` was shadowed by the wrapper's
 * default, the daemon bound elsewhere, and every proxied request failed against
 * a port nothing served. See issue #87.
 */

/** Base ports at offset 0: the daemon, and the web dev server beside it. */
export const BASE_DAEMON_PORT = 13_773;
export const BASE_WEB_DEV_PORT = 5_733;

export interface DaemonPortKey {
  readonly key: string;
  /**
   * `true` when the key names the daemon port itself: a daemon that cannot take
   * that number must fail loudly rather than bind a different one, because the
   * runtime descriptor and every client address it by that port. `false` for the
   * server's general port preference, where falling back to a free port keeps a
   * leftover listener from blocking `pnpm dev`.
   */
  readonly required: boolean;
}

/** Precedence order: the first key holding a non-blank value wins. */
export const DAEMON_PORT_KEYS: ReadonlyArray<DaemonPortKey> = [
  { key: "AWEN_DAEMON_PORT", required: true },
  { key: "AWEN_PORT", required: false },
];

export type DaemonPortRequest =
  | { readonly _tag: "unset" }
  | { readonly _tag: "invalid"; readonly key: string; readonly raw: string }
  | {
      readonly _tag: "set";
      readonly key: string;
      readonly port: number;
      readonly required: boolean;
    };

export type PortOffsetRequest =
  | { readonly _tag: "unset" }
  | { readonly _tag: "invalid"; readonly raw: string }
  | { readonly _tag: "set"; readonly offset: number };

/** Every caller reads ports from an environment; only `process.env` is ever passed. */
type Environment = Readonly<Record<string, string | undefined>>;

export function resolveDaemonPortRequest(env: Environment): DaemonPortRequest {
  for (const { key, required } of DAEMON_PORT_KEYS) {
    const raw = env[key]?.trim();
    if (raw === undefined || raw.length === 0) continue;
    const port = Number(raw);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      return { _tag: "invalid", key, raw };
    }
    return { _tag: "set", key, port, required };
  }

  return { _tag: "unset" };
}

/**
 * `AWEN_PORT_OFFSET` shifts both base ports so concurrent sessions stop
 * colliding. The runner's own `--port-offset`/config surface validates the same
 * rule for its flag; this is the env surface the desktop wrapper reads.
 */
export function resolvePortOffset(env: Environment): PortOffsetRequest {
  const raw = env.AWEN_PORT_OFFSET?.trim();
  if (raw === undefined || raw.length === 0) return { _tag: "unset" };
  const offset = Number(raw);
  if (!Number.isInteger(offset) || offset < 0) return { _tag: "invalid", raw };
  return { _tag: "set", offset };
}

/** Upper bound for a path-derived offset, so ports stay in a sane band. */
export const MAX_HASH_OFFSET = 3000;

/**
 * Deterministic string hash for a path- or instance-derived offset.
 *
 * An exact, dependency-free copy of `effect/Hash.string` (djb2 over UTF-16 code
 * units, then `optimize`). It is hand-written rather than imported because the
 * standalone daemon launcher imports this module before the Effect runtime is
 * loadable. Copying the algorithm exactly, not merely a hash, keeps a
 * developer's existing checkout offset — and any URL already shared for it —
 * unchanged when one half of dev moves onto this shared resolver.
 */
function hashDevSeed(value: string): number {
  let hash = 5381;
  for (let index = value.length; index > 0; index -= 1) {
    hash = (hash * 33) ^ value.charCodeAt(index - 1);
  }
  return (hash & 0xbfffffff) | ((hash >>> 1) & 0x40000000);
}

const hashedOffsetFor = (seed: string): number => ((hashDevSeed(seed) >>> 0) % MAX_HASH_OFFSET) + 1;

export type DevPortOffsetRequest =
  | { readonly _tag: "invalid"; readonly raw: string }
  | { readonly _tag: "set"; readonly offset: number; readonly source: string };

export interface DevPortOffsetInput {
  readonly env: Environment;
  /**
   * The checkout or linked worktree root. Each one gets a stable, distinct
   * offset so concurrent dev sessions never collide and a shared URL keeps
   * working across restarts.
   */
  readonly worktreePath?: string | undefined;
}

/**
 * The single authority for the dev port offset. Both the dev-runner and the
 * desktop wrapper call this, so the browser stack and the desktop stack either
 * resolve the same ports or fail loudly — never silently disagree.
 *
 * Precedence: an explicit `AWEN_PORT_OFFSET` wins, then `AWEN_DEV_INSTANCE`
 * (numeric or hashed), then a hash of the checkout path, then `0` (for callers
 * with no checkout, such as a unit test).
 */
export function resolveDevPortOffset(input: DevPortOffsetInput): DevPortOffsetRequest {
  const explicit = resolvePortOffset(input.env);
  if (explicit._tag === "invalid") {
    return { _tag: "invalid", raw: explicit.raw };
  }
  if (explicit._tag === "set") {
    return {
      _tag: "set",
      offset: explicit.offset,
      source: `AWEN_PORT_OFFSET=${String(explicit.offset)}`,
    };
  }

  const seed = input.env.AWEN_DEV_INSTANCE?.trim();
  if (seed !== undefined && seed.length > 0) {
    if (/^\d+$/u.test(seed)) {
      return { _tag: "set", offset: Number(seed), source: `numeric AWEN_DEV_INSTANCE=${seed}` };
    }
    return {
      _tag: "set",
      offset: hashedOffsetFor(seed),
      source: `hashed AWEN_DEV_INSTANCE=${seed}`,
    };
  }

  const worktreePath = input.worktreePath?.trim();
  if (worktreePath !== undefined && worktreePath.length > 0) {
    return {
      _tag: "set",
      offset: hashedOffsetFor(worktreePath),
      source: `checkout ${worktreePath}`,
    };
  }

  return { _tag: "set", offset: 0, source: "default ports" };
}

export function describeInvalidDaemonPort(request: {
  readonly key: string;
  readonly raw: string;
}): string {
  return `${request.key} must be a port number between 1 and 65535; received "${request.raw}".`;
}

export function describeInvalidPortOffset(raw: string): string {
  return `AWEN_PORT_OFFSET must be a non-negative integer; received "${raw}".`;
}

export function daemonPortForOffset(offset: number): number {
  return BASE_DAEMON_PORT + offset;
}

export function webDevPortForOffset(offset: number): number {
  return BASE_WEB_DEV_PORT + offset;
}

export interface DesktopDevPorts {
  readonly offset: number;
  readonly daemonPort: number;
  readonly webPort: number;
}

export type DesktopDevPortsResult =
  | { readonly _tag: "invalid"; readonly message: string }
  | { readonly _tag: "set"; readonly ports: DesktopDevPorts };

/**
 * Ports the desktop dev app must run with, plus the offset that produced them.
 *
 * An explicitly configured daemon port is absolute and wins; otherwise the
 * daemon sits beside its base port at the web dev server's offset. The caller
 * derives the window URL from `webPort`, which is what keeps a session on a
 * non-zero offset from loading a URL that belongs to a different one.
 */
export function resolveDesktopDevPorts(
  env: Environment,
  worktreePath?: string | undefined,
): DesktopDevPortsResult {
  const offsetRequest = resolveDevPortOffset({ env, worktreePath });
  if (offsetRequest._tag === "invalid") {
    return { _tag: "invalid", message: describeInvalidPortOffset(offsetRequest.raw) };
  }
  const offset = offsetRequest.offset;

  const portRequest = resolveDaemonPortRequest(env);
  if (portRequest._tag === "invalid") {
    return { _tag: "invalid", message: describeInvalidDaemonPort(portRequest) };
  }

  return {
    _tag: "set",
    ports: {
      offset,
      daemonPort: portRequest._tag === "set" ? portRequest.port : daemonPortForOffset(offset),
      webPort: webDevPortForOffset(offset),
    },
  };
}
