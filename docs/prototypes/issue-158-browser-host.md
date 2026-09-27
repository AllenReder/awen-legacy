# #158: Tauri browser host feasibility

Status: **blocking evidence, not production delivery**. The manual native proof has been exercised on a maintainer's Mac; the broker-connected debug host below has not yet been verified there. Browser host delivery remains blocked until the promised Agent operations are demonstrated. Do not infer contract coverage from the presence of a child webview.

## Scope and existing seam

The inherited `PreviewManager` owns `(threadId, tabId)` metadata, open/navigate/resize/refresh/close/list/status events. `PreviewAutomationBroker` routes a provider's `preview_*` request to a connected desktop host. `PreviewAutomationHosts.tsx` advertises all operations only on Electron because `tauriBridge.ts` supplies no `desktopBridge.preview`. The Electron implementation obtains DOM state and input through Electron debugger and `<webview>`; those mechanisms are not available through the Tauri bridge. Preserve the manager, broker, provider tool protocol, preview IDs, profile IDs, and response/error contracts. A Tauri adapter must supply the native page and automation implementations; it must not advertise operations until they work.

The manual debug proof uses Tauri's child `WebviewBuilder` and `Webview::eval_with_callback` to act on the same page displayed in the window. It creates two simultaneously visible guests, moves/resizes/zooms and focuses one, probes persistent storage separation, and checks that a closed guest rejects another evaluation. Its button sequence does **not** connect to `PreviewAutomationBroker`; that remains a direct native check.

A second, opt-in debug mode starts the ordinary Awen window plus a native browser-proof window. `TauriProofAutomationHosts` uses the existing preview RPC subscription and response consumer to connect to `PreviewAutomationBroker`, and advertises only `status`, `open`, `navigate`, and `evaluate`. Those requests reach the displayed native guest. Other operations remain explicit capability gaps rather than being advertised without implementations. This mode is a candidate for the required Agent-contract evidence, not a production host.

## Broker round-trip check (macOS, pending)

Keep the strict dev web server running as below. In a second terminal, start the registered dev app in Agent proof mode:

```sh
AWEN_BROWSER_HOST_PROOF=1 AWEN_BROWSER_HOST_PROOF_AGENT=1 pnpm --filter @awen/desktop build:app
```

The ordinary Awen window should show **Agent browser proof (debug)** with **Broker connected**, alongside a separate **Awen Agent browser proof** native window. Enable Agent browser access in the environment's settings. Use only `gpt-5.6-luna` or `MiniMax-M3` for a real Agent test. Ask it to call `preview_open` with the dev server's `http://localhost:<webPort>/browser-host-proof-page.html`, then `preview_status`, `preview_navigate`, and `preview_evaluate` to read and change the page's input and click count. Record each tool input/result and the visible state of the same native guest. Open a second tab with `reuseExistingTab:false` and target both returned tab IDs independently. In the debug panel, cancel a page close, then confirm it; an Agent call targeting the closed tab must return an explicit error. Any unimplemented operation should return the broker's unsupported-capability result, never a false success.

This mode still needs a native macOS run and does not validate snapshot, trusted click/type/press/scroll, wait conditions, appearance, recording, full profile mapping, or Workbench Pane placement. Each of those remains a blocker for host-dependent delivery.

## Operation inventory

Here, “reuse” refers to the protocol and daemon part, “adapter” to native implementation still required, and “gap” to an unproved capability. The broker-connected mode is implemented as a candidate and remains unverified on macOS; rows do not claim that a source-level adapter has passed native acceptance.

