# Awen

Awen ships a Windows and macOS desktop app, a web client, and a Linux x64
daemon. The web client talks to the daemon through typed contracts and the
shared client runtime.

## Scope

The workspace contains the desktop shell, web client, daemon, client runtime,
contracts, shared modules, SSH helpers, provider integrations, and build tools.
`pnpm build` builds the web and daemon; `pnpm build:desktop` builds the native
desktop app. The web terminal uses xterm.js.

The Awen guidance files (`AGENTS.md`, `CONTEXT.md`, and `docs/agents/`) remain
authoritative and were not replaced by upstream guidance.

## Requirements

- Node.js 24.13.1
- pnpm 11.10.0
- A provider CLI is optional for boot, but at least one provider must be
  installed and authenticated before starting an agent session.

The checked-in package manager installs the local `vite-plus` tool, so no
global `vp` installation is required.

The root `package.json` is the product version source. Use
`pnpm version:set <version>` to update the desktop, web, daemon, and contracts
versions, then `pnpm version:check` to verify them. See
[`docs/agents/releases.md`](./docs/agents/releases.md) for the prerelease process.

## Install and run

From the repository root:

```bash
pnpm install
pnpm build
pnpm start
```

Useful development commands:

```bash
pnpm dev          # Web + daemon, with deterministic per-checkout ports
pnpm dev:server   # daemon only
pnpm dev:web      # Web only
```

The development runner keeps runtime state in this checkout's ignored
`.awen/` directory by default. An explicit `--home-dir` may be passed to the
dev runner when a different test directory is required. Port selection is
stable per checkout, and the runner advances to an available pair when needed.

To exercise the real pairing, typed WebSocket handshake, provider capability
catalog, daemon disconnect, and automatic reconnect without touching user data:

```bash
pnpm smoke:connection
```

The smoke command requires `pnpm build`, creates a temporary state directory,
and removes it after the run. Provider/auth status is read from the daemon's
capability catalog; an unavailable or unauthenticated provider is reported as
such rather than treated as success.

To exercise the real `node-pty` terminal path on the current host, including
ANSI/alternate-screen output, Unicode, resize, detach/attach history, shell
exit status, and invalid working-directory errors:

```bash
pnpm smoke:terminal
```

The command reports the host OS and shell used for the validation. See
[`docs/agents/terminal-runtime.md`](./docs/agents/terminal-runtime.md) for the
terminal ownership boundary and related regression commands.

The local desktop and daemon connect directly; no external service configuration
is required for local development.

## Desktop shell

Awen's desktop target is a Electron shell around the same Awen Web client.
The host owns the native window, resource loading, constrained external-link
opening, and desktop connection bootstrap; agent execution, PTY state,
provider credentials, and persistence remain in the existing daemon. The
Monocode React application is not copied into this checkout.

The desktop shell asks the local daemon launcher to attach to or start the
daemon for this checkout. The daemon is detached from the window lifecycle, so
closing the desktop shell leaves work running. The wrapper resolves its daemon,
web, and window ports through the same offset rule as `pnpm dev` (an explicit
`AWEN_PORT_OFFSET`, else `AWEN_DEV_INSTANCE`, else a hash of the checkout path)
and uses this checkout's `.awen` directory by default. One checkout owns one
`.awen` data root and one port set, so run only one dev stack per checkout; use a
git worktree to run another desktop dev session at the same time:

```bash
# Electron window, this checkout's Web dev server, and the local daemon launcher
pnpm dev:desktop
```

Desktop CSP must allow `'self'` in `connect-src`, and `'wasm-unsafe-eval'` stays
in production `script-src` for the retained WebAssembly adapter. Permitting the
daemon's localhost endpoint alone does not permit bundled assets. The browser
smoke drives the shipped xterm renderer under both desktop policies, checks that
it answers terminal color and status queries, and ensures packaged JavaScript
`eval` stays blocked:

```bash
pnpm --filter @awen/scripts exec playwright install chromium
pnpm smoke:desktop-terminal
# Optional WebKit coverage (install its system dependencies on Linux):
pnpm --filter @awen/scripts exec playwright install webkit
pnpm smoke:desktop-terminal --webkit
```

This headless check complements native desktop UI verification; it does not
launch the Electron application or establish macOS UI acceptance.

The Workbench cutover E2E starts an isolated daemon and Web client, pairs a
headless browser, and exercises the real Sidebar, routes, BSP panes, PTY, and
session lifecycle. It never sends a provider turn:

```bash
pnpm test:e2e:workbench

# Focused Files verification: in-place switching, dirty decisions, disk save and restore.
WORKBENCH_E2E_FILES_ONLY=1 pnpm test:e2e:workbench

# Reuse the installed Chrome instead of Playwright's browser download.
PLAYWRIGHT_USE_SYSTEM_CHROME=1 pnpm test:e2e:workbench

# Keep the temporary AWEN_HOME and failure screenshot for inspection.
WORKBENCH_E2E_KEEP_TEMP=1 pnpm test:e2e:workbench
```

The explicit CLI stop is separate from closing the window:

```bash
pnpm --dir apps/server exec node src/bin.ts daemon stop --base-dir "$PWD/.awen" --confirm
```

The desktop reads the live daemon endpoint from
`<AWEN_HOME>/userdata/server-runtime.json` (or `dev/server-runtime.json`).
For a daemon that requires authentication, provide a short-lived bootstrap
credential or an already-issued bearer token to the desktop process:

```bash
AWEN_DESKTOP_BOOTSTRAP_TOKEN=<pairing-token> pnpm dev:desktop
# or
AWEN_DESKTOP_BEARER_TOKEN=<bearer-token> pnpm dev:desktop
```

`AWEN_DESKTOP_HTTP_URL` and `AWEN_DESKTOP_WS_URL` may explicitly override
runtime-marker discovery; the C02 shell accepts loopback endpoints only. The
desktop build embeds `apps/web/dist`, so it does not require a Web development
server at runtime:

```bash
pnpm build:desktop
AWEN_HOME="$PWD/.awen" AWEN_DESKTOP_BEARER_TOKEN=<bearer-token> \
  apps/desktop/dist-package/mac-arm64/Awen.app/Contents/MacOS/Awen
```

The generated release application identifier is `com.allenreder.awen`; the
development shell uses the separate `com.allenreder.awen.dev` identity. Native
desktop integration currently covers local daemon discovery and supervision;
workspaces, sessions, and the Monocode-derived workbench are follow-up tickets.

## Data and external dependencies

The daemon stores its state below `<base-dir>/userdata/` and writes the
runtime marker to `<base-dir>/userdata/server-runtime.json`. The smoke test
uses its own temporary base directory. Provider credentials remain on the
machine where the daemon runs; this checkout does not copy them.

The local provider CLIs and their authentication are external prerequisites.
`tailscale` is only needed for `pnpm dev:share`. Zig and a Ghostty source
checkout are only needed to rebuild the retained libghostty-vt WebAssembly, which
the shipped client no longer loads.

## Source and license provenance

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for upstream source
revisions and license notices, and
[`third-party-licenses.config.json`](./third-party-licenses.config.json) for
the dependency license inventory.
