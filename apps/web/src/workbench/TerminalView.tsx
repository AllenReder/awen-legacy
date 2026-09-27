import { TerminalViewport } from "../components/ThreadTerminalDrawer";
import { useAwenWorkspace } from "../state/entities";
import { useEnvironment } from "../state/environments";
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
 * Closing this View (closing the Pane) leaves the PTY running on the daemon —
 * the user can reopen the same Session from the Sidebar and reconnect to its
 * scrollback. Stop / terminate is a separate, explicit user action; see D3.
 */
export function TerminalView({
  target,
  focused,
  focusRequestId = 0,
  availableSize,
}: TerminalViewProps) {
  const workspace = useAwenWorkspace(target.environmentId, target.workspaceId);
  const terminalId = runtimeTerminalIdForTarget(target);
  const environment = useEnvironment(target.environmentId);
  if (workspace === null || terminalId === null) {
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
      workspaceId={target.workspaceId}
      terminalId={terminalId}
      terminalLabel="Terminal"
      cwd={workspace.workspaceRoot}
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
