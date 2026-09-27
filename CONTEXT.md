# Awen

A desktop console for running and driving coding agents. Projects hold
Workspaces; Sessions belong to Workspaces; Views present Workspace or Session
state and are displayed as Panes in Tabs.

## Language

**Environment**:
A connected execution-environment scope backed by one Awen daemon/server. It
scopes Project, Workspace, and Session identities and capabilities; it is not
itself a Project or Sidebar grouping.
_Avoid_: Host, Machine, Daemon

**Connection**:
A client-side access configuration and transport tunnel targeting an
Environment. It manages address discovery, SSH forwarding, authentication
credentials, and network lifecycle; it does not own Projects, Workspaces, or
Sessions. Dynamic port remapping or reconnecting through a different tunnel
preserves the target Environment's identity.
_Avoid_: Machine config, Server profile, Remote host

**Awen Deep Link**:
A canonical navigation address that identifies one Awen target by its
Environment- and target-level identities. It opens or focuses a View but is
not the authority for Tab, Pane, focus, or layout state.
_Avoid_: Workbench URL, layout URL, Thread URL

**Project**:
A registered logical project root in Awen. It is the canonical top-level
domain identity in the Sidebar; external project records are integration
references and do not replace the Awen Project identity.
_Avoid_: Repo, Repository, Folder (as UI labels)

**Workspace**:
One stable checkout of a Project. It may be the Project's main checkout or a
Git worktree. A Workspace has its own Awen identity independent of its current
branch, commit, or detached-HEAD state. Its display title is Workspace metadata,
not Project identity; renaming a Workspace does not rename its Project, and
renaming a Project does not rename its Workspaces. Sibling Workspaces of one
Project are different checkouts of the same repository.
_Avoid_: Session, Checkout. Not paseo's Workspace, which is a `cwd` that
happens to carry a branch.

**Session**:
A persistent unit of work belonging to exactly one Workspace. Agent sessions
and terminal sessions are the current Session kinds; each has an Awen identity
independent of the runtime process or provider-native session currently backing
it. A Session may be active, stopped, resumable, or closed according to its
kind and provider capabilities, and Sessions are listed at the third level of
the left sidebar. A Session is not itself the content shown in the main area.
_Avoid_: Task, Job, Run. Not paseo's per-client connection, and not the
provider's own session log.

**View**:
A client-owned presentation bound to a Workspace or Session: for example an
agent conversation, terminal, file browser, git status, or content contributed
by a plugin. A View is the content shown in the main area; the Sidebar exposes
navigation references to the underlying Project, Workspace, and Session. A View
has no independent work lifecycle; opening, moving, or closing a View does
not create or terminate the underlying Session or Workspace work.
_Avoid_: Panel, Surface, Tool, Widget

**Workbench**:
The client-owned organizer of Tabs and their View instances. It accepts
navigation requests from the Sidebar and manages presentation focus and
layout, but it does not own the lifecycle of Projects, Workspaces, or Sessions.
_Avoid_: Shell, Session manager, Navigator

**Session View**:
A View whose target is an Agent session or Terminal session and which presents
that Session's current work. A Session has exactly one Session View across the
whole Workbench: opening an already open Session focuses it, and an explicit
split or drop moves it. Presentation copying is not an ACode operation.
_Avoid_: Session, Runtime panel, Mirror, 镜像, Duplicate View

**New Agent Session View**:
A Workbench View for staging the initial turn of an Agent session. Eager Agent
sessions (ADR-0016) instantiate durable Awen Session identities at creation
time, so New Agent Session Views automatically upgrade to Agent Session Views
upon session creation.
_Avoid_: Draft Session, Provisional Session, Thread

**Workspace View**:
A View whose target is a Project or Workspace concern rather than a persistent
Session, such as files, Git state, or plugin-provided workspace content. It
does not require the daemon to hold a long-lived Session.
_Avoid_: Session, Workspace panel

**File View**:
A Workspace View for browsing, previewing, and editing files relative to its
Workspace. Its content is addressed by Workspace path and does not require an
Agent Session or Thread.
_Avoid_: File panel, File browser

