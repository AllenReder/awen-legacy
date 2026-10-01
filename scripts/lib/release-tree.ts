// @effect-diagnostics nodeBuiltinImport:off - Packaging walks a staged release tree on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Release trees carry only what the packaged daemon runs.
 *
 * Three kinds of entry never earn their place in an installer:
 *
 * - source maps and debug symbols (`*.map`, `*.pdb`), which serve a developer
 *   reading a stack trace;
 * - prebuilt native binaries for a platform the artifact is not for, such as
 *   `node-pty`'s `prebuilds/win32-x64`;
 * - packages that ship one platform's native library under a platform-suffixed
 *   name, such as `@ff-labs/fff-bin-linux-x64-gnu` or `@swc/core-darwin-arm64`.
 *
 * Together they were 36.5 MB of source maps, 52.8 MB of Windows `.pdb` symbols,
 * 58.2 MB of win32 prebuilds, and ~25 MB of foreign native packages inside the
 * shipped macOS app.
 */
const PRUNED_FILE_SUFFIXES = [".map", ".pdb"] as const;

/**
 * A `prebuilds/` child names a platform when it looks like `linux-x64`,
 * `win32-arm64`, `aix-ppc64`, or `linuxmusl-x64`; a plain name such as
 * `shared` is read as a shared directory and left alone. The shape decides,
 * not a list of platforms we happened to see, so a prebuild for a platform
 * nobody enumerated is still pruned instead of shipping.
 */
const PREBUILD_DIRECTORY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/u;

/** `process.platform` spellings that can name a prebuild directory or package. */
const SUPPORTED_PLATFORMS = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32",
]);

/** `process.arch` spellings that can name a prebuild directory or package. */
const SUPPORTED_ARCHES = new Set([
  "arm",
  "arm64",
  "ia32",
  "loong64",
  "mips",
  "mipsel",
  "ppc",
  "ppc64",
  "riscv64",
  "s390",
  "s390x",
  "x64",
]);

export interface ReleaseTarget {
  /** `process.platform` spelling, matching the `<platform>-<arch>` prebuild dirs. */
  readonly platform: string;
  /** `process.arch` spelling, matching the `<platform>-<arch>` prebuild dirs. */
  readonly arch: string;
}

export interface ReleaseTreePruning {
  readonly files: number;
  readonly bytes: number;
}

function hasPrunedSuffix(entryName: string): boolean {
  return PRUNED_FILE_SUFFIXES.some((suffix) => entryName.endsWith(suffix));
}

/**
 * Keep the target platform's own architecture. A sibling build whose platform
 * token merely extends the target's (`linuxmusl-x64` for `linux-x64`) is the
 * same platform seen through a different libc, so it stays too.
 */
function isForeignPrebuildDirectory(
  entryName: string,
  parentName: string,
  target: ReleaseTarget,
): boolean {
  if (parentName !== "prebuilds" || !PREBUILD_DIRECTORY_PATTERN.test(entryName)) return false;
  const platformToken = entryName.slice(0, entryName.indexOf("-"));
  return !(platformToken.startsWith(target.platform) && entryName.endsWith(`-${target.arch}`));
}

/**
 * The package a directory stands for, when it is a package root
 * (`node_modules/<name>`, `node_modules/@scope/<name>`) or a pnpm store entry
 * (`node_modules/.pnpm/<key>`). Any other directory — a scope, a `dist/`, a
 * `prebuilds/` child — returns null.
 */
function platformPackageEntryName(directory: string): string | null {
  const parent = NodePath.dirname(directory);
  const parentName = NodePath.basename(parent);
  if (parentName === ".pnpm" || parentName === "node_modules") {
    return NodePath.basename(directory);
  }
  if (
    parentName.startsWith("@") &&
    NodePath.basename(NodePath.dirname(parent)) === "node_modules"
  ) {
    return NodePath.basename(directory);
  }
  return null;
}

/**
 * The `<platform>-<arch>` pair a package name carries, when it carries one:
 * `@ff-labs/fff-bin-linux-x64-gnu`, `@swc/core-darwin-arm64`, or the pnpm store
 * key `@ff-labs+fff-bin-linux-x64-gnu@0.9.4`. The surrounding words are not
 * interpreted, so a package that merely mentions a platform stays.
 */
function platformPackageTarget(entryName: string): { platform: string; arch: string } | null {
  const tokens = entryName.split("-");
  for (let index = 0; index + 1 < tokens.length; index += 1) {
    const platform = tokens[index] ?? "";
    const arch = tokens[index + 1] ?? "";
    if (SUPPORTED_PLATFORMS.has(platform) && SUPPORTED_ARCHES.has(arch)) {
      return { platform, arch };
    }
  }
  return null;
}

