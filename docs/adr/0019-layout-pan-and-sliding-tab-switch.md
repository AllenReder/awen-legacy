# Right-button layout pan and sliding Tab switch

**Status: accepted**

ADR-0024 amends this decision's fixed-duration settle, two-card presentation,
and unmodified macOS trackpad rules. ADR-0025 amends the "never stretches"
rule below: the underbar now interpolates between the two Tabs' resting widths
when those widths differ, because a Scrolling Tab's resting bar is narrower
than its box. The glass-compatible flat translation and right-button Layout pan
constraints still apply.

The Workbench gains a unified horizontal navigation gesture built on the right mouse
button: a right-drag inside the Workbench canvas pans a Scrolling layout, and — once
the layout cannot pan any further (always, in a BSP layout) — continues into a Sliding
Tab switch that moves a rigid two-Tab strip. Shift+wheel and horizontal trackpad/wheel
deltas drive the same Tab switch. Every user-initiated Tab switch (click, keyboard,
gesture) now plays that sliding transition, and the Topbar expresses the active Tab with
a moving theme-color underbar instead of bold text.

## Context

The left mouse button is fully committed inside the Workbench: it focuses content,
selects text, and moves Panes from the Pane header. There was no gesture for navigating
the Workbench as a whole, so wide Scrolling layouts could only be traversed by wheel or
by the edge auto-scroll that runs during a left-drag. Adjacent Tabs had no visual or
gestural relationship: switching Tabs was an instant `display` toggle, so the Workbench
never felt like one surface. ADR-0012 explicitly reserved a seam for a right-button drag
interaction in Issue #108.