**Git View**:
A Workspace View for inspecting Git state and changes in its Workspace. It
presents the checkout's worktree state rather than owning a Session or running
Git operations on the user's behalf.
_Avoid_: Diff panel, Source Control Session

**Application View**:
A View whose target is application-level content rather than a Project,
Workspace, or Session, such as cross-workspace pull requests, issues,
notifications, or account status. It does not depend on a particular Workspace
or Session for its identity.
_Avoid_: Global View, Workspace View, Session View

**View definition**:
The registered kind of a View, with its identity and renderer. A definition
describes what can be opened and may be supplied by Awen or a plugin; it is
not one opened occurrence.
_Avoid_: Panel registration, View instance

**View instance**:
One client-owned occurrence of a View definition bound to its target and
referenced by a Pane. Moving an instance changes its presentation position,
never Session or Workspace work, and a Session View instance is never copied.
_Avoid_: Session, process, daemon entity

**Workspace path**:
A normalized path relative to a Workspace root, used by file and Git Views as
the stable file identity. Absolute machine paths and provider-native paths are
not Workspace paths.
_Avoid_: cwd, absolute path, repository path

**View data source**:
The typed source of snapshots and updates consumed by a View. It hides whether
the data came from a client plugin, runtime RPC, or another implementation
detail. A View uses typed capabilities for commands; it does not own the
lifecycle of the data it presents.
_Avoid_: DaemonApi, wire message, local filesystem

**View capability**:
A bounded, typed operation that a View or plugin may request for its target,
such as opening, renaming, stopping, or deleting a Session. A capability
grants an operation, not ownership of the target's lifecycle.
_Avoid_: Global store access, daemon handle, unrestricted command

**Welcome View**:
The ordinary initial View shown when a Workbench has no opened Session. It may
offer actions such as adding a Project, selecting a Workspace, or creating a
Session, but it does not represent or own a Session.
_Avoid_: Empty pane, Start session

**Tab**:
A working area, created by the user or supplied as the default initial area,
that arranges Panes. A Tab belongs to no Project and no Workspace: its Panes
may display Views from any Workspace of any Project.
_Avoid_: Workspace, Group, Deck, Page. A Tab is not paseo's Tab, which is a
view inside one Workspace.

**Tab Canvas Docking**:
The gesture and layout transaction of dragging an inactive single-pane Tab from
the Topbar Surface downward into the active Tab's Workbench canvas to merge its
View into the active layout and close the source Tab.
_Avoid_: Tab merging, Pane detachment, Window docking

**Layout pan**:
The Workbench navigation gesture that moves a Scrolling layout horizontally to
reveal Columns beyond the Viewport, preserving each Column's own position in the
strip. A BSP layout has no Layout pan because its content does not overflow the
Viewport.
_Avoid_: Canvas drag, map pan, scroll bar

**Sliding Tab switch**:
The continuous horizontal presentation of a Tab change, with live Tab cards
tiled side by side; retargeting may temporarily keep multiple cards visible.
It changes presentation without changing Tab or Session identity.
_Avoid_: Stacked switch, carousel, page flip, split slide

**Tab switch progress**:
The continuous 0–1 measure of one source-to-destination Sliding Tab switch,
shared by the Tab cards and Tab indicator. Gesture-driven progress is reversible
until release and does not itself imply that the destination is active.
_Avoid_: Scroll offset, swipe amount

**Tab indicator**:
The theme-colored underbar beneath the active Tab in the Topbar Surface. It
conveys the active Tab, any Tab switch progress, and — on a Scrolling layout
whose canvas overflows — how much of that canvas the Viewport shows and where in
it the Viewport sits. It is presentation chrome and owns neither Tab focus nor
Tab order.
_Avoid_: Tab highlight, underline, selection bar

**Pane**:
The smallest functional window in a Tab, holding exactly one View instance.
Panes and Tabs are layout concepts; a Pane is never an empty or standalone
Session state.
_Avoid_: Panel, Widget, Window, Split

**Pane content**:
The presentation of the View held by one Pane. It is independent of the
Sidebar, Tab, and layout tree, and adapts to the Pane's available size and
focus state.
_Avoid_: Pane layout, Shell, Global panel

