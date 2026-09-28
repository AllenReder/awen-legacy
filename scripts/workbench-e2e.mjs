#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium } from "playwright";
import { requestDevRunnerStop } from "./lib/dev-runner-stop.ts";
import { createProcessTreePort, stopProcessTree } from "./lib/process-tree.ts";
import { nodeEntryInvocation, withNodeModulesBin } from "./lib/spawn-command.ts";
import { removePathWithRetry, runTeardownSteps } from "./lib/teardown-steps.ts";
import { verifyWorkbenchFiles } from "./workbench-file-checks.mjs";
import { verifyWorkbenchAppearance } from "./workbench-appearance-checks.mjs";

// This suite never sends an Agent turn. Promotion coverage must use the ACP
// mock agent; a future real-provider smoke must opt in, use gpt-5.6-luna at
// most, and reject gpt-6-astra before sending.
const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
const timeoutMs = Number(process.env.WORKBENCH_E2E_TIMEOUT_MS ?? "120000");
const stopRequestTimeoutMs = 10_000;
const keepTemporary = process.env.WORKBENCH_E2E_KEEP_TEMP === "1";

function stripAnsi(value) {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

async function chooseContextMenuItem(page, trigger, label) {
  await trigger.click({ button: "right" });
  const item = page.getByRole("button", { name: label, exact: true });
  await item.waitFor({ state: "visible", timeout: timeoutMs });
  // The fallback deliberately ignores clicks from the opening gesture. Wait
  // beyond that guard before issuing the semantic menu selection.
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined))),
      ),
  );
  await item.click();
}

async function readOpenTerminalTarget(page) {
  return page.evaluate(async () => {
    const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
    for (const tab of useWorkbenchStore.getState().tabs) {
      for (const view of tab.panes.values()) {
        if (view.target.kind === "workspaceTerminal") return view.target;
      }
    }
    throw new Error("Expected an open Terminal Session View.");
  });
}

/**
 * ADR-0010: re-opening an open Session must focus its existing Session View
 * instead of creating a second one. Creates an empty Tab first so a duplicate
 * Session View would be observable.
 */
async function reopenTerminalFromNewTab(page, target) {
  return page.evaluate(async (terminalTarget) => {
    const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
    const before = useWorkbenchStore.getState();
    const firstTabId = before.activeTabId;
    const tabsBefore = before.tabs.length;
    before.createTab();
    useWorkbenchStore.getState().openTarget(terminalTarget);
    const after = useWorkbenchStore.getState();
    const terminalTabs = after.tabs.filter((tab) =>
      [...tab.panes.values()].some((view) => view.target.kind === "workspaceTerminal"),
    );
    const terminalViewCount = after.tabs.reduce(
      (count, tab) =>
        count +
        [...tab.panes.values()].filter((view) => view.target.kind === "workspaceTerminal").length,
      0,
    );
    return {
      firstTabId,
      tabsBefore,
      tabsAfter: after.tabs.length,
      terminalViewCount,
      terminalTabId: terminalTabs[0]?.id,
      activeTabId: after.activeTabId,
    };
  }, target);
}

async function paneKinds(page) {
  return page
    .locator("[data-pane-id]")
    .evaluateAll((elements) =>
      elements.map((element) => element.getAttribute("data-pane-target-kind")),
    );
}

async function activeWorkbenchTabId(page) {
  return page.evaluate(async () => {
    const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
    return useWorkbenchStore.getState().activeTabId;
  });
}

async function workbenchStateSignature(page) {
  return page.evaluate(async () => {
    const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
    const state = useWorkbenchStore.getState();
    return JSON.stringify({
      activeTabId: state.activeTabId,
      tabs: state.tabs.map((tab) => ({
        id: tab.id,
        panes: [...tab.panes.entries()].map(([paneId, view]) => ({
          paneId,
          presentation: view.presentation,
          target: view.target,
        })),
      })),
    });
  });
}

async function terminalViewCountsByTab(page) {
  return page.evaluate(async () => {
    const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
    return useWorkbenchStore.getState().tabs.map((tab) => ({
      id: tab.id,
      terminalViews: [...tab.panes.values()].filter(
        (view) => view.target.kind === "workspaceTerminal",
      ).length,
    }));
  });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local port."));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function waitForOutput(child, pattern, label) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for ${label}.\n${stripAnsi(output)}`));
    }, timeoutMs);
    const onData = (chunk) => {
      output += chunk.toString();
      const match = stripAnsi(output).match(pattern);
      if (match !== null) {
        cleanup();
        resolve({ match, output });
      }
    };
    const onExit = (code, signal) => {
      cleanup();
      reject(
        new Error(
          `Dev runner exited before ${label}: code=${String(code)} signal=${String(signal)}\n${stripAnsi(output)}`,
        ),
      );
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.once("exit", onExit);
  });
}

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

function waitForChildExitWithin(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) onExit();
  });
}