/**
 * A package that ships another platform's native library. Every libc build of
 * the target platform and arch stays (`linux-x64-gnu` and `linux-x64-musl` on a
 * Linux x64 package), because the host may be either.
 */
function isForeignPlatformPackage(directory: string, target: ReleaseTarget): boolean {
  const entryName = platformPackageEntryName(directory);
  if (entryName === null) return false;
  const packaged = platformPackageTarget(entryName);
  return (
    packaged !== null && (packaged.platform !== target.platform || packaged.arch !== target.arch)
  );
}

function assertSupportedTarget(target: ReleaseTarget): void {
  if (!SUPPORTED_PLATFORMS.has(target.platform)) {
    throw new Error(
      `Unsupported release platform ${JSON.stringify(target.platform)}: expected one of ${[...SUPPORTED_PLATFORMS].join(", ")}.`,
    );
  }
  if (!SUPPORTED_ARCHES.has(target.arch)) {
    throw new Error(
      `Unsupported release architecture ${JSON.stringify(target.arch)}: expected one of ${[...SUPPORTED_ARCHES].join(", ")}.`,
    );
  }
}

/**
 * Every entry the installed daemon cannot load. Directories are named instead
 * of their contents, so a foreign prebuild or package counts once however many
 * binaries it holds.
 */
function collectReleaseOnlyEntries(root: string, target: ReleaseTarget): string[] {
  const entries: string[] = [];

  const walk = (directory: string): void => {
    const parentName = NodePath.basename(directory);
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          isForeignPrebuildDirectory(entry.name, parentName, target) ||
          isForeignPlatformPackage(entryPath, target)
        ) {
          entries.push(entryPath);
          continue;
        }
        walk(entryPath);
        continue;
      }
      // A package link in an isolated layout is dropped with the store entry it
      // points at; leaving it would ship a link to a path that no longer exists.
      if (entry.isSymbolicLink() && isForeignPlatformPackage(entryPath, target)) {
        entries.push(entryPath);
        continue;
      }
      if (hasPrunedSuffix(entry.name)) entries.push(entryPath);
    }
  };

  walk(root);
  return entries;
}

function measureRemoval(entryPath: string): ReleaseTreePruning {
  const stats = NodeFS.lstatSync(entryPath);
  if (!stats.isDirectory()) return { files: 1, bytes: stats.size };

  let files = 0;
  let bytes = 0;
  for (const entryName of NodeFS.readdirSync(entryPath)) {
    const removed = measureRemoval(NodePath.join(entryPath, entryName));
    files += removed.files;
    bytes += removed.bytes;
  }
  return { files, bytes };
}

/**
 * Removes one collected entry.
 *
 * `NodeFS.rmSync` leaves a dangling symlink on disk on Node 25: it follows the
 * link, finds nothing at the target, and returns without unlinking the entry.
 * Pruning routinely makes links dangle by removing the store directory they
 * point at first, so links are unlinked directly instead of routed through
 * `rmSync`.
 */
function removeReleaseOnlyEntry(entryPath: string): void {
  if (NodeFS.lstatSync(entryPath).isSymbolicLink()) {
    NodeFS.unlinkSync(entryPath);
    return;
  }
  NodeFS.rmSync(entryPath, { recursive: true, force: true });
}

/**
 * Refuses a staged tree that still carries source maps, debug symbols, or
 * another platform's prebuilt binaries and native packages. `pruneReleaseTree`
 * runs this over the tree as it stands on disk, so an entry the rules cannot
 * classify fails the build instead of shipping silently.
 */
export function assertReleaseTreePruned(root: string, target: ReleaseTarget): void {
  assertSupportedTarget(target);
  const offenders = collectReleaseOnlyEntries(root, target).map((entryPath) =>
    NodePath.relative(root, entryPath),
  );
  if (offenders.length > 0) {
    throw new Error(
      `The release tree still carries ${offenders.length} release-only entries, which the installer would ship: ${offenders.slice(0, 3).join(", ")}`,
    );
  }
}

/** Removes release-only entries in place and reports what was dropped. */
export function pruneReleaseTree(root: string, target: ReleaseTarget): ReleaseTreePruning {
  assertSupportedTarget(target);
  let removed: ReleaseTreePruning = { files: 0, bytes: 0 };

  for (const entryPath of collectReleaseOnlyEntries(root, target)) {
    const measured = measureRemoval(entryPath);
    removeReleaseOnlyEntry(entryPath);
    removed = { files: removed.files + measured.files, bytes: removed.bytes + measured.bytes };
  }

  assertReleaseTreePruned(root, target);
  return removed;
}

export function describeReleaseTreePruning(pruning: ReleaseTreePruning): string {
  return `${pruning.files} release-only files (${(pruning.bytes / 1024 / 1024).toFixed(1)} MB)`;
}
