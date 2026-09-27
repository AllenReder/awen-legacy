---
status: accepted
---

# Viewport position on the Tab indicator

A Scrolling Tab's horizontal scroll position is shown by the Topbar Tab
indicator instead of a native scrollbar. The Workbench Viewport hides its
native horizontal bar unconditionally; the active Tab's underbar narrows to the
Viewport's share of the Scrolling canvas and travels the active Tab's box as the
Viewport scrolls. For issue #148.

## Context

A Scrolling layout renders Columns into a canvas that can overflow its Viewport,
so the Viewport needs horizontal navigation: Layout pan, wheel, trackpad,
keyboard, focus reveal, and edge auto-scrolling during a drag (ADR-0015,
ADR-0019). It also had a native horizontal scrollbar at the bottom of the
Workbench, which carried no information the Tab indicator does not already have
a home for — the indicator already expresses which Tab is active and the
progress of a Sliding Tab switch (ADR-0019).

Two independent affordances describing one horizontal axis read as clutter, and
the native bar sat below the Workbench canvas rather than in the chrome that
already owns Workbench presentation state.

## Decision

- **The Viewport's native horizontal scrollbar is hidden unconditionally.**
  Hiding it conditionally on overflow would feed back on itself: a classic
  scrollbar consumes layout width, so hiding it widens the Viewport, and the
  canvas width derives from the Viewport, which flips the overflow state back.
  The Viewport stays `overflow-x: auto` — only the painted bar is removed.
- **The active Tab's underbar expresses the Viewport.** When the active Tab is a
  Scrolling layout whose canvas overflows its Viewport, the underbar's width is
  the visible share of the canvas (`tabWidth × clientWidth / scrollWidth`,
  clamped to a visible minimum and to the Tab width) and it travels the active
  Tab's box from the left edge at `scrollLeft = 0` to the right edge at the
  horizontal limit.
- **Nothing else changes shape.** A Tab whose canvas does not overflow — BSP,
  an empty Tab, or a Scrolling strip narrower than its Viewport — keeps an
  underbar spanning the whole active Tab. BSP is included by construction
  because its Viewport cannot scroll.
- **The Viewport owns the reading; the indicator consumes it.** Every mounted
  Scrolling Tab publishes its `clientWidth`, `scrollWidth`, and `scrollLeft`,
  keyed by Tab — not only the active one, because a switch needs the incoming
  Tab's reading before it becomes active. Only a `scrollLeft` change is
  frequent, so the scroll path re-reads nothing but the offset and the indicator
  writes only `transform` and `width` — the same discipline the Tab-geometry
  cache already enforces, because reading layout per frame would force a
  synchronous reflow of the pane subtree on every wheel tick. A Tab that is not
  laid out reports a zero-width box and keeps its last real reading.
- **The underbar follows Viewport readings directly.** It tracks a pan in the
  same frame without easing, because the pointer is already the animation
  (ADR-0024). A Column or window resize moves the Pane rects directly too, so
  the underbar follows that as well rather than easing away from the geometry it
  describes.
- **A switch interpolates both endpoints' resting geometry.** The underbar
  travels from where the source Tab's bar rests to where the target Tab's bar
  rests, interpolating position and width together. That is a pure translation
  when both Tabs rest at full width, preserving ADR-0019's behaviour for
  BSP-to-BSP; where a Scrolling Tab is involved, the bar grows out of or shrinks
  into its narrowing instead of starting at the Tab's edge and snapping its
  width on landing. This generalizes ADR-0019's rule rather than contradicting
  it: the width is still not gesture state, and an endpoint's width is a fact
  about that Tab, not about the drag.
- **A Scrolling Tab is entered at the edge matching the travel direction.** A
  switch whose incoming Tab is a Scrolling layout moves that Tab's Viewport to
  the edge the user was travelling away from — the left edge arriving from a Tab
  on the left, the right edge from one on the right — so the strip reads as
  continuing rather than jumping inward to the incoming Tab's focused Pane. This
  supersedes the focused-Pane reveal for that one commit.
- **The entry holds until the user picks a Pane or scrolls.** The Tab re-runs
  reveal as it gains its real size and as its Columns change, and each of those
  would pull the Viewport inward again, so the entry persists past the commit
  that activated it. It speaks only for the focused-Pane reveal it exists to
  suppress: focusing a different Pane ends it, and so does the Viewport moving
  away from where the entry left it, because that is the user scrolling and
  direct manipulation outranks the entry. Without that second condition the
  entry keeps writing the edge back over the user's scroll.
- **Structural activation is not navigation.** Creating a Tab, or a Tab closing
  onto another, ends any switch rather than running one, so it carries no
  direction and keeps ordinary focused-Pane reveal. Only a Sliding Tab switch
  has a travel direction to enter by.
- **A switch re-places the bar when a reading moves.** An endpoint can move with
  no transition frame behind it: committing a switch reveals the incoming Tab's
  focused Pane, which scrolls that Tab's Viewport. Both endpoints are re-read per
  frame, so the underbar listens for reading changes for the whole switch as well
  as for frames. Subscribing to frames alone leaves the bar on the stale endpoint
  until the switch settles, which reads as a jump at the end of the switch.

## Consequences

- One affordance describes the horizontal axis, in the chrome that already owns
  Workbench presentation.
- Horizontal navigation is entirely gestural: the scrollbar no longer advertises
  that a Scrolling Tab can move. The Tab indicator communicates it instead, but
  only for the active Tab.
- The Viewport widens by the width of a classic scrollbar on platforms that
  reserve one. Layout geometry already derives from `clientWidth`, so no
  computation changes.
- Keyboard and assistive-technology access to horizontal scrolling rests on the
  scrolling container itself, not on the painted bar.
- Every Scrolling Tab holds a live reading, so the indicator depends on all
  Scrolling Tabs being mounted (which the Workbench's Keep-Alive viewports
  already guarantee).
