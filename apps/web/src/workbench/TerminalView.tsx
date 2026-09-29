import { TerminalViewport } from "../components/ThreadTerminalDrawer";
import { useAwenWorkspace } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useTerminalSessionSummary } from "../state/terminalSessions";
import { runtimeTerminalIdForTarget } from "./sessionTarget";
import type { ViewTarget } from "./viewRegistry";
import { WifiOff } from "lucide-react";

interface TerminalViewProps {
  readonly target: Extract<ViewTarget, { kind: "workspaceTerminal" }>;
  readonly paneId: string;
  readonly focused: boolean;
  readonly focusRequestId?: number;
  readonly availableSize: { readonly width: number; readonly height: number };
}

/**
 * View definition rendering one Awen Workspace-owned Terminal Session inside
 * a Pane.
 *
 * Reuses the existing `<TerminalViewport>` (the xterm.js-backed emulator that
 * already handles ANSI, alternate-screen, resize, and selection). The View
 * passes the Workspace's cwd and the pane's focus flag through without
 * re-implementing the emulator.
 *
 * The pane carries the Awen Terminal Session identity; the runtime PTY id the
 * emulator attaches to is resolved at this adapter boundary, so no other
 * Workbench code has to know it.
 *
 * An explicit Pane or Tab close terminates and deletes the daemon PTY through
 * the Workbench close adapter. Unmounting this View during navigation or
 * window shutdown only detaches its emulator.
 */
export function TerminalView({
  target,
  focused,
  focusRequestId = 0,
  availableSize,
}: TerminalViewProps) {
  const workspaceId = target.workspaceId ?? null;
  const workspace = useAwenWorkspace(target.environmentId, workspaceId);
  const terminalId = runtimeTerminalIdForTarget(target);
  const summary = useTerminalSessionSummary({
    environmentId: target.environmentId,
    terminalId,
  });
  // Launch context comes from the current assignment when present, otherwise
  // from the durable terminal metadata, so an unassigned or moved terminal
  // still reconnects to its PTY.
  const cwd = workspace?.workspaceRoot ?? summary?.cwd ?? null;
  const environment = useEnvironment(target.environmentId);
  if (cwd === null) {
    const isOffline = environment !== null && environment.connection.phase !== "connected";
    if (isOffline) {
      return (
        <div
          data-testid="workspace-terminal-offline-state"
          className="flex h-full min-h-0 flex-col items-center justify-center p-6 text-sm text-muted-foreground gap-2"
        >
          <WifiOff className="size-5 text-muted-foreground/60" />
          <span>
            {environment.label} is{" "}
            {environment.connection.phase === "reconnecting" ? "reconnecting" : "offline"}.
          </span>
          <span className="text-xs text-muted-foreground/60">
            Terminal session will reconnect automatically.
          </span>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-muted-foreground">
        Terminal Session is no longer available.
      </div>
    );
  }

  return (
    <TerminalViewport
      topFade
      advancedTypography={false}
      environmentId={target.environmentId}
      {...(workspaceId !== null ? { workspaceId } : {})}
      terminalId={terminalId}
      terminalLabel={summary?.title ?? summary?.label ?? "Terminal"}
      cwd={cwd}
      {...(summary?.worktreePath !== undefined ? { worktreePath: summary.worktreePath } : {})}
      onSessionExited={() => undefined}
      focusRequestId={focusRequestId}
      autoFocus={focused}
      focused={focused}
      availableSize={availableSize}
      visible
      resizeEpoch={0}
      drawerHeight={0}
      keybindings={[]}
    />
  );
}
