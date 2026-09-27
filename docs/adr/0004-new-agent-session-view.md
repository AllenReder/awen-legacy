# Make New Agent Session drafts Workbench Views

**Status: superseded by ADR-0016 and ADR-0026**

Agent-session creation starts in a Workbench-owned **New Agent Session View**
bound to one Workspace and a client-local draft identity. A draft is not a
Session and gains an Awen Session identity only when its first send creates
the Agent Session. One Workspace has at most one draft and each draft has at
most one View across the Workbench; different Workspaces may have distinct
drafts and Views. Closing a View retains the draft, while discarding it is a
separate explicit action. The internal draft route is a client-local recovery
input, not an Awen Deep Link, and promotion replaces it with the canonical
Agent Session route.

We rejected treating a draft as a provisional Session because that would make
Session identity depend on unsent client state, and per-Tab copies because they
would let multiple Views race over one composer, attachment set, and promotion
operation. The single-draft rule keeps creation inside the same Workbench View
model without inventing a second work lifecycle.

## Consequences

- Draft state remains client-owned and must survive closing or reloading its
  View without appearing as a Session in the Sidebar or History.
- A draft is persisted under its owning Workspace identity. Existing drafts are
  migrated by matching their checkout path to a Workspace, falling back to the
  Project's main Workspace; when several drafts map to one Workspace, the most
  recently updated draft is exposed and the remaining payloads are retained
  without appearing as active drafts.
- The New Agent Session View has presentation actions such as open, focus,
  split, close view, and discard; it does not have Session lifecycle actions.
- Thread-only navigation and lifecycle actions do not return through this
  path. Pin, snooze, settle, or archive behavior requires an explicit Awen
  Session model decision if it is wanted again.
