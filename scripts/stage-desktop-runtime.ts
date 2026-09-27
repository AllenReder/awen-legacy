#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalConsole:off - this packaging step downloads one checksummed Node archive and runs before an Effect HTTP runtime exists.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessArchitecture, HostProcessPlatform } from "@awen/shared/hostProcess";
import * as Effect from "effect/Effect";
import { describeReleaseTreePruning, pruneReleaseTree } from "./lib/release-tree.ts";
import { packageManagerInvocation } from "./lib/spawn-command.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "..");
const STAGE_RELATIVE = "apps/desktop/runtime";
const STAGE = NodePath.join(ROOT, STAGE_RELATIVE);
const NODE_DIST_URL = "https://nodejs.org/dist";

interface RuntimeTargetFields {
  readonly platform: "darwin" | "win32" | "linux";
  readonly arch: "arm64" | "x64";
  readonly nodeName: "node" | "node.exe";
}

/**
 * The Rust target triples a packaged desktop runtime can embed a Node binary
 * for. Passing `--target` stages the Node build for that triple instead of the
 * host binary, so an Apple Silicon runner can produce the x86_64 DMG without an
 * Intel runner and every platform ships the same Node version.
 */
const RUNTIME_TARGETS = new Map<string, RuntimeTargetFields>([
  ["aarch64-apple-darwin", { platform: "darwin", arch: "arm64", nodeName: "node" }],
  ["x86_64-apple-darwin", { platform: "darwin", arch: "x64", nodeName: "node" }],
  ["x86_64-pc-windows-msvc", { platform: "win32", arch: "x64", nodeName: "node.exe" }],
  ["aarch64-pc-windows-msvc", { platform: "win32", arch: "arm64", nodeName: "node.exe" }],
  ["x86_64-unknown-linux-gnu", { platform: "linux", arch: "x64", nodeName: "node" }],
  ["aarch64-unknown-linux-gnu", { platform: "linux", arch: "arm64", nodeName: "node" }],
]);

export interface DesktopRuntimeTarget extends RuntimeTargetFields {
  readonly triple: string;
}

/**
 * A published Node download. Windows ships a bare executable under
 * `dist/v<version>/<platform>-<arch>/node.exe`; macOS and Linux only publish the
 * `node` binary inside a tarball.
 */
export interface RuntimeNodeDownload {
  readonly url: string;
  readonly checksumName: string;
  readonly archive: boolean;
  readonly entryPath: string;
}

export function resolveDesktopRuntimeTarget(triple: string): DesktopRuntimeTarget {
  const target = RUNTIME_TARGETS.get(triple);
  if (target === undefined) {
    throw new Error(
      `Unsupported desktop runtime target ${JSON.stringify(triple)}. Known targets: ${[...RUNTIME_TARGETS.keys()].join(", ")}.`,
    );
  }
  return { triple, ...target };
}

/**
 * The version of the embedded Node runtime. `engines.node` is the single source
 * of truth; only an exact version (optionally written as a caret range) can be
 * downloaded, so a range such as `>=24` fails instead of shipping a runtime
 * nobody pinned.
 */
export function resolveRuntimeNodeVersion(enginesNode: string | undefined): string {
  const exact = /^\^?(\d+\.\d+\.\d+)$/u.exec((enginesNode ?? "").trim());
  if (exact === null) {
    throw new Error(
      `Desktop runtime staging needs an exact engines.node version, received ${JSON.stringify(enginesNode ?? null)}.`,
    );
  }
  return exact[1] ?? "";
}

export function runtimeNodeDownload(
  version: string,
  target: DesktopRuntimeTarget,
): RuntimeNodeDownload {
  const nodePlatform = target.platform === "win32" ? "win" : target.platform;
  const base = `${NODE_DIST_URL}/v${version}`;
  if (target.platform === "win32") {
    const checksumName = `${nodePlatform}-${target.arch}/node.exe`;
    return { url: `${base}/${checksumName}`, checksumName, archive: false, entryPath: "" };
  }
  const archiveName = `node-v${version}-${nodePlatform}-${target.arch}.tar.gz`;
  return {
    url: `${base}/${archiveName}`,
    checksumName: archiveName,
    archive: true,
    entryPath: `node-v${version}-${nodePlatform}-${target.arch}/bin/node`,
  };
}

/** Read the digest of one file from a published `SHASUMS256.txt`. */
export function readNodeShasum(shasums: string, checksumName: string): string {
  for (const line of shasums.split("\n")) {
    const match = /^([0-9a-f]{64})\s+(\S+)$/u.exec(line.trim());
    if (match !== null && match[2] === checksumName) return match[1] ?? "";
  }
  throw new Error(`No SHA256 entry for ${checksumName} in the published Node checksum file.`);
}

