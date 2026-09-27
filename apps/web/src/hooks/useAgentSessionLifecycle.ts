import { useCallback } from "react";
import type { ScopedThreadRef } from "@awen/contracts";
import { scopedThreadKey } from "@awen/client-runtime/environment";
import { squashAtomCommandFailure } from "@awen/client-runtime/state/runtime";
import { readThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../components/ui/toast";

export type WillCloseRevert = () => void;
export interface AgentCloseOptions {
  readonly onWillClose?: () => Promise<WillCloseRevert | void> | WillCloseRevert | void;
}

const pendingClosures = new Map<string, Promise<boolean>>();

/** Explicit Archive stops an executing Agent and moves its Thread into History. */
export function useAgentSessionLifecycle() {
  const stop = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const archive = useAtomCommand(threadEnvironment.archive, { reportFailure: false });

  return useCallback(
    function closeAgent(ref: ScopedThreadRef, options: AgentCloseOptions): Promise<boolean> {
      const key = scopedThreadKey(ref);
      const pending = pendingClosures.get(key);
      if (pending) return pending;
      const run = async (): Promise<boolean> => {
        let revert: WillCloseRevert | void = undefined;
        try {
          const input = { environmentId: ref.environmentId, input: { threadId: ref.threadId } };
          const status = readThreadShell(ref)?.session?.status;
          if (status === "running" || status === "starting") {
            const result = await stop(input);
            if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          }
          revert = await options.onWillClose?.();
          const result = await archive(input);
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return true;
        } catch (error) {
          revert?.();
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to archive Agent Session",
              description: error instanceof Error ? error.message : String(error),
            }),
          );
          return false;
        }
      };
      const promise = run().finally(() => pendingClosures.delete(key));
      pendingClosures.set(key, promise);
      return promise;
    },
    [stop, archive],
  );
}