**Sidebar**:
The client-owned navigation tree that exposes Projects, their Workspaces, and
each Workspace's Sessions. It is a full-height column ("贯通式") running from
the top of the window to the bottom, and houses primary window and settings
controls when expanded.
It is a navigator for work and references, not another Tab or Pane.
_Avoid_: Rail, Workspace panel

**Session Row Tab State**:
The presentation state of a Session row in the Sidebar reflecting its presence
and focus across Workbench Tabs: `active-focused` (focused in the active Tab),
`active-unfocused` (present in the active Tab but unfocused), `background-tab`
(open in a non-active Tab), and `unopened` (not open in any Tab).
_Avoid_: Open state, Tab presence, Session status

**Session Status**:
The current activity, blockage, or failure of a Session, independent of Sidebar
focus or Workbench Tab presence. One of `approval`, `input`, `plan`, `working`,
`monitoring`, `failed`, or `ready`; `ready` is the unlabeled resting state. The
same vocabulary covers Agent and Terminal sessions.
_Avoid_: Session state, Alert, Indicator. Not Session Row Tab State, which
describes where a Session is open rather than what it is doing.

**Unread Completion**:
The signal that a `ready` Session's latest turn completed after the Session was
last focused, so the user has not seen the finished turn. It is a decoration on
`ready`, not its own Session Status, and it is the only Sidebar status signal
that focus acknowledges.
_Avoid_: Completed status, Done badge, Unread message

**Status Gutter**:
The fixed-width vertical slot preceding a Sidebar Session row that hosts the
Session Status dot, plus the Unread Completion dot on a `ready` row, while
keeping Session provider icons vertically aligned.
_Avoid_: Margin slot, Alert column, Left padding

**Tab title**:
The user-visible name of a Tab. It is derived from the first Pane until the
user overrides and locks it manually.
_Avoid_: Workspace name, Window title

**History**:
The complete, Workspace-grouped index of `closed` Agent and Terminal Sessions
that remain resumable when supported after their active runtime process is
released. History is an Awen concept; provider or Awen archival states are only
integration details.
_Avoid_: Archive, Deleted sessions

**BSP layout**:
A Tab layout that recursively divides its available rectangle along stored
horizontal or vertical axes; each leaf is one Pane. It is inspired by
Hyprland's Dwindle interaction, but is Awen's own stable split model.
_Avoid_: Dwindle (unless referring to Hyprland)

**Scrolling layout**:
A Tab layout whose Panes are arranged in an ordered horizontal strip of
Columns; each Column stacks Panes vertically and the strip can move
horizontally beyond the viewport.
_Avoid_: Scroll bar, scrolling Split

**Column**:
A first-class unit inside a Scrolling layout. It owns one width policy and a
vertically ordered set of Panes whose shares fill the Column's height.
_Avoid_: Split (when referring to a Scrolling layout Column)

**Viewport**:
The window onto one Tab's laid-out Panes: it holds the canvas the layout
computes and can move that canvas horizontally in a Scrolling layout. It scrolls
only horizontally, and its scroll position is presentation, not Tab or Pane
state.
_Avoid_: Scroll area, scroll pane, canvas (the canvas is what the Viewport holds)

**Trailing Canvas Area**:
The unoccupied horizontal space in a Scrolling layout extending from the right
edge of the rightmost Column to the viewport boundary or the canvas trailing
edge. It acts as an open drop target that appends a new Column at the far right.
_Avoid_: Blank area, Dead zone, Margin

**Agent session**:
A Session representing one agent conversation: one provider, one model
selection, one Workspace, and one transcript. An Agent session is created
eagerly with durable Awen identity and appears in the Sidebar immediately.
Its Awen identity is distinct from any provider-native runtime or thread identifier.
_Avoid_: Agent, Task, Job, Run

**Zero-turn Agent session**:
An Agent session whose transcript contains no turns yet. It presents an initial
composer and model selection without requiring a provider runtime process.
Closing an untouched zero-turn Agent session, or its last remaining View,
permanently deletes it instead of archiving it to History. Unsent content makes
the Session touched and preserves it.
_Avoid_: Draft Session, Provisional Session

