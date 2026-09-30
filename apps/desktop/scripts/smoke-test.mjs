import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium } from "playwright-core";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

// oxlint-disable-next-line awen/no-global-process-runtime -- Standalone smoke runner selects the host Node executable without an Effect runtime.
const hostPlatform = NodeOS.platform();

const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const executable = process.argv[process.argv.indexOf("--executable") + 1];
const packaged = process.argv.includes("--executable");
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "awen-desktop-smoke-"));
const socket = NodeNet.createServer();
await new Promise((resolve, reject) => {
  socket.once("error", reject);
  socket.listen(0, "127.0.0.1", resolve);
});
const port = socket.address().port;
await new Promise((resolve) => socket.close(resolve));
const env = {
  ...process.env,
  AWEN_HOME: scratch,
  AWEN_DISABLE_AUTO_UPDATE: "1",
  ELECTRON_ENABLE_LOGGING: "1",
};
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
delete env.AWEN_PORT;
const launch = packaged
  ? { electronPath: executable, args: [] }
  : resolveElectronLaunchCommand([NodePath.join(desktopDir, "dist-electron/boot.cjs")]);
let output = "";
let child;
let exit;
let browser;
let daemon;
let spawnError;
try {
  child = NodeChildProcess.spawn(
    launch.electronPath,
    [...launch.args, `--remote-debugging-port=${port}`],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  child.on("error", (error) => {
    spawnError = error;
    output += error.message;
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const deadline = Date.now() + 120_000;
  let endpoint;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(`Electron exited before readiness: ${child.exitCode}/${child.signalCode}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) {
        endpoint = (await response.json()).webSocketDebuggerUrl;
        break;
      }
    } catch {
      /* Startup is bounded by the deadline. */
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!endpoint) throw new Error("Electron did not expose a debugging endpoint.");
  browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  let page;
  while (Date.now() < deadline) {
    page = context.pages().find((candidate) => candidate.url().startsWith("awen://app/"));
    if (page) break;
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error("Electron exited before opening its application window.");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!page) throw new Error("The application window never loaded.");
  await page.waitForFunction(
    () =>
      document.querySelector("#root")?.childElementCount > 0 &&
      window.desktopBridge?.getLocalEnvironmentBootstraps().length > 0,
    undefined,
    { timeout: 60_000 },
  );
  const readiness = await page.evaluate(async () => {
    const bridge = window.desktopBridge;
    const local = bridge.getLocalEnvironmentBootstraps()[0];
    const token = await bridge.getLocalEnvironmentBearerToken();
    await bridge.getClientSettings();
    await bridge.discoverSshHosts();
    return {
      origin: local.httpBaseUrl,
      authenticated: Boolean(token),
      platform: bridge.getClientPlatform(),
    };
  });
  if (!readiness.authenticated || !readiness.origin)
    throw new Error("Desktop bridge did not authenticate with its daemon.");
  const response = await fetch(new URL("/.well-known/awen/environment", readiness.origin));
  daemon = readiness.origin;
  if (!response.ok || !(await response.json()).serverVersion)
    throw new Error("Daemon descriptor is not ready.");
  if (child.exitCode !== null || child.signalCode !== null)
    throw new Error("Electron exited during bridge verification.");
  child.kill("SIGTERM");
  await Promise.race([
    exit,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Electron failed to exit.")), 10_000),
    ),
  ]);
  // Ordinary quit must leave the daemon reachable and owned by this data root.
  const survived = await fetch(new URL("/.well-known/awen/daemon", daemon));
  if (!survived.ok || !(await survived.json()).managed)
    throw new Error("Quitting Electron stopped the managed daemon.");
  console.log(
    `Desktop smoke test passed (${readiness.platform}): renderer, bridge, SSH API, daemon readiness and shutdown survival.`,
  );
} catch (error) {
  console.error(error, "\nElectron output:\n", output);
  process.exitCode = 1;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  // Disconnect CDP after shutting down Electron; Browser.close could quit it.
  if (browser) await browser.close().catch(() => {});
  const runtime = process.env.AWEN_SMOKE_RUNTIME;
  const node = runtime
    ? NodePath.join(runtime, hostPlatform === "win32" ? "node.exe" : "node")
    : process.execPath;
  const entry = runtime
    ? NodePath.join(runtime, "dist/bin.mjs")
    : NodePath.resolve(desktopDir, "../server/dist/bin.mjs");
  const stopped = NodeChildProcess.spawnSync(
    node,
    [entry, "daemon", "stop", "--confirm", "--json", "--base-dir", scratch],
    { env, encoding: "utf8", timeout: 15_000 },
  );
  if (stopped.status !== 0) {
    console.error("Smoke daemon cleanup failed:", stopped.stderr);
    process.exitCode = 1;
  }
  await NodeFSP.rm(scratch, { recursive: true, force: true });
}
