---
status: accepted
---

# Continuous Workbench navigation and shared overlays

The approved refactor makes Layout pan and Sliding Tab switch successive segments
of one horizontal route. Both macOS two-finger input and right-button dragging
use `continuousNavigation.ts`; the renderer adapter owns capture, target ownership,
measurement and cancellation. This replaces ADR-0019/0024's single-crossing and
layout-boundary ownership rules. Inner content keeps its own gesture ownership.

A direct gesture consumes the current layout's remaining scroll room, one Viewport
width of Tab crossing, then the incoming layout's room. Reaching an aligned Tab
activates it immediately, and remaining displacement continues in the same event.
Right-button input remains linear 1:1. Trackpad crossings use a monotone curve
with a slight slowdown at alignment, preserving the full route length. Incoming
Scrolling layouts enter at the edge facing the source. Reversing a partial crossing
restores the incoming Tab's saved offset; completed crossings are checkpoints.

A partial crossing settles on release at half travel or a directional flick of
0.35 CSS px/ms over the last 90ms. Momentum can only pan the current layout and
cannot cross another Tab. Momentum following a partial crossing is absorbed.
Window blur, Escape/key input, pointer interruption, resize and Tab-set changes
cancel direct manipulation at its latest checkpoint. New gestures can take over a
settling transition at its visible position. Click, keyboard and Shift+wheel retain
existing interruptible live-card transitions.

The Electron macOS adapter observes AppKit `NSEvent` precise scroll events through
a small Node-API addon, scoped to one NSView/window. It sends displacement, phases,
sequence and gesture identifiers together. Native packets are the sole navigation
displacement source; DOM wheel events are suppressed for that owned gesture.
This supersedes ADR-0024's DOM-delta-only choice, which depended on Tauri input
behavior. Unsupported hosts retain native content scrolling and right dragging;
no heuristic wheel classifier is added. Native momentum completion clears ownership.

The Tab indicator consumes the same live-card frame and Viewport readings. It has
no independent easing clock. Its width and position continue to represent the
visible Scrolling canvas fraction (ADR-0025), including both endpoints during a
crossing. Cyclic crossings project the underbar across the strip's wrap boundary.
Geometry is cached for direct input and refreshed on geometry/reorder changes.

Imperative context menus now render through one React/Base UI host. Menu,
popover, dialog, alert dialog, select, combobox, autocomplete, tooltip and anchored
notification surfaces share material framing and content motion. They retain
Base UI focus, keyboard, collision and submenu behavior. Compact surfaces use
one border/shadow family; modal dialogs use a larger radius/elevation. A stable
GlassBackdrop is a sibling of animated content; entry/exit changes both siblings'
scale and opacity for 170ms using the configured duration multiplier. Their
sampling ancestors remain stationary; frame border and shadow fade separately.
Imperative menus mount closed before opening so Base UI supplies starting styles.
Only adjacent menubar switching skips motion; Escape dismissal retains the same
exit transition. Reduced motion disables all these transitions. Stacked toast
travel and swipe retain their existing spatial interaction, using the shared
material. Modal backdrops/frames, menus, tooltips, notifications and drag previews
occupy layers 50/60, 130, 140, 150 and 160 respectively.

Transparent Electron compositor source pixels can leave sharp source residue
beneath a CSS-filtered overlay. In the native material stage, each GlassBackdrop
anchors an opaque theme base below app content, confined to its exact sample
bounds. It is removed on unmount and disabled with zero blur or reduced
transparency. Its scale and opacity follow the material during transitions to
prevent an opaque flash. Dark overlay density maps to a subtle glass film
(approximately 3.4% tint at the default 90, solid at 100); light overlays retain
their existing tint mapping. This retains real in-window content blur while deliberately
sacrificing desktop transmission only beneath the popup. Sidebar, Topbar and
Workbench material settings are unchanged. Regression probes must therefore use
transparent source pixels and actual app surfaces, not only opaque test stripes.
