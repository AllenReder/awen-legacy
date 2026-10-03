import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
  DesktopSshEnvironmentPlan,
} from "@awen/contracts";
import {
  describeReadinessCause,
  waitForHttpReady as waitForHttpReadyShared,
} from "@awen/shared/httpReadiness";
import { parseChecksums } from "@awen/shared/cliRelease";
import {
  SERVER_RELEASE_CHECKSUMS_FILE,
  serverReleaseArchiveName,
  serverReleaseDownloadBaseUrl,
} from "@awen/shared/serverRelease";
import * as NetService from "@awen/shared/Net";
import { extractJsonObject, fromLenientJson } from "@awen/shared/schemaJson";
import { satisfiesSemverRange } from "@awen/shared/semver";
import { HostProcessPlatform } from "@awen/shared/hostProcess";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeCrypto from "node:crypto";
import * as Option from "effect/Option";

import {
  buildSshChildEnvironment,
  type SshAuthOptions,
  SshPasswordPrompt,
  isSshAuthFailure,
} from "./auth.ts";
import {
  baseScpArgs,
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  getLastNonEmptyOutputLine,
  remoteStateKey,
  resolveSshCommand,
  resolveSshTarget,
  runSshCommand,
  targetConnectionKey,
} from "./command.ts";
import { reportSshProgress, sshProgress, SshEnvironmentProgress } from "./progress.ts";
import { resolveSshUserHome } from "./userHome.ts";

const scpCommandForPlatform = (platform: NodeJS.Platform): string =>
  platform === "win32" ? "scp.exe" : "scp";