| Promised operation or behavior                                                                                                                     | Reuse                                                           | Native adapter or capability gap                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`, `open`, `navigate`, `resize`, `setColorScheme`                                                                                           | `PreviewManager` metadata and `PreviewAutomationBroker` routing | Guest creation, navigation events, real viewport measurement, color-scheme override; manual mode covers direct create/navigate/geometry/evaluation; broker mode routes status/open/navigate but still needs a native run. Resize and color-scheme override remain gaps.       |
| `snapshot`                                                                                                                                         | Request/result schemas and broker                               | DOM tree and target locators for the exact displayed guest; **gap**.                                                                                                                                                                                                          |
| `click`, `type`, `press`, `scroll`                                                                                                                 | Request/error schemas and broker                                | Selector resolution, trusted input/focus/scroll semantics; proof only calls a DOM button and edits a field with script, so trusted input remains a **gap**.                                                                                                                   |
| `evaluate`, `waitFor`                                                                                                                              | Request/result schemas and broker                               | Bounded script execution/result transport and condition polling. `eval_with_callback` is a promising primitive; broker mode routes evaluate to that guest, but the native round trip, awaited values, cancellation, navigation races, and result size limits remain **gaps**. |
| `recordingStart`, `recordingStop`                                                                                                                  | Broker/tool contracts and existing upload path                  | Native frames/capture, encoding and transfer; **gap**.                                                                                                                                                                                                                        |
| User back/forward, refresh, zoom, hard reload, DevTools, screenshots, element picker, audio mute, picture in picture, favicon/title/pointer events | `DesktopPreviewBridge` interface and preview state model        | Tauri/Wry host implementations or verified replacements; **gap** except proof zoom.                                                                                                                                                                                           |
| Page/profile identity, cookie/cache clear and import, Default/Incognito                                                                            | Existing profile IDs and settings                               | Native data-store mapping and profile operations. Proof probes two separate persistent WKWebView stores on macOS 14+; older macOS, Incognito, cookie import, clear, and restart persistence remain **gaps**.                                                                  |
| Two pages, Pane movement/resizing/focus                                                                                                            | Existing preview tab IDs and browser-surface placement rules    | Child webviews plus geometry sync during layout animation. Proof provides manual two-guest controls and reports requested versus measured native geometry and page focus; real Workbench integration and focus arbitration remain **gaps**.                                   |
| Browser close confirmation/cancellation and Agent-visible closed result                                                                            | Existing page identity and broker error envelope                | Close coordinator must recheck active Agent use after the prompt. Proof shows native resource survival/release only; routed Agent result, stale-consent checks, archive cleanup and partial-close behavior remain **gaps**.                                                   |
| Desktop-window exit versus daemon/browser lifetime                                                                                                 | Daemon remains the authority for terminal PTYs                  | Native page JavaScript state is expected to end with the window; reconnect/recovery semantics need a real lifecycle run.                                                                                                                                                      |

## Reproduction

Run on **macOS 14 or later** with the registered Awen Dev app identity (`com.allenreder.awen.dev`). From this worktree, start the dev web server in one terminal, then build and launch the registered app in another:

```sh
pnpm install --frozen-lockfile
AWEN_STRICT_DEV_PORTS=1 pnpm dev:web
```

```sh
AWEN_BROWSER_HOST_PROOF=1 pnpm --filter @awen/desktop build:app
```

The registered runner bundles the proof controller at the app's local origin, selects the checkout's pinned dev web port for its test pages, and supplies that port to the proof. The feature is debug-only and does not register production preview commands. Before binding the window with Computer Use, use `cua.getState()` and `ps` to verify the running executable is the absolute `Awen Dev.app` path printed by `build:app`, its PID and data root match this worktree, the window shows the proof, and the bundle id is `com.allenreder.awen.dev`. In that window, click **Run capability sequence**. Observe both guest pages, the log's same-page message/click count, the navigated URL, rendered viewport and focus after movement/zoom, and `profile A` versus `profile B`. `profile B` must be `null`. Click **Confirm close of page A**, cancel the dialog, then click **Check page A is still open** and verify its URL is returned. Click **Confirm close of page A** again and accept the dialog; the following evaluation must report the closed tab. Reopen it and check persistent profile behavior. Capture the OS version, window/PID, log, and screen recording for the issue. Follow `AGENTS.md` Computer Use identity checks before binding any macOS window.

For the complete Agent-contract gate, expand and validate the native adapter for every promised `preview_*` operation against the same page visible in the Workbench. Do not run a real Agent with a model other than `gpt-5.6-luna` or `MiniMax-M3`.

## Evidence from this checkout

- Platform in this checkout: Linux. A maintainer reported that the manual proof looked correct on macOS, but no OS version, operation log, or Agent result was captured here. The broker-connected mode has not been run on a Mac.
- `pnpm typecheck` and `pnpm test`: passed. `AWEN_BROWSER_HOST_PROOF=1 pnpm --filter @awen/web build`: passed and emitted `dist/browser-host-proof.html`. `cargo fmt --check`: passed.
- `cargo check --features browser-host-proof`: blocked before checking this module because Linux development packages for `dbus-1` and WebKitGTK are absent (`libdbus-sys` cannot find `dbus-1.pc`; `webkit2gtk-4.1.pc` is also absent).

## Host choice and delivery gate

The candidate is a Tauri child-webview host keyed by the existing preview tab identity, with a native adapter behind the current desktop preview bridge and the existing daemon/provider protocol unchanged. A native evaluation callback can return results from the displayed guest, and separate WKWebView data stores are documented on macOS 14+ ([Tauri WebviewBuilder](https://docs.rs/tauri/2.11.5/tauri/webview/struct.WebviewBuilder.html)). This is a **provisional design**, not a supported-platform decision. Supported native platforms remain unestablished. If trusted input, snapshots, recording, profile isolation, or Agent-visible close errors cannot be demonstrated on a supported target, keep subsequent browser-host delivery blocked and raise an explicit product decision; do not substitute an external browser or silently reduce the advertised operation set.
