# Frameless Window Controls and Topbar Integration

Awen adopts a frameless window configuration on Windows and Linux (`decorations: false`) paired with React-rendered native-style caption buttons integrated into the Topbar Surface. This eliminates the duplicate native titlebar while preserving macOS native traffic light overlay behavior, aligning Windows and Linux topbar controls with the dual-chrome architecture established in ADR 0005.

## Status

Accepted; ADR-0030 supersedes the Tauri window-control implementation. Electron
uses native window buttons rather than the React caption buttons. The shared
36px Topbar, pre-shell controls, and platform interaction requirements remain
applicable; macOS traffic lights are centered in that Topbar.

## Context

On macOS, Awen configures `titleBarStyle: "Overlay"` with `hiddenTitle: true`, allowing the native traffic lights to float cleanly over the full-height Sidebar and Workbench header without an extra title strip. On Windows, however, `titleBarStyle` has no effect in Tauri 2; leaving `decorations: true` resulted in an independent, full-height OS native titlebar sitting above the Awen topbar.

Furthermore, WebView2's native Window Controls Overlay (WCO) API is unsupported in Tauri/Wry upstream (`tauri-apps/wry#1650`), making client-rendered window controls necessary. Finally, `SIDEBAR_TRIGGER_LEFT_WIN` was previously set to `0`, gluing the sidebar toggle button directly against the left window border on Windows.

## Decision

1. **Platform-Specific Window Decoration**:
   - In Rust startup (`setup`), disable window decorations dynamically on Windows and Linux (`window.set_decorations(false)`). Linux uses the same path for native Wayland and XWayland, avoiding GTK client-side decorations on one backend and KWin server-side decorations on the other.
   - Retain `titleBarStyle: "Overlay"` and `decorations: true` for macOS in `tauri.conf.json`.

2. **Topbar Surface Window Controls**:
   - Introduce a dedicated `<WindowControls />` component embedded as the trailing flex child of `MaterialSurface kind="topbar"` (in `WorkbenchWindowChrome` and `settings.tsx`).
   - Wrap pairing, authentication, recovery, error, and not-found surfaces in a shared `DesktopAuthWindowChrome` so the frameless window always has a 36px drag region and window controls before the Workbench mounts.
   - The controls render on Windows and Linux desktop hosts (omitted on macOS, which retains native traffic lights, and in browser environments).
   - Sized to match the 36px topbar height with ~46px button widths, adhering to Windows Fitts's Law (closing from the extreme corner) and theme token hover styles (red close button).
   - Ensure the controls container and buttons are strictly marked with `-webkit-app-region: no-drag` so mouse interactions do not conflict with Tauri drag regions.

3. **Window State Synchronization & Permissions**:
   - Add explicit Tauri window permissions (`core:window:allow-minimize`, `core:window:allow-toggle-maximize`, `core:window:allow-close`, `core:window:allow-is-maximized`, `core:window:allow-is-fullscreen`) to `capabilities/default.json`.
   - Listen to Tauri window resize / state events to synchronously toggle between Maximize and Restore icons and accessible labels.

4. **Sidebar Left Inset Harmonization**:
   - Update `SIDEBAR_TRIGGER_LEFT_WIN` from `0` to `BASE_SPACING` (12px), cleanly spacing the sidebar toggle button from the window's left edge and updating collapsed tabs insets and minimum sidebar widths accordingly.

## Considered Options

- **WebView2 Window Controls Overlay (WCO)**: Rejected because upstream Wry cannot yet consume Edge prerelease WCO APIs, leaving `navigator.windowControlsOverlay` non-functional in Tauri.
- **Native Win32 Child Window Overlay Plugin**: Rejected to avoid fragile Win32 GDI subclassing and manifest overhead, keeping styling, opacity, and acrylic glass reactivity pure within the React / Tailwind system.

## Consequences

- Windows users get an integrated topbar where the tab strip and settings breadcrumbs naturally yield to top-right caption controls.
- Linux users get the same single-titlebar model under Wayland and XWayland.
- Auth and pre-shell routes keep window controls and titlebar dragging even when the Workbench or Settings shell is not rendered.
- The sidebar toggle button on Windows gains proper breathing room matching the 12px baseline spacing grid.