export const resolveScpCommand = Effect.map(HostProcessPlatform, scpCommandForPlatform);
import {
  classifySshFailure,
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshLocalPackageError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

export { SshLocalPackageError } from "./errors.ts";

const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_READY_TIMEOUT_MS = 20_000;
const SSH_READY_PROBE_TIMEOUT_MS = 1_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;
const REMOTE_READY_TIMEOUT_MS = 60_000;
const REMOTE_LAUNCH_TIMEOUT_MS = 90_000;
// A cold archive launch also downloads and unpacks a ~70 MB release archive
// and may wait on another installer's lock. The budgets nest: the checksum
// file is tiny and the archive download is bounded; a waiter outlasts both
// downloads plus extraction so it can reuse the result; and the SSH command
// outlasts an install (own or waited-for) plus readiness, with slack for
// verification and extraction, which have no timeout of their own.
const REMOTE_ARCHIVE_CHECKSUMS_SECONDS = 30;
const REMOTE_ARCHIVE_DOWNLOAD_SECONDS = 240;
const REMOTE_ARCHIVE_LOCK_WAIT_SECONDS = 360;
const REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS = 900_000;
const REMOTE_REUSE_READY_TIMEOUT_MS = 2_000;
interface LocalServerPackage {
  readonly version: string;
  readonly archiveName: string;
  readonly archivePath: string;
  readonly checksumsPath: string;
  readonly releaseBaseUrl: string;
}

interface StagedRemoteServerPackage extends LocalServerPackage {
  readonly remoteArchivePath: string;
  readonly remoteChecksumsPath: string;
  readonly stateKey: string;
}

export const resolveRemoteLocalArchivePaths = (staged: {
  readonly stateKey: string;
  readonly version: string;
  readonly archiveName: string;
}): { readonly archivePath: string; readonly checksumsPath: string } => ({
  archivePath: `ssh-launch/${staged.stateKey}/packages/${staged.version}/${staged.archiveName}`,
  checksumsPath: `ssh-launch/${staged.stateKey}/packages/${staged.version}/${SERVER_RELEASE_CHECKSUMS_FILE}`,
});

export function parseRemotePackageStageHome(stdout: string): string | null {
  const prefix = "AWEN_STAGE_HOME=";
  const line = stdout.split(/\r?\n/u).findLast((entry) => entry.startsWith(prefix));
  const home = line?.slice(prefix.length);
  return home !== undefined && home.startsWith("/") && !home.includes("\0") ? home : null;
}

export interface RemoteAwenRunnerOptions {
  /**
   * Dev mode: run `node <path>` on the remote instead of a release archive.
   * The only mode that needs Node on the remote.
   */
  readonly nodeScriptPath?: string | null;
  readonly nodeEngineRange?: string | null;
  /**
   * Exact version whose self-contained release archive the remote installs
   * and runs. Required unless `nodeScriptPath` is set; the remote then needs
   * neither Node nor npm.
   */
  readonly archiveVersion?: string | null;
  readonly releaseBaseUrl?: string | null;
  readonly localArchivePath?: string | null;
  readonly localChecksumsPath?: string | null;
}

export interface SshEnvironmentManagerOptions {
  readonly resolveCliRunner?: Effect.Effect<RemoteAwenRunnerOptions>;
}

interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly remoteServerKind: "external" | "managed" | null;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  readonly scope: Scope.Scope;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | SshPasswordPrompt;

export type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshLocalPackageError
  | PlatformError.PlatformError
  | HttpClientError.HttpClientError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetService.NetError;

function sshTargetLogFields(target: DesktopSshEnvironmentTarget) {
  return {
    alias: target.alias,
    hostname: target.hostname,
    username: target.username,
    port: target.port,
  };
}

function isNodeScriptRunner(runner: RemoteAwenRunnerOptions | undefined): boolean {
  return Boolean(runner?.nodeScriptPath?.trim());
}

function sshRunnerLogFields(runner: RemoteAwenRunnerOptions | undefined) {
  if (runner?.nodeScriptPath?.trim()) {
    return { runner: "node-script", nodeScriptPath: runner.nodeScriptPath.trim() };
  }
  if (runner?.archiveVersion?.trim()) {
    return { runner: "archive", archiveVersion: runner.archiveVersion.trim() };
  }
  return { runner: "archive" };
}

export const localServerPackageCacheDir = Effect.fn("ssh/tunnel.localServerPackageCacheDir")(
  function* (version: string) {
    const path = yield* Path.Path;
    const home = yield* resolveSshUserHome;
    return path.join(home, ".awen", "caches", "server-packages", version);
  },
);

const ensureLocalServerPackage = Effect.fn("ssh/tunnel.ensureLocalServerPackage")(function* (
  runner: RemoteAwenRunnerOptions,
) {
  const version = runner.archiveVersion?.trim() || "";
  if (version === "") {
    return null;
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const archiveName = serverReleaseArchiveName(version);
  const cacheDir = yield* localServerPackageCacheDir(version);
  const archivePath = path.join(cacheDir, archiveName);
  const checksumsPath = path.join(cacheDir, SERVER_RELEASE_CHECKSUMS_FILE);
  const releaseBaseUrl = runner.releaseBaseUrl ?? undefined;

  const verifyCachedPackage = Effect.gen(function* () {
    const [archiveExists, checksumsExists] = yield* Effect.all([
      fs.exists(archivePath),
      fs.exists(checksumsPath),
    ]);
    if (!archiveExists || !checksumsExists) return false;
    const [archiveBytes, checksumsText] = yield* Effect.all([
      fs.readFile(archivePath),
      fs.readFileString(checksumsPath),
    ]);
    const expected = parseChecksums(checksumsText).get(archiveName);
    if (expected === undefined) return false;
    const actual = NodeCrypto.createHash("sha256").update(archiveBytes).digest("hex");
    return actual === expected;
  });

  if (yield* verifyCachedPackage) {
    return {
      version,
      archiveName,
      archivePath,
      checksumsPath,
      releaseBaseUrl: serverReleaseDownloadBaseUrl(version, releaseBaseUrl),
    };
  }

  // A locally built package (scripts/build-server-package.ts output, or the
  // equivalent) is the last-resort source when the GitHub prerelease is gone.
  // It goes through the same SHA256SUMS verification as a downloaded one.
  const localPackageDir = yield* Effect.sync(
    () => process.env.AWEN_SERVER_PACKAGE_DIR?.trim() || null,
  );
  if (localPackageDir !== null) {
    const builtArchivePath = path.join(localPackageDir, archiveName);
    const builtChecksumsPath = path.join(localPackageDir, SERVER_RELEASE_CHECKSUMS_FILE);
    const [builtArchiveExists, builtChecksumsExist] = yield* Effect.all([
      fs.exists(builtArchivePath).pipe(Effect.orElseSucceed(() => false)),
      fs.exists(builtChecksumsPath).pipe(Effect.orElseSucceed(() => false)),
    ]);
    if (builtArchiveExists && builtChecksumsExist) {
      yield* fs.makeDirectory(cacheDir, { recursive: true });
      yield* Effect.all([
        fs.copyFile(builtArchivePath, archivePath),
        fs.copyFile(builtChecksumsPath, checksumsPath),
      ]);
      if (yield* verifyCachedPackage) {
        yield* Effect.logInfo("ssh.tunnel.localPackage.fromBuildArtifact", {
          version,
          archiveName,
          sourceDir: localPackageDir,
        });
        return {
          version,
          archiveName,
          archivePath,
          checksumsPath,
          releaseBaseUrl: serverReleaseDownloadBaseUrl(version, releaseBaseUrl),
        };
      }
      return yield* new SshLocalPackageError({
        message: `Local Awen server package ${archiveName} in ${localPackageDir} failed SHA256 verification.`,
      });
    }
  }

  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const download = Effect.fn("ssh/tunnel.downloadServerPackage")(function* (
    fileName: string,
    destination: string,
  ) {
    yield* reportSshProgress(sshProgress("local-download"));
    const response = yield* httpClient
      .get(`${serverReleaseDownloadBaseUrl(version, releaseBaseUrl)}/${fileName}`)
      .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
    const contentLength = Number(response.headers["content-length"]);
    const encoded = response.headers["content-encoding"]?.trim().toLowerCase();
    const totalBytes =
      (!encoded || encoded === "identity") && Number.isFinite(contentLength) && contentLength > 0
        ? contentLength
        : null;
    let transferredBytes = 0;
    const chunks = yield* response.stream.pipe(
      Stream.tap((chunk) => {
        transferredBytes += chunk.byteLength;
        return reportSshProgress(sshProgress("local-download", { transferredBytes, totalBytes }));
      }),
      Stream.runCollect,
    );
    const bytes = new Uint8Array(transferredBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    yield* fs.writeFile(destination, bytes);
  });

  yield* download(SERVER_RELEASE_CHECKSUMS_FILE, checksumsPath);
  yield* download(archiveName, archivePath);
  if (!(yield* verifyCachedPackage)) {
    return yield* new SshLocalPackageError({
      message: `Downloaded Awen server package ${archiveName} failed SHA256 verification.`,
    });
  }
  return {
    version,
    archiveName,
    archivePath,
    checksumsPath,
    releaseBaseUrl: serverReleaseDownloadBaseUrl(version, releaseBaseUrl),
  };
});

const runScpUpload = Effect.fn("ssh/tunnel.runScpUpload")(function* (
  target: DesktopSshEnvironmentTarget,
  input: SshAuthOptions & {
    readonly sourcePath: string;
    readonly destinationPath: string;
    readonly timeoutMs?: number;
  },
): Effect.fn.Return<
  void,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const hostSpec = yield* buildSshHostSpecEffect(target);
  const progressService = yield* Effect.serviceOption(SshEnvironmentProgress);
  const progressDetail = "Remote download failed; using a local upload.";
  const fs = yield* FileSystem.FileSystem;
  const totalBytes = yield* fs.stat(input.sourcePath).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => null),
  );
  yield* reportSshProgress(
    sshProgress("uploading", { detail: progressDetail, transferredBytes: 0, totalBytes }),
  );
  const environment = yield* buildSshChildEnvironment({
    ...(input.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    ...(input.authSecret === undefined ? {} : { authSecret: input.authSecret }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["scp"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseScpArgs(target, {
      batchMode: input.batchMode ?? "no",
    }),
    input.sourcePath,
    `${hostSpec}:${input.destinationPath}`,
  ];
  const command = yield* resolveScpCommand;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output = yield* Effect.scopedWith((scope) =>
    Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(command, args, {
            env: environment,
            extendEnv: true,
            stdin: { stream: Stream.empty, endOnDone: true },
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, scope),
          Effect.mapError(
            (cause) =>
              new SshCommandError({
                command: [command, ...args],
                exitCode: null,
                stderr: "",
                message:
                  cause instanceof Error
                    ? cause.message
                    : `Failed to spawn SCP command for ${hostSpec}.`,
                cause,
              }),
          ),
        );
      let transferredBytes = 0;
      const sampleRemoteSize = Effect.gen(function* () {
        while (true) {
          const sample = yield* runSshCommand(target, {
            remoteCommandArgs: ["sh", "-s"],
            stdin: `if [ -f ${shellSingleQuote(input.destinationPath)} ]; then wc -c < ${shellSingleQuote(input.destinationPath)}; fi`,
            timeoutMs: 5_000,
            batchMode: input.authSecret === undefined ? "yes" : "no",
            childEnvironment: environment,
          }).pipe(
            Effect.map((result) => Number(getLastNonEmptyOutputLine(result.stdout))),
            Effect.catch(() => Effect.succeed(null)),
          );
          if (
            sample !== null &&
            Number.isFinite(sample) &&
            sample > transferredBytes &&
            (totalBytes === null || sample <= totalBytes)
          ) {
            transferredBytes = sample;
            yield* reportSshProgress(
              sshProgress("uploading", { detail: progressDetail, transferredBytes, totalBytes }),
            );
          }
          yield* Effect.sleep(1_000);
        }
      });
      if (Option.isSome(progressService)) yield* sampleRemoteSize.pipe(Effect.forkIn(scope));
      return yield* Effect.all(
        [
          collectProcessOutput(child.stdout),
          collectProcessOutput(child.stderr),
          child.exitCode.pipe(Effect.map(Number)),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.timeout(Duration.millis(input.timeoutMs ?? REMOTE_ARCHIVE_DOWNLOAD_SECONDS * 1000)),
        Effect.mapError((cause) =>
          cause instanceof SshCommandError
            ? cause
            : new SshCommandError({
                command: [command, ...args],
                exitCode: null,
                stderr: "",
                message:
                  cause instanceof Error
                    ? cause.message
                    : `Failed to run SCP command for ${hostSpec}.`,
                cause,
              }),
        ),
      );
    }),
  );
  if (output === undefined) {
    return yield* new SshCommandError({
      command: [command, ...args],
      exitCode: null,
      stderr: "",
      message: `SCP upload timed out for ${hostSpec}.`,
    });
  }
  const [stdout, stderr, exitCode] = output;
  if (exitCode !== 0) {
    return yield* new SshCommandError({
      command: [command, ...args],
      exitCode,
      stdout,
      stderr,
      message: normalizeSshErrorMessage(stderr, `SCP upload failed for ${hostSpec}.`),
    });
  }
  if (totalBytes !== null) {
    yield* reportSshProgress(
      sshProgress("uploading", {
        detail: progressDetail,
        transferredBytes: totalBytes,
        totalBytes,
      }),
    );
  }
});

const stageLocalServerPackageOnRemote = Effect.fn("ssh/tunnel.stageLocalServerPackageOnRemote")(
  function* (
    target: DesktopSshEnvironmentTarget,
    authOptions: SshAuthOptions,
    localPackage: LocalServerPackage,
  ): Effect.fn.Return<
    StagedRemoteServerPackage,
    SshCommandError | SshInvalidTargetError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const stateKey = remoteStateKey(target);
    const remotePaths = resolveRemoteLocalArchivePaths({
      stateKey,
      version: localPackage.version,
      archiveName: localPackage.archiveName,
    });
    const staging = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s"],
      stdin: `set -eu\nAWEN_HOME="\${AWEN_HOME:-\${HOME}/.awen}"\nmkdir -p "$AWEN_HOME/ssh-launch/${stateKey}/packages/${localPackage.version}"\nrm -f "$AWEN_HOME/${remotePaths.archivePath}" "$AWEN_HOME/${remotePaths.checksumsPath}"\nprintf 'AWEN_STAGE_HOME=%s\\n' "$(cd "$AWEN_HOME" && pwd -P)"\n`,
      timeoutMs: 30_000,
      ...spreadAuthOptions(authOptions),
    });
    const remoteHome = parseRemotePackageStageHome(staging.stdout);
    if (remoteHome === null) {
      return yield* new SshCommandError({
        command: ["ssh"],
        exitCode: null,
        stderr: staging.stderr,
        message: "SSH staging did not return the remote Awen home directory.",
      });
    }
    const remoteRoot = remoteHome.replace(/\/+$/u, "");
    const remoteArchivePath = `${remoteRoot}/${remotePaths.archivePath}`;
    const remoteChecksumsPath = `${remoteRoot}/${remotePaths.checksumsPath}`;
    yield* runScpUpload(target, {
      sourcePath: localPackage.archivePath,
      destinationPath: remoteArchivePath,
      ...spreadAuthOptions(authOptions),
    });
    yield* runScpUpload(target, {
      sourcePath: localPackage.checksumsPath,
      destinationPath: remoteChecksumsPath,
      timeoutMs: 30_000,
      ...spreadAuthOptions(authOptions),
    });
    return {
      ...localPackage,
      remoteArchivePath,
      remoteChecksumsPath,
      stateKey,
    };
  },
);

// RunSshCommandOptions extends SshAuthOptions; spreading conditionally keeps
// exactOptionalPropertyTypes happy without repeating the triplet everywhere.
const spreadAuthOptions = (authOptions: SshAuthOptions) => ({
  ...(authOptions.authSecret === undefined ? {} : { authSecret: authOptions.authSecret }),
  ...(authOptions.batchMode === undefined ? {} : { batchMode: authOptions.batchMode }),
  ...(authOptions.interactiveAuth === undefined
    ? {}
    : { interactiveAuth: authOptions.interactiveAuth }),
});

interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshEnvironmentManagerShape {
  readonly inspectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<
    DesktopSshEnvironmentPlan,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
  readonly disconnectEnvironment: (
    target: DesktopSshEnvironmentTarget,
  ) => Effect.Effect<void, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

const RemoteLaunchResult = Schema.Struct({
  remotePort: Schema.Number,
  serverKind: Schema.optional(Schema.Literals(["external", "managed"])),
});

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));
const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));

const decodeRemoteJsonOutput = <A, E>(
  stdout: string,
  decode: (input: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  decode(stdout).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const jsonObject = extractJsonObject(stdout);
        if (jsonObject === stdout.trim()) {
          return yield* Effect.fail(error);
        }
        const exit = yield* Effect.exit(decode(jsonObject));
        if (Exit.isSuccess(exit)) {
          return exit.value;
        }
        return yield* Effect.fail(error);
      }),
    ),
  );

const decodeRemoteLaunchOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemoteLaunchResult);

const decodeRemotePairingOutput = (stdout: string) =>
  decodeRemoteJsonOutput(stdout, decodeRemotePairingResult);

const remoteNodeEngineCheckMain = function remoteNodeEngineCheckMain() {
  const range = process.argv[2] || "";
  const rawVersion =
    process.versions && process.versions.node ? process.versions.node : process.version;

  if (!satisfiesSemverRange(rawVersion, range)) {
    process.stderr.write(
      "Remote node " + rawVersion + " does not satisfy required range " + range + ".\n",
    );
    process.exit(1);
  }
};

function buildRemoteNodeEngineCheckScript(): string {
  return `${satisfiesSemverRange.toString()}
(${remoteNodeEngineCheckMain.toString()})();`;
}

function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function applyScriptPlaceholders(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(`@@${token}@@`, value);
  }
  return result;
}

// Re-exported from the shared HTTP readiness module so existing importers
// (notably tunnel.test.ts) keep resolving it from here.
export { describeReadinessCause };

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error ? false : port));
    });
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = await tryPort(port);
    if (available) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

const REMOTE_WAIT_READY_SCRIPT = `const http = require("node:http");
const port = Number.parseInt(process.argv[2] ?? "", 10);
const timeoutMs = Number.parseInt(process.argv[3] ?? "", 10);
const probeTimeoutMs = Number.parseInt(process.argv[4] ?? "", 10);
if (!Number.isInteger(port) || !Number.isInteger(timeoutMs) || !Number.isInteger(probeTimeoutMs)) {
  process.exit(1);
}
const deadline = Date.now() + timeoutMs;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Probe the public environment descriptor, not "/": reuse must only adopt a
// daemon that actually speaks the Awen discovery API, not any server that
// happens to answer on the recorded port.
function probe() {
  return new Promise((resolve) => {
    const request = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/.well-known/awen/environment",
        timeout: probeTimeoutMs,
      },
      (response) => {
        response.resume();
        response.once("end", () => {
          resolve(response.statusCode >= 200 && response.statusCode < 300);
        });
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
  });
}

(async () => {
  while (Date.now() < deadline) {
    if (await probe()) {
      process.exit(0);
    }
    await sleep(100);
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

const REMOTE_NODE_ENV_SCRIPT = `prepend_path_if_dir() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
}

remote_node_satisfies_engine() {
  AWEN_NODE_ENGINE_RANGE=@@AWEN_NODE_ENGINE_RANGE@@
  if [ -z "$AWEN_NODE_ENGINE_RANGE" ]; then
    return 0
  fi
  node - "$AWEN_NODE_ENGINE_RANGE" <<'NODE'
@@AWEN_NODE_ENGINE_CHECK_SCRIPT@@
NODE
}

