import type { FileEditorDraft } from "../components/files/FilePreviewPanel";
import { lazy, Suspense } from "react";
import { useAwenWorkspace } from "../state/entities";
import { useEnvironment } from "../state/environments";
import { useWorkspaceViewActions } from "./useWorkspaceViewActions";
import { getPanePresentation } from "./workbenchState";
import { useWorkbenchStore } from "./workbenchStore";
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
  const { onOpenFile } = useWorkspaceViewActions({
    environmentId: target.environmentId,
    workspaceId: target.workspaceId,
    paneId,
  });
  const presentation = useWorkbenchStore((state) => getPanePresentation(state, paneId));
  const selectedPath = target.initialPath ?? null;
  const revealLine =
    typeof presentation?.revealLine === "number"
      ? presentation.revealLine
      : (target.revealLine ?? null);

  const savedDraft = presentation?.fileDraft;
  const initialDraft: FileEditorDraft | undefined =
    savedDraft &&
    typeof savedDraft === "object" &&
    "path" in savedDraft &&
    typeof savedDraft.path === "string" &&
    "contents" in savedDraft &&
    typeof savedDraft.contents === "string" &&
    (!("contentHash" in savedDraft) ||
      savedDraft.contentHash === undefined ||
      typeof savedDraft.contentHash === "string")
      ? {
          path: savedDraft.path,
          contents: savedDraft.contents,
          contentHash:
            "contentHash" in savedDraft
              ? (savedDraft.contentHash as string | undefined)
              : undefined,
        }
      : undefined;

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
          revealRequestId={_focusRequestId}
          onOpenFile={onOpenFile}
          initialDraft={initialDraft}
          onDraftChange={(fileDraft) =>
            useWorkbenchStore.getState().setPanePresentation(paneId, { fileDraft })
          }
          navigationOpensPane
          paneId={paneId}
          explicitSave
          workspaceMutationId={null}
        />
      </Suspense>
    </div>
  );
}
