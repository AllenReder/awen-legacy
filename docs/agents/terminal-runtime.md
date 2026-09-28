# Terminal runtime boundary

Issue #5 keeps the donor terminal chain intact: the server owns the real PTY
and bounded history, the typed WebSocket contracts expose lifecycle operations,
and the web client renders the stream with xterm.js (`@xterm/xterm`).

Issue #165 gives every terminal one stable, Environment-scoped identity: the
client-chosen `terminalId`. It is the lookup, persistence, subscription, and
deep-link key, and it survives PTY restarts, reconnect, and Workspace
reassignment. `term-1` is only the conventional first id. The old
`(threadId, terminalId)` owner shape and the `(workspaceId, terminalId)` pair
are no longer identity: a `workspaceId` may accompany a request as the
terminal's current assignment (used only to resolve a launch directory), but it
is never the key and may be absent.

## Public operations

`TerminalManager` is the server-side public seam used by the WebSocket handlers.
The matching contracts are in `packages/contracts/src/terminal.ts` and
`packages/contracts/src/rpc.ts`.

- `open` starts a terminal lazily or returns the existing session for the same
  stable `terminalId`. When a `workspaceId` is supplied, the daemon resolves
  `cwd` from the persisted Workspace and callers cannot redirect it; otherwise
  the caller's `cwd` is used. A PTY startup failure is represented by an
  `error` snapshot and event; the event message includes the shells that were
  attempted.
- `attach` attaches an existing Workspace session and streams an initial
  snapshot followed by live output, exit, error, clear, restart, and activity
  events. It creates a missing terminal only when a launch `cwd` or Workspace
  assignment is supplied. Detaching removes only the client listener; it does
  not kill the PTY.
- `write` sends input bytes to the running PTY. `resize` forwards settled
  columns and rows to the PTY. The shell can observe the new size through
  `stty`/its native console API.
- `rename` sets a persistent user-owned title for an existing session.
  Terminal sessions also follow OSC 0/1/2 title updates emitted by the PTY
  until the user renames them; a manual title takes precedence thereafter.
- `clear` clears retained history, `restart` replaces the PTY in place, and
  `close` explicitly releases the session and optionally deletes its history.

The server retains up to 5,000 lines and 8 MiB per terminal. The client keeps a
separate bounded output buffer and replays the snapshot into the renderer with
replies suppressed, so restored history never answers a query against the live
shell.

## Renderer and resize behavior

`ThreadTerminalDrawer` attaches through `useAttachedTerminalSession` and sends
input and resize through `terminalEnvironment`. `XtermTerminalSurface` owns the
screen, ANSI state, cursor, selection, alternate screen, and terminal replies;
React does not interpret terminal frames.

Hidden drawers remain mounted so their PTY can continue running. The drawer
suppresses its fit/resize effects while hidden, so a hidden view does not
continuously send meaningless resize RPCs. Re-showing the drawer fits once and
reports the settled grid.

### Who answers terminal protocol queries

The renderer answers them, because it is the only component holding the state
they describe. Its replies reach the PTY through `onData`, the same path as
typed input:

- OSC 10/11/12 (foreground/background/cursor) come back with the colors the
  surface was told to paint, so the answer is right in both light and dark
  themes. While this went unanswered, Claude Code fell back to an inherited
  `COLORFGBG`, chose the light theme, and painted black text onto a dark pane.
- DSR 5/6 and DA1 come back with this screen's status, cursor position, and
  device attributes.

The daemon deliberately answers none of these. It runs no emulator, so it could
only invent a cursor position, and it cannot know which theme the client is
painting. Paseo answers them in its daemon because that daemon hosts a headless
xterm; Awen's daemon does not.

`createTerminalSpawnEnv` therefore drops an inherited `COLORFGBG` rather than
guessing an appearance, and declares the PTY it actually provides:
`TERM=xterm-256color`, `TERM_PROGRAM=awen`, `COLORTERM=truecolor`. An explicit
per-session `env` from the client still overrides those defaults.

## Workspace assignment and reconnect

The Awen path keeps PTY state in the single `TerminalManager`, keyed by the
stable `terminalId`. The terminal summary exposes `kind: "terminal"`, an
optional `workspaceId` assignment, and a monotonically increasing
`generation`. The daemon persists the Session index beside terminal history.
On daemon restart, a former live generation is reported as `exited`; reopening
starts a new generation rather than pretending the old shell was recovered.
Closing a client connection or the desktop window does not close the PTY;
reopening the same `terminalId` reconnects to the same running instance.
Moving or hiding a Pane never restarts it. Unregistering a Workspace does not
close or replace a terminal still assigned to it.

Session identity remains the stable `terminalId`; title changes never alter it.
Workspace-created terminals receive creation-order defaults within their
Workspace (`Terminal 1`, `Terminal 2`, ...). A terminal-provided title is
persisted and restored until the next PTY publishes a title. A manually
renamed title takes precedence and is equally durable across that boundary.