ensure_remote_node_path() {
  if command -v node >/dev/null 2>&1 && remote_node_satisfies_engine >/dev/null 2>&1; then
    return 0
  fi

  prepend_path_if_dir "$HOME/.local/bin"
  prepend_path_if_dir "$HOME/bin"
  prepend_path_if_dir "/opt/homebrew/bin"
  prepend_path_if_dir "/usr/local/bin"
  prepend_path_if_dir "/usr/bin"
  prepend_path_if_dir "/bin"

  if [ -z "\${VOLTA_HOME:-}" ]; then
    VOLTA_HOME="$HOME/.volta"
  fi
  export VOLTA_HOME
  prepend_path_if_dir "$VOLTA_HOME/bin"

  prepend_path_if_dir "$HOME/.asdf/shims"
  prepend_path_if_dir "$HOME/.asdf/bin"
  if [ ! -x "$HOME/.asdf/shims/node" ] && [ -s "$HOME/.asdf/asdf.sh" ]; then
    # shellcheck disable=SC1090
    . "$HOME/.asdf/asdf.sh"
  fi

  prepend_path_if_dir "$HOME/.local/share/mise/shims"
  prepend_path_if_dir "$HOME/.mise/shims"
  if ! command -v node >/dev/null 2>&1 && command -v mise >/dev/null 2>&1; then
    eval "$(mise activate sh)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${FNM_DIR:-}" ]; then
    FNM_DIR="$HOME/.local/share/fnm"
  fi
  export FNM_DIR
  prepend_path_if_dir "$FNM_DIR"
  prepend_path_if_dir "$HOME/.fnm"
  if ! command -v node >/dev/null 2>&1 && command -v fnm >/dev/null 2>&1; then
    eval "$(fnm env --shell bash)" >/dev/null 2>&1 || true
    fnm use --silent-if-unchanged >/dev/null 2>&1 || fnm use default >/dev/null 2>&1 || true
  fi

  prepend_path_if_dir "$HOME/.nodenv/bin"
  prepend_path_if_dir "$HOME/.nodenv/shims"
  if ! command -v node >/dev/null 2>&1 && command -v nodenv >/dev/null 2>&1; then
    eval "$(nodenv init -)" >/dev/null 2>&1 || true
  fi

  if [ -z "\${NVM_DIR:-}" ]; then
    NVM_DIR="$HOME/.nvm"
  fi
  export NVM_DIR

  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090
    . "$NVM_DIR/nvm.sh"
    if ! command -v node >/dev/null 2>&1 && command -v nvm >/dev/null 2>&1; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || nvm use --silent --lts >/dev/null 2>&1 || true
    fi
  fi

  if ! command -v node >/dev/null 2>&1 && [ -d "$NVM_DIR/versions/node" ]; then
    for AWEN_NODE_BIN in "$NVM_DIR"/versions/node/*/bin; do
      if [ -x "$AWEN_NODE_BIN/node" ]; then
        PATH="$AWEN_NODE_BIN:$PATH"
        export PATH
      fi
    done
  fi

  command -v node >/dev/null 2>&1 && remote_node_satisfies_engine
}
`;

const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
@@AWEN_NODE_ENV_SCRIPT@@
AWEN_NODE_SCRIPT_PATH=@@AWEN_NODE_SCRIPT_PATH@@
if [ -n "$AWEN_NODE_SCRIPT_PATH" ]; then
  ensure_remote_node_path || true
  if ! command -v node >/dev/null 2>&1; then
    printf 'AWEN_ERROR prerequisite-missing Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
    exit 1
  fi
  exec node "$AWEN_NODE_SCRIPT_PATH" "$@"
fi
AWEN_ARCHIVE_VERSION=@@AWEN_ARCHIVE_VERSION@@
if [ -z "$AWEN_ARCHIVE_VERSION" ]; then
  printf 'AWEN_ERROR install-download-checksum No Awen server release version was provided for the remote runtime.\\n' >&2
  exit 1
fi
if [ "$(uname -s)" != "Linux" ]; then
  printf 'AWEN_ERROR prerequisite-missing Awen remote daemon install currently supports Linux x64 only; remote OS is %s.\\n' "$(uname -s)" >&2
  exit 1
fi
case "$(uname -m)" in
  x86_64 | amd64) ;;
  *) printf 'AWEN_ERROR prerequisite-missing Awen remote daemon install currently supports Linux x64 only; remote architecture is %s.\\n' "$(uname -m)" >&2; exit 1 ;;
esac
if ! ensure_remote_node_path; then
  printf 'AWEN_ERROR prerequisite-missing Remote host is missing Node.js 22 or newer on PATH. Install Node.js or configure a supported version manager for non-interactive shells.\\n' >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  printf 'AWEN_ERROR prerequisite-missing Remote host is missing Git on PATH. Install Git before connecting Awen.\\n' >&2
  exit 1
fi
AWEN_RELEASE_BASE_URL=@@AWEN_RELEASE_BASE_URL@@
AWEN_LOCAL_ARCHIVE_PATH=@@AWEN_LOCAL_ARCHIVE_PATH@@
AWEN_LOCAL_CHECKSUMS_PATH=@@AWEN_LOCAL_CHECKSUMS_PATH@@
AWEN_HOME="\${AWEN_HOME:-\${HOME}/.awen}"
AWEN_RUNTIME_DIR="$AWEN_HOME/runtime/versions/$AWEN_ARCHIVE_VERSION"
awen_runtime_ready() {
  [ -x "$AWEN_RUNTIME_DIR/bin/awen" ] && [ "$(cat "$AWEN_RUNTIME_DIR/.install-complete" 2>/dev/null)" = "$AWEN_ARCHIVE_VERSION" ]
}
if ! awen_runtime_ready; then
  mkdir -p "$AWEN_HOME/runtime/versions"
  AWEN_LOCK="$AWEN_HOME/runtime/versions/.$AWEN_ARCHIVE_VERSION.install.lock"
  AWEN_LOCK_WAITED=0
  AWEN_LOCK_UNOWNED=0
  while ! mkdir "$AWEN_LOCK" 2>/dev/null; do
    AWEN_LOCK_OWNER="$(cat "$AWEN_LOCK/pid" 2>/dev/null || true)"
    if [ -n "$AWEN_LOCK_OWNER" ]; then
      AWEN_LOCK_UNOWNED=0
      if ! kill -0 "$AWEN_LOCK_OWNER" 2>/dev/null; then
        rm -rf "$AWEN_LOCK"
        continue
      fi
    else
      AWEN_LOCK_UNOWNED=$((AWEN_LOCK_UNOWNED + 1))
      if [ "$AWEN_LOCK_UNOWNED" -ge 5 ]; then
        rm -rf "$AWEN_LOCK"
        continue
      fi
    fi
    if [ "$AWEN_LOCK_WAITED" -ge @@AWEN_ARCHIVE_LOCK_WAIT_SECONDS@@ ]; then
      printf 'AWEN_ERROR install-download-checksum Another Awen %s installation has held %s for too long.\\n' "$AWEN_ARCHIVE_VERSION" "$AWEN_LOCK" >&2
      exit 1
    fi
    sleep 1
    AWEN_LOCK_WAITED=$((AWEN_LOCK_WAITED + 1))
  done
  printf '%s\\n' "$$" > "$AWEN_LOCK/pid.tmp" && mv "$AWEN_LOCK/pid.tmp" "$AWEN_LOCK/pid"
  trap 'rm -rf "$AWEN_LOCK"' EXIT
fi
if ! awen_runtime_ready; then
  AWEN_ARCHIVE="awen-server-$AWEN_ARCHIVE_VERSION-linux-x64.tar.gz"
  AWEN_STAGING="$(mktemp -d "$AWEN_HOME/runtime/versions/.staging-XXXXXX")"
  trap 'rm -rf "$AWEN_STAGING" "$AWEN_LOCK"' EXIT
  if [ -n "$AWEN_LOCAL_ARCHIVE_PATH" ] && [ -n "$AWEN_LOCAL_CHECKSUMS_PATH" ]; then
AWEN_HOME_FALLBACK="\${AWEN_HOME:-\${HOME}/.awen}"
    cp "$AWEN_HOME_FALLBACK/$AWEN_LOCAL_ARCHIVE_PATH" "$AWEN_STAGING/$AWEN_ARCHIVE"
    cp "$AWEN_HOME_FALLBACK/$AWEN_LOCAL_CHECKSUMS_PATH" "$AWEN_STAGING/SHA256SUMS"
  else
    awen_fetch() {
      AWEN_PROGRESS_FLAG="$AWEN_STAGING/.progress-active"
      if [ "$2" = "$AWEN_STAGING/$AWEN_ARCHIVE" ]; then
        : > "$AWEN_PROGRESS_FLAG"
        (
          while [ -f "$AWEN_PROGRESS_FLAG" ]; do
            if [ -f "$2" ]; then
              AWEN_PROGRESS_TOTAL=0
              if [ -f "$AWEN_STAGING/.download-headers" ]; then
                AWEN_PROGRESS_TOTAL="$(awk '/^HTTP\\// { size=0 } tolower($1) == "content-length:" { gsub("\\r", "", $2); size=$2 } END { print size+0 }' "$AWEN_STAGING/.download-headers")"
              fi
              printf 'AWEN_PROGRESS download %s %s\\n' "$(wc -c < "$2" | tr -d ' ')" "$AWEN_PROGRESS_TOTAL" >&2
            fi
            sleep 1
          done
        ) &
        AWEN_PROGRESS_PID=$!
      fi
      if command -v curl >/dev/null 2>&1; then
        curl -fsSL --connect-timeout 30 --max-time "$3" "$1" -o "$2" -D "$AWEN_STAGING/.download-headers" && AWEN_FETCH_OK=1 || AWEN_FETCH_OK=0
      elif command -v wget >/dev/null 2>&1; then
        wget -q --timeout=30 --tries=1 "$1" -O "$2" && AWEN_FETCH_OK=1 || AWEN_FETCH_OK=0
      else
        printf 'AWEN_ERROR install-download-checksum Remote host needs curl or wget to download %s.\\n' "$AWEN_ARCHIVE" >&2
        AWEN_FETCH_OK=0
      fi
      if [ -n "\${AWEN_PROGRESS_PID:-}" ]; then
        rm -f "$AWEN_PROGRESS_FLAG"
        kill "$AWEN_PROGRESS_PID" 2>/dev/null || true
        wait "$AWEN_PROGRESS_PID" 2>/dev/null || true
        AWEN_PROGRESS_TOTAL=0
        if [ -f "$AWEN_STAGING/.download-headers" ]; then
          AWEN_PROGRESS_TOTAL="$(awk '/^HTTP\\// { size=0 } tolower($1) == "content-length:" { gsub("\\r", "", $2); size=$2 } END { print size+0 }' "$AWEN_STAGING/.download-headers")"
        fi
        printf 'AWEN_PROGRESS download %s %s\\n' "$(wc -c < "$2" 2>/dev/null | tr -d ' ')" "$AWEN_PROGRESS_TOTAL" >&2
        unset AWEN_PROGRESS_PID
      fi
      rm -f "$AWEN_STAGING/.download-headers"
      [ "$AWEN_FETCH_OK" -eq 1 ]
    }
    awen_fetch "$AWEN_RELEASE_BASE_URL/v$AWEN_ARCHIVE_VERSION/SHA256SUMS" "$AWEN_STAGING/SHA256SUMS" @@AWEN_ARCHIVE_CHECKSUMS_SECONDS@@
    awen_fetch "$AWEN_RELEASE_BASE_URL/v$AWEN_ARCHIVE_VERSION/$AWEN_ARCHIVE" "$AWEN_STAGING/$AWEN_ARCHIVE" @@AWEN_ARCHIVE_DOWNLOAD_SECONDS@@
  fi
  printf 'AWEN_PROGRESS stage installing\\n' >&2
  AWEN_EXPECTED="$(grep " \\*\\{0,1\\}$AWEN_ARCHIVE$" "$AWEN_STAGING/SHA256SUMS" | cut -d' ' -f1)"
  if command -v sha256sum >/dev/null 2>&1; then
    AWEN_ACTUAL="$(sha256sum "$AWEN_STAGING/$AWEN_ARCHIVE" | cut -d' ' -f1)"
  else
    AWEN_ACTUAL="$(shasum -a 256 "$AWEN_STAGING/$AWEN_ARCHIVE" | cut -d' ' -f1)"
  fi
  if [ -z "$AWEN_EXPECTED" ] || [ "$AWEN_ACTUAL" != "$AWEN_EXPECTED" ]; then
    printf 'AWEN_ERROR install-download-checksum Checksum mismatch for %s.\\n' "$AWEN_ARCHIVE" >&2; exit 1
  fi
  tar -xzf "$AWEN_STAGING/$AWEN_ARCHIVE" -C "$AWEN_STAGING" --strip-components=1
  rm -f "$AWEN_STAGING/$AWEN_ARCHIVE" "$AWEN_STAGING/SHA256SUMS"
  if ! "$AWEN_STAGING/bin/awen" --version >/dev/null 2>&1; then
    printf 'AWEN_ERROR install-download-checksum The Awen %s executable does not run on this host.\\n' "$AWEN_ARCHIVE_VERSION" >&2; exit 1
  fi
  printf '%s\\n' "$AWEN_ARCHIVE_VERSION" > "$AWEN_STAGING/.install-complete"
  rm -rf "$AWEN_RUNTIME_DIR"
  mv "$AWEN_STAGING" "$AWEN_RUNTIME_DIR"
fi
if [ -n "\${AWEN_LOCK:-}" ]; then
  rm -rf "$AWEN_LOCK"
  trap - EXIT
fi
printf 'AWEN_PROGRESS stage starting\\n' >&2
exec "$AWEN_RUNTIME_DIR/bin/awen" "$@"
`;

const REMOTE_LAUNCH_SCRIPT = `set -eu
@@AWEN_NODE_ENV_SCRIPT@@
STATE_KEY="$1"
AWEN_HOME="\${AWEN_HOME:-\${HOME}/.awen}"
STATE_DIR="$AWEN_HOME/ssh-launch/$STATE_KEY"
DEFAULT_SERVER_HOME="$AWEN_HOME"
DEFAULT_RUNTIME_FILE="$DEFAULT_SERVER_HOME/userdata/server-runtime.json"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
MANAGED_FILE="$STATE_DIR/managed"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-awen.sh"
RUNNER_NEXT="$STATE_DIR/run-awen.next.$$"
mkdir -p "$STATE_DIR"
cleanup_runner_next() {
  rm -f "$RUNNER_NEXT"
}
trap cleanup_runner_next EXIT
cat >"$RUNNER_NEXT" <<'SH'
@@AWEN_RUNNER_SCRIPT@@
SH
mv "$RUNNER_NEXT" "$RUNNER_FILE"
chmod 700 "$RUNNER_FILE"
AWEN_ARCHIVE_MODE=@@AWEN_ARCHIVE_MODE@@
if [ "$AWEN_ARCHIVE_MODE" = "1" ]; then
  "$RUNNER_FILE" --version >/dev/null
elif ! ensure_remote_node_path; then
  printf 'AWEN_ERROR prerequisite-missing Remote host is missing node on PATH. Install Node or configure a supported version manager for non-interactive shells.\\n' >&2
  exit 1
fi
pick_port() {
  if [ "$AWEN_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper pick-port "$PORT_FILE" "@@AWEN_DEFAULT_REMOTE_PORT@@" "@@AWEN_REMOTE_PORT_SCAN_WINDOW@@"
    return
  fi
  node - "$PORT_FILE" "@@AWEN_DEFAULT_REMOTE_PORT@@" "@@AWEN_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@AWEN_PICK_PORT_SCRIPT@@
NODE
}
wait_ready() {
  if [ "$AWEN_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper wait-ready "$REMOTE_PORT" "$1" "@@AWEN_READY_PROBE_TIMEOUT_MS@@"
    return
  fi
  node - "$REMOTE_PORT" "$1" "@@AWEN_READY_PROBE_TIMEOUT_MS@@" <<'NODE'
@@AWEN_WAIT_READY_SCRIPT@@
NODE
}
wait_for_pid_exit() {
  PID_TO_WAIT="$1"
  WAIT_COUNT=0
  while kill -0 "$PID_TO_WAIT" 2>/dev/null && [ "$WAIT_COUNT" -lt 20 ]; do
    WAIT_COUNT=$((WAIT_COUNT + 1))
    sleep 0.1
  done
}
resolve_default_runtime_port() {
  if [ "$AWEN_ARCHIVE_MODE" = "1" ]; then
    "$RUNNER_FILE" __ssh-helper runtime-port "$DEFAULT_RUNTIME_FILE"
    return
  fi
  node - "$DEFAULT_RUNTIME_FILE" <<'NODE'
const fs = require("node:fs");
const runtimePath = process.argv[2] ?? "";
try {
	  const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8"));
	  const pid = Number(runtime.pid);
	  const port = Number(runtime.port);
	  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) {
	    process.exit(1);
	  }
  const origin = new URL(String(runtime.origin ?? ""));
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) {
    process.exit(1);
  }
  process.kill(pid, 0);
  process.stdout.write(\`\${pid} \${port}\`);
} catch {
  process.exit(1);
}
NODE
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
DEFAULT_RUNTIME_INFO="$(resolve_default_runtime_port 2>/dev/null || true)"
DEFAULT_REMOTE_PORT=""
if [ -n "$DEFAULT_RUNTIME_INFO" ]; then
  DEFAULT_REMOTE_PORT="\${DEFAULT_RUNTIME_INFO#* }"
fi
if [ -n "$DEFAULT_REMOTE_PORT" ]; then
  MANAGED_ALIVE=0
  if [ "$REMOTE_MANAGED" = "managed" ] && [ -n "$REMOTE_PID" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
    MANAGED_ALIVE=1
  fi
  # A live Awen-managed daemon wins over the default runtime record: adopting
  # the external daemon would mean stopping ours, and Awen never silently
  # stops a daemon that may own active Sessions.
  if [ "$MANAGED_ALIVE" != "1" ]; then
    REMOTE_PORT="$DEFAULT_REMOTE_PORT"
    if wait_ready "@@AWEN_REUSE_READY_TIMEOUT_MS@@"; then
      REMOTE_PID=""
      REMOTE_PORT="$DEFAULT_REMOTE_PORT"
      REMOTE_MANAGED="external"
      rm -f "$PID_FILE"
      printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
      printf 'external\\n' >"$MANAGED_FILE"
    else
      REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
      REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
      REMOTE_MANAGED="$(cat "$MANAGED_FILE" 2>/dev/null || true)"
    fi
  fi
fi
if [ "$REMOTE_MANAGED" = "external" ]; then
  if [ -z "$REMOTE_PORT" ] || ! wait_ready "@@AWEN_REUSE_READY_TIMEOUT_MS@@"; then
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  fi
elif [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  # A live managed daemon is reused even when the runner script changed; the
  # updated runner takes effect on the daemon's next natural start. Only an
  # unhealthy daemon is restarted here.
  if ! wait_ready "@@AWEN_REUSE_READY_TIMEOUT_MS@@"; then
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    REMOTE_PID=""
    REMOTE_PORT=""
    REMOTE_MANAGED=""
  fi
else
  REMOTE_PID=""
  REMOTE_PORT=""
  REMOTE_MANAGED=""
fi
if [ -z "$REMOTE_PORT" ]; then
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    if [ "$AWEN_ARCHIVE_MODE" = "1" ]; then
      printf 'AWEN_ERROR daemon-start Failed to find an available port on the remote host.\\n' >&2
    else
      printf 'AWEN_ERROR daemon-start Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    fi
    exit 1
  fi
  nohup env AWEN_NO_BROWSER=1 AWEN_HOME="$AWEN_HOME" "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$DEFAULT_SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
  printf 'managed\\n' >"$MANAGED_FILE"
  if ! wait_ready "@@AWEN_READY_TIMEOUT_MS@@"; then
    printf 'AWEN_ERROR daemon-start Remote Awen daemon did not become ready on 127.0.0.1:%s.\\n' "$REMOTE_PORT" >&2
    if [ -s "$LOG_FILE" ]; then
      tail -n 80 "$LOG_FILE" >&2 2>/dev/null || true
    else
      printf 'It wrote nothing to %s, so it exited before producing any output.\\n' "$LOG_FILE" >&2
    fi
    kill "$REMOTE_PID" 2>/dev/null || true
    wait_for_pid_exit "$REMOTE_PID"
    rm -f "$PID_FILE" "$PORT_FILE" "$MANAGED_FILE"
    exit 1
  fi
fi
printf '{"remotePort":%s,"serverKind":"%s"}\\n' "$REMOTE_PORT" "\${REMOTE_MANAGED:-managed}"
`;

const REMOTE_INSPECT_SCRIPT = `set -eu
STATE_KEY="$1"
AWEN_HOME="$(printenv AWEN_HOME || true)"
if [ -z "$AWEN_HOME" ]; then AWEN_HOME="$HOME/.awen"; fi
OS="$(uname -s 2>/dev/null || true)"
ARCH="$(uname -m 2>/dev/null || true)"
ensure_remote_node_path || true
NODE_VERSION="$(node -v 2>/dev/null || true)"
if command -v git >/dev/null 2>&1; then GIT_AVAILABLE=yes; else GIT_AVAILABLE=no; fi
DAEMON=install
PORT="$(cat "$AWEN_HOME/ssh-launch/$STATE_KEY/port" 2>/dev/null || true)"
if command -v node >/dev/null 2>&1; then
  DEFAULT_PORT="$(node - "$AWEN_HOME/userdata/server-runtime.json" <<'NODE' 2>/dev/null || true
const fs = require("node:fs");
try {
  const runtime = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const origin = new URL(runtime.origin);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(origin.hostname)) process.exit(1);
  process.kill(Number(runtime.pid), 0);
  process.stdout.write(String(runtime.port));
} catch { process.exit(1); }
NODE
)"
  for CANDIDATE_PORT in "$PORT" "$DEFAULT_PORT"; do
    if [ -n "$CANDIDATE_PORT" ] && node -e 'const port = Number(process.argv[1]); if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1); fetch("http://127.0.0.1:" + port + "/.well-known/awen/environment", { signal: AbortSignal.timeout(1500) }).then(async response => { const body = await response.json(); process.exit(response.ok && typeof body.environmentId === "string" ? 0 : 1) }).catch(() => process.exit(1))' "$CANDIDATE_PORT" >/dev/null 2>&1; then
      DAEMON=reuse
      break
    fi
  done
fi
printf 'AWEN_PREFLIGHT\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$OS" "$ARCH" "$NODE_VERSION" "$GIT_AVAILABLE" "$DAEMON"
`;

export function parseSshEnvironmentInspection(
  stdout: string,
  runner?: RemoteAwenRunnerOptions,
): DesktopSshEnvironmentPlan | null {
  const line = stdout.split(/\r?\n/u).findLast((entry) => entry.startsWith("AWEN_PREFLIGHT\t"));
  const fields = line?.split("\t");
  if (fields?.length !== 6) return null;
  const [, os, arch, rawNodeVersion, gitAvailable, daemon] = fields;
  if (gitAvailable !== "yes" && gitAvailable !== "no") return null;
  if (daemon !== "reuse" && daemon !== "install") return null;
  const nodeVersion = rawNodeVersion || null;
  return {
    version: runner?.archiveVersion ?? "",
    os: os ?? "",
    arch: arch ?? "",
    nodeVersion,
    nodeSupported:
      nodeVersion !== null &&
      satisfiesSemverRange(nodeVersion, runner?.nodeEngineRange ?? ">=22.16"),
    gitAvailable: gitAvailable === "yes",
    daemon,
  };
}

const REMOTE_PAIRING_SCRIPT = `set -eu
AWEN_HOME="\${AWEN_HOME:-\${HOME}/.awen}"
STATE_DIR="$AWEN_HOME/ssh-launch/@@AWEN_STATE_KEY@@"
DEFAULT_SERVER_HOME="$AWEN_HOME"
RUNNER_FILE="$STATE_DIR/run-awen.sh"
mkdir -p "$STATE_DIR"
cat >"$RUNNER_FILE" <<'SH'
@@AWEN_RUNNER_SCRIPT@@
SH
chmod 700 "$RUNNER_FILE"
PAIRING_BASE_DIR="$DEFAULT_SERVER_HOME"
if ! AWEN_HOME="$AWEN_HOME" "$RUNNER_FILE" auth pairing create --base-dir "$PAIRING_BASE_DIR" --json; then
  printf 'AWEN_ERROR daemon-authentication Failed to create an authorized pairing credential for the remote daemon.\\n' >&2
  exit 1
fi
`;

const REMOTE_LOG_TAIL_SCRIPT = `set -eu
AWEN_HOME="\${AWEN_HOME:-\${HOME}/.awen}"
STATE_DIR="$AWEN_HOME/ssh-launch/@@AWEN_STATE_KEY@@"
LOG_FILE="$STATE_DIR/server.log"
if [ -f "$LOG_FILE" ]; then
  tail -n 80 "$LOG_FILE" 2>/dev/null || true
fi
`;

export class SshInvalidArchiveVersionError extends Schema.TaggedError<SshInvalidArchiveVersionError>()(
  "SshInvalidArchiveVersionError",
  { archiveVersion: Schema.String },
) {
  override get message(): string {
    return `'${this.archiveVersion}' is not an exact awen version and cannot name a runtime directory.`;
  }
}

// The version becomes a directory name the runner removes and recreates, so
// it must be one exact SemVer segment: no separators, no `..`, no shell
// metacharacters beyond what SemVer allows.
const EXACT_ARCHIVE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export class SshMissingRunnerError extends Schema.TaggedError<SshMissingRunnerError>()(
  "SshMissingRunnerError",
  {},
) {
  override get message(): string {
    return "A remote awen runner needs an archive version or a node script path.";
  }
}

export function buildRemoteAwenRunnerScript(input?: RemoteAwenRunnerOptions): string {
  const nodeScriptPath = input?.nodeScriptPath?.trim() || "";
  const archiveVersion = input?.archiveVersion?.trim() || "";
  if (nodeScriptPath === "" && archiveVersion === "") {
    throw new SshMissingRunnerError();
  }
  if (archiveVersion !== "" && !EXACT_ARCHIVE_VERSION.test(archiveVersion)) {
    throw new SshInvalidArchiveVersionError({ archiveVersion });
  }
  // Strip the `/v<version>` the helper appends: the script builds URLs itself.
  const releaseBaseUrl = serverReleaseDownloadBaseUrl(
    "",
    input?.releaseBaseUrl ?? undefined,
  ).replace(/\/v$/u, "");
  const localArchivePath = input?.localArchivePath?.trim() || "";
  const localChecksumsPath = input?.localChecksumsPath?.trim() || "";
  if (localArchivePath !== "" && localChecksumsPath === "") {
    throw new SshMissingRunnerError();
  }
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      AWEN_NODE_SCRIPT_PATH: shellSingleQuote(nodeScriptPath),
      AWEN_ARCHIVE_VERSION: shellSingleQuote(archiveVersion),
      AWEN_RELEASE_BASE_URL: shellSingleQuote(releaseBaseUrl),
      AWEN_LOCAL_ARCHIVE_PATH: shellSingleQuote(localArchivePath),
      AWEN_LOCAL_CHECKSUMS_PATH: shellSingleQuote(localChecksumsPath),
      AWEN_ARCHIVE_LOCK_WAIT_SECONDS: String(REMOTE_ARCHIVE_LOCK_WAIT_SECONDS),
      AWEN_ARCHIVE_DOWNLOAD_SECONDS: String(REMOTE_ARCHIVE_DOWNLOAD_SECONDS),
      AWEN_ARCHIVE_CHECKSUMS_SECONDS: String(REMOTE_ARCHIVE_CHECKSUMS_SECONDS),
      AWEN_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    }),
  );
}

export function buildRemoteNodeEnvScript(input?: RemoteAwenRunnerOptions): string {
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_NODE_ENV_SCRIPT, {
      AWEN_NODE_ENGINE_RANGE: shellSingleQuote(input?.nodeEngineRange?.trim() || ""),
      AWEN_NODE_ENGINE_CHECK_SCRIPT: stripTrailingNewlines(buildRemoteNodeEngineCheckScript()),
    }),
  );
}

export function buildRemoteLaunchScript(input?: RemoteAwenRunnerOptions): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    AWEN_ARCHIVE_MODE: isNodeScriptRunner(input) ? "0" : "1",
    AWEN_NODE_ENV_SCRIPT: buildRemoteNodeEnvScript(input),
    AWEN_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteAwenRunnerScript(input)),
    AWEN_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    AWEN_WAIT_READY_SCRIPT: stripTrailingNewlines(REMOTE_WAIT_READY_SCRIPT),
    AWEN_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    AWEN_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
    AWEN_READY_TIMEOUT_MS: String(REMOTE_READY_TIMEOUT_MS),
    AWEN_REUSE_READY_TIMEOUT_MS: String(REMOTE_REUSE_READY_TIMEOUT_MS),
    AWEN_READY_PROBE_TIMEOUT_MS: String(SSH_READY_PROBE_TIMEOUT_MS),
  });
}

export function buildRemotePairingScript(
  target: DesktopSshEnvironmentTarget,
  input?: RemoteAwenRunnerOptions,
): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    AWEN_STATE_KEY: remoteStateKey(target),
    AWEN_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteAwenRunnerScript(input)),
  });
}

function buildRemoteLogTailScript(target: DesktopSshEnvironmentTarget): string {
  return applyScriptPlaceholders(REMOTE_LOG_TAIL_SCRIPT, {
    AWEN_STATE_KEY: remoteStateKey(target),
  });
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuthOptions,
    runner?: RemoteAwenRunnerOptions,
  ): Effect.fn.Return<
    { readonly remotePort: number; readonly remoteServerKind: "external" | "managed" | null },
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    yield* Effect.logInfo("ssh.remoteServer.launch.start", {
      ...sshTargetLogFields(target),
      ...sshRunnerLogFields(runner),
      stateKey: remoteStateKey(target),
    });
    yield* reportSshProgress(sshProgress("starting"));
    const progressService = yield* Effect.serviceOption(SshEnvironmentProgress);
    let stderrRemainder = "";
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-l", "-s", "--", remoteStateKey(target)],
      stdin: buildRemoteLaunchScript(runner),
      timeoutMs: isNodeScriptRunner(runner)
        ? REMOTE_LAUNCH_TIMEOUT_MS
        : REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS,
      onStderrChunk: (chunk) => {
        stderrRemainder += chunk;
        const lines = stderrRemainder.split(/\r?\n/u);
        stderrRemainder = lines.pop() ?? "";
        for (const line of lines) {
          const match = /^AWEN_PROGRESS download (\d+) (\d+)$/u.exec(line);
          if (match && Option.isSome(progressService)) {
            const totalBytes = Number(match[2]);
            progressService.value.report(
              sshProgress("remote-download", {
                transferredBytes: Number(match[1]),
                totalBytes: totalBytes > 0 ? totalBytes : null,
              }),
            );
          } else if (line === "AWEN_PROGRESS stage installing" && Option.isSome(progressService)) {
            progressService.value.report(sshProgress("installing"));
          } else if (line === "AWEN_PROGRESS stage starting" && Option.isSome(progressService)) {
            progressService.value.report(sshProgress("starting"));
          }
        }
      },
      ...spreadAuthOptions(input ?? {}),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchOutput(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "SSH launch returned unparseable output.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (!Number.isInteger(parsed.remotePort)) {
      return yield* new SshLaunchError({
        message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
        stdout: result.stdout,
      });
    }
    yield* Effect.logInfo("ssh.remoteServer.launch.ready", {
      ...sshTargetLogFields(target),
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
      stateKey: remoteStateKey(target),
    });
    return {
      remotePort: parsed.remotePort,
      remoteServerKind: parsed.serverKind ?? null,
    };
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
  runner?: RemoteAwenRunnerOptions,
): Effect.fn.Return<
  {
    readonly credential: string;
  },
  SshCommandError | SshInvalidTargetError | SshPairingError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.start", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemotePairingScript(target, runner),
    // Pairing may be the first command on a cold remote, so it can install
    // the archive on the way.
    ...(isNodeScriptRunner(runner) ? {} : { timeoutMs: REMOTE_ARCHIVE_LAUNCH_TIMEOUT_MS }),
    ...spreadAuthOptions(input ?? {}),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingOutput(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  yield* Effect.logDebug("ssh.remoteServer.pairingToken.created", {
    ...sshTargetLogFields(target),
    stateKey: remoteStateKey(target),
  });
  return {
    credential: parsed.credential,
  };
});

const readRemoteServerLogTail = Effect.fn("ssh/tunnel.readRemoteServerLogTail")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemoteLogTailScript(target),
    timeoutMs: 10_000,
    ...spreadAuthOptions(input ?? {}),
  });
  return result.stdout.trim();
});

export const waitForHttpReady = (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly probeTimeoutMs?: number;
  readonly path?: string;
}): Effect.Effect<void, SshReadinessError, HttpClient.HttpClient> =>
  waitForHttpReadyShared({
    baseUrl: input.baseUrl,
    path: input.path ?? "/.well-known/awen/environment",
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.intervalMs === undefined ? {} : { intervalMs: input.intervalMs }),
    probeTimeoutMs: input.probeTimeoutMs ?? SSH_READY_PROBE_TIMEOUT_MS,
    makeError: ({ requestUrl, probeTimeoutMs, cause }) => {
      if (typeof cause === "object" && cause !== null && "kind" in cause) {
        const kind = (cause as { readonly kind?: unknown }).kind;
        if (kind === "probe-timeout") {
          return new SshReadinessError({
            message: `Backend readiness probe exceeded ${probeTimeoutMs}ms at ${requestUrl}.`,
            cause,
          });
        }
        if (kind === "overall-timeout") {
          const overall = cause as unknown as {
            readonly baseUrl: string;
            readonly timeoutMs: number;
            readonly lastFailure: unknown;
          };
          return new SshReadinessError({
            message: `Timed out waiting ${overall.timeoutMs}ms for backend readiness at ${overall.baseUrl}.`,
            cause: overall.lastFailure,
          });
        }
      }
      return new SshReadinessError({
        message: `Backend readiness probe failed at ${requestUrl}.`,
        cause,
      });
    },
  });

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

export const resolveLoopbackSshHttpBaseUrl = Effect.fn("ssh/tunnel.resolveLoopbackSshHttpBaseUrl")(
  function* (rawHttpBaseUrl: unknown): Effect.fn.Return<string, SshHttpBridgeError> {
    return yield* Effect.try({
      try: () => {
        if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
          throw new Error("Invalid SSH forwarded http base URL.");
        }
        const baseUrl = new URL(rawHttpBaseUrl);
        if (!isLoopbackHostname(baseUrl.hostname)) {
          throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
        }
        return baseUrl.toString();
      },
      catch: (cause) =>
        new SshHttpBridgeError({
          message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
          cause,
        }),
    });
  },
);

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService.NetService;
  return yield* net.reserveLoopbackPort();
});

const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuthOptions;
  readonly remoteServerKind: "external" | "managed" | null;
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService.NetService
  | Scope.Scope
> {
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ControlMaster=no",
    "-o",
    "ControlPath=none",
    "-o",
    "ControlPersist=no",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-n",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    hostSpec,
  ];
  const sshCommand = yield* resolveSshCommand;
  const tunnelCommand = [sshCommand, ...args];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Scope.Scope;
  yield* Effect.logDebug("ssh.tunnel.spawn.start", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    localPort: input.localPort,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    httpBaseUrl: input.httpBaseUrl,
  });
  const child = yield* spawner
    .spawn(
      ChildProcess.make(sshCommand, args, {
        env: childEnvironment,
        extendEnv: true,
        stdin: {
          stream: Stream.empty,
          endOnDone: true,
        },
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: tunnelCommand,
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
            cause,
          }),
      ),
    );
  yield* Effect.logDebug("ssh.tunnel.spawn.succeeded", {
    ...sshTargetLogFields(input.resolvedTarget),
    command: tunnelCommand,
    pid: child.pid,
    localPort: input.localPort,
    remotePort: input.remotePort,
    httpBaseUrl: input.httpBaseUrl,
  });
  const tunnelEntry: SshTunnelEntry = {
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    remoteServerKind: input.remoteServerKind,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
    scope,
  };
  const exitFailure = Effect.all(
    [collectProcessOutput(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: tunnelCommand,
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) => {
      const error = new SshCommandError({
        command: tunnelCommand,
        exitCode,
        stderr,
        message: normalizeSshErrorMessage(
          stderr,
          `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
        ),
      });
      return Effect.logWarning("ssh.tunnel.process.exited", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
        exitCode,
        stderr,
      }).pipe(Effect.andThen(Effect.fail(error)));
    }),
  );
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: SSH_READY_TIMEOUT_MS,
    }),
    exitFailure,
  ).pipe(
    Effect.tap(() =>
      Effect.logInfo("ssh.tunnel.ready", {
        ...sshTargetLogFields(input.resolvedTarget),
        command: tunnelCommand,
        pid: child.pid,
        localPort: input.localPort,
        remotePort: input.remotePort,
        httpBaseUrl: input.httpBaseUrl,
      }),
    ),
    Effect.tapError((cause) =>
      Effect.gen(function* () {
        const net = yield* NetService.NetService;
        const processRunningExit = yield* Effect.exit(child.isRunning);
        const localPortAvailableExit = yield* Effect.exit(
          net.canListenOnHost(input.localPort, "127.0.0.1"),
        );
        const remoteLogTailExit = yield* Effect.exit(
          readRemoteServerLogTail(input.resolvedTarget, input.authOptions),
        );
        const processRunning = Exit.isSuccess(processRunningExit) ? processRunningExit.value : null;
        const localPortAvailable = Exit.isSuccess(localPortAvailableExit)
          ? localPortAvailableExit.value
          : null;
        const remoteLogTail = Exit.isSuccess(remoteLogTailExit)
          ? remoteLogTailExit.value || null
          : null;
        yield* Effect.logWarning("ssh.tunnel.ready.failed", {
          ...sshTargetLogFields(input.resolvedTarget),
          command: tunnelCommand,
          pid: child.pid,
          processRunning,
          ...(Exit.isSuccess(processRunningExit)
            ? {}
            : { processRunningError: processRunningExit.cause }),
          localPort: input.localPort,
          localPortListening: localPortAvailable === null ? null : !localPortAvailable,
          remotePort: input.remotePort,
          httpBaseUrl: input.httpBaseUrl,
          ...(Exit.isSuccess(localPortAvailableExit)
            ? {}
            : { localPortProbeError: localPortAvailableExit.cause }),
          ...(remoteLogTail === null ? {} : { remoteLogTail }),
          ...(Exit.isSuccess(remoteLogTailExit)
            ? {}
            : { remoteLogTailError: remoteLogTailExit.cause }),
          cause,
        });
      }),
    ),
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  );
  return tunnelEntry;
});

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const managerScope = yield* Scope.Scope;
  const tunnels = new Map<string, SshTunnelEntry>();
  const targetLocks = new Map<string, Semaphore.Semaphore>();
  const authSecrets = new Map<string, string>();

  // Keep one lock per target so reconnect cannot reuse a server while stop is pending.
  const withTargetLock = Effect.fn("ssh/tunnel.withTargetLock")(function* <A, E, R>(
    key: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<A, E, R> {
    let lock = targetLocks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      targetLocks.set(key, lock);
    }
    return yield* lock.withPermits(1)(effect);
  });

  const closeTunnelEntry = Effect.fn("ssh/tunnel.closeTunnelEntry")(function* (
    entry: SshTunnelEntry,
  ) {
    yield* Effect.logDebug("ssh.tunnel.close.start", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
    yield* Scope.close(entry.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.logInfo("ssh.tunnel.close.succeeded", {
      ...sshTargetLogFields(entry.target),
      key: entry.key,
      localPort: entry.localPort,
      remotePort: entry.remotePort,
    });
  });

  yield* Scope.addFinalizer(
    managerScope,
    Effect.sync(() => [...tunnels.values()]).pipe(
      Effect.flatMap((entries) =>
        Effect.forEach(entries, closeTunnelEntry, { concurrency: "unbounded" }),
      ),
      Effect.ignore,
    ),
  );

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<string, SshInvalidTargetError | SshPasswordPromptError, SshPasswordPrompt> {
    const promptService = yield* SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.unavailable", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    yield* Effect.logInfo("ssh.auth.passwordPrompt.request", {
      ...sshTargetLogFields(target),
      attempt,
    });
    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    });
    if (password === null) {
      yield* Effect.logWarning("ssh.auth.passwordPrompt.cancelled", {
        ...sshTargetLogFields(target),
        attempt,
      });
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    yield* Effect.logInfo("ssh.auth.passwordPrompt.received", {
      ...sshTargetLogFields(target),
      attempt,
    });
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      yield* Effect.logWarning("ssh.auth.failed", {
        ...sshTargetLogFields(input.target),
        key: input.key,
        promptCount: input.promptCount,
        cause: input.error,
      });
      const promptService = yield* SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshPasswordPrompt;
    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: "no" as const,
            interactiveAuth: true,
          };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: authSecrets.get(input.key) ?? null,
    });
  });

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly runner?: RemoteAwenRunnerOptions;
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logDebug("ssh.environment.tunnel.create.start", {
      ...sshTargetLogFields(input.resolvedTarget),
      ...sshRunnerLogFields(input.runner),
      key: input.key,
    });
    const remoteLaunch = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        launchOrReuseRemoteServer(input.resolvedTarget, authOptions, input.runner).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              // Only package acquisition/verification failures can benefit
              // from the local upload fallback. Authentication, host trust,
              // prerequisites, and daemon-start failures must surface as-is
              // instead of downloading and uploading a ~70 MB package first.
              if (classifySshFailure(error).code !== "install-download-checksum") {
                return yield* error;
              }
              if (!isNodeScriptRunner(input.runner) && input.runner?.archiveVersion) {
                yield* reportSshProgress(
                  sshProgress("local-download", {
                    detail: "Remote download failed; using a local upload.",
                  }),
                );
                yield* Effect.logWarning("ssh.environment.releaseDownload.fallback", {
                  ...sshTargetLogFields(input.resolvedTarget),
                  ...sshRunnerLogFields(input.runner),
                  cause: error,
                });
                const localPackage = yield* ensureLocalServerPackage(input.runner);
                if (localPackage === null) {
                  return yield* error;
                }
                const staged = yield* stageLocalServerPackageOnRemote(
                  input.resolvedTarget,
                  authOptions,
                  localPackage,
                );
                const stagedPaths = resolveRemoteLocalArchivePaths(staged);
                return yield* launchOrReuseRemoteServer(input.resolvedTarget, authOptions, {
                  ...input.runner,
                  releaseBaseUrl: staged.releaseBaseUrl,
                  localArchivePath: stagedPaths.archivePath,
                  localChecksumsPath: stagedPaths.checksumsPath,
                });
              }
              return yield* error;
            }),
          ),
        ),
    });
    const remotePort = remoteLaunch.remotePort;
    yield* reportSshProgress(sshProgress("connecting"));
    yield* Effect.logDebug("ssh.environment.remotePort.ready", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      remotePort,
      remoteServerKind: remoteLaunch.remoteServerKind,
    });
    const localPort = yield* reserveLocalTunnelPort();
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    yield* Effect.logDebug("ssh.environment.localPort.reserved", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    const entryScope = yield* Scope.make("sequential");
    const tunnelEntry = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        startSshTunnel({
          key: input.key,
          resolvedTarget: input.resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          authOptions,
          remoteServerKind: remoteLaunch.remoteServerKind,
        }).pipe(Effect.provideService(Scope.Scope, entryScope)),
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isSuccess(exit) ? Effect.void : Scope.close(entryScope, Exit.void).pipe(Effect.ignore),
      ),
    );
    tunnels.set(input.key, tunnelEntry);
    yield* Scope.addFinalizer(
      entryScope,
      // Only the local forwarding process is torn down. The remote daemon is
      // deliberately left running so its Sessions survive a disconnect; the
      // next ensure reuses it through the launch script's reuse path.
      Effect.gen(function* () {
        if (tunnels.get(tunnelEntry.key) === tunnelEntry) {
          tunnels.delete(tunnelEntry.key);
        }
        yield* tunnelEntry.process
          .kill({
            killSignal: "SIGTERM",
            forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
          })
          .pipe(Effect.ignore);
        yield* Effect.logDebug("ssh.environment.tunnel.finalizer.succeeded", {
          ...sshTargetLogFields(tunnelEntry.target),
          key: tunnelEntry.key,
          localPort: tunnelEntry.localPort,
          remotePort: tunnelEntry.remotePort,
        });
      }).pipe(Effect.ignore),
    );
    yield* Effect.logDebug("ssh.environment.tunnel.create.succeeded", {
      ...sshTargetLogFields(input.resolvedTarget),
      key: input.key,
      localPort,
      remotePort,
    });
    return tunnelEntry;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    runner?: RemoteAwenRunnerOptions,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const entry = tunnels.get(key) ?? null;

    if (entry !== null) {
      yield* Effect.logDebug("ssh.environment.tunnel.existing.check", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      });
      const readinessExit = yield* Effect.exit(
        waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
      );
      if (Exit.isSuccess(readinessExit)) {
        yield* Effect.logDebug("ssh.environment.tunnel.reused", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
        });
        return entry;
      }
      yield* Effect.logWarning("ssh.environment.tunnel.existing.stale", {
        ...sshTargetLogFields(resolvedTarget),
        key,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
        cause: readinessExit.cause,
      });
      yield* closeTunnelEntry(entry);
    }

    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      ...(runner === undefined ? {} : { runner }),
    }).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("ssh.environment.tunnel.create.failed", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          cause,
        }),
      ),
    );
  });

  const inspectEnvironment = Effect.fn("ssh/tunnel.inspectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<
    DesktopSshEnvironmentPlan,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    const result = yield* runWithSshAuth({
      key: targetConnectionKey(resolvedTarget),
      target: resolvedTarget,
      operation: (authOptions) =>
        runSshCommand(resolvedTarget, {
          remoteCommandArgs: ["sh", "-l", "-s", "--", remoteStateKey(resolvedTarget)],
          stdin: `${buildRemoteNodeEnvScript(runner)}\n${REMOTE_INSPECT_SCRIPT}`,
          ...spreadAuthOptions(authOptions),
        }),
    });
    const plan = parseSshEnvironmentInspection(result.stdout, runner);
    if (plan === null) {
      return yield* new SshLaunchError({
        message: "SSH prerequisite inspection returned an invalid result.",
        stdout: result.stdout,
      });
    }
    return plan;
  });

  const ensureEnvironment = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: { readonly issuePairingToken?: boolean },
  ): Effect.fn.Return<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    yield* Effect.logInfo("ssh.environment.ensure.start", {
      ...sshTargetLogFields(target),
      issuePairingToken: requestOptions?.issuePairingToken === true,
    });
    yield* reportSshProgress(sshProgress("connecting"));
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    yield* Effect.logDebug("ssh.environment.target.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      key,
    });
    const runner =
      options.resolveCliRunner === undefined ? undefined : yield* options.resolveCliRunner;
    yield* Effect.logDebug("ssh.environment.runner.resolved", {
      ...sshTargetLogFields(resolvedTarget),
      ...sshRunnerLogFields(runner),
      key,
    });
    return yield* withTargetLock(
      key,
      Effect.gen(function* () {
        const entry = yield* ensureTunnelEntry(key, resolvedTarget, runner);

        yield* reportSshProgress(sshProgress("pairing"));
        const pairingResult = requestOptions?.issuePairingToken
          ? yield* runWithSshAuth({
              key,
              target: entry.target,
              operation: (authOptions) =>
                issueRemotePairingToken(entry.target, authOptions, runner),
            })
          : null;
        const pairingToken = pairingResult?.credential ?? null;

        yield* Effect.logInfo("ssh.environment.ensure.succeeded", {
          ...sshTargetLogFields(entry.target),
          key,
          localPort: entry.localPort,
          remotePort: entry.remotePort,
          remoteServerKind: entry.remoteServerKind,
          issuedPairingToken: pairingToken !== null,
        });
        return {
          target: entry.target,
          httpBaseUrl: entry.httpBaseUrl,
          wsBaseUrl: entry.wsBaseUrl,
          pairingToken,
          remotePort: entry.remotePort,
          ...(entry.remoteServerKind ? { remoteServerKind: entry.remoteServerKind } : {}),
        };
      }),
    );
  });

  const disconnectEnvironment = Effect.fn("ssh/tunnel.disconnectEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
  ): Effect.fn.Return<void, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    yield* Effect.logInfo("ssh.environment.disconnect.start", sshTargetLogFields(target));
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    yield* withTargetLock(
      key,
      Effect.gen(function* () {
        const entry = tunnels.get(key) ?? null;
        yield* Effect.logDebug("ssh.environment.disconnect.targetResolved", {
          ...sshTargetLogFields(resolvedTarget),
          key,
          hasTunnel: entry !== null,
        });
        if (entry !== null) {
          yield* Effect.gen(function* () {
            tunnels.delete(key);
            yield* closeTunnelEntry(entry);
          }).pipe(Effect.uninterruptible);
        }
        // Disconnecting only tears down the local forwarding. The remote
        // daemon keeps running so its Sessions survive; a later connect
        // reuses it instead of reinstalling.
        yield* Effect.logInfo("ssh.environment.disconnect.succeeded", {
          ...sshTargetLogFields(resolvedTarget),
          key,
        });
      }),
    );
  });

  return SshEnvironmentManager.of({ inspectEnvironment, ensureEnvironment, disconnectEnvironment });
});

/**
 * @effect-expect-leaking ChildProcessSpawner | FileSystem | HttpClient | NetService | Path | SshPasswordPrompt
 */
export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@awen/ssh/tunnel/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
