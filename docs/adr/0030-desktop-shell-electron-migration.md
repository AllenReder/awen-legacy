# Migrate Desktop Shell from Tauri to Electron

ADR-0031 amends the navigation input, continuous route, shared indicator and
overlay architecture described here; its rules take precedence where they differ.


Awen adopts Electron 44 for its desktop shell and a shared Chromium browser host across macOS, Windows, and Linux. The shell uses TypeScript and native system window materials; the existing managed daemon remains responsible for running Sessions independently of the desktop application. Browser automation delivery still requires evidence for the same displayed page through the existing Agent contracts.

## Status

Accepted; refined by the migration review discussion on 2026-09-30. This records the intended architecture, not a claim that the current branch has completed native acceptance.

Supersedes the Tauri compositor and window-button implementation choices in ADR-0009 (Native Window Glass), ADR-0010 (Material Surface Glass), and ADR-0011 (Frameless Window Controls). Their appearance, layout, and interaction requirements otherwise remain applicable. Retains ADR-0011 (SSH Remote Environments) and its local-daemon SSH boundary.

## Context

In early v1 development, Awen adopted Tauri 2 for its desktop shell (`apps/desktop/src-tauri`), inspired by Monocode's lightweight bundle size and initial visual experiments with macOS private WindowServer blur APIs (`CGSSetWindowBackgroundBlurRadius`).

As Awen grew into a comprehensive coding agent workbench, several structural blockers emerged:

