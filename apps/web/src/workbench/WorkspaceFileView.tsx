import { lazy, Suspense, useEffect, useState } from "react";
import { useAwenWorkspace } from "../state/entities";
import { useEnvironment } from "../state/environments";
import type { ViewTarget } from "./viewRegistry";
import { Spinner } from "~/components/ui/spinner";
import { WifiOff } from "lucide-react";

const FilePreviewPanel = lazy(() => import("../components/files/FilePreviewPanel"));

export interface WorkspaceFileViewProps {
  readonly target: Extract<ViewTarget, { kind: "workspace" }>;
  readonly paneId: string;
  readonly focused: boolean;
  readonly focusRequestId?: number;
  readonly availableSize: { readonly width: number; readonly height: number };
}

export function WorkspaceFileView({
  target,
  paneId,
  focused: _focused,
  focusRequestId: _focusRequestId = 0,
  availableSize: _availableSize,
}: WorkspaceFileViewProps) {
  const workspace = useAwenWorkspace(target.environmentId, target.workspaceId);
  const environment = useEnvironment(target.environmentId);
  const [selectedPath, setSelectedPath] = useState<string | null>(
    "initialPath" in target && typeof target.initialPath === "string" ? target.initialPath : null,
  );
  const [revealLine, setRevealLine] = useState<number | null>(
    "revealLine" in target && typeof target.revealLine === "number" ? target.revealLine : null,
  );
  const [revealRequestId, setRevealRequestId] = useState(1);

  useEffect(() => {
    if ("initialPath" in target && typeof target.initialPath === "string") {
      setSelectedPath(target.initialPath);
      setRevealLine(
        "revealLine" in target && typeof target.revealLine === "number" ? target.revealLine : null,
      );
      setRevealRequestId((r) => r + 1);
    }
  }, [target]);

  if (workspace === null) {
    const isOffline = environment !== null && environment.connection.phase !== "connected";
    if (isOffline) {
      return (
        <div
          data-testid="workspace-file-offline-state"
          className="flex h-full min-h-0 flex-col items-center justify-center p-6 text-sm text-muted-foreground gap-2"
        >
          <WifiOff className="size-5 text-muted-foreground/60" />
          <span>
            {environment.label} is{" "}
            {environment.connection.phase === "reconnecting" ? "reconnecting" : "offline"}.
          </span>
          <span className="text-xs text-muted-foreground/60">
            Workspace views will reconnect automatically.
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
      data-testid="workspace-file-view"
    >
      <Suspense
        fallback={
          <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
            <Spinner className="size-5" />
          </div>
        }
      >
        <FilePreviewPanel
          environmentId={target.environmentId}
          cwd={workspace.workspaceRoot}
          projectName={workspace.title}
          relativePath={selectedPath}
          revealLine={revealLine}
          revealRequestId={revealRequestId}
          onOpenFile={(relativePath) => {
            setSelectedPath(relativePath);
            setRevealLine(null);
            setRevealRequestId((r) => r + 1);
          }}
          paneId={paneId}
          explicitSave
          workspaceMutationId={null}
        />
      </Suspense>
    </div>
  );
}