export interface StageRuntimeArguments {
  readonly target?: string;
}

export function readStageArguments(argv: readonly string[]): StageRuntimeArguments {
  let target: string | undefined;
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index] ?? "";
    index += 1;
    if (argument === "--target") {
      const value = argv[index];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(
          "--target needs a Rust target triple, for example --target x86_64-apple-darwin.",
        );
      }
      index += 1;
      target = value;
      continue;
    }
    if (argument.startsWith("--target=")) {
      const value = argument.slice("--target=".length);
      if (value.length === 0) throw new Error("--target needs a Rust target triple.");
      target = value;
      continue;
    }
    throw new Error(
      `Unknown argument ${JSON.stringify(argument)}. Usage: node scripts/stage-desktop-runtime.ts [--target <triple>]`,
    );
  }
  return target === undefined ? {} : { target };
}

function runPnpm(args: string[]): void {
  const invocation = packageManagerInvocation(args);
  const result = NodeChildProcess.spawnSync(invocation.command, [...invocation.args], {
    cwd: ROOT,
    stdio: "inherit",
    shell: invocation.shell,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm exited with ${result.status}`);
}

/**
 * The packaged runtime must carry a standalone Node instead of one that links a
 * Homebrew or `/usr/local` library a user's machine may not have.
 */
function assertStandaloneHostNode(execPath: string): void {
  const linkedLibraries = NodeChildProcess.execFileSync("otool", ["-L", execPath], {
    encoding: "utf8",
  });
  if (/\/(?:opt\/homebrew|usr\/local)\/.*\.dylib/u.test(linkedLibraries)) {
    throw new Error(
      "Desktop packaging needs a standalone Node binary; the current Node links Homebrew libraries.",
    );
  }
}

function readEngineNodeVersion(): string | undefined {
  const manifest: unknown = JSON.parse(
    NodeFS.readFileSync(NodePath.join(ROOT, "package.json"), "utf8"),
  );
  const engines = (manifest as { engines?: { node?: string } }).engines;
  return engines?.node;
}

export function sha256File(filePath: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
}

/**
 * Where downloaded Node builds are kept between runs. CI points
 * `AWEN_NODE_RUNTIME_CACHE` at a directory it restores and saves, so a warm
 * cache replaces the download with a checksum re-verification.
 */
export function resolveNodeRuntimeCache(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment.AWEN_NODE_RUNTIME_CACHE?.trim();
  return configured
    ? NodePath.resolve(configured)
    : NodePath.join(NodeOS.tmpdir(), "awen-node-runtime");
}

/** Cache location of one published Node build, keyed by version and target. */
export function nodeRuntimeCachePath(
  cacheDirectory: string,
  version: string,
  target: DesktopRuntimeTarget,
  fileName: string,
): string {
  return NodePath.join(
    cacheDirectory,
    `v${version}`,
    `${target.platform}-${target.arch}`,
    fileName,
  );
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
  return await response.text();
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`Could not download ${url}: ${response.status} ${response.statusText}`);
  NodeFS.writeFileSync(destination, Buffer.from(await response.arrayBuffer()));
}

async function downloadVerifiedRuntimeNode(
  download: RuntimeNodeDownload,
  expected: string,
  cachePath: string,
): Promise<string> {
  if (NodeFS.existsSync(cachePath) && sha256File(cachePath) === expected) {
    console.log(`[awen] reusing cached ${NodePath.basename(cachePath)}`);
    return cachePath;
  }
  NodeFS.mkdirSync(NodePath.dirname(cachePath), { recursive: true });
  await downloadFile(download.url, cachePath);
  const actual = sha256File(cachePath);
  if (actual !== expected) {
    NodeFS.rmSync(cachePath, { force: true });
    throw new Error(
      `Node runtime checksum mismatch for ${download.url}: expected ${expected}, received ${actual}.`,
    );
  }
  return cachePath;
}

async function stageTargetNode(target: DesktopRuntimeTarget, destination: string): Promise<void> {
  const version = resolveRuntimeNodeVersion(readEngineNodeVersion());
  const download = runtimeNodeDownload(version, target);
  const expected = readNodeShasum(
    await fetchText(`${NODE_DIST_URL}/v${version}/SHASUMS256.txt`),
    download.checksumName,
  );
  const fileName = NodePath.basename(new URL(download.url).pathname);
  const cached = await downloadVerifiedRuntimeNode(
    download,
    expected,
    nodeRuntimeCachePath(resolveNodeRuntimeCache(), version, target, fileName),
  );
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-node-runtime-"));
  try {
    if (download.archive) {
      NodeChildProcess.execFileSync("tar", ["-xzf", cached, "-C", scratch], {
        stdio: "inherit",
      });
      NodeFS.copyFileSync(NodePath.join(scratch, download.entryPath), destination);
    } else {
      NodeFS.copyFileSync(cached, destination);
    }
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
  console.log(`[awen] staged Node ${version} for ${target.triple}`);
}

/**
 * Remove the `node_modules/.bin` shims a deploy writes for package binaries.
 * Nothing in the packaged runtime executes a shim: the desktop shell starts the
 * daemon with `dist/bin.mjs` through the embedded Node binary. On POSIX those
 * shims are symlinks, which the installer cannot carry, so drop them before the
 * link check rather than shipping a tree that cannot be copied faithfully.
 */
export function removeNodeModulesBinShims(runtimeDir: string): void {
  NodeFS.rmSync(NodePath.join(runtimeDir, "node_modules", ".bin"), {
    recursive: true,
    force: true,
  });
}

/**
 * Refuse to stage a runtime that resolves anything through a symlink or a
 * junction. Tauri's resource copy drops those entries, so a linked tree ships
 * an installer whose daemon cannot resolve its dependencies; failing here names
 * the mechanism instead of leaving it to a user-visible crash.
 */
export function assertLinkFreeRuntime(runtimeDir: string): void {
  const offenders: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = NodePath.join(directory, entry.name);
      if (NodeFS.lstatSync(entryPath).isSymbolicLink()) {
        offenders.push(NodePath.relative(runtimeDir, entryPath));
        continue;
      }
      if (entry.isDirectory()) walk(entryPath);
    }
  };
  walk(runtimeDir);
  if (offenders.length > 0) {
    throw new Error(
      `The staged desktop runtime resolves ${offenders.length} path(s) through symlinks or junctions, which the installer cannot copy: ${offenders.slice(0, 3).join(", ")}`,
    );
  }
}

export async function stageDesktopRuntime({ target }: StageRuntimeArguments = {}): Promise<void> {
  const hostPlatform = Effect.runSync(HostProcessPlatform);
  const runtimeTarget = target === undefined ? undefined : resolveDesktopRuntimeTarget(target);
  const nodeName = runtimeTarget?.nodeName ?? (hostPlatform === "win32" ? "node.exe" : "node");

  // Without `--target` the runtime matches the developer's machine, so the
  // binary can be copied and checked in place.
  if (runtimeTarget === undefined && hostPlatform === "darwin") {
    assertStandaloneHostNode(process.execPath);
  }

  runPnpm(["build"]);
  NodeFS.rmSync(STAGE, { recursive: true, force: true });
  // Stage the hoisted layout. Tauri copies this tree into the installer as
  // desktop resources, and that copy keeps real files and directories only:
  // symlinks and junctions never reach the installed app. The isolated layout
  // resolves every dependency through exactly those links, so the packaged
  // daemon could not load its first import (`@ff-labs/fff-node`), the shell
  // reported a failed local runtime config, and the client fell back to the
  // window origin instead of the daemon.
  runPnpm([
    "--config.confirmModulesPurge=false",
    "--config.node-linker=hoisted",
    "--filter=@awen/server",
    "deploy",
    "--legacy",
    "--prod",
    STAGE_RELATIVE,
  ]);

  const nodeDestination = NodePath.join(STAGE, nodeName);
  if (runtimeTarget === undefined) {
    NodeFS.copyFileSync(process.execPath, nodeDestination);
  } else {
    await stageTargetNode(runtimeTarget, nodeDestination);
  }
  if (nodeName !== "node.exe") {
    NodeFS.chmodSync(nodeDestination, 0o755);
  }

  if (!NodeFS.existsSync(NodePath.join(STAGE, "dist/bin.mjs"))) {
    throw new Error("The staged desktop runtime is missing dist/bin.mjs.");
  }
  removeNodeModulesBinShims(STAGE);
  // The installer carries this tree as desktop resources, so it ships only what
  // the packaged daemon loads: no source maps (the bundle embeds the full
  // TypeScript text) and no prebuilds for another platform.
  const runtimeTreeTarget = {
    platform: runtimeTarget?.platform ?? hostPlatform,
    arch: runtimeTarget?.arch ?? Effect.runSync(HostProcessArchitecture),
  };
  const pruned = pruneReleaseTree(STAGE, runtimeTreeTarget);
  console.log(`[awen] pruned ${describeReleaseTreePruning(pruned)} from the staged runtime`);
  assertLinkFreeRuntime(STAGE);
  console.log(`[awen] staged desktop daemon and Node runtime in ${STAGE}`);
}

if (import.meta.main) {
  stageDesktopRuntime(readStageArguments(process.argv.slice(2))).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