1. **Browser Host & Agent Automation (Issue #158)**: Tauri runs distinct Webview engines per platform (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). Without unified Chrome DevTools Protocol (CDP) support, essential agent capabilities—such as live DOM snapshots with element bounding boxes, trusted hardware-level click/type input dispatching, screencasting, and isolated browser profiles—could not be uniformly supported across platforms.
2. **Platform Usability Gaps**: On Windows, Tauri's custom HTML titlebar buttons prevented Windows 11 native Snap Layouts from triggering when hovering over the maximize button. On Linux, WebKitGTK required extensive host development packages and exhibited inconsistent rendering and crashes across distributions.
3. **Architecture Divergence**: The Rust desktop crate formed an isolated subsystem requiring FFI bindings, separate compilation toolchains, and duplicative IPC layers, whereas the rest of Awen is written in TypeScript and Effect.

## Decision

1. **Adopt Electron 44 Architecture**:
   - Replace `apps/desktop/src-tauri` with an Electron main process (`apps/desktop/src/main.ts`), preload bridge, and Vite packaging pipeline (`vp pack`).
   - Start or discover the existing managed local daemon through its established launcher and ownership protocol. Closing a window, quitting Electron, or relaunching the same app version must leave the daemon and its active Agent and Terminal Sessions running.
   - Reuse the daemon's SSH trust, setup-plan, provisioning, progress, cancellation, and forwarding APIs through the desktop bridge. The migration does not introduce a second SSH owner in the Electron process.
   - Remove the retired Tauri renderer adapter, dependencies, and browser-host prototype. Trackpad navigation starts from Chromium wheel input. Electron gesture notifications supplement that input, but cannot be required: preventing default scrolling can suppress their generation. Preserve earlier wheel travel when a begin notification arrives late and settle after 120ms of wheel inactivity when no end notification arrives. These notifications are not equivalent to AppKit's direct/momentum phase metadata. Preserve the daemon's SSH failure codes across Electron IPC error serialization so onboarding can still distinguish host-key, authentication, and prerequisite failures.

2. **Native Translucency and Window Appearance**:
   - **macOS**: Apply system-standard `vibrancy: "under-window"`, `visualEffectState: "active"`, and transparent background. Retain native traffic lights with the pre-migration visual placement: vertically centered in the actual 36px Topbar, including Sidebar, Workbench, and Settings states. Position them from the rendered Topbar height and renderer zoom rather than the inherited 52px constant; verify the visual inset in the native app instead of copying Tauri coordinates into Electron.
   - **Windows**: Use native Window Controls Overlay at the shared 36px Topbar height, retaining native Snap Layouts. Apply system Acrylic where supported and an opaque material fallback where it is unavailable.
   - **Linux**: Use Electron's native window buttons with the same Topbar geometry and an opaque, theme-aware window material, eliminating WebKitGTK dependencies.
   - Keep native window mode (`transparent: false`) on all platforms. Transparent content backgrounds expose system materials without the resize/maximize restrictions or missing macOS shadow associated with Electron's transparent-window mode.
   - Auth and pre-shell routes reserve the same native-control space as Settings and Workbench. Electron does not render the obsolete React caption buttons alongside native controls.
   - System window blur uses OS material presets. Remove the pixel-radius control and private CGS blur path; retain Window Glass enablement, per-region opacity, and Background Mask. Theme updates and window recreation preserve the user's material preferences.
   - Content Backdrop Blur has one independently configurable application setting shared by Overlay and composer surfaces: 0–32px, default 16px, with zero disabling the content blur. It remains available when Window Glass is disabled and on Linux's opaque main-window stage. Modal surrounding dimming and its light blur remain distinct; the old native-radius value is not reinterpreted as this new setting. A system reduce-transparency preference takes precedence and uses clear opaque materials.
   - Revalidate the Tauri/WebView2-specific Windows Overlay fallback against Electron before carrying it forward as a platform limitation.
   - Workbench Artwork and its Settings thumbnail use the same controlled image-resource URL for a user-selected local file.

3. **Activate Full In-App Browser Automation**:
   - Implement `DesktopPreviewBridge` via `<webview>` / `WebContentsView` with CDP session management (`preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_evaluate`, `preview_waitFor`, and screencast frames).
   - Support persistent and ephemeral profile isolation and cookie management.

4. **Restore Native System Capabilities**:
   - Provide native file/folder pickers (`pickFolder`, `pickFile`), application menu bar, and OS credential storage (`@napi-rs/keyring`).
   - All application context menus use renderer menus for consistent appearance and interaction across platforms. Preserve draggable entries, their pointer callbacks, and existing Pane drop transactions; never serialize callbacks through Electron IPC. Native text editing menus remain a shell fallback.
   - Complete Linux browser-cookie import, including the missing native helper source, build dependencies, and packaged executable.

5. **Complete Development and Release Integration**:
   - Address every finding in the migration review: SSH bridge coverage, macOS signing/notarization, precise Windows installer collection, smoke-test readiness, packaged daemon/client resource layout, desktop development dependencies, Linux import helper, native controls, Artwork loading, blur settings, and material preference retention.
   - Update version tooling, its tests, and release documentation to the Electron resource and manifest layout. `version:check` must not read the removed Tauri/Cargo files.
   - Package the daemon with its standalone Node runtime and the web client using one resource layout matched by runtime discovery and installed-artifact verification. Development builds and watches the required backend output rather than depending on a previous build.
   - Validate real startup and public bridge/daemon behavior; nonzero process exits or missing readiness fail smoke tests. Linux GUI checks run with a display service. Installer checks exercise installed resources, not only the repository bundle.
   - Keep the existing published platform scope: macOS and Windows desktop installers, plus the Linux daemon archive. Do not add Linux desktop installer artifacts or Linux desktop installer jobs in this migration; Linux development, native window behavior, and browser-cookie import fixes remain in scope.

## Consequences

- Desktop distributions carry Chromium and therefore grow relative to the Tauri shell; measure final artifact sizes rather than treating an estimate as acceptance evidence.
- The host choice changes from Tauri to Electron. Issue #158's original Tauri-only prototype criteria and downstream delivery status must be reconciled explicitly; choosing Electron is not proof that every browser operation works.
- The desktop shell no longer needs a Rust toolchain. Platform native addons and the Linux browser-secret helper still require their own build and packaging support.
- Ordinary shell shutdown leaves the managed daemon running. Installing an update or first launching a new app version replaces the local daemon together with the desktop shell. This operation may interrupt active Agent and Terminal Sessions; the update action is explicitly “Update and restart”. Same-version restarts reuse the daemon. Follow t3code's stop/install/relaunch flow without a separate deferred daemon-upgrade workflow. The remote SSH daemon upgrade boundary in ADR-0011 is unchanged.