/**
 * Terminate the isolated daemon, not just the runner that launched it.
 *
 * `scripts/dev-runner.ts` resolves `vp`, which starts a Vite+ core process,
 * which runs `node --watch src/bin.ts`, which runs the daemon holding this
 * run of the temporary home.
 *
 * Ask the runner through its pid-scoped stop file first. That lets the runner
 * unwind its Effect scope while `vp` is still alive, so the child-process
 * finalizer can use `taskkill /T /F` instead of orphaning the descendants.
 * The process-tree sweep remains the fallback for an early crash or a runner
 * that does not answer the request.
 */
async function stopDaemonProcessTree(child, home) {
  if (typeof child.pid !== "number") return;

  // oxlint-disable-next-line awen/no-global-process-runtime -- Standalone browser harness owns native child process groups.
  if (NodeOS.platform() === "win32" && child.exitCode === null && child.signalCode === null) {
    let requestPath = null;
    try {
      requestPath = await requestDevRunnerStop(home, child.pid);
      if (await waitForChildExitWithin(child, stopRequestTimeoutMs)) {
        console.log(
          `workbench: dev runner drained its process tree (stop request: ${requestPath})`,
        );
        return;
      }
      console.error(
        `workbench: dev runner did not exit within ${String(stopRequestTimeoutMs)}ms after stop request ${requestPath}; falling back to force teardown`,
      );
    } catch (error) {
      console.error(
        `workbench: could not request the dev-runner stop: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const port = createProcessTreePort({
    hasRootExited: () => child.exitCode !== null || child.signalCode !== null,
    // oxlint-disable-next-line awen/no-global-process-runtime -- Standalone browser harness owns native child process groups.
    platform: NodeOS.platform(),
    rootExited: waitForChildExit(child),
  });
  const result = await stopProcessTree({ port, rootPid: child.pid });
  if (result.descendants.status === "skipped") {
    if (result.descendants.reason === "root-exited") {
      console.error(
        "workbench: the dev runner had already exited, so the daemon tree it left behind could not be tracked or stopped",
      );
    }
    if (result.descendants.reason === "enumeration-unavailable") {
      console.error(
        "workbench: could not read the process table, so the runner's own tree was force-killed without a descendant sweep",
      );
    }
  }
  if (result.survivors.length > 0) {
    console.error(`workbench: daemon processes survived teardown: ${result.survivors.join(", ")}`);
  }
}

async function finishTemporaryHome(directory, keepTemporary) {
  if (keepTemporary) {
    console.log(`kept workbench E2E data at ${directory}`);
    return;
  }
  const result = await removePathWithRetry(directory);
  if (result.removed) return;
  console.error(
    `workbench: kept ${directory} after ${result.attempts} removal attempts: ${result.reason}`,
  );
}

function runGit(cwd, ...args) {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function verifyBranchSelection(page, temporaryRoot) {
  const repo = NodePath.join(temporaryRoot, "branch-selection-repo");
  const remote = NodePath.join(temporaryRoot, "branch-selection-remote.git");
  const otherWorktree = NodePath.join(temporaryRoot, "branch-selection-feature-b");
  await NodeFSP.mkdir(repo);
  await NodeFSP.mkdir(remote);
  runGit(remote, "init", "--bare", "-b", "main");
  runGit(repo, "init", "-b", "main");
  runGit(repo, "config", "user.name", "Workbench E2E");
  runGit(repo, "config", "user.email", "workbench@example.test");
  await NodeFSP.writeFile(NodePath.join(repo, "README.md"), "branch selection fixture\n");
  runGit(repo, "add", "README.md");
  runGit(repo, "commit", "-m", "initial");
  runGit(repo, "remote", "add", "origin", remote);
  runGit(repo, "push", "-u", "origin", "main");
  runGit(repo, "remote", "set-head", "origin", "-a");
  runGit(repo, "branch", "feature-a");
  runGit(repo, "branch", "feature-b");
  runGit(repo, "switch", "feature-a");
  runGit(repo, "worktree", "add", otherWorktree, "feature-b");

  await page.getByTestId("sidebar-add-project").click();
  await page.getByText("Local folder", { exact: true }).click();
  const projectPath = page.getByPlaceholder("Enter path (e.g. ~/projects/my-app)");
  await projectPath.fill(repo);
  await projectPath.press("Enter");
  const projectRow = page
    .getByTestId("sidebar-project-row")
    .filter({ hasText: "branch-selection-repo" });
  await projectRow.waitFor({ state: "visible", timeout: timeoutMs });
  const mainWorkspace = projectRow.locator("..").getByTestId("sidebar-workspace-row").first();
  await chooseContextMenuItem(page, mainWorkspace, "New Agent Session");
  const agentPane = page.locator(
    '[data-pane-focused="true"][data-pane-target-kind="agentSession"], [data-pane-focused="true"][data-pane-target-kind="newAgentSession"]',
  );
  await agentPane.waitFor({ state: "visible", timeout: timeoutMs });
  const initialAgentUrl = page.url();
  const branchTrigger = agentPane.locator('[data-slot="combobox-trigger"]').filter({
    has: page.locator("svg.lucide-git-branch"),
  });

  await branchTrigger.click();
  const branchPopup = page.locator('[data-slot="combobox-popup"]:visible');
  await branchPopup.getByPlaceholder("Search refs...").fill("main");
  await branchPopup.getByText("main", { exact: true }).click();
  await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('[data-testid="sidebar-workspace-row"]')].find(
      (element) => element.textContent?.includes("branch-selection-repo"),
    );
    return row?.querySelector('[data-testid="sidebar-workspace-branch"]')?.textContent === "main";
  });
  NodeAssert.equal(runGit(repo, "branch", "--show-current"), "main");
  NodeAssert.equal(page.url(), initialAgentUrl, "In-place checkout must keep the Agent Session.");
  NodeAssert.equal(
    await projectRow.locator("..").getByTestId("sidebar-workspace-row").count(),
    1,
    "In-place checkout must keep the Workspace identity.",
  );

  await branchTrigger.click();
  await branchPopup.getByPlaceholder("Search refs...").fill("feature-b");
  await branchPopup.getByText("feature-b", { exact: true }).click();
  await page.waitForFunction(() =>
    [...document.querySelectorAll('[data-testid="sidebar-workspace-dir"]')].some((element) =>
      element.textContent?.includes("branch-selection-feature-b"),
    ),
  );
  NodeAssert.equal(runGit(otherWorktree, "branch", "--show-current"), "feature-b");
  NodeAssert.equal(page.url(), initialAgentUrl, "Migration must keep the Agent Session.");
  NodeAssert.equal(
    await projectRow.locator("..").getByTestId("sidebar-workspace-row").count(),
    2,
    "Selecting an unregistered worktree must register it in the same Project.",
  );
  const projectWorkspaces = projectRow.locator("..");
  const worktreeRow = projectWorkspaces.getByTestId("sidebar-workspace-row").filter({
    has: page.getByTestId("sidebar-workspace-dir").filter({
      hasText: "branch-selection-feature-b",
    }),
  });
  const worktreeContainer = worktreeRow.locator("..").locator("..");
  const sourceContainer = mainWorkspace.locator("..").locator("..");
  for (const container of [worktreeContainer, sourceContainer]) {
    const disclosure = container.getByTestId("sidebar-workspace-disclosure");
    if ((await disclosure.getAttribute("aria-label")) === "Expand Workspace") {
      await disclosure.click();
    }
  }
  await worktreeContainer.getByTestId("sidebar-session-row").waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
  NodeAssert.equal(
    await sourceContainer.getByTestId("sidebar-session-row").count(),
    0,
    "Migration must remove the Agent Session from its previous Workspace.",
  );
}

async function main() {
  const temporaryRoot = await NodeFSP.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "awen-workbench-e2e-"),
  );
  const home = NodePath.join(temporaryRoot, "home");
  await NodeFSP.mkdir(home, { recursive: true });

  const serverPort = await reservePort();
  // Run the daemon with this Node executable rather than `pnpm exec node`: a
  // bare `pnpm` cannot be spawned on Windows, and `node_modules/.bin` on PATH
  // gives `scripts/dev-runner.ts` the `vp` it resolves by name.
  const devRunnerInvocation = nodeEntryInvocation(
    NodePath.join(repositoryRoot, "scripts/dev-runner.ts"),
    ["--home-dir", home, "--port", String(serverPort), "--auto-bootstrap-project-from-cwd", "dev"],
  );
  const child = NodeChildProcess.spawn(devRunnerInvocation.command, devRunnerInvocation.args, {
    cwd: repositoryRoot,
    // oxlint-disable-next-line awen/no-global-process-runtime -- This standalone browser harness owns native child process groups.
    detached: NodeOS.platform() !== "win32",
    env: withNodeModulesBin(
      {
        ...process.env,
        CI: "1",
        AWEN_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
      },
      [repositoryRoot],
    ),
    shell: devRunnerInvocation.shell,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let browser = null;
  let page = null;
  const pageErrors = [];
  const consoleErrors = [];
  try {
    const { match: pairingMatch } = await waitForOutput(
      child,
      /pairingUrl:\s*(https?:\/\/\S+)/,
      "the isolated daemon pairing URL",
    );
    const pairingUrl = stripAnsi(pairingMatch[1]);
    console.log("workbench: daemon ready");
    browser = await chromium.launch({
      headless: process.env.WORKBENCH_E2E_HEADED !== "1",
      ...(process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "1" ? { channel: "chrome" } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(() => {
      localStorage.setItem(
        "awen:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: new Date().toISOString() }),
      );
    });
    page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    page.on("crash", () => console.error("workbench: browser page crashed"));
    page.on("pageerror", (error) => pageErrors.push(error));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    await page.goto(pairingUrl, { waitUntil: "domcontentloaded" });
    console.log("workbench: page loaded");

    const addProject = page.getByTestId("sidebar-add-project");
    const workspaceRow = page.getByTestId("sidebar-workspace-row").first();
    await workspaceRow.waitFor({ state: "visible", timeout: timeoutMs });
    console.log("workbench: workspace ready");
    await page.locator("[data-workbench-window-chrome]:not(html)").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    NodeAssert.equal(await page.locator(".sidebar-stage-backdrop").count(), 0);
    NodeAssert.equal(await page.getByText("Awen", { exact: true }).count(), 0);

    if (process.env.WORKBENCH_E2E_FILES_ONLY === "1") {
      await verifyWorkbenchFiles(page, repositoryRoot);
      return;
    }

    if (process.env.WORKBENCH_E2E_APPEARANCE_ONLY === "1") {
      await verifyWorkbenchAppearance(page);
      return;
    }

    if (process.argv.includes("--branch-only")) {
      await verifyBranchSelection(page, temporaryRoot);
      console.log(
        "workbench branch E2E passed: default checkout, Workspace identity, existing worktree registration and migration",
      );
      return;
    }

    const sidebarToggle = page.getByRole("button", { name: "Toggle main sidebar", exact: true });
    const sidebarToggleBefore = await sidebarToggle.boundingBox();
    await sidebarToggle.click();
    await page.waitForTimeout(400);
    const sidebarToggleAfter = await sidebarToggle.boundingBox();
    NodeAssert.deepEqual(sidebarToggleAfter, sidebarToggleBefore);
    await sidebarToggle.click();
    await page.waitForTimeout(400);

    await chooseContextMenuItem(page, workspaceRow, "New Agent Session");
    const draftPane = page.locator('[data-pane-target-kind="newAgentSession"]');
    await draftPane.waitFor({ state: "visible", timeout: timeoutMs });
    NodeAssert.match(page.url(), /\/draft\/[^/]+$/);

    const draftUrl = page.url();
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator('[data-pane-target-kind="newAgentSession"]').waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    NodeAssert.equal(page.url(), draftUrl);
    await page
      .locator('[data-testid="sidebar-workspace-row"][data-environment-connected="true"]')
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs });

    await chooseContextMenuItem(
      page,
      page.getByTestId("sidebar-workspace-row").first(),
      "New Terminal Session",
    );
    const terminalPane = page.locator('[data-pane-target-kind="workspaceTerminal"]');
    const terminalCreated = await terminalPane
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!terminalCreated) {
      throw new Error(
        `Terminal Session did not open. Visible text:\n${(await page.locator("body").innerText()).slice(0, 8_000)}`,
      );
    }
    const paneTargetKinds = await page
      .locator("[data-pane-id]")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-pane-target-kind")),
      );
    NodeAssert.equal(new Set(paneTargetKinds).size, paneTargetKinds.length);
    NodeAssert.ok(paneTargetKinds.includes("newAgentSession"));
    NodeAssert.ok(paneTargetKinds.includes("workspaceTerminal"));
    NodeAssert.match(page.url(), /\/terminal-sessions\//);
    const terminalTarget = await readOpenTerminalTarget(page);

    const panes = page.locator("[data-pane-id]");
    const before = await panes.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { kind: element.getAttribute("data-pane-target-kind"), width: rect.width };
      }),
    );
    const separator = page.locator("[data-sash-id]").first();
    const separatorBox = await separator.boundingBox();
    NodeAssert.ok(separatorBox !== null, "Expected a visible BSP separator.");
    const separatorHit = await separator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return hit?.closest("[data-sash-id]")?.getAttribute("data-sash-id") ?? null;
    });
    NodeAssert.equal(
      separatorHit,
      await separator.getAttribute("data-sash-id"),
      "The BSP separator must render on top of the pane boundary.",
    );
    await page.mouse.move(separatorBox.x + separatorBox.width / 2, separatorBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(separatorBox.x + separatorBox.width / 2 + 120, separatorBox.y + 80, {
      steps: 8,
    });
    await page.mouse.up();
    const after = await panes.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { kind: element.getAttribute("data-pane-target-kind"), width: rect.width };
      }),
    );
    NodeAssert.notDeepEqual(
      after.map((pane) => pane.width),
      before.map((pane) => pane.width),
      "Dragging the BSP separator must resize the two panes.",
    );

    const beforeLayoutSwitch = await workbenchStateSignature(page);
    const terminalCanvas = await terminalPane.locator("canvas").first().elementHandle();
    await page.getByRole("button", { name: "Scrolling layout", exact: true }).click();
    await page.locator('[data-layout-mode="scrolling"]').waitFor({ state: "visible" });
    NodeAssert.equal(await workbenchStateSignature(page), beforeLayoutSwitch);
    NodeAssert.equal(
      await page.locator(".workbench-column-controls").count(),
      0,
      "Scrolling mode must not render extra Column or Stack control bars.",
    );
    const canvas = page.locator(".workbench-canvas");
    const initialGap = await canvas.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--pane-gap").trim(),
    );
    const initialRadius = await canvas.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--pane-radius").trim(),
    );
    const initialShadow = await canvas.evaluate((el) =>
      getComputedStyle(el).getPropertyValue("--pane-shadow").trim(),
    );
    NodeAssert.equal(initialGap, "0px");
    NodeAssert.equal(initialRadius, "0px");
    NodeAssert.equal(initialShadow, "none");
    NodeAssert.equal(
      await terminalCanvas.evaluate((element) => element.isConnected),
      true,
      "Switching must retain the terminal emulator mount.",
    );
    const columnSash = page.getByRole("separator", { name: "Column width" }).first();
    await columnSash.focus();
    await columnSash.press("ArrowRight");
    const scrollingLayout = await page.evaluate(async () => {
      const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
      return useWorkbenchStore
        .getState()
        .tabs.find((tab) => tab.id === useWorkbenchStore.getState().activeTabId).columns;
    });
    NodeAssert.equal(scrollingLayout[0].width, 576);
    await page.getByRole("button", { name: "BSP layout", exact: true }).click();
    await page.getByRole("button", { name: "Scrolling layout", exact: true }).click();
    NodeAssert.equal(await terminalCanvas.evaluate((element) => element.isConnected), true);
    NodeAssert.equal(await workbenchStateSignature(page), beforeLayoutSwitch);
    await page.getByRole("button", { name: "BSP layout", exact: true }).click();

    await draftPane.getByRole("button", { name: "Close pane" }).click();
    await NodeAssert.rejects(
      draftPane.waitFor({ state: "visible", timeout: 1_000 }),
      /Timeout|detached|hidden/i,
    );
    NodeAssert.equal(await page.locator('[data-pane-target-kind="workspaceTerminal"]').count(), 1);
    NodeAssert.equal(await page.locator('[data-pane-target-kind="newAgentSession"]').count(), 0);

    await chooseContextMenuItem(
      page,
      page.getByTestId("sidebar-workspace-row").first(),
      "New Agent Session",
    );
    await page.locator('[data-pane-target-kind="newAgentSession"]').waitFor({
      state: "visible",
      timeout: timeoutMs,
    });

    const tabsBeforeUiCreate = await page.locator('[role="tab"]').count();
    await page.getByRole("button", { name: "New tab" }).click();
    await page.waitForTimeout(250);
    NodeAssert.equal(await page.locator('[role="tab"]').count(), tabsBeforeUiCreate + 1);
    await page
      .locator('[role="tab"][aria-selected="true"]')
      .getByRole("button", { name: /^Close / })
      .click();
    await page.waitForTimeout(250);
    NodeAssert.equal(await page.locator('[role="tab"]').count(), tabsBeforeUiCreate);
    await page.locator('[data-pane-target-kind="newAgentSession"]').waitFor({
      state: "visible",
      timeout: timeoutMs,
    });

    const reopened = await reopenTerminalFromNewTab(page, terminalTarget);
    await page.locator('[data-pane-target-kind="workspaceTerminal"]').waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    NodeAssert.equal(
      reopened.terminalViewCount,
      1,
      "ADR-0010: re-opening the same Terminal Session must not create a second Session View.",
    );
    NodeAssert.equal(
      reopened.activeTabId,
      reopened.terminalTabId,
      "Re-opening an already open Session focuses the Tab that shows it.",
    );
    NodeAssert.equal(
      reopened.tabsAfter,
      reopened.tabsBefore + 1,
      "Only the empty Tab created by this check should be new.",
    );

    const mergeTabIds = await page.evaluate(async () => {
      const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
      const tabs = useWorkbenchStore.getState().tabs;
      return {
        draftTabId: tabs.find((tab) =>
          [...tab.panes.values()].some((view) => view.target.kind === "newAgentSession"),
        )?.id,
        terminalTabId: tabs.find((tab) =>
          [...tab.panes.values()].some((view) => view.target.kind === "workspaceTerminal"),
        )?.id,
      };
    });
    NodeAssert.ok(
      mergeTabIds.draftTabId !== undefined && mergeTabIds.terminalTabId !== undefined,
      "Expected separate draft and Terminal tabs.",
    );
    await page.evaluate(async (tabId) => {
      const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
      useWorkbenchStore.getState().activateTab(tabId);
    }, mergeTabIds.draftTabId);
    const firstTabTerminalPane = page
      .locator('[data-pane-target-kind="workspaceTerminal"]')
      .first();
    const firstTabDraftPane = page.locator('[data-pane-target-kind="newAgentSession"]').first();
    await firstTabTerminalPane.waitFor({ state: "visible", timeout: timeoutMs });
    await firstTabDraftPane.waitFor({ state: "visible", timeout: timeoutMs });
    const stateBeforePreview = await workbenchStateSignature(page);

    const terminalHandle = firstTabTerminalPane.locator("[data-workbench-pane-drag-handle]");
    const terminalHandleBox = await terminalHandle.boundingBox();
    const draftBox = await firstTabDraftPane.boundingBox();
    NodeAssert.ok(terminalHandleBox !== null && draftBox !== null, "Expected draggable panes.");
    await page.mouse.move(
      terminalHandleBox.x + terminalHandleBox.width / 2,
      terminalHandleBox.y + terminalHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      draftBox.x + Math.min(12, draftBox.width * 0.1),
      draftBox.y + draftBox.height / 2,
      { steps: 12 },
    );
    await page.locator("[data-workbench-drop-preview]").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await page.locator("[data-workbench-drag-ghost]").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    NodeAssert.equal(await workbenchStateSignature(page), stateBeforePreview);
    NodeAssert.equal(
      await page.evaluate(() => getComputedStyle(document.documentElement).userSelect),
      "none",
      "Dragging must disable text selection across the document.",
    );
    const previewDestination = page.locator(
      '[data-workbench-preview-pane][data-destination="true"]',
    );
    NodeAssert.equal(await previewDestination.count(), 1);
    const previewDestinationBox = await previewDestination.boundingBox();
    NodeAssert.ok(previewDestinationBox !== null, "Expected a destination preview.");
    await page.mouse.up();
    await page.locator("[data-workbench-drop-preview]").waitFor({
      state: "detached",
      timeout: timeoutMs,
    });
    NodeAssert.deepEqual(await paneKinds(page), [
      "agentSession",
      "workspaceTerminal",
      "newAgentSession",
    ]);
    await page.locator(".workbench-pane-frame").evaluateAll(async (elements) => {
      await Promise.all(
        elements.flatMap((element) =>
          element.getAnimations().map((animation) => animation.finished.catch(() => {})),
        ),
      );
    });
    const movedTerminalBox = await page
      .locator('[data-pane-target-kind="workspaceTerminal"]')
      .first()
      .boundingBox();
    NodeAssert.ok(movedTerminalBox !== null, "Expected the moved Terminal Pane.");
    NodeAssert.ok(Math.abs(movedTerminalBox.x - previewDestinationBox.x) < 2);
    NodeAssert.ok(Math.abs(movedTerminalBox.y - previewDestinationBox.y) < 2);
    NodeAssert.ok(Math.abs(movedTerminalBox.width - previewDestinationBox.width) < 2);
    NodeAssert.ok(Math.abs(movedTerminalBox.height - previewDestinationBox.height) < 2);

    const draftHandle = firstTabDraftPane.locator("[data-workbench-pane-drag-handle]");
    const draftHandleBox = await draftHandle.boundingBox();
    const terminalBox = await firstTabTerminalPane.boundingBox();
    NodeAssert.ok(draftHandleBox !== null && terminalBox !== null, "Expected draggable panes.");
    await page.mouse.move(
      draftHandleBox.x + draftHandleBox.width / 2,
      draftHandleBox.y + draftHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      terminalBox.x + terminalBox.width / 2,
      terminalBox.y + terminalBox.height / 2,
      { steps: 12 },
    );
    await page.locator("[data-workbench-drop-preview]").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await page.locator("[data-workbench-drag-ghost]").waitFor({
      state: "detached",
      timeout: timeoutMs,
    });
    NodeAssert.deepEqual(await paneKinds(page), [
      "agentSession",
      "workspaceTerminal",
      "newAgentSession",
    ]);

    await page.mouse.move(
      draftHandleBox.x + draftHandleBox.width / 2,
      draftHandleBox.y + draftHandleBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      terminalBox.x + terminalBox.width / 2,
      terminalBox.y + terminalBox.height / 2,
      { steps: 12 },
    );
    await page.mouse.up();
    await page.locator("[data-workbench-drop-preview]").waitFor({
      state: "detached",
      timeout: timeoutMs,
    });
    NodeAssert.deepEqual(await paneKinds(page), ["agentSession", "newAgentSession"]);

    // ADR-0010 replaced the Duplicate-pane action: there is no copy entry, and
    // re-opening a Session focuses its one View instead of adding a Tab.
    const tabsBeforeReopen = await page.locator('[role="tab"]').count();
    const agentPaneCount = await page.locator('[data-pane-target-kind="agentSession"]').count();
    NodeAssert.equal(
      await page
        .locator('[data-pane-target-kind="agentSession"]')
        .first()
        .getByRole("button", { name: "Duplicate pane", exact: true })
        .count(),
      0,
      "Pane headers must not offer a Duplicate pane action.",
    );
    const reopenAgent = await page.evaluate(async () => {
      const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
      const state = useWorkbenchStore.getState();
      const agentView = state.tabs
        .flatMap((tab) => [...tab.panes.values()])
        .find((view) => view.target.kind === "agentSession");
      state.openTarget(agentView.target);
      const after = useWorkbenchStore.getState();
      return {
        tabs: after.tabs.length,
        agentViews: after.tabs.reduce(
          (count, tab) =>
            count +
            [...tab.panes.values()].filter((view) => view.target.kind === "agentSession").length,
          0,
        ),
      };
    });
    await page.waitForTimeout(250);
    NodeAssert.equal(await page.locator('[role="tab"]').count(), tabsBeforeReopen);
    NodeAssert.equal(reopenAgent.tabs, tabsBeforeReopen);
    NodeAssert.equal(reopenAgent.agentViews, agentPaneCount);

    // An explicit split is a layout intent: it moves the Session's one View and
    // closes the Pane it came from.
    const moved = await page.evaluate(async () => {
      const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
      const state = useWorkbenchStore.getState();
      const entries = state.tabs.flatMap((tab) =>
        [...tab.panes.entries()].map(([paneId, view]) => ({ paneId, view })),
      );
      const agentView = entries.find((entry) => entry.view.target.kind === "agentSession");
      const anchor = entries.find((entry) => entry.view.target.kind === "newAgentSession");
      const tabsBefore = state.tabs.length;
      const panesBefore = state.tabs.reduce((count, tab) => count + tab.panes.size, 0);
      state.setFocused(anchor.paneId);
      state.splitFocused(agentView.view.target, "down");
      const after = useWorkbenchStore.getState();
      return {
        tabsBefore,
        tabsAfter: after.tabs.length,
        panesBefore,
        panesAfter: after.tabs.reduce((count, tab) => count + tab.panes.size, 0),
        agentViews: after.tabs.reduce(
          (count, tab) =>
            count +
            [...tab.panes.values()].filter((view) => view.target.kind === "agentSession").length,
          0,
        ),
        previousPaneHoldsAgent: after.tabs.some(
          (tab) => tab.panes.get(agentView.paneId)?.target.kind === "agentSession",
        ),
      };
    });
    NodeAssert.equal(
      moved.agentViews,
      1,
      "ADR-0010: an explicit split must move the Session's one View.",
    );
    NodeAssert.equal(moved.tabsAfter, moved.tabsBefore);
    NodeAssert.equal(moved.panesAfter, moved.panesBefore);
    NodeAssert.equal(
      moved.previousPaneHoldsAgent,
      false,
      "Moving a Session View closes the Pane it came from.",
    );
    await page.evaluate(async (tabId) => {
      const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
      useWorkbenchStore.getState().activateTab(tabId);
    }, firstTabId);

    const draftSourceTabId = await page.evaluate(async () => {
      const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
      const tab = useWorkbenchStore
        .getState()
        .tabs.find((candidate) =>
          [...candidate.panes.values()].some((view) => view.target.kind === "newAgentSession"),
        );
      if (tab) useWorkbenchStore.getState().activateTab(tab.id);
      return tab?.id ?? null;
    });
    NodeAssert.ok(draftSourceTabId !== null, "Expected a Tab containing the draft View.");
    const draftPaneInSourceTab = page.locator('[data-pane-target-kind="newAgentSession"]').first();
    const draftHandleInSourceTab = draftPaneInSourceTab.locator(
      "[data-workbench-pane-drag-handle]",
    );
    await draftHandleInSourceTab.waitFor({ state: "visible", timeout: timeoutMs });
    const draftHandleInSourceTabBox = await draftHandleInSourceTab.boundingBox();
    const newTabButton = page.locator("[data-workbench-new-tab-drop]");
    const newTabButtonBox = await newTabButton.boundingBox();
    NodeAssert.ok(
      draftHandleInSourceTabBox !== null && newTabButtonBox !== null,
      "Expected a draggable Pane and the New tab button.",
    );
    await page.mouse.move(
      draftHandleInSourceTabBox.x + draftHandleInSourceTabBox.width / 2,
      draftHandleInSourceTabBox.y + draftHandleInSourceTabBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      newTabButtonBox.x + newTabButtonBox.width / 2,
      newTabButtonBox.y + newTabButtonBox.height / 2,
      { steps: 12 },
    );
    await page.locator("[data-workbench-drop-preview]").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await page.locator("[data-workbench-tab-drop-marker]").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await page.mouse.up();
    await page.waitForTimeout(250);
    const dragCreatedTabId = await activeWorkbenchTabId(page);
    NodeAssert.deepEqual(await paneKinds(page), ["newAgentSession"]);
    NodeAssert.equal(await page.locator('[role="tab"]').count(), tabsBeforeDuplicate + 1);

    await page.getByTestId("sidebar-workspace-disclosure").first().click();
    const terminalSessionRow = page
      .locator('[data-testid="sidebar-session-row"][data-session-kind="terminal"]')
      .first();
    await terminalSessionRow.waitFor({ state: "visible", timeout: timeoutMs });
    const terminalSessionRowBox = await terminalSessionRow.boundingBox();
    const sidebarTargetDraft = page.locator('[data-pane-target-kind="newAgentSession"]').first();
    const sidebarTargetDraftBox = await sidebarTargetDraft.boundingBox();
    NodeAssert.ok(
      terminalSessionRowBox !== null && sidebarTargetDraftBox !== null,
      "Expected a Sidebar Session and a target Pane.",
    );
    await page.mouse.move(
      terminalSessionRowBox.x + terminalSessionRowBox.width / 2,
      terminalSessionRowBox.y + terminalSessionRowBox.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      sidebarTargetDraftBox.x + sidebarTargetDraftBox.width * 0.9,
      sidebarTargetDraftBox.y + sidebarTargetDraftBox.height / 2,
      { steps: 12 },
    );
    await page.locator("[data-workbench-drop-preview]").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await page.mouse.up();
    await page.waitForTimeout(250);
    NodeAssert.deepEqual(await paneKinds(page), ["newAgentSession", "workspaceTerminal"]);
    await chooseContextMenuItem(page, terminalSessionRow, "Close session");
    await page.locator('[data-pane-target-kind="workspaceTerminal"]').waitFor({
      state: "detached",
      timeout: timeoutMs,
    });
    NodeAssert.deepEqual(
      (await terminalViewCountsByTab(page)).map((tab) => tab.terminalViews),
      [0, 0, 0],
      "closeSession must remove the Terminal View from every internal Tab.",
    );
    await page.evaluate(async (tabId) => {
      const { useWorkbenchStore } = await import("/src/workbench/workbenchStore.ts");
      useWorkbenchStore.getState().activateTab(tabId);
    }, dragCreatedTabId);
    await page.locator('[data-pane-target-kind="newAgentSession"]').waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await page.getByTestId("sidebar-history-toggle").first().waitFor({
      state: "visible",
      timeout: timeoutMs,
    });

    await page.getByTestId("sidebar-history-toggle").first().click();
    const closedTerminalRow = page
      .locator(
        '[data-testid="sidebar-session-row"][data-session-kind="terminal"][data-session-closed="true"]',
      )
      .first();
    await closedTerminalRow.waitFor({ state: "visible", timeout: timeoutMs });
    await chooseContextMenuItem(page, closedTerminalRow, "Delete session");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await closedTerminalRow.waitFor({ state: "detached", timeout: timeoutMs });

    page.once("dialog", (dialog) => void dialog.accept());
    await chooseContextMenuItem(
      page,
      page.getByTestId("sidebar-project-row").first(),
      "Remove project",
    );
    await page.getByTestId("sidebar-project-row").first().waitFor({
      state: "detached",
      timeout: timeoutMs,
    });
    await page.getByText("Welcome to Awen", { exact: true }).waitFor({ timeout: timeoutMs });
    NodeAssert.equal(await page.locator("[data-pane-id]").count(), 1);
    NodeAssert.deepEqual(pageErrors, []);

    const finalActiveTab = page.locator('[role="tab"][aria-selected="true"]');
    await finalActiveTab.dblclick();
    const titleInput = page.getByRole("textbox", { name: "Tab title" });
    await titleInput.fill("Pinned workbench");
    await titleInput.press("Enter");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator("[data-workbench-window-chrome]:not(html)").waitFor({
      state: "visible",
      timeout: timeoutMs,
    });
    await NodeAssert.doesNotReject(
      page.getByRole("tab", { name: "Open Pinned workbench" }).waitFor({
        state: "visible",
        timeout: timeoutMs,
      }),
    );

    await addProject.waitFor({ state: "visible", timeout: timeoutMs });
    console.log(
      "workbench E2E passed: chrome geometry, tabs, draft reload, drag preview/move/replace/cancel/new-tab/sidebar-drop, split/resize, cross-Tab closeSession, Delete, title/persistence, remove project",
    );
  } catch (error) {
    console.error(`Browser page errors: ${pageErrors.map(String).join("\n")}`);
    console.error(`Browser console errors: ${consoleErrors.join("\n")}`);
    if (page !== null) {
      const screenshotPath = NodePath.join(temporaryRoot, "failure.png");
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
      console.error(`Workbench E2E failure screenshot: ${screenshotPath}`);
      console.error(
        (
          await page
            .locator("body")
            .innerText()
            .catch(() => "")
        ).slice(0, 12_000),
      );
    }
    throw error;
  } finally {
    // Teardown must not throw: an error raised here would replace the failure
    // that made the harness fail, which is how a `browser.launch` error used to
    // surface as an unattributable `EBUSY` instead.
    const failures = await runTeardownSteps([
      {
        label: "close the browser",
        run: async () => {
          await browser?.close();
        },
      },
      { label: "terminate the daemon process tree", run: () => stopDaemonProcessTree(child, home) },
      {
        label: keepTemporary ? "retain the temporary home" : "remove the temporary home",
        run: () => finishTemporaryHome(temporaryRoot, keepTemporary),
      },
    ]);
    for (const failure of failures) {
      console.error(
        `workbench: teardown failed (${failure.label}): ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`,
      );
    }
  }
}

await main();
