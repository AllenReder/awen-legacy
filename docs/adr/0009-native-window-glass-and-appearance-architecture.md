# Native Window Glass and Appearance Architecture

Awen adopts native OS-level desktop translucency (macOS WindowServer blur and Windows Acrylic) and completely overhauls its appearance and theme system. We retire all legacy awen palettes and storage keys in favor of an Awen-native curated theme suite, configurable dual-pane translucency (full-height Sidebar and optional Workbench Glass), custom chat background wallpapers, and a clean `awen:*` storage namespace.

## Status

Accepted; ADR-0030 supersedes the Tauri compositor implementation, including the
private macOS pixel-radius API. Native Window Glass now uses system material
presets. Theme, Artwork, and user-controlled transparency requirements remain
applicable, with the Material Surface refinements in ADR-0010.

## Context

Previously, the desktop shell ran with an opaque window background (`#0a0a0a`), relying only on CSS `backdrop-filter` which could not blur or reveal the user's desktop wallpaper. Additionally, the theme engine, built-in palettes (`awen-chat`, etc.), and persistence keys were heavily coupled to pre-v1 awen artifacts. Monocode demonstrated a high-fidelity desktop experience on macOS and Windows by combining native compositor effects with finely tuned CSS translucency.

## Decision

1. **Native Window Glass**:
   - **Tauri Shell**: Configure windows as transparent with `macOSPrivateApi: true`.
   - **macOS Compositor**: Dynamically resolve and invoke `CGSSetWindowBackgroundBlurRadius` via `dlsym`. Place an `NSVisualEffectView` behind the `WKWebView` with 0.01 alpha to preserve native window shadows without jagged corner clipping and prevent visual artifacts during repaints.
   - **Windows Compositor**: Apply Tauri 2's `Effect::Acrylic` on Windows 10/11 with transparent background color; fallback to opaque if unsupported.
   - **Linux**: Fallback to opaque rendering.
   - **Light Mode**: Glass remains enabled in both light and dark modes per user preference.

2. **Dual-Pane Glass Scope**:
   - **Sidebar**: Full-height navigation pillar is translucent by default with user-configurable opacity (15%–100%, default 85%).
   - **Workbench Glass**: Configurable toggle allowing users to choose between an opaque Workbench (for focused code editing) and a translucent Workbench (50%–100% opacity, default 88%).
   - **Floating Chrome**: Dialogs, popovers, and menus leverage `GlassBackdrop` with high-blur diffusion.

3. **Awen Native Theme Suite**:
   - Completely purge legacy `awen-chat` and `awen-*` aliases.
   - Introduce official curated themes: `awen-default` (Monocode-inspired neutral dark aesthetic, optimized for glass), `zinc`, `slate`, `midnight`, `forest`, and `ocean`, each with matched light variants.
   - Retain full compatibility with VS Code and OpenVSX theme imports and custom theme editing.

4. **Storage & Namespace Cutover**:
   - Clean break migration to `awen:*` keys (`awen:theme`, `awen:themes:v1`, `awen:theme-halves:v1`, `awen:ui-state:v1`, `awen:terminal-state:v1`).

5. **Chat Background Wallpaper**:
   - Support user-selected local wallpaper images displayed behind session transcripts, with adjustable opacity (5%–65%) and scope (empty session vs. all turns).

## Consequences

- The desktop window is transparent from initialization, requiring proper launch field handling to avoid flashes before web styles load.
- Theme tokens now cleanly separate opaque canvas colors from glass-mixed background values.
- All pre-v1 `awen` branding and storage keys are eliminated across the desktop shell and web client.
