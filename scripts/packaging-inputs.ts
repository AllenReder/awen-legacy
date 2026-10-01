#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off

import * as NodeFS from "node:fs";
import * as NodeProcess from "node:process";

/**
 * Files whose changes can change *how* the release installers are built: the
 * desktop app, its native modules, the packaging scripts, the dependency graph
 * and the workflows themselves.
 *
 * Application code is deliberately absent. `quality`, `tests` and the Linux
 * `desktop-shell` smoke cover it, and the full four-target matrix still runs on
 * every push to `main`, every tag and every pull request that touches one of
 * these paths. `ci.yml` feeds a `git diff --name-only` listing on stdin and
 * expects `true` or `false` on stdout.
 */
export const PACKAGING_INPUT_PREFIXES = [
  "apps/desktop/",
  "native/",
  "scripts/",
  ".github/workflows/",
] as const;

export const PACKAGING_INPUT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
] as const;

export function isPackagingInput(changedPath: string): boolean {
  const path = changedPath.trim().replace(/^\.\//u, "");
  if (path.length === 0) {
    return false;
  }
  return (
    PACKAGING_INPUT_PREFIXES.some((prefix) => path.startsWith(prefix)) ||
    PACKAGING_INPUT_FILES.some((file) => path === file)
  );
}

export function anyPackagingInput(changedPaths: Iterable<string>): boolean {
  for (const changedPath of changedPaths) {
    if (isPackagingInput(changedPath)) {
      return true;
    }
  }
  return false;
}

function readChangedPaths(): string[] {
  if (NodeProcess.stdin.isTTY === true) {
    return [];
  }
  return NodeFS.readFileSync(0, "utf8").split("\n");
}

if (import.meta.main) {
  NodeProcess.stdout.write(`${anyPackagingInput(readChangedPaths())}\n`);
}