A first draft of this interaction (Grill session on Issue #108) considered an elastic
Tab indicator that stretched across two Tabs while dragging. We rejected the stretch:
it made the indicator's width carry gesture state and read as a second animation.

The Tab cards were also first drafted with a non-linear scale dip at the midpoint. That
was removed after visual QA: scaling a card that contains `backdrop-filter` glass makes
the browser build a render surface that drops the glass's mask, and a flat slide reads
more cleanly anyway.

## Decision

- **Right-drag is horizontal-only and lives on the Workbench stage.** A right-pointer
  press anywhere in the Workbench canvas — including Pane content such as terminals and
  editors — arms the gesture. Vertical movement is ignored because the Workbench
  Viewport never scrolls vertically (ADR-0015).
- **Two sequential phases, one gesture.**
  - **Phase 1 — Layout pan** (Scrolling layout only): the pointer delta maps 1:1 onto
    `viewport.scrollLeft`, clamped to `[0, maxScrollLeft]`.
  - **Phase 2 — Sliding Tab switch**: the first pixel of pointer travel that the layout
    cannot consume becomes Tab-switch progress. BSP layouts have no Phase 1 and enter
    Phase 2 directly; a Scrolling layout whose content does not overflow behaves the
    same way.
- **Flat rigid strip.** The outgoing and incoming Tabs are laid out as two full-size
  cards, one viewport width apart, and progress `p` translates both cards as one rigid
  strip by exactly one viewport width in the switch direction. The cards keep their full
  size and opacity, so a switch reads as a horizontal page slide with the two Tabs tiled
  edge to edge — no scale, fade, or depth.
- **The moving cards stay compositing-neutral.** The transition wrapper and cards must
  not introduce `will-change`, `backface-visibility`, `border-radius`, `overflow`, or
  `box-shadow`, and the strip moves with a 2D `translate` rather than a scale or
  `translate3d`. Any of those makes the browser build a render surface around the moving
  card, which drops the `mask`/`clip-path` on descendant `backdrop-filter` glass (the
  Chat composer and its attached banners) and paints it as a hard rectangle for the
  duration of the switch. The glass therefore stays live while a card moves instead of
  being disabled, which would also force a full repaint of the card subtree.
- **The indicator measures once per switch.** The Topbar Tabs do not move while the
  Workbench cards slide, so the underbar's two endpoint geometries are read once when the
  switch begins and interpolated per frame. Re-reading layout every frame would force a
  synchronous reflow of the whole card subtree on each frame, which stalls the switch for
  heavy Tabs such as Agent sessions.
- **Direction follows Tab order.** Dragging the pointer left reveals the next Tab
  from the right edge; dragging right reveals the previous Tab from the left edge.
  Tab order is the Topbar's visual order and wraps cyclically.
- **Right-click vs right-drag are separated by displacement.** A right press that
  releases within the drag threshold (5px) opens the Pane context menu when it started
  on a Pane header, and does nothing elsewhere. Crossing the threshold starts the
  gesture and dismisses any open menu. Native `contextmenu` is always suppressed on the
  Workbench stage; menus over Pane content are intentionally not offered.
- **Shift+wheel switches Tabs; unmodified trackpad streams scroll content.**
  Each discrete Shift+wheel notch commits one full sliding switch; notches during a
  switch are queued (bounded to depth 2) and played in turn. Before a wheel gesture
  is promoted to a Tab switch, every horizontal scroller between the wheel target
  and the Workbench stage — including a Scrolling layout viewport that still has room
  in that direction — is given the gesture. `shiftKey + deltaY` is treated as
  horizontal intent because Windows and Chrome do not always synthesize `deltaX`.
  Unmodified trackpad horizontal deltas (`shiftKey: false`) remain continuous content
  navigation: when content or layout viewports cannot scroll further, they are
  absorbed and never queue Tab switches. The Topbar Tab strip keeps its native
  horizontal scrolling and never switches Tabs.
- **All user-initiated switches share the transition.** Clicking a Tab, pressing the
  Tablist arrow keys, focusing an already-open Tab from the Sidebar, a right-drag commit,
  and a wheel notch all play the same sliding transition: `TAB_SETTLE_DURATION_MS`
  (340ms) with `settleEaseOut`, `cubic-bezier(0.4, 0, 0.2, 1)`. That curve starts from
  rest, so continuing a paused gesture on release does not snap forward the way the
  front-loaded Apple curve did. Switches caused by creating or closing a Tab stay
  instant, preserving ADR-0013's zero-latency close behaviour; only the Tab indicator
  animates for those.
- **Commit and cancel.** The gesture commits when progress reaches 50% or the release
  velocity exceeds the flick threshold, and otherwise animates back to 0. Interactive
  progress is linear in pointer travel; the settle to 0 or 1, and the discrete-switch
  ramp, use the settle easing above.
- **Tab indicator replaces bold text.** The active Tab keeps its `bg-foreground/5`
  background but is no longer `font-medium`. A single shared underbar, 2px tall and
  colored `--primary`, is pinned to the bottom edge of the Topbar. At rest its width
  tracks the active Tab's measured width. It follows gesture progress directly, and
  animates with the Apple easing when the active Tab changes without a transition
  (including Tab reordering and close/new).
  It does not carry gesture state and never stretched _with the gesture_ — the
  elastic drag-time stretch rejected in Context above stays rejected. ADR-0025
  amends what its width does across a switch: the underbar interpolates position
  and width together between the two Tabs' resting geometry. When both Tabs rest
  at full width that is a pure translation, as before; when one is a Scrolling Tab
  the bar grows out of, or shrinks into, that Tab's narrowing.
- **Reduced motion skips automatic motion.** When `prefers-reduced-motion: reduce` is
  set, a Tab change lands immediately, the eased settle never runs, and the indicator
  jumps without animation. A right-drag in progress still tracks the pointer directly,
  because that is direct manipulation rather than decorative motion.

## Consequences

- The Workbench reads as one continuous surface: Tabs are tiled cards, and every path to
  a different Tab shares one motion language.
- Right-button interaction never collides with text selection, terminal input, or Pane
  dragging, all of which remain on the left button.
- Suppressing the native context menu across the Workbench stage is deliberate: Pane
  content does not own a right-click menu (the Pane header menu survives via the
  displacement threshold). Any future content that needs a context menu must claim it
  explicitly rather than inheriting the browser menu.
- The transition keeps every Tab's viewport mounted (ADR "keep-alive"), showing exactly
  two of them during a switch. The strip translate is a compositor transform, so terminal
  and editor content is not re-laid-out mid-transition.

## Navigation coordination

The transition module owns the sole settle animation. Starting another gesture
or transition cancels that animation before publishing the new state; input
adapters never have to retain independent cancellation handles. Ordinary Tab
activation is observed synchronously, and wheel navigation carries its signed
direction explicitly so cyclic wraparound keeps the user's direction.

Layout pan is independent of Tab count. Release velocity is measured at release,
including any pause since the last movement. Pointer cancellation, Escape, and
window blur cancel a gesture. Finishing a transition lands the indicator at the
active Tab without starting a second animation from stale geometry.

A single capture listener on the Workbench stage dispatches horizontal wheel
intent: it scrolls the innermost eligible scroller, then the layout viewport,
then queues a Tab switch. It also translates Shift+vertical wheel explicitly.
There is no competing viewport capture listener, and the queue advances on
transition completion rather than a timeout (including reduced motion).
