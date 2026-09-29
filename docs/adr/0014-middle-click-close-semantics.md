# Middle-click close semantics across Topbar Tab and Sidebar Session

**Status: accepted for input behavior; Terminal close policy superseded by #156/#169**

The current policy is that an explicit Topbar Tab close, including middle-click,
terminates and deletes any Terminal Sessions in that Tab. Agent Sessions remain
intact. The historical decision below records the earlier presentation-only
Terminal behavior and the input gesture rules that still apply.

Middle-click (mouse button 1 / auxclick) on a Topbar Tab closes the presentation Tab
layout without affecting the underlying Session. Middle-click on a Sidebar Session
triggers a domain lifecycle action: archiving an active Session to History or permanently
deleting a History Session with destructive confirmation.

## Context

Desktop browsers and developer workstations establish strong user expectations around
middle-click for dismissing tabbed items and document lists. However, Awen strictly
distinguishes between presentation layout units (Tabs and Views) and persistent work units
(Sessions and Workspaces). Applying middle-click naively across the interface risks
conflating these boundaries or inadvertently deleting persistent session transcripts.

## Decision

- **Topbar Tab middle-click (Presentation layer)**:
  - Invokes the standard Tab close pipeline (`handleCloseTab`), executing a 220ms fluid
    horizontal width collapse before unmounting.
  - Leaves the underlying Session entity intact (Tabs are layout organizers, not work owners).
  - Preserves the single-remaining-Tab invariant: middle-click is a no-op when only one
    Tab remains.
  - Enforces `canCloseTab` unsaved-state guards.
  - Middle-clicking a background (inactive) Tab leaves the current active Tab focused,
    avoiding viewport hopping.
  - Middle-clicking an actively edited (renaming) Tab is ignored to prevent loss of edits.
- **Sidebar active Session middle-click (Lifecycle archival)**:
  - Invokes `closeSession`: gracefully stops running agent/terminal processes, archives the
    thread to `History`, and removes associated Session Views across all Tabs.
  - Executes a 220ms fluid vertical height collapse in the active session list.
  - Operates as a background action: does not shift Workbench focus or navigate URL routes.
- **Sidebar History Session middle-click (Destructive deletion with confirmation)**:
  - Invokes `deleteSession`: requires explicit confirmation via `requestDestructiveConfirmation`
    warning that transcripts and outputs will be permanently deleted.
  - If confirmed, executes a 220ms fluid vertical height collapse and purges the session.
  - If cancelled or escaped, the session remains untouched in History without animating.
- **Event safety and cross-platform compass suppression**:
  - Bound via `auxclick` (`button === 1`), requiring pointer press and release within the same item.
  - `pointerdown` and `mousedown` explicitly call `preventDefault()` on `button === 1` to
    suppress Windows autoscroll compass indicators and Linux X11 primary selection paste.
