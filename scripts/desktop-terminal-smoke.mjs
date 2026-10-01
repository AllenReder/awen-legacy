import { makeDesktopContentSecurityPolicy } from "../apps/desktop/src/electron/DesktopContentSecurityPolicy.ts";
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { chromium } from "playwright";
import { build } from "vite-plus";

// Exercise the shipped terminal renderer under the checked-in desktop CSP.
// Use a non-loopback origin so the daemon's localhost allowlist cannot mask
// a missing 'self' source. All requests are fulfilled locally by Playwright.
//
// Two separate questions are asserted:
//   1. The xterm surface answers OSC 11 with the background it was told to
//      paint. That reply is what tells a CLI which theme to use; while it went
//      unanswered, Claude Code fell back to a stale host COLORFGBG, chose the
//      light theme, and painted black text onto a dark pane.
//   2. Replaying history answers nothing. Restored bytes describe the past, so
//      a query inside them must not reach the live shell as stray input.
//   3. The packaged CSP still permits a bundled WebAssembly payload while
//      blocking JavaScript eval.
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
const engine = chromium;
const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "awen-desktop-terminal-"));
// The palette the page paints with, and the replies that must come back.
const TERMINAL_BACKGROUND = "#fcfcfc";
const EXPECTED_BACKGROUND_REPLY = "\u001b]11;rgb:fcfc/fcfc/fcfc\u001b\\";
const EXPECTED_STATUS_REPLY = "\u001b[0n";
let browser;

try {
  await build({
    configFile: false,
    root: NodePath.join(root, "apps/web"),
    logLevel: "error",
    build: {
      outDir: directory,
      emptyOutDir: true,
      rollupOptions: {
        input: NodePath.join(root, "apps/web/src/terminal/xterm/surface.ts"),
        preserveEntrySignatures: "strict",
        output: { entryFileNames: "renderer.js" },
      },
    },
  });
  browser = await engine.launch({ headless: true });
  for (const [label, policy] of [
    ["packaged", makeDesktopContentSecurityPolicy({ scheme: "awen" })],
    ["development", makeDesktopContentSecurityPolicy({ scheme: "awen-dev" })],
  ]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      NodeAssert.equal(url.origin, "http://awen.test", "The smoke must not access remote services");
      if (url.pathname === "/") {
        await route.fulfill({
          contentType: "text/html",
          headers: { "Content-Security-Policy": policy },
          body: '<script type="module" src="/entry.js"></script>',
        });
      } else if (url.pathname === "/entry.js") {
        await route.fulfill({
          contentType: "application/javascript",
          body: `import { XtermTerminalSurface } from './renderer.js';
            try {
              const mount = document.createElement('div');
              mount.style.width = '640px';
              mount.style.height = '320px';
              document.body.appendChild(mount);
              const replies = [];
              const surface = await XtermTerminalSurface.create(mount, {
                theme: { background: '${TERMINAL_BACKGROUND}', foreground: '#27272a', cursor: '#26384e' },
                font: { family: 'monospace', size: 13 },
                onData: (data) => replies.push(data),
                onResize: () => {},
              });
              surface.write('\\u001b]11;?\\u001b\\\\');
              surface.write('\\u001b[5n');
              await new Promise((resolve) => setTimeout(resolve, 100));
              const repliesBeforeReplay = replies.length;
              surface.resetAndWrite('restored \\u001b]11;?\\u001b\\\\ history');
              await new Promise((resolve) => setTimeout(resolve, 100));
              const repliesDuringReplay = replies.slice(repliesBeforeReplay);
              let permitsJavaScriptEval = false;
              try { permitsJavaScriptEval = (0, eval)('1 + 1') === 2; } catch {}
              let compilesWebAssembly = false;
              try {
                await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
                compilesWebAssembly = true;
              } catch {}
              surface.dispose();
              window.result = {
                ok: true,
                replies,
                repliesDuringReplay,
                permitsJavaScriptEval,
                compilesWebAssembly,
              };
            } catch (error) {
              window.result = { ok: false, error: String(error) };
            }`,
        });
      } else {
        const file = NodePath.resolve(directory, `.${url.pathname}`);
        NodeAssert.ok(file.startsWith(`${directory}${NodePath.sep}`));
        await route.fulfill({
          contentType: file.endsWith(".wasm") ? "application/wasm" : "application/javascript",
          body: await NodeFSP.readFile(file),
        });
      }
    });
    await page.goto("http://awen.test/");
    await page.waitForFunction(() => window.result !== undefined, undefined, { timeout: 10_000 });
    const result = await page.evaluate(() => window.result);
    NodeAssert.equal(result.ok, true, `${label}: ${result.error}\n${errors.join("\n")}`);
    NodeAssert.ok(
      result.replies.includes(EXPECTED_BACKGROUND_REPLY),
      `${label}: OSC 11 must be answered with the painted background, got ${JSON.stringify(result.replies)}`,
    );
    NodeAssert.ok(
      result.replies.includes(EXPECTED_STATUS_REPLY),
      `${label}: device status report must be answered, got ${JSON.stringify(result.replies)}`,
    );
    NodeAssert.deepEqual(
      result.repliesDuringReplay,
      [],
      `${label}: replaying history must not answer a query against the live shell`,
    );
    if (label === "packaged") {
      NodeAssert.equal(
        result.compilesWebAssembly,
        true,
        "Packaged CSP must still permit wasm-unsafe-eval",
      );
      NodeAssert.equal(
        result.permitsJavaScriptEval,
        false,
        "Packaged JavaScript eval must remain blocked",
      );
    }
    console.log(`${engine.name()} ${label}: terminal replies and desktop CSP verified`);
    await page.close();
  }
} finally {
  await browser?.close();
  await NodeFSP.rm(directory, { recursive: true, force: true });
}
