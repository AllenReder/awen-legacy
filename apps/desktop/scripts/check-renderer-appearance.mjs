import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { _electron as electron } from "playwright-core";
import { DEFAULT_CLIENT_SETTINGS } from "@awen/contracts/settings";
import { resolveElectronLaunchCommand } from "./electron-launcher.mjs";

// This probe owns an isolated Electron profile and daemon. It never attaches to
// an existing app or changes the user's settings. Build the web client first.
const desktopDir = NodePath.resolve(import.meta.dirname, "..");
const assetsUrl = NodeURL.pathToFileURL(
  NodePath.resolve(desktopDir, "../web/dist") + NodePath.sep,
).href;
const url = process.argv[2] ?? "awen://app";
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "awen-appearance-"));
const artifacts = NodePath.join(scratch, "artifacts");
await NodeFSP.mkdir(artifacts);
await NodeFSP.mkdir(NodePath.join(scratch, "userdata"));
await NodeFSP.writeFile(
  NodePath.join(scratch, "userdata/client-settings.json"),
  JSON.stringify({
    ...DEFAULT_CLIENT_SETTINGS,
    sidebarOpacity: 10,
    topbarOpacity: 10,
    workbenchOpacity: 10,
    backgroundMaskDarkOpacity: 30,
    glassOpacity: 90,
    contentBackdropBlur: 16,
    onboardingCompletedAt: new Date().toISOString(),
  }),
);
const wrapper = NodePath.join(scratch, "probe.cjs");
// DesktopEnvironment derives macOS userData from NodeOS.homedir. Override it only
// inside this disposable process, before boot, to isolate cookies and locks too.
await NodeFSP.writeFile(
  wrapper,
  `require('node:os').homedir=()=>${JSON.stringify(scratch)};require(${JSON.stringify(NodePath.join(desktopDir, "dist-electron/boot.cjs"))});`,
);
const launch = resolveElectronLaunchCommand([wrapper]);
const env = { ...process.env, AWEN_HOME: scratch, AWEN_DISABLE_UPDATE_CHECK: "1" };
delete env.VITE_DEV_SERVER_URL;
delete env.ELECTRON_RUN_AS_NODE;
delete env.AWEN_PORT;
let app;
let page;
let passed = false;
try {
  app = await electron.launch({
    executablePath: launch.electronPath,
    args: launch.args,
    env,
    timeout: 30000,
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    page = app.windows().find((p) => p.url().startsWith("awen://app/"));
    if (page) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  NodeAssert.ok(page, "The isolated app did not open its main window");
  // Serve the freshly built client at the production desktop origin.
  await app.evaluate(({ session, net, BrowserWindow }, target) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.setBackgroundThrottling(false);
    session.defaultSession.protocol.unhandle("awen");
    session.defaultSession.protocol.handle("awen", (request) => {
      const source = new URL(request.url);
      return net.fetch(
        new URL(source.pathname === "/" ? "index.html" : source.pathname.slice(1), target).href,
      );
    });
  }, assetsUrl);
  await page.goto(url);
  await page.waitForSelector('[data-testid="sidebar-add-project"]', { timeout: 60000 });
  // Fresh profiles can show provider update notifications over the Sidebar.
  const dismiss = page.getByRole("button", { name: "Dismiss notification", exact: true }).first();
  await page.addLocatorHandler(dismiss, async (button) => button.click());
  if (await dismiss.count()) await dismiss.click();

  const spread = (values) =>
    Math.max(...values.map((p) => p[2])) - Math.min(...values.map((p) => p[2]));
  const pixels = async (points) =>
    app.evaluate(
      async ({ BrowserWindow }, input) => {
        const w = BrowserWindow.getAllWindows().find((w) =>
          w.webContents.getURL().startsWith(input.url),
        );
        const shot = await w.webContents.capturePage();
        const size = shot.getSize();
        const bitmap = shot.toBitmap();
        const scale = size.width / input.width;
        return input.points.map(([x, y]) => {
          const offset = (Math.floor(y * scale) * size.width + Math.floor(x * scale)) * 4;
          return [...bitmap.subarray(offset, offset + 4)];
        });
      },
      { url, width: await page.evaluate(() => innerWidth), points },
    );

  const checkColorTransmission = async (bounds, name) => {
    await page.evaluate(
      (midpoint) => {
        document.documentElement.style.setProperty("--glass-blur", "16px");
        document.querySelector("#appearance-probe").style.background =
          `linear-gradient(90deg, rgba(255,60,30,.7) ${midpoint}px, rgba(30,90,255,.7) ${midpoint}px)`;
      },
      bounds.x + bounds.width / 2,
    );
    await page.waitForTimeout(200);
    const [left, right] = await pixels([
      [bounds.x + bounds.width / 4, bounds.y + 12],
      [bounds.x + (bounds.width * 3) / 4, bounds.y + 12],
    ]);
    const difference = Math.max(
      ...left.slice(0, 3).map((channel, i) => Math.abs(channel - right[i])),
    );
    NodeAssert.ok(
      difference > 60,
      `${name} material hides broad background colors (${difference})`,
    );
    await page.screenshot({ path: NodePath.join(artifacts, `${name}-colors.png`) });
    console.log(`PASS ${name} background color transmission: channel difference ${difference}`);
  };

  // Sample the material itself, not just text, throughout popup entry and exit.
  await page.evaluate(() => {
    window.__overlayFrames = [];
    const record = () => {
      const popup = document.querySelector(
        '[data-context-menu], [data-slot="command-dialog-popup"]',
      );
      const glass = popup?.querySelector(".material-surface-overlay");
      if (glass) {
        const style = getComputedStyle(glass);
        window.__overlayFrames.push({
          opacity: Number(style.opacity),
          scale: style.scale,
          background: style.backgroundColor,
          kind: popup.hasAttribute("data-context-menu") ? "menu" : "dialog",
          ending: popup.hasAttribute("data-ending-style"),
        });
      }
      requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  });
  await page.locator('[data-testid="sidebar-add-project"]').click();
  await page.waitForSelector('[data-slot="command-dialog-popup"]');
  await page.waitForTimeout(400);
  const materialFrames = await page.evaluate(() => window.__overlayFrames);
  NodeAssert.ok(
    materialFrames.some((frame) => frame.opacity < 0.95),
    "Popup glass appears instantly; only its text animates",
  );
  const restMaterial = materialFrames.at(-1);
  const tintAlpha = Number(restMaterial.background.match(/[,/]\s*([\d.]+)\s*\)$/)?.[1] ?? 1);
  NodeAssert.ok(tintAlpha < 0.15, `Dark popup tint hides its backdrop (alpha=${tintAlpha})`);

  await page.evaluate(() => {
    const stripe = document.createElement("div");
    stripe.id = "appearance-probe";
    stripe.style.cssText =
      "position:fixed;inset:0;z-index:10;background:repeating-linear-gradient(90deg,transparent 0px,transparent 4px,rgba(255,255,255,.7) 4px,rgba(255,255,255,.7) 8px)";
    document.querySelector("#root").append(stripe);
  });
  const popup = await page.locator('[data-slot="command-dialog-popup"]').boundingBox();
  const dialogSamples = Array.from({ length: 80 }, (_, i) => [popup.x + 20 + i, popup.y + 6]);
  const dialogContrasts = [];
  for (const radius of [16, 0]) {
    await page.evaluate(
      (r) => document.documentElement.style.setProperty("--glass-blur", `${r}px`),
      radius,
    );
    await page.waitForTimeout(300);
    dialogContrasts.push(spread(await pixels(dialogSamples)));
    await page.screenshot({ path: NodePath.join(artifacts, `add-project-${radius}.png`) });
  }
  NodeAssert.ok(
    dialogContrasts[0] < 5 && dialogContrasts[1] > 8,
    `Add Project blur absent: pixel contrast 16px/0px=${dialogContrasts}`,
  );
  console.log(`PASS Add Project pixel blur: contrast ${dialogContrasts.join("/")} (16px/0px)`);
  await checkColorTransmission(popup, "add-project");
  await page.evaluate(() => {
    document.querySelector("#appearance-probe").remove();
    document.documentElement.style.setProperty("--glass-blur", "16px");
  });
  await page.keyboard.press("Escape");
  await page.waitForSelector('[data-slot="command-dialog-popup"]', { state: "detached" });
  const dialogExit = await page.evaluate(() =>
    window.__overlayFrames.filter((frame) => frame.kind === "dialog" && frame.ending),
  );
  NodeAssert.ok(
    dialogExit.some(
      (frame) => frame.opacity > 0.05 && frame.opacity < 0.95 && Number(frame.scale) < 1,
    ),
    "Dialog material disappears without fade/shrink",
  );
  console.log(`PASS dialog material entry/exit, dark tint alpha=${tintAlpha}`);
  await page.getByRole("button", { name: "New tab", exact: true }).click();
  await page.waitForTimeout(300);
  const before = await page
    .locator('[role="tab"][aria-selected="true"]')
    .getAttribute("data-tab-id");
  NodeAssert.equal(
    await page.evaluate(() => typeof window.desktopBridge?.onTrackpadInput),
    "function",
    "Native trackpad addon did not attach",
  );
  const stage = await page.locator(".workbench-viewport-container").boundingBox();
  await page.mouse.move(stage.x + stage.width - 8, stage.y + stage.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(stage.x - 8, stage.y + stage.height / 2, { steps: 12 });
  await page.waitForTimeout(50);
  NodeAssert.notEqual(
    await page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab-id"),
    before,
    "Full-width right drag did not activate at its checkpoint",
  );
  await page.mouse.up({ button: "right" });
  console.log("PASS full-width right drag activates before release");
  await page.waitForTimeout(400);
  await page
    .locator('.workbench-viewport:not([style*="display: none"]) [data-workbench-pane-drag-handle]')
    .first()
    .click({ button: "right" });
  await page.waitForSelector("[data-context-menu]", { timeout: 15000 });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  const menuEntry = await page.evaluate(() =>
    window.__overlayFrames.filter((frame) => frame.kind === "menu" && !frame.ending),
  );
  NodeAssert.ok(
    menuEntry.some((frame) => frame.opacity < 0.95 && Number(frame.scale) < 1),
    "Context menu glass appears without fade/scale",
  );
  const menu = await page.locator("[data-context-menu]").boundingBox();
  await page.evaluate(() => {
    const stripe = document.createElement("div");
    stripe.id = "appearance-probe";
    stripe.style.cssText =
      "position:fixed;inset:0;z-index:10;background:repeating-linear-gradient(90deg,transparent 0px,transparent 4px,rgba(255,255,255,.7) 4px,rgba(255,255,255,.7) 8px)";
    document.querySelector("#root").append(stripe);
  });
  const menuContrasts = [];
  for (const radius of [16, 0]) {
    await page.evaluate(
      (r) => document.documentElement.style.setProperty("--glass-blur", `${r}px`),
      radius,
    );
    await page.waitForTimeout(300);
    menuContrasts.push(
      spread(await pixels(Array.from({ length: 80 }, (_, i) => [menu.x + 20 + i, menu.y + 6]))),
    );
    await page.screenshot({ path: NodePath.join(artifacts, `context-menu-${radius}.png`) });
  }
  NodeAssert.ok(
    menuContrasts[0] < 5 && menuContrasts[1] > 8,
    `Context menu blur absent: ${menuContrasts}`,
  );
  console.log(`PASS context menu transparent-source blur: ${menuContrasts.join("/")}`);
  await checkColorTransmission(menu, "context-menu");
  await page.evaluate(() => {
    document.querySelector("#appearance-probe").remove();
    document.documentElement.style.setProperty("--glass-blur", "16px");
  });
  await page.keyboard.press("Escape");
  await page.waitForSelector("[data-context-menu]", { state: "detached" });
  const menuExit = await page.evaluate(() =>
    window.__overlayFrames.filter((frame) => frame.kind === "menu" && frame.ending),
  );
  NodeAssert.ok(
    menuExit.some(
      (frame) => frame.opacity > 0.05 && frame.opacity < 0.95 && Number(frame.scale) < 1,
    ),
    "Context menu material disappears without fade/shrink",
  );
  console.log("PASS context menu material entry/exit");
  NodeAssert.equal(
    await page.locator("[data-glass-sampling-underlay]").count(),
    0,
    "Popup sampling underlay leaked after closing",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page
    .locator('.workbench-viewport:not([style*="display: none"]) [data-workbench-pane-drag-handle]')
    .first()
    .focus();
  const closedPane = await page
    .locator('.workbench-viewport:not([style*="display: none"]) .workbench-pane')
    .first()
    .getAttribute("data-pane-id");
  await page.keyboard.press("Shift+F10");
  await page.waitForSelector("[data-context-menu]", { timeout: 15000 });
  NodeAssert.equal(
    await page
      .locator("[data-context-menu] .overlay-content")
      .evaluate((element) => getComputedStyle(element).transitionDuration),
    "0s",
  );
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForSelector("[data-context-menu]", { state: "detached" });
  await page.waitForFunction(
    (previous) =>
      !Array.from(document.querySelectorAll(".workbench-pane")).some(
        (element) => element.getAttribute("data-pane-id") === previous,
      ),
    closedPane,
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  console.log("PASS context menu keyboard selection with reduced motion");
  await page.goto(`${url}/#/settings/appearance`);
  await page.reload();
  await page.waitForSelector("#content-backdrop-blur");
  await page.waitForTimeout(300);
  const baseline = (await pixels([[40, 350]]))[0];
  await page.locator("#content-backdrop-blur").fill("24");
  await page.waitForTimeout(300);
  const changed = (await pixels([[40, 350]]))[0];
  NodeAssert.ok(
    baseline.every((v, i) => Math.abs(v - changed[i]) <= 1),
    `Blur slider changed Sidebar tint: ${baseline} -> ${changed}`,
  );
  NodeAssert.equal(await page.locator('[data-slot$="backdrop"]').count(), 0);
  await page.screenshot({ path: NodePath.join(artifacts, "settings.png") });
  console.log(`PASS blur slider leaves Sidebar RGBA unchanged: ${baseline}`);
  passed = true;
} catch (error) {
  if (page) {
    console.log("PAGE", page.url(), await page.locator("body").innerText());
    await page.screenshot({ path: NodePath.join(artifacts, "failure.png") });
  }
  throw error;
} finally {
  if (app) await app.close().catch(() => app.process().kill("SIGKILL"));
  const stopped = NodeChildProcess.spawnSync(
    process.execPath,
    [
      NodePath.resolve(desktopDir, "../server/dist/bin.mjs"),
      "daemon",
      "stop",
      "--confirm",
      "--json",
      "--base-dir",
      scratch,
    ],
    { env, encoding: "utf8", timeout: 15000 },
  );
  NodeAssert.equal(stopped.status, 0, "Probe daemon cleanup failed");
  // Retain screenshots for inspection; never retain auth state or daemon data.
  const destination = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "awen-appearance-artifacts-"),
  );
  await NodeFSP.cp(artifacts, destination, { recursive: true });
  await NodeFSP.rm(scratch, { recursive: true, force: true });
  console.log(`${passed ? "PASS" : "FAIL"} screenshots: ${destination}`);
}
