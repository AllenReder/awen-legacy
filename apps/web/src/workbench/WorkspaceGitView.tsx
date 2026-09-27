import { lazy, Suspense } from "react";
import { useAwenWorkspace } from "../state/entities";
import { useEnvironment } from "../state/environments";
import type { ViewTarget } from "./viewRegistry";
import { Spinner } from "~/components/ui/spinner";
import { WifiOff } from "lucide-react";

const DiffPanel = lazy(() => import("../components/DiffPanel"));

export interface WorkspaceGitViewProps {
  readonly target: Extract<ViewTarget, { kind: "workspace" }>;
  readonly paneId: string;
  readonly focused: boolean;
  readonly focusRequestId?: number;
  readonly availableSize: { readonly width: number; readonly height: number };
}

export function WorkspaceGitView({
  target,
  paneId: _paneId,
  focused: _focused,
  focusRequestId: _focusRequestId = 0,
  availableSize: _availableSize,
}: WorkspaceGitViewProps) {
  const workspace = useAwenWorkspace(target.environmentId, target.workspaceId);
  const environment = useEnvironment(target.environmentId);

  if (workspace === null) {
    const isOffline = environment !== null && environment.connection.phase !== "connected";
    if (isOffline) {
      return (
        <div
          data-testid="workspace-git-offline-state"
          className="flex h-full min-h-0 flex-col items-center justify-center p-6 text-sm text-muted-foreground gap-2"
        >
          <WifiOff className="size-5 text-muted-foreground/60" />
          <span>
            {environment.label} is{" "}
            {environment.connection.phase === "reconnecting" ? "reconnecting" : "offline"}.
          </span>
          <span className="text-xs text-muted-foreground/60">
            Git view will reconnect automatically.
          </span>
        </div>
      );
    }
    return (
      <div className="flex h-full min-h-0 items-center justify-center p-6 text-sm text-muted-foreground">
        Workspace is no longer available.
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-h-0 flex-1 overflow-hidden"
      data-testid="workspace-git-view"
    >
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        }
      >
        <DiffPanel
          mode="embedded"
          workspaceScope={{
            environmentId: target.environmentId,
            workspaceId: target.workspaceId,
            cwd: workspace.workspaceRoot,
          }}
          initialGitScope="unstaged"
          workspaceMutationId={null}
        />
      </Suspense>
    </div>
  );
}
