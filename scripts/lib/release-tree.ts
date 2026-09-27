// @effect-diagnostics nodeBuiltinImport:off - Packaging walks a staged release tree on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Release trees carry only what the packaged daemon runs.
 *
 * Two kinds of entry never earn their place in an installer: source maps and
 * debug symbols (`*.map`, `*.pdb`), which serve a developer reading a stack
 * trace, and prebuilt native binaries for a platform the artifact is not for.
 * `node-pty` alone ships ~58 MB of win32 binaries and ~53 MB of `.pdb` symbols
 * inside the Linux x64 daemon package, and the server bundle's own source maps
 * embed the full TypeScript text of every module.
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

/** `process.platform` spellings that can name a prebuild directory. */
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

/** `process.arch` spellings that can name a prebuild directory. */
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
 * of their contents, so a foreign prebuild counts once however many binaries
 * it holds.
 */
function collectReleaseOnlyEntries(root: string, target: ReleaseTarget): string[] {
  const entries: string[] = [];

  const walk = (directory: string): void => {
    const parentName = NodePath.basename(directory);
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (isForeignPrebuildDirectory(entry.name, parentName, target)) {
          entries.push(entryPath);
          continue;
        }
        walk(entryPath);
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
 * Refuses a staged tree that still carries source maps, debug symbols, or
 * another platform's prebuilt binaries. `pruneReleaseTree` runs this over the
 * tree as it stands on disk, so an entry the rules cannot classify fails the
 * build instead of shipping silently.
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
    NodeFS.rmSync(entryPath, { recursive: true, force: true });
    removed = { files: removed.files + measured.files, bytes: removed.bytes + measured.bytes };
  }

  assertReleaseTreePruned(root, target);
  return removed;
}

export function describeReleaseTreePruning(pruning: ReleaseTreePruning): string {
  return `${pruning.files} release-only files (${(pruning.bytes / 1024 / 1024).toFixed(1)} MB)`;
}
