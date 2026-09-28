import type { EnvironmentId, WorkspaceId } from "@awen/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@awen/client-runtime/state/runtime";
import { useCallback } from "react";

import { createTerminalId } from "../lib/terminalIds";
import { toastManager } from "../components/ui/toast";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { terminalTargetForRuntime } from "./sessionTarget";
import type { ViewTarget } from "./viewRegistry";
import { useWorkbenchStore } from "./workbenchStore";

export interface WorkspaceViewActionsInput {
  readonly environmentId: EnvironmentId;
  readonly workspaceId: WorkspaceId;
  readonly paneId: string;
}

export function useWorkspaceViewActions({
  environmentId,
  workspaceId,
  paneId,
}: WorkspaceViewActionsInput) {
  const openTerminal = useAtomCommand(terminalEnvironment.open);

  const onBrowseFiles = useCallback(() => {
    const fileTarget: ViewTarget = {
      kind: "workspace",
      definitionId: "fileView",
      environmentId,
      workspaceId,
    };
    useWorkbenchStore.getState().openFromPane(paneId, fileTarget);
  }, [environmentId, paneId, workspaceId]);

  const onReviewChanges = useCallback(() => {
    const gitTarget: ViewTarget = {
      kind: "workspace",
      definitionId: "gitView",
      environmentId,
      workspaceId,
    };
    useWorkbenchStore.getState().openFromPane(paneId, gitTarget);
  }, [environmentId, paneId, workspaceId]);

  const onNewTerminalSession = useCallback(() => {
    const terminalId = createTerminalId();
    void openTerminal({
      environmentId,
      input: { workspaceId, terminalId },
    }).then((result) => {
      if (result._tag === "Failure") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Unable to create terminal",
            description: failure instanceof Error ? failure.message : "An error occurred.",
          });
        }
        return;
      }
      const terminalTarget = terminalTargetForRuntime({
        environmentId,
        workspaceId,
        terminalId,
      });
      useWorkbenchStore.getState().openFromPane(paneId, terminalTarget);
    });
  }, [environmentId, openTerminal, paneId, workspaceId]);

  const onOpenFile = useCallback(
    (initialPath: string) => {
      useWorkbenchStore.getState().openFromPane(paneId, {
        kind: "workspace",
        definitionId: "fileEditor",
        environmentId,
        workspaceId,
        initialPath,
      });
    },
    [environmentId, workspaceId, paneId],
  );

  return { onBrowseFiles, onReviewChanges, onNewTerminalSession, onOpenFile };
}