Closing a View, Pane, or Tab remains distinct from calling `close`; `close` is
reserved for explicit terminal termination. The Sidebar can create a terminal
directly under a Workspace, including when it has no Agent Sessions.

## Following the shell directory

A running terminal follows the shell's real working directory (ADR-0028). The
daemon observes the process cwd through `TerminalDirectoryObserver` and updates
only the mutable `workspaceId` assignment; it never changes launch context,
restarts the PTY, or alters Session/Pane identity. Observation failures are
reported as `unknown` and retain the last confirmed assignment.

The supported observation matrix lives in
`apps/server/src/terminal/DirectoryObservation.ts`:

| Platform              | Mechanism                 | Behavior                                     |
| --------------------- | ------------------------- | -------------------------------------------- |
| Linux                 | `/proc/<pid>/cwd`         | supported; a removed cwd reports unavailable |
| macOS                 | `lsof -a -p <pid> -d cwd` | supported under the same user                |
| other (incl. Windows) | none                      | assignment retained; no directory following  |

`resolveWorkspaceAssignmentForDirectory` maps an observed path to the nearest
registered Workspace root. A subdirectory keeps the checkout's assignment, a
registered sibling Workspace takes over, and a known path outside every
registered Workspace becomes unassigned without registering anything. The
Sidebar shows unassigned terminals in their Environment's group.

## Directory occupancy versus assignment

`TerminalManager.getDirectoryOccupancy()` is the separate destructive-deletion
check. `AwenWorkspaceService.remove` uses it instead of trusting the Sidebar: a
running Session blocks deleting a directory when its observed directory is
inside it, when its last confirmed assignment still points at it, or — with no
confirmed directory yet — when it was launched inside it without a confirmed
assignment elsewhere. Exited Sessions and confirmed departures release the
directory. Unregistering a Workspace (`deleteDirectory: false`) is a different
operation and is allowed while a terminal runs there; the terminal is released
to the unassigned group.

## Validation

The real-PTY validation entry point is:

```bash
pnpm smoke:terminal
```

It uses the live `node-pty` adapter and the current host shell, then checks
ANSI color, cursor/alternate-screen control sequences, Chinese output, PTY
resize visibility, shell exit code, detach/attach history reuse, same-PTY
reconnect identity, and invalid cwd errors. It prints the host OS and shell so
the evidence is tied to the machine that ran it.

The smoke addresses one stable `terminalId` and asserts that detaching and
reattaching reuses the same PTY pid and retained history. That id is disposable
server-seam input, not an ownership model. The product path is checked
separately through the visible Web client:
`TerminalViewport` → `useAttachedTerminalSession` → `terminalEnvironment` →
typed WebSocket contracts → `TerminalManager`.

Related regression commands:

```bash
pnpm --filter awen exec vp test run src/terminal/Manager.test.ts src/terminal/NodePtyAdapter.test.ts src/terminal/OutputProtocol.test.ts
pnpm --filter @awen/client-runtime exec vp test run src/state/terminalSession.test.ts
pnpm --filter @awen/web exec vp test run --project unit src/terminal/xterm/surface.test.ts
pnpm smoke:desktop-terminal
```

The smoke is intentionally separate from the fake-PTY unit tests: a passing
string replay cannot substitute for a real shell and native PTY. The desktop
smoke is the opposite kind of check: it drives the shipped renderer in a real
browser, because "the surface answers a color query" is a DOM behaviour that no
node-side test can observe.

## Recorded evidence

Observed on 2026-09-18 in this checkout:

- `pnpm smoke:terminal` passed on `darwin` using `/bin/zsh`; it reported a real
  PTY, resize `100x32`, shell exit `7`, ANSI/Unicode output, an interactive
  alternate-screen child that accepted input and restored the screen, live
  output after restore, detach/attach history reuse, and invalid cwd errors.
- The local v1 client was opened with `pnpm dev` on checkout
  `codex/implement-5`. The terminal drawer accepted `printf` input, rendered
  `AWEN_UI` and `AWEN_UI_RED 中文`, and restored both lines after the drawer
  was hidden and shown again. This exercised the typed client path named above;
  no agent turn was sent during this check.
- `pnpm smoke:desktop-terminal` failed on Chromium when the renderer's protocol
  replies were suppressed and passed once they were restored, so the check is
  load-bearing rather than decorative. It also fails if a replayed snapshot
  answers a query.
- The structured startup-failure case is covered by
  `reports every attempted shell when terminal startup cannot succeed` in
  `apps/server/src/terminal/Manager.test.ts`.
- Full regression finished with 330 server test files (4,785 passed, 10
  skipped) and 388 web test files (5,022 passed); the other workspace package
  suites also passed. The repository's existing Effect suggestions and local
  storage/SQLite runtime warnings remained non-fatal.