**Terminal session**:
A Session representing one Workspace-owned terminal work context, including its
terminal history and resumable state when supported. Its Awen identity is
independent of the current PTY process and terminal emulator instance.
_Avoid_: Terminal, Terminal pane, PTY

**Provider**:
An agent runtime integration such as Codex, Claude Code, or OpenCode that can
create and drive Agent sessions through a common provider capability catalog.
_Avoid_: Harness (as the only provider identity), CLI, Model

**Provider capability catalog**:
The registry exposed to the client describing available providers, provider
instances, models, authentication state, and supported operations. The client
discovers capabilities instead of hard-coding a provider list.
_Avoid_: HarnessId union, Provider menu, Model list

**Daemon sidecar**:
A local runtime process used by the desktop application to host provider
runtimes, active Session execution, PTYs, and persistence behind typed
contracts. Its transport, supervision mechanism, and provider-native runtime
identities are implementation details and do not define Awen domain identity.
_Avoid_: Tauri command, Renderer process, Pane runtime

**Agent timeline**:
The structured presentation of an Agent session's turns and runtime events,
including user/agent text, reasoning, tool activity, approvals, and failures.
It is distinct from terminal output and provider-native protocol details.
_Avoid_: Raw transcript, Terminal output, Provider protocol

**Terminal emulator**:
A Pane content that interprets a Terminal Session's PTY stream as a terminal
screen with ANSI styling, cursor state, alternate-screen behavior, selection,
scrollback, and responsive dimensions.
_Avoid_: Terminal text, Preformatted output, Agent timeline

**Appearance**:
The client presentation preferences governing color scheme, interface contrast,
typography, and desktop window translucency.
_Avoid_: Display settings, Styling preferences

**Theme**:
A coherent set of semantic color tokens mapping canonical UI roles to concrete
color values for light or dark modes.
_Avoid_: Skin, Palette file, CSS style

**Window Glass**:
The desktop-translucent frosted glass effect achieved through native OS window
composition (macOS WindowServer blur or Windows Acrylic/Mica) and client tinting.
_Avoid_: CSS blur, Backdrop filter, Translucency hack

**Glass Stage**:
The native desktop composition layer behind the web view that supplies the
window-wide frosted-glass base. It is a platform capability, not a Theme,
Sidebar, Workbench, or View.
_Avoid_: Glass background, CSS stage, Global blur layer

**Background Mask**:
A window-wide tint that brightens the blurred desktop in light mode or darkens
it in dark mode. Its separately remembered light and dark strengths combine
with Material Surface opacity without fading the content above those surfaces.
_Avoid_: Content opacity, Blur strength, Workbench Artwork

**Material Surface**:
A user-visible chrome layer that intentionally supplies a background material
over the Glass Stage. Sidebar, Topbar, Workbench, and Overlay are Material
Surfaces; they own their material settings and edges.
_Avoid_: Panel background, Widget background, Arbitrary glass layer

**Content Layer**:
The text, controls, and View content rendered above Material Surfaces. A
Content Layer renders with a transparent base background and does not own the
background material for its containing area.
_Avoid_: Pane background, View background, Opaque content shell

**Workbench Glass**:
The presentation toggle determining whether the Workbench main pane adopts
Window Glass translucency or stays opaque.
_Avoid_: Body glass, Main pane glass

**Topbar Surface**:
The horizontal title and tab chrome above the Workbench, alongside the
full-height Sidebar when expanded; it carries Settings navigation when Settings
replaces the working content. It is a distinct Material Surface whose visual
continuity with the Sidebar does not merge their layout ownership.
_Avoid_: Header, Toolbar, Tab strip

**Workbench Artwork**:
An optional image layer shown beneath all Workbench content and above the
Workbench Material Surface. It belongs to the Workbench rather than any one
View, Session, or Tab.
_Avoid_: Chat wallpaper, Session background, View background

## Core invariants

- A Connection is a client-side access transport to an Environment; reconnecting or changing forwarded ports does not change Environment or Workspace identity.
- A Project owns zero or more Workspaces.
- A Workspace belongs to exactly one Project.
- Workspace identity is independent of Git branch, commit, or HEAD state.
- A Session belongs to exactly one Workspace.
- The current Session kinds are Agent session and Terminal session; other
  main-area content is a View, not a Session.
