---
status: accepted
---

# Interruptible Workbench motion

ADR-0031 amends the navigation input, continuous route, shared indicator and
overlay architecture described here; its rules take precedence where they differ.


The design session agreed to establish motion principles for the whole frontend,
with the first implementation covering Sidebar visibility, Sliding Tab switches
and the Tab indicator, and Pane layout changes. Motion should follow direct input
closely and settle quickly with little or no visible bounce; interrupted motion
should continue from its current visual state.

For issue #122, an AppKit scroll-phase monitor distinguishes new macOS trackpad
gestures from momentum and forwards phase information through Tauri. Browser and
other platform behavior adapts to the input information available. The native
monitor does not forward displacement: DOM wheel events remain the sole source
of Tab travel, avoiding duplicate input.

Rapid Tab activation by click, keyboard, or Sidebar navigation immediately
retargets motion from its current visual state to the latest requested Tab;
intermediate requests do not form an animation playback queue. Each discrete
Shift+mouse-wheel notch still contributes to the requested destination. This
prioritizes immediate input response over completing each intermediate transition.
Transitions may temporarily display three or more live Tab cards when a third
destination is requested. Already visible cards must leave continuously while
the latest destination enters, preserving flat translation and sharp live content.
The concrete card arrangement needs prototype validation.

Trackpad Tab switching remains reversible until the direct gesture ends, even
after crossing a distance threshold. A threshold informs the release decision;
it does not irreversibly commit while the fingers are still moving. Settle should
start when direct input ends rather than waiting for momentum to drain. Issue
#122 is problem context; its early-commit wording is not a binding requirement
for this redesign. A macOS two-finger preview uses a longer direct travel than
the initial implementation. A short, fast directional flick can still commit
on release. Ordinary release commits after 20% of the preview travel; a shorter
slow movement returns to the source Tab.

Once a trackpad gesture scrolls inner content or pans a Scrolling layout, it
keeps that scroll ownership through the boundary. A new physical gesture that
begins with no horizontal scroll room may preview an adjacent Tab. Reversing an
uncommitted Tab preview first returns the revealed Tab to its origin; remaining
reverse travel may scroll the original content, after which that gesture keeps
scroll ownership. Momentum from a gesture must not produce another Tab switch.
Content and Scrolling layout wheel events keep WebView's default scrolling path,
including native momentum; Tab gestures intercept wheel events only when the
gesture starts with no scroll room.

Where reliable native gesture phases are unavailable, ordinary trackpad input
continues to scroll content without switching Tabs. Click, keyboard, right-drag,
and discrete Shift+wheel navigation retain their supported paths. This first
implementation does not use heuristic wheel classification to promise parity
with the macOS desktop gesture.

During an uncommitted gesture preview, the source Tab remains logically active.
A successful release commits activation when settle starts. Click and keyboard
navigation activate their destination immediately. Settle completion is not an
input or activation gate, and new gestures take over the current visual state.

Pane size transitions preserve sharp text and live interaction. Divider dragging
updates real sizes directly; automatic layout transitions may reduce content
reflow frequency according to View type. Text scaling and static content
screenshots are not the chosen transition strategy. The exact resizing policy
must be validated against terminal, editor, and conversation content.

## Implementation boundary

Keep durable Workbench layout and activation state separate from transient
presentation state. A shared motion primitive retains current position, velocity,
and target and can retarget without resetting position or restarting a fixed
duration curve. Use strongly damped spring settling with little or no overshoot;
direct manipulation follows input without adding a spring lag. Per-frame updates
should avoid rendering the whole React content tree. Sharing this primitive does
not mean putting unrelated animations into one global progress value.

- Sidebar width, its layout reservation, and titlebar control placement derive
  from one coordinated presentation state. Actual content resizing must be
  measured and optimized alongside this coordination.
- Tab navigation owns card arrangement, activation requests, and handoff to new
  input. Cards and indicator consume the same presentation frame. Temporary
  multi-card presentation replaces the strict two-card assumption when needed;
  it does not require painting every mounted Tab. Preserve live View identity
  and the existing glass-compatible flat translation constraints.
- Pane layout supplies target rectangles while presentation retains current
  rectangles across changes. Each animated property has one owner, avoiding
  competing CSS transitions and WAAPI compensation. Treat BSP and Scrolling
  layouts consistently, including position and size changes. Content-specific
  resize policies must avoid scaling text and delaying direct divider input.
- An input adapter supplies gesture identity, phase, momentum phase, travel,
  and timing where available. A gesture coordinator locks ownership once inner
  scrolling or Layout pan consumes travel, and keeps old momentum separate
  from new direct input. Native events and DOM wheel
  events must not apply the same displacement twice. Validate the native/WebView
  routing before relying on this adapter for the production gesture.

Retain current cyclic Tab navigation, immediate main-content switching on Tab
creation/closure, and concurrent close behavior. Reduced-motion preferences
skip automatic Workbench transitions; direct manipulation still tracks input.
The Animation speed setting scales automatic interface motion from 0× to 2×,
defaulting to 1×. Zero disables automatic motion; direct manipulation still
tracks input and native scrolling retains the platform's inertia. Each motion
keeps its own base timing, with spring frequency scaled inversely and CSS/WAAPI
durations scaled directly. The old Panel animations value is not carried into
the new setting because its default 0ms disabled panels while leaving Tab and
Pane motion active.

ADR-0019's fixed-duration, two-card,
and trackpad rules are amended; its flat live-card presentation and glass
constraints remain relevant.

## Validation and delivery

The implementation uses a small analytic critically damped spring for scalar
presentation values and one rectangle controller per Pane. No suitable spring
implementation exists among the current dependencies, and `_refs/` is absent
from this checkout, so there is no local implementation to adapt. The controllers
retain position and velocity across target changes without adding another
general animation framework.

Acceptance scenarios include rapid Sidebar reversal; A-to-B-to-C and A-to-B-to-A
navigation; scroll ownership at the boundary and reversal; release commit/cancel followed
by a long momentum tail; a fresh reverse gesture during settle; repeated
Shift+wheel input; rapid Pane split/close/rearrangement; and Sidebar resizing
while terminal, editor, and conversation Views are present. Check reduced motion,
focus routing, live content identity, and glass rendering alongside continuity.
Profile layout, content resize, and frame timing on the actual desktop app;
source inspection alone does not establish visual smoothness or a frame-rate
guarantee.

The implementation follows these decisions on the feature branch. Web typechecks,
native compilation, and targeted interaction tests cover the state boundaries.
Desktop visual and physical trackpad verification remain outstanding because
Computer Use access to the registered Awen Dev window was denied by automatic
approval review. A synthetic event test cannot establish physical gesture feel.
