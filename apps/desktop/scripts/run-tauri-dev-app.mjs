import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveDesktopDevPorts } from "../../../packages/shared/src/daemonPort.ts";

const desktopRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = NodePath.resolve(desktopRoot, "../..");
const developmentHome = process.env.AWEN_HOME?.trim() || NodePath.resolve(repositoryRoot, ".awen");
const devConfig = NodePath.resolve(desktopRoot, "src-tauri/tauri.dev.conf.json");
const browserProof = process.env.AWEN_BROWSER_HOST_PROOF === "1";
const resolvedPorts = resolveDesktopDevPorts(process.env, repositoryRoot);
if (resolvedPorts._tag === "invalid") {
  console.error(`[awen] ${resolvedPorts.message}`);
  process.exit(1);
}

const environment = {
  ...process.env,
  AWEN_HOME: process.env.AWEN_HOME?.trim() || developmentHome,
  AWEN_PORT_OFFSET: process.env.AWEN_PORT_OFFSET?.trim() || "0",
  ...(browserProof
    ? {
        AWEN_PORT_OFFSET: String(resolvedPorts.ports.offset),
        AWEN_PROOF_WEB_ORIGIN: `http://localhost:${String(resolvedPorts.ports.webPort)}`,
      }
    : {}),
};

const build = NodeChildProcess.spawnSync(
  "pnpm",
  [
    "exec",
    "tauri",
    "build",
    "--debug",
    "--config",
    devConfig,
    ...(browserProof ? ["--features", "browser-host-proof"] : []),
  ],
  {
    cwd: desktopRoot,
    env: environment,
    stdio: "inherit",
  },
);

if (build.error) {
  console.error(`Unable to build the Awen Dev app: ${build.error.message}`);
  process.exitCode = 1;
} else if (build.status !== 0) {
  process.exitCode = build.status ?? 1;
} else {
  const bundleRoot = NodePath.resolve(desktopRoot, "src-tauri/target/debug/bundle/macos");
  const preferredAppPath = NodePath.join(bundleRoot, "Awen Dev.app");
  if (!NodeFS.existsSync(preferredAppPath)) {
    console.error(`The Awen Dev app bundle was not found under ${bundleRoot}.`);
    process.exitCode = 1;
  } else {
    const appPath = preferredAppPath;
    const executable = NodePath.join(appPath, "Contents/MacOS/awen-desktop");
    if (!NodeFS.existsSync(executable)) {
      console.error(`The Awen Dev executable was not found at ${executable}.`);
      process.exitCode = 1;
    } else {
      const child = NodeChildProcess.spawn(executable, [], {
        cwd: repositoryRoot,
        env: environment,
        detached: true,
        stdio: "inherit",
      });
      child.unref();
      console.log(`Started Awen Dev: ${appPath}`);
    }
  }
}
