# Sidebar Session Navigation and Tab Creation

Opening an unopened Session or creating a Session from the Sidebar now opens as the first Pane in a new Tab (inserted immediately to the right of the active Tab) or reuses an active empty Welcome Tab, instead of splitting the currently focused Tab. Activating an already-opened Session focuses that existing View and switches to its Tab.

## Status

Accepted.

## Context

Previously, clicking a Session row in the Sidebar, opening a session via context menu, or creating a new Agent/Terminal session called `openTarget`, which split the currently focused Tab by placing a new Pane to its right. This disrupted the user's active Tab layout and caused existing Panes to squish and reflow whenever a new Session was visited. Furthermore, clicking an already-opened Session from another Tab created redundant splits or was difficult to locate across Tabs.

## Decision

We update the Workbench target opening policy (`applyOpenTarget`):

1. **Reuse Existing Views**: If the target Session already exists in the active Tab, focus its Pane directly. If it exists in another Tab, activate the leftmost Tab containing it and focus its Pane.
2. **Reuse Welcome Tab**: If the target Session is not open in any Tab, and the active Tab is an empty Welcome Tab (`welcome` View), replace the Welcome View in-place with the target Session.
3. **Open in New Tab**: If the target Session is not open in any Tab and the active Tab contains existing work, insert a new Tab immediately to the right of the active Tab containing the target Session as its sole first Pane, and immediately activate that Tab.
4. **Explicit Splitting**: In-tab splitting remains accessible via explicit gestures: `Alt + Click` (or `Alt + Shift + Click`) on a Session row, and dragging a Session onto an existing Pane's drop zones.

## Consequences

- The active Tab's layout is protected from unintended mutation and reflow during casual navigation.
- Deep links, router navigation, and sidebar clicks share unified, deterministic behavior across the Workbench.
- Users maintain full control over multi-pane workflows via keyboard modifiers and drag-and-drop.
