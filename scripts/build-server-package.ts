#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Assembles a standalone headless server distribution package for Awen daemon.
 * Layout:
 *   bin/awen (executable launcher with Node.js version verification)
 *   dist/bin.mjs
 *   package.json
 *   node_modules/ (production dependencies)
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { HostProcessArchitecture, HostProcessPlatform } from "@awen/shared/hostProcess";
import * as Effect from "effect/Effect";
import packageJson from "../apps/server/package.json" with { type: "json" };
import productPackageJson from "../package.json" with { type: "json" };
import { describeReleaseTreePruning, pruneReleaseTree } from "./lib/release-tree.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..");
const DEFAULT_OUTPUT_DIR = NodePath.join(REPO_ROOT, "release-server");

const WRAPPER_SCRIPT = `#!/bin/sh
set -eu
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SERVER_DIR="$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js ^22.16, ^23.11, or >=24.10 is required to run Awen daemon." >&2
  echo "Please install Node.js (https://nodejs.org) on this system." >&2
  exit 1
fi

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit((major === 22 && minor >= 16) || (major === 23 && minor >= 11) || (major === 24 && minor >= 10) || major > 24 ? 0 : 1)' >/dev/null 2>&1; then
  echo "Error: Node.js ^22.16, ^23.11, or >=24.10 is required (found $(node -v))." >&2
  exit 1
fi

export AWEN_HOME="\${AWEN_HOME:-$HOME/.awen}"

exec node "$SERVER_DIR/dist/bin.mjs" "$@"
`;

export interface BuildServerPackageOptions {
  readonly outputDir?: string | undefined;
  readonly platform?: string;
  readonly arch?: string;
  readonly version?: string;
  readonly skipBuild?: boolean;
}

export function isExactServerPackageVersion(version: string): boolean {
  const core = "(?:0|[1-9]\\d*)";
  const prerelease = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
  return new RegExp(
    `^${core}\\.${core}\\.${core}(?:-${prerelease}(?:\\.${prerelease})*)?$`,
    "u",
  ).test(version);
}

export function buildServerPackage(options: BuildServerPackageOptions = {}) {
  const hostPlatform = Effect.runSync(HostProcessPlatform);
  const hostArch = Effect.runSync(HostProcessArchitecture);
  const outputDir = options.outputDir ?? DEFAULT_OUTPUT_DIR;
  const platform =
    options.platform ??
    (hostPlatform === "darwin" ? "darwin" : hostPlatform === "win32" ? "win32" : "linux");
  const arch = options.arch ?? (hostArch === "arm64" ? "arm64" : "x64");
  const version = options.version ?? productPackageJson.version;
  if (!isExactServerPackageVersion(version)) {
    throw new Error(`Server package version must be exact, received '${version}'.`);
  }
  if (version !== productPackageJson.version) {
    throw new Error(
      `Server package version ${version} does not match the product version ${productPackageJson.version}.`,
    );
  }
  if (version !== packageJson.version) {
    throw new Error(
      `Server package version ${version} does not match the bundled daemon version ${packageJson.version}.`,
    );
  }
  const stem = `awen-server-${version}-${platform}-${arch}`;

  if (!options.skipBuild) {
    console.log("[build-server-package] Building server bundle in apps/server...");
    NodeChildProcess.execSync("pnpm exec vp pack", {
      cwd: NodePath.join(REPO_ROOT, "apps/server"),
      stdio: "inherit",
    });
  }

  const stageRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "awen-server-pkg-"));
  const stageDir = NodePath.join(stageRoot, stem);

  try {
    console.log(`[build-server-package] Staging production deployment into ${stageDir}...`);
    NodeChildProcess.execSync(
      `pnpm --config.confirmModulesPurge=false --filter=@awen/server deploy --legacy --prod "${stageDir}"`,
      {
        cwd: REPO_ROOT,
        stdio: "inherit",
      },
    );

    // The deploy copies the published package verbatim: the bundle ships source
    // maps with the full TypeScript text, and node-pty ships every platform
    // prebuild including ~53 MB of Windows .pdb symbols. Drop what the daemon
    // cannot load before the archive is written.
    const releaseTarget = { platform, arch };
    // pruneReleaseTree refuses to return while a release-only entry remains.
    const pruned = pruneReleaseTree(stageDir, releaseTarget);
    console.log(
      `[build-server-package] Pruned ${describeReleaseTreePruning(pruned)} from the staged deployment.`,
    );

    const binDir = NodePath.join(stageDir, "bin");
    NodeFS.mkdirSync(binDir, { recursive: true });

    const awenWrapperPath = NodePath.join(binDir, "awen");
    NodeFS.writeFileSync(awenWrapperPath, WRAPPER_SCRIPT, { mode: 0o755 });

    const readmeContent = `# Awen Daemon Package

Standalone headless server package for Awen daemon.

## Requirements
- Linux x64 (or supported POSIX environment)
- Node.js >= 22.16
- Git

## Quick Start

\`\`\`bash
# Start daemon in background (survives SSH disconnect)
./bin/awen daemon start

# Check status
./bin/awen daemon status

# Generate client pairing token for Awen desktop
./bin/awen auth pairing create --json

# Read bootstrap token
./bin/awen daemon token

# Stop daemon safely
./bin/awen daemon stop --confirm
\`\`\`
`;
    NodeFS.writeFileSync(NodePath.join(stageDir, "README.md"), readmeContent);

    NodeFS.mkdirSync(outputDir, { recursive: true });
    const archiveFileName = `${stem}.tar.gz`;
    const archivePath = NodePath.join(outputDir, archiveFileName);
    const checksumPath = NodePath.join(outputDir, "SHA256SUMS");

    console.log(`[build-server-package] Creating archive ${archivePath}...`);
    NodeChildProcess.execSync(`tar -czf "${archivePath}" -C "${stageRoot}" "${stem}"`, {
      stdio: "inherit",
    });
    const archiveHash = NodeCrypto.createHash("sha256")
      .update(NodeFS.readFileSync(archivePath))
      .digest("hex");
    NodeFS.writeFileSync(checksumPath, `${archiveHash}  ${archiveFileName}\n`);

    console.log(`[build-server-package] Successfully created ${archivePath}`);
    console.log(`[build-server-package] Wrote ${checksumPath}`);
    return { archivePath, checksumPath, stageDir, stem, version };
  } finally {
    NodeFS.rmSync(stageRoot, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const optionValue = (name: string) => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };
  const outputDir = optionValue("output-dir");
  const platform = optionValue("platform");
  const arch = optionValue("arch");
  const version = optionValue("version");
  buildServerPackage({
    ...(outputDir !== undefined ? { outputDir } : {}),
    ...(platform !== undefined ? { platform } : {}),
    ...(arch !== undefined ? { arch } : {}),
    ...(version !== undefined ? { version } : {}),
  });
}
