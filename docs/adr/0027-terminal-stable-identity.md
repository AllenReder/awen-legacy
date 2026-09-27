# Give a Terminal Session a stable, Workspace-independent identity

**Status: accepted (supersedes the Terminal link and Terminal identity scope in ADR-0003 and ADR-0026)**

A Terminal Session is identified by one stable, client-chosen `terminalId`
within its Environment. That id is the lookup key for the PTY, the persisted
history and Session index, event subscriptions, Pane reuse, and the deep link.
It survives PTY restarts, client disconnect and window closure, and Workspace
reassignment.

A Workspace is a nullable, mutable assignment on a Terminal Session. A selected
Workspace supplies the launch directory when a terminal is created, but it is
not part of the identity: changing the assignment never re-keys the PTY or
invalidates its event stream, and the Pane/attach path never restarts the
process because of it. An explicit `open` restarts only when its launch context
(`cwd`, worktree, or env) changes. Unregistering a Workspace preserves any
terminal still running under it.

The canonical Terminal link is `/{environmentId}/terminal-sessions/{terminalSessionId}`.
The former Workspace-scoped Terminal link
(`/{environmentId}/workspaces/{workspaceId}/terminal-sessions/{terminalSessionId}`)
is removed during the alpha contract reset. An unassigned terminal is resolved
from the Environment's terminal metadata rather than from the Workspace tree.
