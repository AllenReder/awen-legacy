import type { DesktopSshEnvironmentTarget, DesktopSshHostKeyTrust } from "@awen/contracts";
import * as NodeCrypto from "node:crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { SshHostDiscoveryError, SshInvalidTargetError } from "./errors.ts";
import { buildSshHostSpecEffect } from "./command.ts";
import { resolveSshUserHome } from "./userHome.ts";

export type SshTrustError =
  | SshHostDiscoveryError
  | SshInvalidTargetError
  | PlatformError.PlatformError;

export type { DesktopSshHostKeyTrust as SshHostKeyTrust } from "@awen/contracts";

export interface SshHostKeyTrustClassification {
  readonly status: DesktopSshHostKeyTrust["status"];
  /** Key type of the decisive key: the presented key for new/changed hosts. */
  readonly keyType: string | null;
}

const emptyClassification: SshHostKeyTrustClassification = {
  status: "new",
  keyType: null,
};

const runTool = (
  command: string,
  args: ReadonlyArray<string>,
): Effect.Effect<
  { readonly stdout: string; readonly stderr: string; readonly exitCode: number },
  SshHostDiscoveryError | PlatformError.PlatformError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(command, args, {
          stdin: { stream: Stream.empty, endOnDone: true },
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new SshHostDiscoveryError({
              message: `Failed to run SSH host key tool ${command}.`,
              cause,
            }),
        ),
      );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        child.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        ),
        child.stderr.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (acc, chunk) => acc + chunk,
          ),
        ),
        child.exitCode.pipe(Effect.map(Number)),
      ],
      { concurrency: "unbounded" },
    );
    return { stdout, stderr, exitCode };
  });

function targetHostname(target: DesktopSshEnvironmentTarget): string {
  return target.hostname.trim() || target.alias.trim();
}

export function knownHostsLookupHost(target: DesktopSshEnvironmentTarget): string {
  const hostname = targetHostname(target);
  return target.port !== null && target.port !== 22 ? `[${hostname}]:${target.port}` : hostname;
}

function keyscanArgs(target: DesktopSshEnvironmentTarget): string[] {
  return [
    "-T",
    "10",
    ...(target.port !== null ? ["-p", String(target.port)] : []),
    targetHostname(target),
  ];
}

interface HostKey {
  readonly keyType: string;
  readonly key: string;
  readonly line: string;
}

export function fingerprintHostKey(key: string): string {
  return `SHA256:${NodeCrypto.createHash("sha256").update(Buffer.from(key, "base64")).digest("base64").replace(/=+$/u, "")}`;
}

/** All keyscan lines that belong to the target (keyscan can echo neighbours). */
function parseKeyscan(stdout: string, target: DesktopSshEnvironmentTarget): HostKey[] {
  const hostPrefix =
    target.port !== null && target.port !== 22
      ? `[${targetHostname(target)}]:${target.port}`
      : targetHostname(target);
  const keys: HostKey[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [hosts, keyType, key] = trimmed.split(/\s+/u);
    if (!hosts || !keyType || !key) continue;
    if (hosts.split(",").includes(hostPrefix)) {
      keys.push({ keyType, key, line: `${hostPrefix} ${keyType} ${key}` });
    }
  }
  return keys;
}

export function confirmedHostKeyLine(
  keyscanOutput: string,
  target: DesktopSshEnvironmentTarget,
  expectedKeyType: string,
  expectedFingerprint: string,
): string | null {
  return (
    parseKeyscan(keyscanOutput, target).find(
      (key) =>
        key.keyType === expectedKeyType && fingerprintHostKey(key.key) === expectedFingerprint,
    )?.line ?? null
  );
}

/**
 * Keys from `ssh-keygen -F <host>` output. Every returned line already matched
 * the host (including through hashed known_hosts entries), so only the key
 * type and key material matter. Comment lines (`# Host … found: line N`) are
 * skipped.
 */
function parseKnownHostKeys(stdout: string): ReadonlyArray<Pick<HostKey, "keyType" | "key">> {
  const keys: Array<Pick<HostKey, "keyType" | "key">> = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [, keyType, key] = trimmed.split(/\s+/u);
    if (keyType && key) keys.push({ keyType, key });
  }
  return keys;
}

