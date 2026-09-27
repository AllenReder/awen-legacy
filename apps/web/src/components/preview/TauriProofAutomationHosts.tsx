"use client";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@awen/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  type EnvironmentId,
  type PreviewAutomationHost,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
} from "@awen/contracts";
import { invoke } from "@tauri-apps/api/core";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import { isTauri } from "~/env";
import { ensureLocalApi } from "~/localApi";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { createPreviewAutomationClientId } from "./previewAutomationClientId";
import { PreviewAutomationTargetUnavailableError } from "./previewAutomationErrors";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";

type NativeSlot = "a" | "b";
interface NativePage {
  readonly tabId: Exclude<PreviewAutomationRequest["tabId"], undefined>;
  readonly threadId: PreviewAutomationRequest["threadId"];
  readonly slot: NativeSlot;
}

const SUPPORTED_PROOF_OPERATIONS = ["status", "open", "navigate", "evaluate"] as const;

/**
 * An intentionally narrow, debug-only host that proves the real Agent MCP →
 * daemon broker → Tauri guest round trip. It does not advertise the remaining
 * preview operations until their native behavior has been demonstrated.
 */
export function TauriProofAutomationHosts() {
  const { environments } = useEnvironments();
  if (!isTauri || import.meta.env.VITE_BROWSER_HOST_PROOF_AGENT !== "1") return null;
  return environments.map((environment) => (
    <TauriProofAutomationHost
      key={environment.environmentId}
      environmentId={environment.environmentId}
    />
  ));
}

