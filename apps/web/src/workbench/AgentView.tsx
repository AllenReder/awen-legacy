import ChatView from "../components/ChatView";
import type { AwenAgentSessionShell } from "@awen/contracts";
import { useAwenAgentSessionShell } from "../state/entities";
import { useWorkspaceViewActions } from "./useWorkspaceViewActions";
import type { ViewTarget } from "./viewRegistry";

interface AgentViewProps {
  readonly target: Extract<ViewTarget, { kind: "agentSession" }>;
  readonly paneId: string;
  readonly focused: boolean;
  readonly focusRequestId?: number;
  readonly availableSize: { readonly width: number; readonly height: number };
}

/**
 * View definition rendering one Awen Agent Session inside a Pane.
 *
 * Adapter from the workbench's `View instance` to the existing `<ChatView>`
 * component (which already hosts the Awen timeline, composer, tool activity,
 * approvals and error surface). The View resolves the current Workspace from
 * the durable Session shell, so its navigation address remains stable.
 *
 * Closing this View (closing the Pane) tears down only ChatView's local
 * subscriptions; the Agent Session's transcript and execution state remain on
 * the daemon, so re-opening the same Session from the Sidebar reattaches to
 * the live Agent Session rather than creating a fresh one.
 */
export function AgentView({
  target,
  paneId,
  focused,
  focusRequestId = 0,
  availableSize,
}: AgentViewProps) {
  const session = useAwenAgentSessionShell(target.environmentId, target.agentSessionId);
  if (session === null) {
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-muted-foreground">
        Loading Agent Session…
      </div>
    );
  }

  return (
    <LoadedAgentView
      target={target}
      paneId={paneId}
      focused={focused}
      focusRequestId={focusRequestId}
      availableSize={availableSize}
      session={session}
    />
  );
}

function LoadedAgentView({
  target,
  paneId,
  focused,
  focusRequestId = 0,
  availableSize,
  session,
}: AgentViewProps & { readonly session: AwenAgentSessionShell }) {
  const { onBrowseFiles, onReviewChanges, onNewTerminalSession } = useWorkspaceViewActions({
    environmentId: target.environmentId,
    workspaceId: session.workspaceId,
    paneId,
  });

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      {session.status === "closed" && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-between border-b border-border bg-muted/40 px-3 py-1 text-xs text-muted-foreground"
        >
          <span>This Agent Session is closed and preserved in Workspace History.</span>
          <span className="opacity-70">Read-only</span>
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <ChatView
          environmentId={target.environmentId}
          threadId={session.threadId}
          routeKind="server"
          workbenchMode
          focused={focused}
          focusRequestId={focusRequestId}
          availableSize={availableSize}
          onBrowseFiles={onBrowseFiles}
          onReviewChanges={onReviewChanges}
          onNewTerminalSession={onNewTerminalSession}
        />
      </div>
    </div>
  );
}
