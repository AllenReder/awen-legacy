import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveDesktopDevPorts } from "../../../packages/shared/src/daemonPort.ts";
import {
  nodeEntryInvocation,
  resolvePackageEntry,
  spawnInherited,
} from "../../../scripts/lib/spawn-command.ts";

const desktopRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = NodePath.resolve(desktopRoot, "../..");
const inheritedHome = process.env.AWEN_HOME?.trim();
const developmentHome = inheritedHome || NodePath.resolve(repositoryRoot, ".awen");

// Daemon port, web dev proxy target, and the window URL all come from the one
// resolution in `@awen/shared/daemonPort`, so they cannot disagree. The checkout
// root feeds the offset rule, so `dev:app` lands on the same ports the
// dev-runner would use for this checkout and different worktrees stay isolated.
const resolvedPorts = resolveDesktopDevPorts(process.env, repositoryRoot);
if (resolvedPorts._tag === "invalid") {
  console.error(`[awen] ${resolvedPorts.message}`);
  process.exit(1);
}
const { daemonPort, webPort } = resolvedPorts.ports;
const cliArgs = process.argv.slice(2);
const hasExplicitConfig = cliArgs.some((argument) => argument === "--config" || argument === "-c");
const tauriArgs =
  cliArgs[0] === "dev" && !hasExplicitConfig
    ? [
        cliArgs[0],
        "--config",
        NodePath.resolve(desktopRoot, "src-tauri/tauri.dev.conf.json"),
        // The window must load the web dev port, not the literal `devUrl` in
        // tauri.conf.json. Merged last on purpose: a later `--config` value wins.
        "--config",
        JSON.stringify({ build: { devUrl: `http://localhost:${String(webPort)}` } }),
        ...cliArgs.slice(1),
      ]
    : cliArgs;

function launchTauriCli() {
  // The Tauri CLI is a Node program under `node_modules`. Launch its entry
  // point with this Node executable instead of `pnpm exec tauri`: on Windows
  // Node neither resolves the bare `pnpm` name through `PATHEXT` (`ENOENT`) nor
  // accepts the `.cmd` shim without a shell (`EINVAL`).
  const tauriEntry = resolvePackageEntry("@tauri-apps/cli/tauri.js", desktopRoot);
  return spawnInherited(nodeEntryInvocation(tauriEntry, tauriArgs), {
    cwd: desktopRoot,
    env: {
      ...process.env,
      AWEN_HOME: process.env.AWEN_HOME?.trim() || developmentHome,
      AWEN_PORT_OFFSET: String(resolvedPorts.ports.offset),
      // Pinned as a requirement, not a preference: the web dev proxy addresses
      // the daemon by this number, so a daemon that took a different one would
      // answer nothing. The launcher fails loudly instead of drifting.
      AWEN_DAEMON_PORT: String(daemonPort),
      AWEN_PORT: String(daemonPort),
      AWEN_PROOF_WEB_ORIGIN: `http://localhost:${String(webPort)}`,
      // The web dev server must keep the port the window loads: walking to the
      // next free number would leave it serving a URL nothing reads.
      AWEN_STRICT_DEV_PORTS: process.env.AWEN_STRICT_DEV_PORTS?.trim() || "1",
    },
    failureLabel: "Unable to start the Tauri CLI",
  });
}

try {
  launchTauriCli();
} catch (error) {
  console.error(
    `Unable to start the Tauri CLI: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
