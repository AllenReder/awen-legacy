# Eager agent sessions and workspace context menu drag-to-create

**Status: accepted for drag behavior; Agent identity and close policy superseded by ADR-0026 (supersedes ADR-0004)**

Awen allows dragging creation actions directly from the Sidebar workspace context menu into the Workbench (active tab pane splits, center replace, or new tabs). In addition, Agent sessions are created eagerly with durable Awen identities (`AgentSessionId` and `ThreadId`) appearing in the Sidebar immediately at t=0, superseding the single client-local draft model of ADR-0004. Untouched zero-turn Agent sessions are permanently deleted upon closure instead of archived to History.

## Context

Previously, Issue #110 identified that users could not drag creation actions (Browse Files, Review Changes, New Agent Session, New Terminal Session) from a workspace's context menu into the Workbench layout. Casual navigation opened new tabs by default, but organizing complex multi-pane layouts required explicit drag-and-drop gestures.

Furthermore, ADR-0004 previously restricted agent session drafts to a single client-local `NewAgentSessionView` per workspace that did not appear in the Sidebar before first send. This prevented users from staging multiple distinct concurrent conversations or organizing new agent sessions directly in the Sidebar tree.

## Decision

- **Eager Agent Session Creation**: Clicking or dragging "New Agent Session" invokes `thread.create` to allocate a durable Awen session immediately with 0 turns. The session appears in the Workspace active session list in the Sidebar and is displayed in the Workbench as an `AgentView` with an initial composer and model selector. The session does not spawn an external provider runtime process until its first turn is sent.
- **Untouched Zero-Turn Session Lifecycle**: When a zero-turn Agent session (`messages.length === 0` and no draft content) is closed via Sidebar context menu, middle-click, or closing its last remaining View, it is permanently deleted via `thread.delete` rather than archived into History. Sessions with existing conversation turns continue to enter History when closed.
- **Workspace Context Menu Drag Gesture**:
  - The four creation actions in the workspace context menu (`browse-files`, `review-changes`, `new-agent-session`, `new-terminal-session`) support drag-and-drop.
  - When pointer movement exceeds 5px, the context menu dismisses immediately and a drag ghost appears under the pointer.
  - Drop destinations include:
    - **Pane 4-directional edge splits**: Left, Right, Top, and Bottom.
    - **Pane center replace**: Replaces the target Pane's View instance.
    - **Tab strip**: Dropping onto an existing Tab inserts into that Tab; dropping onto the tab strip gap or `+` button creates a new Tab.
    - **Scrolling layout trailing canvas area**: Appends a new Column at the far right.
- **Terminal Session Creation on Commit**: Dragging "New Terminal Session" generates an anticipated terminal target for virtual drop previews, but only allocates the backend daemon PTY (`openTerminal`) when the drop transaction commits. If dropped or cancelled, no orphaned PTY process is left behind.
- **File and Git View Uniqueness**: Dropping a File View or Git View into a Tab that already contains that same View focuses the existing Pane rather than duplicating it.

## Consequences

- The distinction between provisional drafts and active sessions is eliminated in favor of a unified Session lifecycle.
- Users can create, stage, and arrange multiple agent sessions in parallel directly from the Sidebar and context menus.
- Zero-turn sessions do not pollute History when closed.
- Multi-pane workspace organization is fluid, consistent with existing session and pane drag-and-drop invariants.

## Close policy clarification

The same lifecycle policy handles explicit Sidebar Session closes and cleanup
following an explicit Pane or Tab close. A Session with draft text, attachments,
other composer payload, transcript content, or pending submission is touched:
closing its View only detaches the View; explicitly closing the Session archives
it. Only an untouched zero-turn Session may be permanently deleted automatically.
Remaining Views are counted across Tabs using the canonical environment/thread
identity, including an eager draft View that has not yet been promoted.

The Workbench reports completed View closes to the lifecycle adapter; it does not
perform runtime commands itself. Reordering, docking, target promotion, and
workspace reconciliation do not emit explicit View-close events. Close decisions
are refreshed after asynchronous stop/animation work so typing or submitting
while a row collapses cannot reuse an earlier empty-session decision.
