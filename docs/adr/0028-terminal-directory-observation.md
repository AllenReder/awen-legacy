# Follow the shell's real directory for Terminal assignment

**Status: accepted (extends ADR-0027; foreground-Agent precedence is #167)**

A Terminal Session follows the working directory its shell is actually in. The
daemon observes that directory from the owning process rather than from
terminal output, maps it to a Workspace this Environment already knows, and
updates the Session's Sidebar assignment. The launch context, PTY, history,
event stream, Session identity, and Pane stay untouched; only the assignment is
reprojected.

## Observation, not inference

`TerminalDirectoryObserver` is the explicit capability seam
(`apps/server/src/terminal/DirectoryObservation.ts`). It reports `known` only
when the OS can name a process's current directory:

| Platform              | Mechanism                 | Result                         |
| --------------------- | ------------------------- | ------------------------------ |
| Linux                 | `/proc/<pid>/cwd`         | supported                      |
| macOS                 | `lsof -a -p <pid> -d cwd` | supported                      |
| other (incl. Windows) | none                      | `unknown`, assignment retained |

`unknown` is not "outside every Workspace": it means the daemon cannot tell.
Unknown retains the last confirmed assignment and never moves the terminal to
the unassigned group. A path that resolves outside every registered Workspace
is a _known_ unregistered directory and becomes unassigned.

PTY activity wakes a coalesced OS query (50ms on Linux, 250ms for macOS lsof).
A separate 1s fallback clock covers silent shells and registry changes. One
serialized worker handles both triggers; output bursts do not queue one probe
per chunk. Output text, arbitrary descendants, tmux panes, and nested SSH are
not authority for assignment. Unregistration releases assignments under the
same observation lock so an old registry snapshot cannot restore a removed ID.

## Assignment rules

- The nearest registered ancestor Workspace wins. A subdirectory of a checkout
  keeps that checkout's assignment; a registered sibling Workspace takes over
  when the shell enters it.
- Matching is limited to Workspaces already registered in this Environment, so a
  `cd` may assign across Projects but never creates a Project or Workspace.
- Unregistering a Workspace clears the assignment of any Session still pointing
  at it; the terminal keeps running and becomes unassigned.

## Directory occupancy and deletion

Sidebar assignment is a projection, not an occupancy check. Destructive
Workspace deletion asks `TerminalManager.getDirectoryOccupancy()` for live
evidence: refreshed shell cwd, last confirmed assignment, launch directory, and
fresh cwd observations for its live descendants. Descendant discovery reuses the
runtime process-table inspector and does not change Sidebar assignment.
A running Session blocks deletion when:

- a live descendant's directory is inside the Workspace, or
- the process table, shell cwd, or a live descendant's cwd is unavailable (the daemon cannot
  prove deletion safe, so destructive deletion is refused until inspection
  succeeds or the work stops), or
- its observed shell directory is inside the Workspace, or
- its last confirmed assignment is that Workspace (the conservative stand-in
  when observation is unavailable), or
- it has no confirmed directory for the current PTY and was launched inside the
  Workspace without a confirmed assignment elsewhere.

This is release-aware: once a Session and its relevant descendants exit, or
fresh observation confirms they left, the Workspace becomes deletable again.
Child observations are read for each deletion check, not retained as history.
Observation and deletion are not an atomic OS transaction: processes can still
move after a check. Historical assignments are not permanent
locks. Removing a Workspace registration stays separate from deleting its
directory: unregistration is allowed while a terminal runs there and releases
its assignment; only destructive deletion requires the occupancy check.