function TauriProofAutomationHost({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const pages = useRef(new Map<string, NativePage>());
  const closingPages = useRef(new Set<string>());
  const currentByThread = useRef(new Map<string, string>());
  const [openPages, setOpenPages] = useState<ReadonlyArray<NativePage>>([]);
  const [closeResult, setCloseResult] = useState("");
  const [clientId] = useState(createPreviewAutomationClientId);
  const [connectionAtom] = useState(() => Atom.make<string | null>(null));
  const connectionId = useAtomValue(connectionAtom);
  const initialHost = useMemo<PreviewAutomationHost>(
    () => ({
      clientId,
      environmentId,
      supportedOperations: [...SUPPORTED_PROOF_OPERATIONS],
    }),
    [clientId, environmentId],
  );
  const requestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: initialHost,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const navigatePreview = useAtomCommand(previewEnvironment.navigate, { reportFailure: false });
  const closePreview = useAtomCommand(previewEnvironment.close, { reportFailure: false });
  const respond = useAtomCommand(previewEnvironment.respondToAutomation, { reportFailure: false });
  const focusHost = useAtomCommand(previewEnvironment.focusAutomationHost, {
    reportFailure: false,
  });

  const findPage = useCallback((request: PreviewAutomationRequest): NativePage | null => {
    const tabId = request.tabId ?? currentByThread.current.get(request.threadId);
    const page = tabId ? pages.current.get(tabId) : undefined;
    return page?.threadId === request.threadId ? page : null;
  }, []);

  const readStatus = useCallback(
    async (page: NativePage | null): Promise<PreviewAutomationStatus> => {
      if (!page) {
        return {
          available: true,
          visible: false,
          tabId: null,
          url: null,
          title: null,
          loading: false,
        };
      }
      const state = await invoke<{
        url: string;
        title: string;
        loading: boolean;
        width: number;
        height: number;
      }>("evaluate", {
        tab: page.slot,
        script:
          "({ url: location.href, title: document.title, loading: document.readyState !== 'complete', width: innerWidth, height: innerHeight })",
      });
      return {
        available: true,
        visible: true,
        tabId: page.tabId,
        url: state.url,
        title: state.title,
        loading: state.loading,
        ...(state.width > 0 && state.height > 0
          ? { viewport: { width: state.width, height: state.height } }
          : {}),
        viewportSetting: FILL_PREVIEW_VIEWPORT,
      };
    },
    [],
  );

  const waitForPage = useCallback(
    async (page: NativePage, expectedUrl: string | undefined, timeoutMs: number) => {
      const deadline = Date.now() + Math.min(timeoutMs, 15_000);
      while (Date.now() < deadline) {
        try {
          const status = await readStatus(page);
          if (!status.loading && (!expectedUrl || status.url === expectedUrl)) return status;
        } catch {
          // A new guest can reject evaluation until its document is ready.
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 100));
      }
      throw new Error(`Native proof page ${page.tabId} did not load before the deadline`);
    },
    [readStatus],
  );

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      const existing = findPage(request);
      const unavailableTarget = () =>
        new PreviewAutomationTargetUnavailableError({
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: request.threadId,
          tabId: request.tabId ?? null,
          bridgeAvailable: true,
        });
      switch (request.operation) {
        case "status":
          if (request.tabId && !existing) {
            throw unavailableTarget();
          }
          return readStatus(existing);
        case "open": {
          const input = request.input as PreviewAutomationOpenInput;
          // The broker may attach its last tab as an implicit target even after
          // that page was explicitly closed. Only an Agent-specified tabId
          // requires the old resource to still exist; otherwise open a new one.
          if (request.tabIdExplicit && request.tabId && !existing) {
            throw unavailableTarget();
          }
          const reused = input.reuseExistingTab !== false ? existing : null;
          const resolvedUrl = input.url
            ? resolveBrowserNavigationTarget(environmentId, { kind: "url", url: input.url })
                .resolvedUrl
            : undefined;
          if (reused) {
            if (resolvedUrl) {
              await invoke("navigate", { tab: reused.slot, url: resolvedUrl });
              const result = await navigatePreview({
                environmentId,
                input: { threadId: request.threadId, tabId: reused.tabId, url: resolvedUrl },
              });
              if (result._tag === "Failure") throw squashAtomCommandFailure(result);
            }
            return waitForPage(reused, resolvedUrl, request.timeoutMs);
          }
          const usedSlots = new Set(Array.from(pages.current.values(), (page) => page.slot));
          const slot: NativeSlot | undefined = !usedSlots.has("a")
            ? "a"
            : !usedSlots.has("b")
              ? "b"
              : undefined;
          if (!slot) throw new Error("The native browser proof supports only two open pages");
          const opened = await openPreview({
            environmentId,
            input: {
              threadId: request.threadId,
              ...(resolvedUrl ? { url: resolvedUrl } : {}),
              viewport: FILL_PREVIEW_VIEWPORT,
            },
          });
          if (opened._tag === "Failure") throw squashAtomCommandFailure(opened);
          const page: NativePage = { tabId: opened.value.tabId, threadId: request.threadId, slot };
          try {
            await invoke("open", { tab: slot, ...(resolvedUrl ? { url: resolvedUrl } : {}) });
            const status = await waitForPage(page, resolvedUrl, request.timeoutMs);
            pages.current.set(page.tabId, page);
            currentByThread.current.set(request.threadId, page.tabId);
            setOpenPages(Array.from(pages.current.values()));
            return status;
          } catch (error) {
            await closePreview({
              environmentId,
              input: { threadId: request.threadId, tabId: page.tabId },
            });
            throw error;
          }
        }
        case "navigate": {
          if (!existing) throw unavailableTarget();
          const input = request.input as PreviewAutomationNavigateInput;
          const target = input.target ?? { kind: "url" as const, url: input.url! };
          const resolvedUrl = resolveBrowserNavigationTarget(environmentId, target).resolvedUrl;
          await invoke("navigate", { tab: existing.slot, url: resolvedUrl });
          const navigated = await navigatePreview({
            environmentId,
            input: { threadId: request.threadId, tabId: existing.tabId, url: resolvedUrl },
          });
          if (navigated._tag === "Failure") throw squashAtomCommandFailure(navigated);
          return waitForPage(existing, resolvedUrl, request.timeoutMs);
        }
        case "evaluate": {
          if (!existing) throw unavailableTarget();
          const input = request.input as { expression: string; awaitPromise?: boolean };
          if (input.awaitPromise) {
            throw new Error("The native proof has not validated awaited JavaScript results");
          }
          return invoke("evaluate", { tab: existing.slot, script: input.expression });
        }
        default:
          throw new Error(`Native proof does not support ${request.operation}`);
      }
    },
    [closePreview, environmentId, findPage, navigatePreview, openPreview, readStatus, waitForPage],
  );

  const [handlerAtom] = useState(() =>
    Atom.make({
      handle: async (_request: PreviewAutomationRequest): Promise<unknown> => {
        throw new Error("Native proof host is not ready");
      },
    }),
  );
  const setHandler = useAtomSet(handlerAtom);
  useEffect(() => setHandler({ handle: handleRequest }), [handleRequest, setHandler]);
  const consumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom,
        clientId,
        connectionAtom,
        environmentId,
        requestHandlerAtom: handlerAtom,
        respond: (response) => respond({ environmentId, input: response }),
        label: `preview:tauri-proof:${environmentId}:${clientId}`,
      }),
    [clientId, connectionAtom, environmentId, handlerAtom, requestsAtom, respond],
  );
  useAtomValue(consumerAtom);

  useEffect(() => {
    if (!connectionId) return;
    const reportFocus = () => {
      void focusHost({
        environmentId,
        input: {
          clientId,
          environmentId,
          connectionId,
          focused: document.hasFocus(),
        },
      });
    };
    reportFocus();
    window.addEventListener("focus", reportFocus);
    window.addEventListener("blur", reportFocus);
    return () => {
      window.removeEventListener("focus", reportFocus);
      window.removeEventListener("blur", reportFocus);
    };
  }, [clientId, connectionId, environmentId, focusHost]);

  const requestClose = async (page: NativePage) => {
    if (closingPages.current.has(page.tabId)) return;
    closingPages.current.add(page.tabId);
    try {
      if (
        !(await ensureLocalApi().dialogs.confirm(`Close Agent browser page ${page.tabId}?`, {
          variant: "destructive",
        }))
      ) {
        setCloseResult(`Cancelled close of ${page.tabId}; the page remains available.`);
        return;
      }
      if (pages.current.get(page.tabId) !== page) {
        setCloseResult(`Page ${page.tabId} changed while confirming close; nothing was closed.`);
        return;
      }
      await invoke("close", { tab: page.slot });
      pages.current.delete(page.tabId);
      if (currentByThread.current.get(page.threadId) === page.tabId) {
        const remaining = Array.from(pages.current.values()).find(
          (candidate) => candidate.threadId === page.threadId,
        );
        if (remaining) currentByThread.current.set(page.threadId, remaining.tabId);
        else currentByThread.current.delete(page.threadId);
      }
      setOpenPages(Array.from(pages.current.values()));
      const closed = await closePreview({
        environmentId,
        input: { threadId: page.threadId, tabId: page.tabId },
      });
      setCloseResult(
        closed._tag === "Failure"
          ? `Native page closed, but daemon cleanup failed: ${String(squashAtomCommandFailure(closed))}`
          : `Closed ${page.tabId}; the next Agent call must report the missing page.`,
      );
    } finally {
      closingPages.current.delete(page.tabId);
    }
  };

  return (
    <aside
      style={{ position: "fixed", bottom: 12, left: 12, zIndex: 1000, maxWidth: 300 }}
      className="rounded border bg-background p-2 text-xs shadow-lg"
      aria-label="Tauri Agent browser proof"
    >
      <div className="font-semibold">Agent browser proof (debug)</div>
      <div>{connectionId ? "Broker connected" : "Waiting for broker"}</div>
      {openPages.map((page) => (
        <button
          key={page.tabId}
          type="button"
          className="block underline"
          onClick={() =>
            void requestClose(page).catch((error: unknown) => setCloseResult(String(error)))
          }
        >
          Close {page.slot}: {page.tabId}
        </button>
      ))}
      {closeResult ? <div role="status">{closeResult}</div> : null}
    </aside>
  );
}
