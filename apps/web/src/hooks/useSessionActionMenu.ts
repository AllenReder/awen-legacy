import { useCallback } from "react";
import { settlePromise } from "@awen/client-runtime/state/runtime";
import { readLocalApi } from "../localApi";
import { findSessionViewPane, isSessionViewFocused } from "../workbench/workbenchState";
import { useWorkbenchStore } from "../workbench/workbenchStore";
import { sessionRouteForTarget } from "../workbench/deepLinks";
import {
  buildSessionActionMenuItems,
  type SessionActionMenuId,
  type SessionActionMenuState,
} from "../components/sidebar/sessionActionMenu.logic";
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

  const openMenu = useCallback(
    (position: { x: number; y: number }) => {
      void (async () => {
        const api = readLocalApi();
        if (!api) return;

        const isOpenInWorkbench = findSessionViewPane(store, target) !== null;
        const isFocusedInWorkbench = isSessionViewFocused(store, target);

        const state: SessionActionMenuState = {
          kind: target.kind === "agentSession" ? "agent" : "terminal",
          isClosed,
          isOpenInWorkbench,
          isFocusedInWorkbench,
          canRename: onStartRename !== undefined,
          canClose: true,
          canDelete: true,
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
    [commands, isClosed, navigateTo, onStartRename, sessionTitle, store, target],
  );

  return { openMenu, commands };
}

export default useSessionActionMenu;