- Session identity is independent of its runtime process and provider-native
  session identity.
- Closing a View, Pane, or Tab does not by itself stop or delete a Session,
  except that closing the final View of an untouched zero-turn Agent session
  deletes that empty Session; other Session lifecycle actions are explicit.
- A Workbench may contain multiple Tabs; each Tab owns its own Panes, and a
  Session View is unique across the whole Workbench rather than per Tab.
- A Workbench with no opened Session shows a Welcome View rather than an empty
  Pane. An explicit close that removes a Tab's last non-Welcome Pane closes that
  Tab; when it is the Workbench's only Tab, it recovers Welcome in place
  (ADR-0023).
- An Agent session is created eagerly with durable Awen identity (AgentSessionId and ThreadId) and appears in the Sidebar under its Workspace immediately, even before its first turn is sent.
- A Workspace may contain multiple zero-turn Agent sessions.
- An untouched zero-turn Agent session (empty transcript and no unsent draft payload) is permanently deleted upon closing rather than archived to History.
- Dragging a Workspace context menu action onto the Workbench creates that View instance into the targeted Pane (supporting 4-directional edge splits and center replace) or Tab drop zone without requiring prior navigation.
- A Tab belongs to no Project or Workspace and may display Views from multiple
  Workspaces or Projects.
- A Pane displays exactly one View instance and is never empty.
- A Session has at most one Session View in the whole Workbench (ADR-0010),
  whichever Tab it lands in; opening it again focuses that View.
- Closing one Session View only detaches that View, with the untouched zero-turn
  exception above; closing a Session removes that View while preserving its History entry.
- Terminal Sessions are presented only by Terminal Session Views; an Agent
  Session View does not own or embed a Terminal Session.
- A View may present a Session or Workspace without owning its work lifecycle.
- File, Git, Project, and Workspace Views keep their own per-Tab coexistence
  rules; Workbench uniqueness applies only to Session Views.
- Opening an unopened Session or draft from the Sidebar opens it as the sole View in a new Tab (or replaces an active Welcome Tab), rather than adding a Pane to the current Tab.
- Activating a Session that already has an opened Session View focuses that existing View and activates its Tab.
- Splitting within an active Tab is explicit through keyboard modifiers or drag-and-drop.
- The Workbench Viewport never scrolls vertically; vertical scrolling belongs strictly to the Content Layer of individual Panes.
- In a Scrolling layout, the Viewport scrolls purely horizontally, and the Trailing Canvas Area beyond the rightmost Column is a valid drop target that appends a new Column at the far right.
- The Viewport paints no native horizontal scrollbar; the Tab indicator carries its position and width instead (ADR-0025).
- A user-navigated Tab change (click, keyboard, Layout pan, or wheel notch) presents a Sliding Tab switch; a Tab change caused by creating or closing a Tab lands instantly.
- A Layout pan is unavailable in a BSP layout; a horizontal gesture a layout cannot consume promotes to a Sliding Tab switch instead.
- The Tab indicator tracks the active Tab, any Tab switch progress, and — on a Scrolling layout whose canvas overflows — the Viewport's share of that canvas and its position in it. It never spans more than the active Tab's width.
- Runtime and provider implementation details must not define Awen domain
  identity.
- Provider-native lifecycle commands may implement Awen Session operations,
  but they do not add user-visible Session actions or lifecycle states.
- A Workspace header in the Sidebar displays its active Git branch on the left and its Workspace directory name on the right.
- A Sidebar Session row visually differentiates four Tab states (`active-focused`, `active-unfocused`, `background-tab`, and `unopened`) via active backgrounds, trailing edge indicators (vertical line for active-unfocused, dot for background-tab), and typography without altering Session identity.
- Terminal Sessions dynamically display the active agent provider icon when an agent CLI runs as their foreground process.
- A Session's Session Status is focus-independent: focusing a Session never changes or hides what it reports. Focus only acknowledges the Session's Unread Completion.
- Unread Completion is client-owned: a `ready` Session shows it while its latest turn completed after the Session was last focused, and focusing the Session clears it until a later turn completes.
