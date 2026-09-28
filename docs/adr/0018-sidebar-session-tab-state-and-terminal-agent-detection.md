# Sidebar Session Row Tab State, Workspace Branch Projection, and Terminal Agent Detection

Awen reads the checkout's live Git status to display `[Branch] [WorkspaceDir]` in the Sidebar. Session rows visually reflect four Session Row Tab States with right-edge indicators, reserve a fixed 14px Status Gutter for notification alignment, display agent provider icons, and dynamically switch terminal icons via zero-config foreground process detection rather than mandatory agent hooks.

## Status

Accepted. Session-row status derivation and alert dismissal are superseded by
[ADR-0020](./0020-unified-session-status-and-unread-completion.md); the Status
Gutter, the four Session Row Tab States, and terminal agent detection here stand.

## Context

The previous Sidebar header displayed `{workspace.title}` on the left and a `{workspace.role}` (`MAIN` / `WORKTREE`) badge on the right, which caused ambiguity between project name and checkout branch. In addition, Session rows only distinguished between active-tab focused and unfocused, leaving background-tab sessions indistinguishable from unopened sessions. Agent sessions lacked provider branding, and terminal sessions running agent CLIs (e.g. `opencode`, `claude`, `codex`, `cursor`) appeared as generic terminals.

Reference project `paseo` detects terminal agent states by requiring per-agent hooks and a dedicated CLI reporting channel. While hooks allow deep internal state queries (e.g. waiting for user input), they require manual per-agent setup and external configuration.

## Decision

1. **Workspace Header Layout and Projection**:
   - The Sidebar subscribes to Git status for each Workspace root, using the same VCS status source as the Agent Session composer. Workspace metadata is not authoritative for the checked-out branch. An unresolved status must not be displayed as `main` or as the Workspace title.
   - The Workspace header displays the active branch name on the left (truncated with ellipsis if long) and the Workspace directory name on the right (`shrink-0` with muted styling). The previous `MAIN`/`WORKTREE` badge is removed.

2. **Four Session Row Tab States**:
   - `active-focused`: Active tab focused pane. Rendered with `bg-sidebar-row-active` and bold text (`font-bold`).
   - `active-unfocused`: Present in active tab but not focused. Rendered with transparent background, normal text, and a 2px vertical indicator bar (`bg-primary/80`, 14px height) at the right edge.
   - `background-tab`: Open in a non-active tab. Rendered with transparent background, secondary text, and a 2px dot (`bg-muted-foreground/70`) at the right edge.
   - `unopened`: Not open in any tab. Rendered with muted text and no trailing indicators.

3. **Status Gutter and Icon Alignment**:
   - A fixed 14px Status Gutter precedes every Session row to house status indicators (waiting for user action, error, background running, or unread completion) without causing horizontal layout shifts in provider icons.

4. **Zero-Config Terminal Agent Detection**:
   - Rather than requiring users to configure agent hooks in external tools, Awen leverages the server daemon's existing foreground child-process monitoring (`childCommandLabel`).
   - When a known agent CLI (`opencode`, `claude`, `codex`, `cursor`) runs as the foreground command, the terminal row dynamically displays that agent's provider icon, reverting to `TerminalIcon` as soon as the process exits. Deep hook integration is retained as a future optional extension.

## Consequences

- Sidebar navigation gives immediate visual clarity on branch context, workspace directory, and open tabs without extra clicks or navigation modals.
- All session rows remain strictly aligned vertically regardless of active alert states.
- Terminal sessions running agent CLIs feel first-class out of the box with zero user configuration.
