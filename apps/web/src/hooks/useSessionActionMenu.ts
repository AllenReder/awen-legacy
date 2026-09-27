import { useCallback } from "react";
import { isOrchestrationSessionExecuting } from "@awen/contracts";
import { scopeThreadRef } from "@awen/client-runtime/environment";
import { settlePromise, squashAtomCommandFailure } from "@awen/client-runtime/state/runtime";
import { readLocalApi } from "../localApi";
import { findSessionViewPane, isSessionViewFocused } from "../workbench/workbenchState";
import { useWorkbenchStore } from "../workbench/workbenchStore";
import { sessionRouteForTarget } from "../workbench/deepLinks";
import {
  buildSessionActionMenuItems,
  siblingWorkspacesForAgent,
  type SessionActionMenuId,
  type SessionActionMenuState,
} from "../components/sidebar/sessionActionMenu.logic";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { readThreadShell, useAwenAgentSessionShell, useAwenProjects } from "../state/entities";
import { sessionEnvironment } from "../state/projects";
import { useAtomCommand } from "../state/use-atom-command";
import { useSessionCommands, type SessionTarget, type WillCloseRevert } from "./useSessionCommands";

export function useSessionActionMenu(input: {
  readonly target: SessionTarget;
  readonly isClosed?: boolean | undefined;
  readonly sessionTitle?: string | undefined;
  readonly onStartRename?: (() => void) | undefined;
  readonly onWillClose?:
    | (() => Promise<WillCloseRevert | void> | WillCloseRevert | void)
    | undefined;
  readonly navigateTo?:
    | ((input: {
        readonly to: string;
        readonly params: Record<string, string>;
        readonly replace: boolean;
      }) => void)
    | undefined;
}) {
  const { target, isClosed = false, sessionTitle, onStartRename, onWillClose, navigateTo } = input;
  const store = useWorkbenchStore();
  const commands = useSessionCommands(target, onWillClose ? { onWillClose } : undefined);
  const awenProjects = useAwenProjects();
  const agentSession = useAwenAgentSessionShell(
    target.kind === "agentSession" ? target.environmentId : null,
    target.kind === "agentSession" ? target.agentSessionId : null,
  );
  const migrateToWorkspace = useAtomCommand(sessionEnvironment.migrateToWorkspace, {
    reportFailure: false,
  });

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const isOpenInWorkbench = findSessionViewPane(store, target) !== null;
        const isFocusedInWorkbench = isSessionViewFocused(store, target);
        const siblingWorkspaces =
          target.kind === "agentSession" && agentSession
            ? siblingWorkspacesForAgent(
                awenProjects,
                target.environmentId,
                agentSession.workspaceId,
              )
            : [];
        const threadShell =
          target.kind === "agentSession" && agentSession
            ? readThreadShell(scopeThreadRef(target.environmentId, agentSession.threadId))
            : null;
        const isExecuting = isOrchestrationSessionExecuting(threadShell?.session ?? null);

        const state: SessionActionMenuState = {
          kind: target.kind === "agentSession" ? "agent" : "terminal",
          isClosed,
          isOpenInWorkbench,
          isFocusedInWorkbench,
          canRename: onStartRename !== undefined,
          canClose: true,
          canDelete: true,
          canMigrate: siblingWorkspaces.length > 0,
          canMigrateNow: !isExecuting,
        };

        const items = buildSessionActionMenuItems(state);
        const clicked = await settlePromise(() => api.contextMenu.show(items, position));
        if (clicked._tag === "Failure" || clicked.value === null) return;

        const action: SessionActionMenuId = clicked.value;
        switch (action) {
          case "open":
            commands.openSession();
            navigateTo?.({ ...sessionRouteForTarget(target), replace: true });
            return;
          case "focus":
            commands.focusSession();
            navigateTo?.({ ...sessionRouteForTarget(target), replace: true });
            return;
          case "split:right":
            commands.splitSession("right");
            return;
          case "split:down":
            commands.splitSession("down");
            return;
          case "move-workspace": {
            if (target.kind !== "agentSession" || agentSession === undefined) return;
            const picked = await settlePromise(() =>
              api.contextMenu.show(
                siblingWorkspaces.map((workspace) => ({
                  id: workspace.id,
                  label: workspace.title,
                  icon: "folder",
                })),
                position,
              ),
            );
            if (picked._tag === "Failure" || picked.value === null) return;
            const result = await migrateToWorkspace({
              environmentId: target.environmentId,
              input: {
                agentSessionId: target.agentSessionId,
                targetWorkspaceId: picked.value,
              },
            });
            if (result._tag === "Failure") {
              const failure = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Failed to move Agent Session",
                  description: failure instanceof Error ? failure.message : "An error occurred.",
                }),
              );
              return;
            }
            toastManager.add({ type: "success", title: "Agent Session moved" });
            return;
          }
          case "rename":
            onStartRename?.();
            return;
          case "close-session":
            void commands.closeSession();
            return;
          case "delete-session":
            void commands.deleteSession(sessionTitle);
            return;
        }
      })();
    },
    [
      agentSession,
      awenProjects,
      commands,
      isClosed,
      migrateToWorkspace,
      navigateTo,
      onStartRename,
      sessionTitle,
      store,
      target,
    ],
  );

  return { openMenu, commands };
}

export default useSessionActionMenu;
