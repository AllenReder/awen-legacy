# Make Awen identity the canonical deep-link boundary

**Status: superseded by ADR-0026 for Agent Session links; Terminal links and Workbench ownership remain accepted**

Awen deep links identify an Environment-scoped Awen target, not a provider
Thread or a Workbench layout. The canonical Session routes are
`/{environmentId}/workspaces/{workspaceId}/agent-sessions/{agentSessionId}` and
`/{environmentId}/workspaces/{workspaceId}/terminal-sessions/{terminalSessionId}`.
Project is deliberately absent from Session links because a Workspace already
belongs to exactly one Project, and Environment is the connection scope that
makes the otherwise opaque IDs resolvable.

URLs are recoverable entry points, not the Workbench state authority. A deep
link may open or focus a View, but Tab, Pane, focus, layout, animation, and
filter state remain Workbench or View state. Browser history therefore does
not encode pane operations. Sidebar actions dispatch Workbench commands first
and may replace the URL with a canonical target route after the command.

Agent and Terminal Session identities use separate path segments and cannot be
interchanged. Future Workspace and Application Views can add separate route
families (for example `.../views/{definitionId}` and `/views/{definitionId}`)
without changing Session links. Application Views target application-level
content such as pull requests or issues and do not borrow Workspace or Session
identity.

Legacy `/{environmentId}/{threadId}` links remain compatibility inputs only.
The adapter resolves a Thread to its Awen Agent Session after projection data
hydrates and redirects once to the canonical route. `ThreadId` is not known to
the Workbench, Sidebar, or `ViewTarget`. Closed Sessions resolve to their
read-only history presentation; deleted or nonexistent targets resolve to a
missing state without changing existing layout. This is a temporary v1
migration boundary, not a permanent public API; removing it is a breaking
change after callers have migrated.
