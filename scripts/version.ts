#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const SEMVER_CORE = "(?:0|[1-9]\\d*)";
const SEMVER_PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const EXACT_VERSION = new RegExp(
  `^${SEMVER_CORE}\\.${SEMVER_CORE}\\.${SEMVER_CORE}(?:-${SEMVER_PRERELEASE_IDENTIFIER}(?:\\.${SEMVER_PRERELEASE_IDENTIFIER})*)?$`,
  "u",
);
const PACKAGE_FILES = [
  "package.json",
  "apps/server/package.json",
  "apps/web/package.json",
  "apps/desktop/package.json",
  "packages/contracts/package.json",
] as const;

function readJson(filePath: string): Record<string, unknown> {
  const value: unknown = JSON.parse(NodeFS.readFileSync(filePath, "utf8"));
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath} must contain a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function formatJson(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function macOSNativeVersion(version: string): string {
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`Version must be an exact semver-like value, received '${version}'.`);
  }
  return version.split("-", 1)[0]!;
}

function isNumericBundleVersion(version: unknown): boolean {
  if (typeof version !== "string" || !/^\d+$/u.test(version)) return false;
  return Number.isSafeInteger(Number(version));
}

function incrementMacOSBundleVersion(version: unknown): string {
  if (typeof version !== "string" || !/^\d+$/u.test(version)) {
    throw new Error("macOS bundleVersion must be a numeric build number.");
  }
  const buildNumber = Number(version);
  if (!Number.isSafeInteger(buildNumber)) {
    throw new Error("macOS bundleVersion must be a safe integer.");
  }
  return String(buildNumber + 1);
}

export function checkVersion(rootDir = REPO_ROOT): string[] {
  const rootVersion = readJson(NodePath.join(rootDir, "package.json")).version;
  if (typeof rootVersion !== "string" || !EXACT_VERSION.test(rootVersion)) {
    return ["package.json must declare an exact product version."];
  }

  const problems: string[] = [];
  for (const relativePath of PACKAGE_FILES.slice(1)) {
    const version = readJson(NodePath.join(rootDir, relativePath)).version;
    if (version !== rootVersion) {
      problems.push(`${relativePath}: expected ${rootVersion}, found ${String(version)}.`);
    }
  }
  const desktop = readJson(NodePath.join(rootDir, "apps/desktop/package.json"));
  const mac = (desktop.build as { mac?: { bundleVersion?: unknown } } | undefined)?.mac;
  if (!isNumericBundleVersion(mac?.bundleVersion)) {
    problems.push("apps/desktop/package.json: build.mac.bundleVersion must be numeric.");
  }
  return problems;
}

export function setVersion(version: string, rootDir = REPO_ROOT): void {
  if (!EXACT_VERSION.test(version)) {
    throw new Error(`Version must be an exact semver-like value, received '${version}'.`);
  }

  const updates = new Map<string, string>();
  // `formatJson` expands compact arrays, so rewriting a manifest whose value did
  // not change silently reformats it: bumping the version used to expand the
  // arrays in manifests and fail `vp fmt --check` in CI. Only record a
  // manifest when its parsed value actually differs from what is on disk.
  const recordManifest = (relativePath: string, value: Record<string, unknown>): void => {
    const next = formatJson(value);
    if (next === formatJson(readJson(NodePath.join(rootDir, relativePath)))) return;
    updates.set(relativePath, next);
  };
  const currentProductVersion = readJson(NodePath.join(rootDir, "package.json")).version;
  for (const relativePath of PACKAGE_FILES) {
    const packageJson = readJson(NodePath.join(rootDir, relativePath));
    if (typeof packageJson.version !== "string") {
      throw new Error(`${relativePath} must already declare a version.`);
    }
    packageJson.version = version;
    if (relativePath === "apps/desktop/package.json" && version !== currentProductVersion) {
      const build = packageJson.build as { mac: { bundleVersion: string } };
      build.mac.bundleVersion = incrementMacOSBundleVersion(build.mac.bundleVersion);
    }
    recordManifest(relativePath, packageJson);
  }

  for (const [relativePath, contents] of updates) {
    const filePath = NodePath.join(rootDir, relativePath);
    if (NodeFS.readFileSync(filePath, "utf8") !== contents)
      NodeFS.writeFileSync(filePath, contents);
  }
}

if (import.meta.main) {
  try {
    const [command, version] = process.argv.slice(2);
    if (command === "check") {
      const problems = checkVersion();
      if (problems.length > 0) throw new Error(problems.join("\n"));
      process.stdout.write("Product versions are in sync.\n");
    } else if (command === "set" && version) {
      setVersion(version);
      process.stdout.write(`Product version set to ${version}.\n`);
    } else {
      throw new Error("Usage: node scripts/version.ts check | set <version>");
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
