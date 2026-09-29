# Migrate Desktop Shell from Tauri to Electron

Awen migrates its desktop client shell from Rust + Tauri 2 to an Electron 44 architecture. This establishes a unified Chromium runtime across macOS, Windows, and Linux, activates full in-app browser automation via the Chrome DevTools Protocol (CDP), preserves native translucency (macOS Vibrancy and Windows Acrylic/Mica) without fragile private CGS APIs, and unifies the codebase on a 100% TypeScript stack.

## Status

Accepted.

## Context

In early v1 development, Awen adopted Tauri 2 for its desktop shell (`apps/desktop/src-tauri`), inspired by Monocode's lightweight bundle size and initial visual experiments with macOS private WindowServer blur APIs (`CGSSetWindowBackgroundBlurRadius`).

As Awen grew into a comprehensive coding agent workbench, several structural blockers emerged:
1. **Browser Host & Agent Automation (Issue #158)**: Tauri runs distinct Webview engines per platform (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux). Without unified Chrome DevTools Protocol (CDP) support, essential agent capabilities—such as live DOM snapshots with element bounding boxes, trusted hardware-level click/type input dispatching, screencasting, and isolated browser profiles—could not be uniformly supported across platforms.
2. **Platform Usability Gaps**: On Windows, Tauri's custom HTML titlebar buttons prevented Windows 11 native Snap Layouts from triggering when hovering over the maximize button. On Linux, WebKitGTK required extensive host development packages and exhibited inconsistent rendering and crashes across distributions.
3. **Architecture Divergence**: The Rust desktop crate formed an isolated subsystem requiring FFI bindings, separate compilation toolchains, and duplicative IPC layers, whereas the rest of Awen is written in TypeScript and Effect.

## Decision

1. **Adopt Electron 44 Architecture**:
   - Replace `apps/desktop/src-tauri` with an Electron main process (`apps/desktop/src/main.ts`), preload bridge, and Vite packaging pipeline (`vp pack`).
   - Manage the local Node daemon (`apps/server`) lifecycle through `DesktopBackendManager` and `DesktopBackendPool`.

2. **Native Translucency and Window Appearance**:
   - **macOS**: Apply system-standard `vibrancy: "under-window"`, `visualEffectState: "active"`, and transparent background. Retain `titleBarStyle: "hiddenInset"` with traffic lights aligned to the Sidebar header.
   - **Windows**: Apply Electron 28+ native `backgroundMaterial: "acrylic"`, transparent background, and `titleBarOverlay` (Window Controls Overlay) at 36px height, restoring native Windows 11 Snap Layouts.
   - **Linux**: Fallback to modern borderless dark chrome, eliminating WebKitGTK system dependencies.

3. **Activate Full In-App Browser Automation**:
   - Implement `DesktopPreviewBridge` via `<webview>` / `WebContentsView` with CDP session management (`preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_evaluate`, `preview_waitFor`, and screencast frames).
   - Support persistent and ephemeral profile isolation and cookie management.

4. **Restore Native System Capabilities**:
   - Provide native context menus (`showContextMenu` via `Menu.popup`), native file/folder pickers (`pickFolder`, `pickFile`), application menu bar, and OS credential storage (`@napi-rs/keyring`).

## Consequences

- The desktop installer artifact changes to an Electron distribution (~90–120MB), aligned with industry-standard developer tools (VS Code, Cursor).
- Issue #158 is unblocked, allowing agents to reliably automate web preview sessions across all supported platforms.
- The monorepo builds and typechecks under a single TypeScript toolchain, removing Rust toolchain and cache overhead from CI.
