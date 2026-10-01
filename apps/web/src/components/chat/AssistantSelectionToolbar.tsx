import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@awen/contracts";
import { QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "~/lib/selectionActions";
import { Button } from "../ui/button";
import { readLocalApi } from "~/localApi";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { toastManager } from "../ui/toast";

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    position: SelectionActionPoint;
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    toolbar.style.left = `${Math.max(8, Math.min(selection.position.x, window.innerWidth - rect.width - 8))}px`;
    toolbar.style.top = `${Math.max(8, Math.min(selection.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = (pointer: SelectionActionPoint | null) => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (rect.bottom < viewportRect.top || rect.top > viewportRect.bottom || rect.width === 0) {
        clear();
        return;
      }
      const rects = captured.range.getClientRects();
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        position: resolveSelectionActionPosition({
          bounds: viewportRect,
          selectionRect: rects.item(rects.length - 1) ?? rect,
          pointer,
          viewport: { width: window.innerWidth, height: window.innerHeight },
        }),
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      onSelection: update,
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const onContextMenu = (event: MouseEvent) => {
      const nativeSelection = window.getSelection();
      if (!nativeSelection || nativeSelection.isCollapsed || nativeSelection.rangeCount !== 1)
        return;
      const range = nativeSelection.getRangeAt(0).cloneRange();
      if (!viewport.contains(range.startContainer) || !viewport.contains(range.endContainer))
        return;
      const text = nativeSelection.toString();
      const api = readLocalApi();
      if (!text.trim() || !api) return;
      // Capture before the menu takes focus and the browser selection changes.
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      const citation =
        captured && messageId
          ? {
              version: 1 as const,
              ...threadRef,
              messageId: MessageId.make(messageId),
              ...captured.selector,
            }
          : null;
      event.preventDefault();
      event.stopPropagation();
      actions.cancel();
      clear();
      void api.contextMenu
        .show<"copy" | "cite">(
          [
            { id: "copy", label: "Copy", icon: "copy" },
            ...(citation
              ? [
                  {
                    id: "cite" as const,
                    label: "Cite",
                    icon: "quote",
                    disabled: citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH,
                  },
                ]
              : []),
          ],
          { x: event.clientX, y: event.clientY },
        )
        .then(async (action) => {
          if (action === "copy") await writeTextToClipboard(text);
          if (
            action === "cite" &&
            citation &&
            captured &&
            citation.text.length <= ASSISTANT_CITATION_MAX_TEXT_LENGTH &&
            onCite(citation, { source: captured.source, range: captured.range, viewport })
          ) {
            // Do not clear a different selection made while the menu was open.
            if (window.getSelection()?.toString() === text)
              window.getSelection()?.removeAllRanges();
          }
        })
        .catch(() =>
          toastManager.add({ type: "error", title: "Unable to perform selection action" }),
        );
    };
    viewport.addEventListener("contextmenu", onContextMenu, true);
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      if (toolbar.disabled) return;
      event.preventDefault();
      event.stopPropagation();
      toolbar.focus({ preventScroll: true });
    };
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
      viewport.removeEventListener("contextmenu", onContextMenu, true);
      actionsRef.current = null;
    };
  }, [threadRef, viewport, onCite]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  return createPortal(
    <Button
      ref={toolbarRef}
      type="button"
      size="xs"
      variant="glass"
      disabled={tooLong}
      aria-label={tooLong ? "Selection is too long to cite" : "Cite selection in composer"}
      className="fixed z-50 max-w-[calc(100vw-1rem)] rounded-full px-2.5"
      style={{ left: selection.position.x, top: selection.position.y }}
      onPointerDown={(event) => event.preventDefault()}
      onClick={cite}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <QuoteIcon aria-hidden="true" className="size-3.5" />
      {tooLong ? "Shorten selection" : "Cite"}
    </Button>,
    document.body,
  );
}
