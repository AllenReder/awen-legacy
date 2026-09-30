# Material Surface Glass Architecture

ADR-0030 supersedes this decision's Tauri compositor, native pixel-radius
control, and window-control implementation choices. Content Backdrop Blur is now
an independently configurable application setting; native Window Glass uses
system material presets. The Windows WebView2 Overlay workaround below requires
fresh Electron validation. The material hierarchy and appearance requirements
remain accepted.

Accepted; supersedes the web visual-layer parts of ADR-0009 while retaining its
native macOS and Windows glass foundation. Awen separates Theme's opaque
semantic colors from a Material system: a native Glass Stage supplies the
window-wide desktop blur, explicit Sidebar, Topbar, Workbench, and Overlay
Material Surfaces own tint, blur, saturation, and edge treatment, and View or
Pane content layers render transparent base backgrounds. Overlay surfaces use
web backdrop filtering because the native stage cannot blur content beneath a
dialog or menu inside the web view. A transparent DWM window prevents WebView2
from sampling in-page content, so Windows substitutes a denser acrylic-style
Overlay tint with grain, an explicit edge, and shadow while keeping the
window-level Acrylic stage; macOS and browser fallbacks remain unchanged. This
replaces the awen-derived practice
of opaque component backgrounds and selector-specific transparency overrides;
custom and imported themes continue to provide colors only, not Material
parameters. The legacy glass settings migrate once into a Material settings
group; unknown values use the new defaults. Platform capability is represented
as native-stage, css-overlay, or opaque. The blur control specifies the WindowServer radius in pixels on macOS;
Windows maps glass to its Acrylic/Mica capabilities. Sidebar, Topbar, and Workbench default
to 50% opacity with a shared 10%–100% range; Overlay remains at 90%. Each is
individually adjustable in Settings. Saved opacity values are preserved; only
missing values and explicit resets adopt the new defaults. Overlay backdrops mount only while open, nested backdrop filters
are avoided, and a reduce-transparency or disabled-glass path remains available.
Optional wallpaper becomes Workbench Artwork: one image layer beneath all
Workbench content and above the Workbench Material Surface, rather than a
background owned by Agent or Welcome Views. It uses one opacity across every
Workbench state, including Settings, and stops at the Sidebar material edge.

## Visual redesign boundary

The material and control appearance redesign preserves Awen's navigation and
layout. Monocode is the reference for native blur, material continuity, edge
treatment, and control finish; adopting those qualities does not replace
Awen's Sidebar, Tab, Pane, or View organization with Monocode's layout.

Sidebar, Topbar, and Workbench share one continuous Glass Stage while retaining
independently adjustable tint opacity. Each region paints its material once;
Topbar opacity must not compound with a Workbench material beneath it. View
headers and content inherit their containing region's material rather than
introducing another region-wide background.
Settings and the ordinary Workbench share the same 36px Topbar geometry. When
the Sidebar is collapsed, both reserve the same window-control area and place
the same short separator between the action button and the content; Settings
uses Back and its breadcrumb where the Workbench uses Settings and its Tabs.
With the Sidebar expanded, neither Topbar reserves the collapsed control area.
Controls retain subtle theme-aware borders: quiet at rest, slightly stronger
on hover, and clearly accented for keyboard focus. Control borders and region
dividers are separate semantic roles; changing the Sidebar divider must not
repaint control borders or every Pane outline.
Sidebar interaction states remain distinct without opaque dark blocks:
hovering a Project, Workspace, or Session gently brightens the row; an
unfocused Session already displayed in the current Tab has a small marker;
the currently focused Session alone receives a soft accent background.
Code blocks and ordinary inputs may use a subtle translucent local backing for
readability. The Agent composer and its attached model, permission, and
workspace controls instead share one continuous local frosted backdrop,
following the earlier awen composer treatment. This backdrop blurs content
behind the composer; native desktop blur alone cannot replace it. Attached
parts must not stack independent blur layers. Floating menus and dialogs use
their own denser frosted Overlay material to separate their content from the
content underneath.
Modal dialogs dim the surrounding application by 20% and retain a light blur.
This surrounding backdrop is separate from the dialog's Overlay material;
context menus do not introduce a full-window dimmer. Overlay opacity remains
independently adjustable from Sidebar, Topbar, and Workbench opacity.

The redesign preserves native application interaction boundaries: text
selection is available in prose, code, terminal output, and editable inputs;
navigation, titles, toolbars, buttons, and Settings explanatory text do not
participate in drag selection. Non-interactive empty areas of the Topbar and
Sidebar drag the desktop window, while controls and navigation items retain
their own click and drag-and-drop behavior.

macOS is the primary visual acceptance platform. The Linux development server
can validate code and browser behavior, but native blur, desktop window
dragging, and final material appearance require verification in the macOS
desktop application. Existing fallback behavior on other platforms remains.

Implementation reference: Monocode `bb3924b61f4d48ba12327ee1eb70a8b83d95e51d`
confirms the existing macOS WindowServer and 1%-alpha AppKit backing approach.
Window dragging uses Tauri's existing deep drag regions, including its native
interactive-element exclusions, rather than a parallel JavaScript drag system.

## Background mask and readable glass

One Background Mask tints the blurred desktop beneath every Material Surface:
white in light mode, black in dark mode. Its strength is independent of region
opacity, ranges from 0% to 100%, and is stored separately for light (10% default)
and dark (35% default). These alpha layers compound; region opacity is not a
measurement of total desktop transmission. The mask never covers content or
adds another blur, and opaque fallback surfaces cover it. Mode selection uses
the same root appearance state as theme colors, including live previews.
Built-in secondary text is tuned against composited glass, rather than only
against opaque theme swatches. Material edges own the Sidebar divider; theme
text-color overrides must not repaint it as a white highlight.

Terminal default canvas and viewport fills always remain transparent, including
after initialization, live output, and history replay request a default
background color. Explicit ANSI cell backgrounds, selection, and cursor
rendering retain their semantics; enforcing canvas transparency must preserve
terminal color-query handling. Terminal Session Views alone opt in
to a 16px top content fade when the normal buffer has history above the
viewport. Alternate screens and a cursor inside the fade band disable it;
scrollbars and Pane chrome are never masked.