/**
 * Pure trust decision from the two tool outputs, mirroring what OpenSSH does
 * at connect time:
 *
 * - a scanned key matching a known_hosts entry of the same type => trusted;
 * - a known_hosts entry whose key type the host now serves with different
 *   material (or no overlap at all) => changed — always blocks, never
 *   auto-accepted;
 * - no known_hosts entry => new (presented for user confirmation);
 * - an unreachable host with a known_hosts entry stays trusted — the SSH
 *   client enforces the known key at connect time.
 */
export function classifySshHostKeyTrust(
  knownHostsStdout: string,
  keyscanStdout: string,
  target: DesktopSshEnvironmentTarget,
): SshHostKeyTrustClassification {
  const knownKeys = parseKnownHostKeys(knownHostsStdout);
  const scannedKeys = parseKeyscan(keyscanStdout, target);

  if (knownKeys.length > 0) {
    if (scannedKeys.length === 0) {
      return { status: "trusted", keyType: null };
    }
    let matched = false;
    for (const scanned of scannedKeys) {
      const sameType = knownKeys.filter((known) => known.keyType === scanned.keyType);
      if (sameType.some((known) => known.key === scanned.key)) {
        matched = true;
      } else if (sameType.length > 0) {
        return { status: "changed", keyType: scanned.keyType };
      }
    }
    if (matched) {
      return { status: "trusted", keyType: null };
    }
    // Every scanned key type is unknown to known_hosts while other key types
    // are known: the host's key material was replaced wholesale.
    const first = scannedKeys[0]!;
    return { status: "changed", keyType: first.keyType };
  }

  const first = scannedKeys[0];
  if (first === undefined) {
    return emptyClassification;
  }
  return { status: "new", keyType: first.keyType };
}

export const inspectSshHostTrust = Effect.fn("ssh/trust.inspectSshHostTrust")(function* (
  target: DesktopSshEnvironmentTarget,
): Effect.fn.Return<
  DesktopSshHostKeyTrust,
  SshTrustError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const knownHosts = yield* runTool("ssh-keygen", ["-F", knownHostsLookupHost(target)]).pipe(
    Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })),
  );
  const keyscan = yield* runTool("ssh-keyscan", keyscanArgs(target)).pipe(
    Effect.orElseSucceed(() => ({ stdout: "", stderr: "", exitCode: 1 })),
  );
  const classification = classifySshHostKeyTrust(
    knownHosts.exitCode === 0 ? knownHosts.stdout : "",
    keyscan.exitCode === 0 ? keyscan.stdout : "",
    target,
  );
  const presented = parseKeyscan(keyscan.exitCode === 0 ? keyscan.stdout : "", target).find(
    (key) => key.keyType === classification.keyType,
  );
  return {
    status: classification.status,
    fingerprint: presented ? fingerprintHostKey(presented.key) : null,
    keyType: classification.keyType,
  };
});

export const trustSshHostKey = Effect.fn("ssh/trust.trustSshHostKey")(function* (
  target: DesktopSshEnvironmentTarget,
  expectedKeyType: string,
  expectedFingerprint: string,
): Effect.fn.Return<
  void,
  SshTrustError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const hostSpec = yield* buildSshHostSpecEffect(target);
  const trust = yield* inspectSshHostTrust(target);
  if (trust.status === "trusted") return;
  if (trust.status === "changed") {
    return yield* new SshHostDiscoveryError({
      message: `SSH host key changed for ${hostSpec}. Awen never accepts a changed host key automatically.`,
      cause: null,
    });
  }
  const keyscan = yield* runTool("ssh-keyscan", keyscanArgs(target));
  const line = confirmedHostKeyLine(
    keyscan.exitCode === 0 ? keyscan.stdout : "",
    target,
    expectedKeyType,
    expectedFingerprint,
  );
  if (line === null) {
    return yield* new SshHostDiscoveryError({
      message: `The SSH host key for ${hostSpec} changed since confirmation or could not be read.`,
      cause: keyscan.stderr,
    });
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* resolveSshUserHome;
  const sshDir = path.join(home, ".ssh");
  const knownHostsPath = path.join(sshDir, "known_hosts");
  yield* fs.makeDirectory(sshDir, { recursive: true, mode: 0o700 });
  const existing = yield* fs.readFileString(knownHostsPath).pipe(Effect.orElseSucceed(() => ""));
  if (existing.includes(line)) return;
  yield* fs.writeFileString(
    knownHostsPath,
    `${existing.endsWith("\n") || existing.length === 0 ? existing : `${existing}\n`}${line}\n`,
  );
});
