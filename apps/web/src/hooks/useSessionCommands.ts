import { useCallback } from "react";
import { useAgentSessionLifecycle, type WillCloseRevert } from "./useAgentSessionLifecycle";
import { scopeThreadRef } from "@awen/client-runtime/environment";
import { squashAtomCommandFailure } from "@awen/client-runtime/state/runtime";
import { requestDestructiveConfirmation } from "../lib/destructiveConfirmation";
import { readThreadShell, useAwenAgentSessionShell } from "../state/entities";
import { useComposerDraftStore } from "../composerDraftStore";
import { terminalEnvironment } from "../state/terminal";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { runtimeTerminalIdForTarget } from "../workbench/sessionTarget";
import { type ViewTarget } from "../workbench/viewRegistry";
import { type SplitDir } from "../workbench/workbenchState";
import { useWorkbenchStore } from "../workbench/workbenchStore";

export type SessionTarget = Extract<ViewTarget, { kind: "agentSession" | "workspaceTerminal" }>;

function failureToast(title: string, error: unknown) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}

export type { WillCloseRevert } from "./useAgentSessionLifecycle";

export function useSessionCommands(
  target: SessionTarget,
  options?: {
    readonly onWillClose?: () => Promise<WillCloseRevert | void> | WillCloseRevert | void;
  },
) {
  const store = useWorkbenchStore();
  const stopThreadSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const closeAgent = useAgentSessionLifecycle();
  const deleteThread = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });

  const agentSession = useAwenAgentSessionShell(
    target.kind === "agentSession" ? target.environmentId : null,
    target.kind === "agentSession" ? target.agentSessionId : null,
  );

  const openSession = useCallback(() => {
    store.openTarget(target);
  }, [store, target]);

  // A Session View is unique across the Workbench (ADR-0010), so "Focus" and
  // "Open" are the same command: both activate the Tab that shows the Session.
  const focusSession = openSession;

  const splitSession = useCallback(
    (dir: SplitDir) => {
      store.splitFocused(target, dir);
    },
    [store, target],
  );

  const handleCloseSession = useCallback(async () => {
    if (target.kind === "agentSession") {
      const threadId = agentSession?.threadId;
      if (!threadId) {
        failureToast(
          "Failed to close agent session",
          new Error("Agent session thread is not loaded."),
        );
        return;
      }
      const closed = await closeAgent(scopeThreadRef(target.environmentId, threadId), {
        ...(options?.onWillClose ? { onWillClose: options.onWillClose } : {}),
      });
      if (!closed) return;
      store.removeSessionViews(target);
      toastManager.add({ type: "success", title: "Agent session closed" });
    } else {
      const terminalId = runtimeTerminalIdForTarget(target);
      if (!terminalId) {
        failureToast(
          "Failed to close terminal session",
          new Error("Terminal id could not be resolved."),
        );
        return;
      }
      let revert: WillCloseRevert | void = undefined;
      if (options?.onWillClose) {
        revert = await options.onWillClose();
      }
      const result = await closeTerminal({
        environmentId: target.environmentId,
        input: { workspaceId: target.workspaceId, terminalId, deleteHistory: false },
      });
      if (result._tag === "Failure") {
        revert?.();
        failureToast("Failed to close terminal session", squashAtomCommandFailure(result));
        return;
      }
      store.removeSessionViews(target);
      toastManager.add({ type: "success", title: "Terminal session closed" });
    }
  }, [agentSession?.threadId, closeAgent, closeTerminal, options, store, target]);

  const handleDeleteSession = useCallback(
    async (sessionTitle?: string) => {
      const title =
        sessionTitle ??
        (target.kind === "agentSession"
          ? (agentSession?.title ?? "Agent Session")
          : "Terminal Session");
      const confirmed = await requestDestructiveConfirmation({
        message: [
          `Delete session "${title}"?`,
          "This permanently clears all conversation and output history for this session.",
        ].join("\n"),
        onFailure: (error) => failureToast("Failed to confirm session deletion", error),
      });
      if (!confirmed) return;
      let revert: WillCloseRevert | void = undefined;
      if (options?.onWillClose) {
        revert = await options.onWillClose();
      }

      if (target.kind === "agentSession") {
        const threadId = agentSession?.threadId;
        if (!threadId) {
          revert?.();
          failureToast(
            "Failed to delete agent session",
            new Error("Agent session thread is not loaded."),
          );
          return;
        }
        const threadShell = readThreadShell(scopeThreadRef(target.environmentId, threadId));
        if (threadShell?.session && threadShell.session.status !== "stopped") {
          await stopThreadSession({
            environmentId: target.environmentId,
            input: { threadId },
          });
        }
        const deleteResult = await deleteThread({
          environmentId: target.environmentId,
          input: { threadId },
        });
        if (deleteResult._tag === "Failure") {
          revert?.();
          failureToast("Failed to delete agent session", squashAtomCommandFailure(deleteResult));
          return;
        }
        useComposerDraftStore
          .getState()
          .clearDraftThread(scopeThreadRef(target.environmentId, threadId));
        store.removeSessionViews(target);
        toastManager.add({ type: "success", title: "Agent session deleted" });
      } else {
        const terminalId = runtimeTerminalIdForTarget(target);
        if (!terminalId) {
          revert?.();
          failureToast(
            "Failed to delete terminal session",
            new Error("Terminal id could not be resolved."),
          );
          return;
        }
        const result = await closeTerminal({
          environmentId: target.environmentId,
          input: { workspaceId: target.workspaceId, terminalId, deleteHistory: true },
        });
        if (result._tag === "Failure") {
          revert?.();
          failureToast("Failed to delete terminal session", squashAtomCommandFailure(result));
          return;
        }
        store.removeSessionViews(target);
        toastManager.add({ type: "success", title: "Terminal session deleted" });
      }
    },
    [
      agentSession?.threadId,
      agentSession?.title,
      closeTerminal,
      deleteThread,
      options,
      stopThreadSession,
      store,
      target,
    ],
  );

  return {
    openSession,
    focusSession,
    splitSession,
    closeSession: handleCloseSession,
    deleteSession: handleDeleteSession,
  };
}
