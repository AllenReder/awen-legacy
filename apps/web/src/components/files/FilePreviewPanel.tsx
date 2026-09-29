import { Spinner } from "~/components/ui/spinner";
import type {
  ChatFileAttachment,
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@awen/contracts";
import { filePreviewDelimiter } from "@awen/shared/delimitedPreview";
import {
  isWorkspaceAudioPreviewPath,
  isWorkspaceImagePreviewPath,
  isWorkspaceVideoPreviewPath,
} from "@awen/shared/filePreview";
import { VirtualizedFile, parseDiffFromFile, type SelectedLineRange } from "@pierre/diffs";
import { Editor } from "@pierre/diffs/editor";
import { EditProvider, File, FileDiff, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@awen/client-runtime/state/runtime";
import { mediaFileReference } from "@awen/client-runtime/media-reference";
import { Code2, Eye, FolderTree, Globe2, Save, Table2, WrapTextIcon } from "lucide-react";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { MediaVideoPlayer } from "~/components/media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "~/components/media/MediaActions";
import { useRemoteOpenState } from "~/remoteOpen";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { assetEnvironment } from "~/state/assets";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { AttachmentFilePreview } from "./AttachmentFilePreview";
import { AudioPreview } from "./AudioPreview";
import { BrowserDocumentFrame, isPdfPreviewFile } from "./BrowserDocumentFrame";
import { DelimitedTablePreview } from "./DelimitedTablePreview";
import FileBrowserPanel from "./FileBrowserPanel";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "~/components/ui/dialog";
import { useWorkbenchStore } from "~/workbench/workbenchStore";
import { projectEnvironment } from "~/state/projects";
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import {
  FILE_LINK_REVEAL_ATTRIBUTE,
  FILE_LINK_REVEAL_UNSAFE_CSS,
  FILE_SURFACE_SUBHEADER_CLASS,
  FileSurfaceAction,
  FileSurfaceFailure,
  FileSurfaceLoading,
} from "./fileSurfaceChrome";
import SourceFilePreview from "./ReadOnlySourcePreview";
import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { projectFileCacheKey, projectFileEditorCacheKey } from "./fileContentRevision";
import {
  buildEditableFileOptions,
  buildFileEditorKey,
  shouldEnableCommentAnnotations,
} from "./fileEditorOptions";
import {
  isMarkdownPreviewFile,
  setMarkdownTaskChecked,
  shouldShowFileExplorer,
} from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import {
  getOptimisticProjectFileQueryData,
  setProjectFileQueryData,
  useProjectFileQuery,
} from "./projectFilesQueryState";

export interface FileEditorDraft {
  readonly path: string;
  readonly contents: string;
  readonly contentHash: string | undefined;
}

interface FilePreviewPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  attachment?: ChatFileAttachment | undefined;
  threadRef?: ScopedThreadRef | undefined;
  composerDraftTarget?: ScopedThreadRef | DraftId | undefined;
  keybindings?: ResolvedKeybindingsConfig | undefined;
  availableEditors?: ReadonlyArray<EditorId> | undefined;
  revealLine?: number | null | undefined;
  revealRequestId?: number | undefined;
  onOpenFile?: ((relativePath: string) => void) | undefined;
  onPendingChange?: ((relativePath: string, pending: boolean) => void) | undefined;
  selectedFilePending?: boolean | undefined;
  workspaceMutationId: string | null;
  initialDraft?: FileEditorDraft | undefined;
  onDraftChange?: ((draft: FileEditorDraft | null) => void) | undefined;
  navigationManaged?: boolean | undefined;
  explicitSave?: boolean | undefined;
  paneId?: string | undefined;
}

const EMPTY_KEYBINDINGS: ResolvedKeybindingsConfig = [];
const EMPTY_EDITORS: ReadonlyArray<EditorId> = [];
const FILE_EXPLORER_STORAGE_KEY = "awen.fileExplorerOpen";
const RENDER_MARKDOWN_STORAGE_KEY = "awen.renderMarkdown";
const RENDER_BROWSER_FILE_STORAGE_KEY = "awen.renderBrowserFile";
const RENDER_TABLE_STORAGE_KEY = "awen.renderTable";
type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly alt: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = useMemo(
    () => ({
      _tag: "workspace-file" as const,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.threadRef.threadId, props.absolutePath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;
  const imageUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;
  const actionsSource: MediaActionSource = {
    kind: "image",
    name: props.alt,
    src: imageUrl,
    reference: mediaFileReference(props.absolutePath, props.workspaceRoot),
    asset: { environmentId: props.environmentId, resource },
  };

  if (assetUrl._tag === "Failure" || (imageUrl !== null && failedUrl === imageUrl)) {
    return (
      <MediaActions source={actionsSource}>
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
          Unable to load workspace image.
        </div>
      </MediaActions>
    );
  }

  return assetUrl._tag === "Success" && imageUrl !== null ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <MediaActions source={actionsSource}>
        <img
          className="max-h-full max-w-full object-contain"
          src={imageUrl}
          alt={props.alt}
          onError={() => setFailedUrl(imageUrl)}
        />
      </MediaActions>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  );
}

/**
 * Renders an HTML or PDF file in place from its signed asset URL. HTML runs in
 * a sandboxed frame with an opaque origin, so a page cannot reach the app's
 * session or storage. A file inside the workspace may load sibling assets; a
 * host file outside it is served on its own.
 */
function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly workspaceMutationId: string | null;
}) {
  const insideWorkspace =
    mediaFileReference(props.absolutePath, props.workspaceRoot).relativePath !== undefined;
  const resource = useMemo(
    () => ({
      _tag: insideWorkspace ? ("workspace-file" as const) : ("media-file" as const),
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [insideWorkspace, props.threadRef.threadId, props.absolutePath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;

  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load file preview.
      </div>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }
  return (
    <BrowserDocumentFrame
      src={`${assetUrl.url}${revisionSuffix}`}
      title={props.title}
      pdf={isPdfPreviewFile(props.absolutePath)}
    />
  );
}

function WorkspaceVideoPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = useMemo(
    () => ({
      _tag: "media-file" as const,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.threadRef.threadId, props.absolutePath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    resourceKey: JSON.stringify([props.environmentId, resource]),
    refresh: () => {
      // Failed refreshes flow through assetUrl and can be retried from the player.
      void refreshAssetUrl().catch(() => undefined);
    },
  });
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;
  const latestUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <MediaVideoPlayer
        src={latestUrl}
        sourceFailed={assetUrl._tag === "Failure"}
        label={props.name}
        revision={props.workspaceMutationId}
        preload="metadata"
        className="flex h-full min-h-0 w-full max-w-5xl items-center justify-center"
        onRetry={refreshAssetUrl}
        actionsSource={{
          kind: "video",
          name: props.name,
          src: latestUrl,
          reference: mediaFileReference(props.absolutePath, props.workspaceRoot),
          asset: { environmentId: props.environmentId, resource },
        }}
      />
    </div>
  );
}

function WorkspaceAudioPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly name: string;
  readonly workspaceMutationId: string | null;
}) {
  const resource = useMemo(
    () => ({
      _tag: "media-file" as const,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.threadRef.threadId, props.absolutePath],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    resourceKey: JSON.stringify([props.environmentId, resource]),
    refresh: () => {
      void refreshAssetUrl().catch(() => undefined);
    },
  });
  const revisionSuffix =
    props.workspaceMutationId === null
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${encodeURIComponent(props.workspaceMutationId)}`;
  const url = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;
  if (assetUrl._tag === "Failure" || (url !== null && failedUrl === url)) {
    return (
      <FileSurfaceFailure
        message="Unable to load audio."
        onRetry={() => {
          setFailedUrl(null);
          void refreshAssetUrl().catch(() => undefined);
        }}
      />
    );
  }
  if (url === null) return <FileSurfaceLoading />;
  return <AudioPreview src={url} name={props.name} onError={() => setFailedUrl(url)} />;
}

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

/**
 * Frames to keep retrying while the file contents or line metrics are not
 * available yet (fresh mounts hydrate asynchronously).
 */
const REVEAL_MAX_ATTEMPTS = 30;
/**
 * After scrolling to the target, hold it for a short window so late
 * programmatic scroll resets (editable-editor focus and state restoration)
 * cannot silently snap the file back to the top. Real user input cancels the
 * guard immediately.
 */
const REVEAL_GUARD_FRAMES = 20;
const REVEAL_GUARD_TOLERANCE_PX = 2;

interface FileRevealState {
  frameId: number | null;
  cancelGuard: (() => void) | null;
  handledRequestId: number | null;
  latestRequestId: number | null;
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const [revealStatesByPath] = useState(() => new Map<string, FileRevealState>());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const existingState = revealStatesByPath.get(relativePath);
      const state: FileRevealState = existingState ?? {
        frameId: null,
        cancelGuard: null,
        handledRequestId: null,
        latestRequestId: null,
      };
      if (!existingState) revealStatesByPath.set(relativePath, state);

      const cancelPendingReveal = () => {
        if (state.frameId !== null) {
          cancelAnimationFrame(state.frameId);
          state.frameId = null;
        }
        state.cancelGuard?.();
      };

      if (phase === "unmount") {
        cancelPendingReveal();
        return;
      }

      const contents = instance.file?.contents;
      const targetLine =
        revealLine === null || contents === undefined ? null : clampFileLine(contents, revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (state.latestRequestId !== revealRequestId) {
        cancelPendingReveal();
        state.latestRequestId = revealRequestId;
        state.handledRequestId = null;
      }

      if (revealLine === null) {
        fileContainer.style.minHeight = "";
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight),
      )}px`;

      if (state.handledRequestId === revealRequestId || state.frameId !== null) {
        return;
      }

      const resolveScrollTarget = (line: number): number | null => {
        const linePosition = instance.getLinePosition(line);
        if (!linePosition) return null;

        const scrollContainerRect = scrollContainer.getBoundingClientRect();
        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainerRect.top;
        const root = fileContainer.shadowRoot ?? fileContainer;
        const renderedLineElement = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
        const renderedLineRect = renderedLineElement?.getBoundingClientRect();

        return resolveCenteredFileLineScrollTop({
          scrollTop: scrollContainer.scrollTop,
          scrollHeight: scrollContainer.scrollHeight,
          viewportTop: scrollContainerRect.top,
          viewportHeight: scrollContainer.clientHeight,
          fileTop,
          estimatedLine: linePosition,
          ...(renderedLineRect && renderedLineRect.height > 0
            ? {
                renderedLine: {
                  top: renderedLineRect.top,
                  height: renderedLineRect.height,
                },
              }
            : {}),
        });
      };

      const guardScrollTarget = (line: number) => {
        let framesLeft = REVEAL_GUARD_FRAMES;
        let guardFrameId: number | null = null;
        const cancelGuard = () => {
          if (guardFrameId !== null) {
            cancelAnimationFrame(guardFrameId);
            guardFrameId = null;
          }
          scrollContainer.removeEventListener("wheel", cancelGuard);
          scrollContainer.removeEventListener("touchstart", cancelGuard);
          scrollContainer.removeEventListener("pointerdown", cancelGuard, true);
          window.removeEventListener("keydown", cancelGuard, true);
          if (state.cancelGuard === cancelGuard) state.cancelGuard = null;
        };
        scrollContainer.addEventListener("wheel", cancelGuard, { passive: true });
        scrollContainer.addEventListener("touchstart", cancelGuard, { passive: true });
        // Pierre stops gutter pointer events from bubbling. Listen in capture
        // so starting a comment cancels the reveal guard before the row expands.
        scrollContainer.addEventListener("pointerdown", cancelGuard, {
          passive: true,
          capture: true,
        });
        window.addEventListener("keydown", cancelGuard, true);
        const holdTarget = () => {
          guardFrameId = null;
          framesLeft -= 1;
          if (framesLeft <= 0 || !scrollContainer.isConnected) {
            cancelGuard();
            return;
          }
          const targetTop = resolveScrollTarget(line);
          if (
            targetTop !== null &&
            Math.abs(scrollContainer.scrollTop - targetTop) > REVEAL_GUARD_TOLERANCE_PX
          ) {
            scrollContainer.scrollTop = targetTop;
          }
          guardFrameId = requestAnimationFrame(holdTarget);
        };
        guardFrameId = requestAnimationFrame(holdTarget);
        state.cancelGuard = cancelGuard;
      };

      const scheduleReveal = (attempt: number) => {
        state.frameId = requestAnimationFrame(() => {
          state.frameId = null;
          if (state.latestRequestId !== revealRequestId || !fileContainer.isConnected) {
            return;
          }

          // Contents and line metrics can lag the first post-render on fresh
          // mounts; clamping against missing contents would scroll to line 1
          // and wrongly mark the request handled.
          const currentContents = instance.file?.contents;
          const line =
            currentContents === undefined ? null : clampFileLine(currentContents, revealLine);
          const targetTop = line === null ? null : resolveScrollTarget(line);
          if (line === null || targetTop === null) {
            if (attempt < REVEAL_MAX_ATTEMPTS) scheduleReveal(attempt + 1);
            return;
          }
          updateFileLinkReveal(fileContainer, line);

          scrollContainer.scrollTop = targetTop;
          state.handledRequestId = revealRequestId;
          guardScrollTarget(line);
        });
      };

      scheduleReveal(0);
    },
    [revealStatesByPath, relativePath, revealLine, revealRequestId],
  );
}

interface EditableFileSurfaceProps {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  composerDraftTarget?: ScopedThreadRef | DraftId | undefined;
  contents: string;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  wordWrap: boolean;
  onPostRender: FilePostRender;
  onPendingChange?: ((relativePath: string, pending: boolean) => void) | undefined;
  explicitSave?: boolean | undefined;
  onDraftChange?: ((contents: string) => void) | undefined;
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

const NOOP_PENDING_CHANGE = () => {};
const EMPTY_LINE_ANNOTATIONS: FileCommentLineAnnotation[] = [];

function EditableFileSurface({
  environmentId,
  cwd,
  relativePath,
  composerDraftTarget,
  contents,
  resolvedTheme,
  revealRequestId,
  wordWrap,
  onPostRender,
  onPendingChange,
  explicitSave = false,
  onDraftChange,
}: EditableFileSurfaceProps) {
  const enableCommentAnnotations = shouldEnableCommentAnnotations(composerDraftTarget);
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    enableCommentAnnotations && selectionOverride?.revealRequestId === revealRequestId
      ? selectionOverride.range
      : null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enableCommentAnnotations) return;
      setSelectionOverride({ revealRequestId, range });
    },
    [enableCommentAnnotations, revealRequestId],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | null>(null);

  const onDraftChangeRef = useRef(onDraftChange);
  onDraftChangeRef.current = onDraftChange;
  const composerDraftTargetRef = useRef(composerDraftTarget);
  composerDraftTargetRef.current = composerDraftTarget;

  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange: onPendingChange ?? NOOP_PENDING_CHANGE,
    enabled: !explicitSave,
  });
  const saveCoordinatorRef = useRef(saveCoordinator);
  saveCoordinatorRef.current = saveCoordinator;

  const editor = useMemo(
    () =>
      new Editor<FileCommentAnnotationGroup>({
        persistState: true,
        persistStateStorage: "inMemory",
        onChange: (file, nextLineAnnotations) => {
          if (explicitSave) {
            onDraftChangeRef.current?.(file.contents);
          } else {
            setProjectFileQueryData(environmentId, cwd, relativePath, file.contents);
            saveCoordinatorRef.current.change(file.contents);
          }
          if (nextLineAnnotations && composerDraftTargetRef.current) {
            const remapped = remapFileCommentAnnotations(
              nextLineAnnotations as FileCommentLineAnnotation[],
            );
            setLineAnnotations(remapped);
            for (const annotation of remapped) {
              for (const entry of annotation.metadata.entries) {
                if (entry.kind !== "comment") continue;
                addReviewComment(
                  composerDraftTargetRef.current,
                  buildFileReviewComment({
                    id: entry.id,
                    filePath: relativePath,
                    startLine: entry.startLine,
                    endLine: entry.endLine,
                    text: entry.text,
                    contents: file.contents,
                  }),
                );
              }
            }
          }
        },
      }),
    [addReviewComment, cwd, environmentId, explicitSave, relativePath],
  );

  useEffect(
    () => () => {
      editor.cleanUp();
    },
    [editor],
  );

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      if (composerDraftTarget) {
        removeReviewComment(composerDraftTarget, entryId);
      }
      setLineAnnotations((current) => {
        return current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
      });
    },
    [composerDraftTarget, removeReviewComment, setSelectedRange],
  );

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) => {
      setSelectedRange(null);
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId);
      if (entry && composerDraftTarget) {
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text,
            contents,
          }),
        );
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((annotationEntry) =>
              annotationEntry.id === entryId
                ? { ...annotationEntry, kind: "comment", text }
                : annotationEntry,
            ),
          },
        })),
      );
    },
    [
      addReviewComment,
      composerDraftTarget,
      contents,
      lineAnnotations,
      relativePath,
      setSelectedRange,
    ],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange) => {
      editor.setSelections([]);
      editor.blur();
      const { startLine, endLine } = normalizeFileCommentRange(range);
      const draftEntry: FileCommentAnnotationEntry = {
        id: nextFileCommentId(),
        kind: "draft",
        startLine,
        endLine,
        text: "",
      };
      setLineAnnotations((current) => {
        const withoutDraft = current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
        const existingIndex = withoutDraft.findIndex(
          (annotation) => annotation.lineNumber === endLine,
        );
        if (existingIndex < 0) {
          return [
            ...withoutDraft,
            {
              lineNumber: endLine,
              metadata: { entries: [draftEntry] },
            },
          ];
        }
        return withoutDraft.map((annotation, index) =>
          index === existingIndex
            ? {
                ...annotation,
                metadata: { entries: [...annotation.metadata.entries, draftEntry] },
              }
            : annotation,
        );
      });
    },
    [editor],
  );
  const hasOpenCommentForm =
    enableCommentAnnotations &&
    lineAnnotations.some((annotation) =>
      annotation.metadata.entries.some((entry) => entry.kind === "draft"),
    );
  useEffect(() => {
    if (!enableCommentAnnotations) return;
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, enableCommentAnnotations, hasOpenCommentForm, setSelectedRange]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      if (!enableCommentAnnotations) return;
      setSelectedRange(range);
      if (range) {
        beginComment(range);
      }
    },
    [beginComment, enableCommentAnnotations, setSelectedRange],
  );

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
      if (phase === "unmount") return;

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null;
        if (!fileContainer.isConnected) return;
        instance.setSelectedLines(selectedRange, { notify: false });
      });
    },
    [onPostRender, selectedRange],
  );

  const fileOptions = useMemo(
    () =>
      buildEditableFileOptions({
        enableCommentAnnotations,
        hasOpenCommentForm,
        wordWrap,
        resolvedTheme,
        onPostRender: handlePostRender,
        onGutterUtilityClick: setSelectedRange,
        onLineSelectionChange: setSelectedRange,
        onLineSelectionEnd: handleLineSelectionEnd,
      }),
    [
      enableCommentAnnotations,
      handleLineSelectionEnd,
      handlePostRender,
      hasOpenCommentForm,
      resolvedTheme,
      setSelectedRange,
      wordWrap,
    ],
  );

  return (
    <EditProvider editor={editor}>
      <div ref={surfaceRef} className="flex min-h-0 flex-1">
        <Virtualizer
          className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
          config={{
            overscrollSize: 600,
            intersectionObserverMargin: 1200,
          }}
        >
          <File<FileCommentAnnotationGroup>
            file={{
              name: relativePath,
              contents,
              cacheKey: projectFileEditorCacheKey(
                environmentId,
                cwd,
                relativePath,
                contents,
                editor.getFile(),
              ),
            }}
            options={fileOptions}
            selectedLines={selectedRange}
            lineAnnotations={enableCommentAnnotations ? lineAnnotations : EMPTY_LINE_ANNOTATIONS}
            {...(enableCommentAnnotations
              ? {
                  renderAnnotation: (annotation) => (
                    <div className="py-1">
                      {annotation.metadata.entries.map((entry) => (
                        <DiffCommentAnnotation
                          key={entry.id}
                          kind={entry.kind}
                          rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                          text={entry.text}
                          onCancel={() => removeAnnotationEntry(entry.id)}
                          onComment={(text) => submitAnnotationEntry(entry.id, text)}
                          onDelete={() => removeAnnotationEntry(entry.id)}
                        />
                      ))}
                    </div>
                  ),
                }
              : {})}
            className="min-h-full"
            contentEditable
          />
        </Virtualizer>
      </div>
    </EditProvider>
  );
}

function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  threadRef,
  readOnly,
  onPendingChange,
}: Omit<
  EditableFileSurfaceProps,
  | "resolvedTheme"
  | "composerDraftTarget"
  | "revealLine"
  | "revealRequestId"
  | "wordWrap"
  | "onPostRender"
> & {
  threadRef: ScopedThreadRef;
  readOnly: boolean;
}) {
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    onPendingChange: onPendingChange ?? (() => {}),
  });

  return (
    <ScrollArea className="min-h-0 flex-1">
      <FileMarkdownPreview
        text={contents}
        cwd={cwd}
        relativePath={relativePath}
        threadRef={threadRef}
        onTaskListChange={
          readOnly
            ? undefined
            : ({ markerOffset, checked }) => {
                const currentContents =
                  getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
                  contents;
                const nextContents = setMarkdownTaskChecked(currentContents, markerOffset, checked);
                if (nextContents === currentContents) return;
                setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
                saveCoordinator.change(nextContents);
              }
        }
      />
    </ScrollArea>
  );
}

function renderedToggleLabel(mode: "markdown" | "html" | "table", rendered: boolean): string {
  if (mode === "markdown") return rendered ? "Show markdown source" : "Show rendered markdown";
  if (mode === "table") return rendered ? "Show source" : "Show table";
  return rendered ? "Show HTML source" : "Show rendered page";
}

function initialExplorerOpen(): boolean {
  try {
    return getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean) ?? true;
  } catch (error) {
    console.error(error);
    return true;
  }
}

export default function FilePreviewPanel({
  environmentId,
  cwd,
  projectName,
  relativePath,
  attachment,
  threadRef,
  composerDraftTarget,
  keybindings = EMPTY_KEYBINDINGS,
  availableEditors = EMPTY_EDITORS,
  revealLine = null,
  revealRequestId = 0,
  onOpenFile,
  onPendingChange,
  selectedFilePending = false,
  workspaceMutationId,
  initialDraft,
  onDraftChange,
  navigationManaged = false,
  explicitSave = false,
  paneId,
}: FilePreviewPanelProps) {
  const effectiveThreadRef = useMemo<ScopedThreadRef>(
    () => threadRef ?? ({ environmentId, threadId: "workspace-files" as any } as ScopedThreadRef),
    [environmentId, threadRef],
  );
  const [restoredDraft] = useState(() =>
    initialDraft?.path === relativePath ? initialDraft : undefined,
  );
  const [initialContents, setInitialContents] = useState(restoredDraft?.contents);
  const draftContentsRef = useRef<string | null>(restoredDraft?.contents ?? null);
  const draftRevisionRef = useRef(0);
  const draftHashRef = useRef<string | undefined>(restoredDraft?.contentHash);
  const draftCallbackRef = useRef(onDraftChange);
  useEffect(() => {
    draftCallbackRef.current = onDraftChange;
  }, [onDraftChange]);
  const previousPathRef = useRef(relativePath);
  const [reloadKey, setReloadKey] = useState(0);
  const [isDirty, setIsDirty] = useState(restoredDraft !== undefined);
  const [conflict, setConflict] = useState<{
    readonly actualHash?: string | undefined;
    readonly diskContents?: string | undefined;
  } | null>(null);

  const resetDraft = useCallback(() => {
    draftRevisionRef.current += 1;
    draftContentsRef.current = null;
    draftHashRef.current = undefined;
    setInitialContents(undefined);
    draftCallbackRef.current?.(null);
    setIsDirty(false);
  }, []);

  const [pendingSwitchPath, setPendingSwitchPath] = useState<string | null>(null);
  const [showSwitchModal, setShowSwitchModal] = useState(false);
  const [showCloseModal, setShowCloseModal] = useState(false);
  const [closeReason, setCloseReason] = useState<"close" | "switch">("close");
  const [showDiffModal, setShowDiffModal] = useState(false);
  const closeResolverRef = useRef<((choice: "cancel" | "discard" | "save") => void) | null>(null);
  const resolveCloseChoice = useCallback((choice: "cancel" | "discard" | "save") => {
    setShowCloseModal(false);
    const resolve = closeResolverRef.current;
    closeResolverRef.current = null;
    resolve?.(choice);
  }, []);
  useEffect(
    () => () => {
      closeResolverRef.current?.("cancel");
    },
    [],
  );
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const environment = useEnvironment(environmentId);
  const isEnvironmentOffline = environment !== null && environment.connection.phase !== "connected";
  const remoteOpenState = useRemoteOpenState(environmentId);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const isVideo = relativePath !== null && isWorkspaceVideoPreviewPath(relativePath);
  const isAudio = relativePath !== null && !isVideo && isWorkspaceAudioPreviewPath(relativePath);
  const isImage = relativePath !== null && !isVideo && isWorkspaceImagePreviewPath(relativePath);
  const isMedia = isImage || isVideo || isAudio;
  // PDFs have no text to show; HTML has, and can toggle between page and source.
  const isPdf = relativePath !== null && isPdfPreviewFile(relativePath);
  const isHtml = relativePath !== null && !isPdf && isBrowserPreviewFile(relativePath);
  // A file outside the workspace (an absolute path) is shown, never edited.
  const isHostFile =
    attachment !== undefined || (relativePath !== null && isAbsolutePath(relativePath));
  const file = useProjectFileQuery(
    environmentId,
    cwd,
    relativePath,
    attachment === undefined && !isMedia && !isPdf,
  );
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const showExplorer = shouldShowFileExplorer({
    relativePath,
    explorerOpen,
    attachmentOpen: attachment !== undefined,
  });
  // Reading markdown rendered is a preference, not a property of one file. Keeping
  // it on the panel meant a thread switch dropped it and forced source back.
  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(
    RENDER_MARKDOWN_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [renderBrowserFilePreferred, setRenderBrowserFilePreferred] = useLocalStorage(
    RENDER_BROWSER_FILE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  const [renderTablePreferred, setRenderTablePreferred] = useLocalStorage(
    RENDER_TABLE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  // Paired with the path on purpose: each file surface counts its reveals from
  // one, so a bare id would let a dismissed reveal on one file swallow the first
  // reveal on the next.
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const isMarkdown = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const tableDelimiter =
    relativePath && attachment === undefined ? filePreviewDelimiter({ name: relativePath }) : null;
  // A reveal still wins over the preference: the line only exists in the source.
  const revealHandled =
    revealLine === null ||
    (handledReveal?.path === relativePath && handledReveal.requestId === revealRequestId);
  const renderMarkdown = isMarkdown && renderMarkdownPreferred && revealHandled;
  const renderBrowserFile = isPdf || (isHtml && renderBrowserFilePreferred && revealHandled);
  const renderTable = tableDelimiter !== null && renderTablePreferred && revealHandled;
  const renderedMode = isMarkdown
    ? ("markdown" as const)
    : tableDelimiter
      ? ("table" as const)
      : isHtml
        ? ("html" as const)
        : null;
  const canToggleRendered = attachment === undefined && renderedMode !== null;
  const updateClientSettings = useUpdateClientSettings();
  // Word wrap only reaches the text bodies. A rendered Markdown document, a table and the
  // browser frame all lay themselves out, so the toggle stays hidden rather than inert.
  const showsRawText =
    relativePath !== null &&
    file.data !== null &&
    !(isMarkdown && renderMarkdown) &&
    !(tableDelimiter && renderTable) &&
    !renderBrowserFile;
  const rendered = isMarkdown ? renderMarkdown : tableDelimiter ? renderTable : renderBrowserFile;
  const setRenderedPreferred = isMarkdown
    ? setRenderMarkdownPreferred
    : tableDelimiter
      ? setRenderTablePreferred
      : setRenderBrowserFilePreferred;
  const canOpenInBrowser =
    relativePath !== null &&
    attachment === undefined &&
    !isVideo &&
    isPreviewSupportedInRuntime() &&
    isBrowserPreviewFile(relativePath);
  const absolutePath =
    relativePath && attachment === undefined ? resolvePathLinkTarget(relativePath, cwd) : null;
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  useWorkspaceMutationRefresh({
    enabled:
      attachment === undefined &&
      relativePath !== null &&
      !isMedia &&
      !isPdf &&
      !selectedFilePending,
    mutationId: workspaceMutationId,
    refresh: file.refresh,
    resourceKey: `file:${environmentId}:${cwd}:${relativePath ?? ""}`,
  });

  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const toggleExplorer = () => {
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  const handleOpenInBrowser = useCallback(() => {
    if (!absolutePath || !environmentHttpBaseUrl) return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef: effectiveThreadRef,
        filePath: absolutePath,
        workspaceRoot: cwd,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  }, [absolutePath, createAssetUrl, cwd, environmentHttpBaseUrl, openPreview, threadRef]);

  useEffect(() => {
    if (previousPathRef.current === relativePath) return;
    previousPathRef.current = relativePath;
    resetDraft();
    setConflict(null);
  }, [relativePath, resetDraft]);

  useEffect(() => {
    if (!isDirty && file.data) {
      draftContentsRef.current = null;
    }
  }, [file.data, isDirty]);

  const handleDraftChange = useCallback(
    (next: string) => {
      draftRevisionRef.current += 1;
      draftHashRef.current ??= file.data?.contentHash ?? undefined;
      const dirty = next !== (file.data?.contents ?? "");
      draftContentsRef.current = dirty ? next : null;
      setIsDirty((prev) => (prev !== dirty ? dirty : prev));
      if (relativePath)
        draftCallbackRef.current?.(
          dirty ? { path: relativePath, contents: next, contentHash: draftHashRef.current } : null,
        );
    },
    [file.data?.contents, file.data?.contentHash, relativePath],
  );

  const conflictDiff = useMemo(() => {
    if (!conflict || !relativePath || conflict.diskContents === undefined) return null;
    const draftText = draftContentsRef.current ?? file.data?.contents ?? "";
    return parseDiffFromFile(
      { name: relativePath, contents: conflict.diskContents },
      { name: relativePath, contents: draftText },
    );
  }, [conflict, file.data?.contents, relativePath]);

  const writeFileCommand = useAtomCommand(projectEnvironment.writeFile);
  const readFileCommand = useAtomQueryRunner(projectEnvironment.readFile, { reportFailure: false });

  const handleSave = useCallback(
    async (force = false): Promise<boolean> => {
      if (isEnvironmentOffline) {
        toastManager.add(
          stackedThreadToast({
            type: "warning",
            title: "Cannot save file",
            description: `${environment?.label ?? "Remote environment"} is offline. Remote file cannot be modified.`,
          }),
        );
        return false;
      }
      const draftToSave = draftContentsRef.current;
      const revisionToSave = draftRevisionRef.current;
      const contentsToSave = draftToSave ?? file.data?.contents;
      if (!relativePath || contentsToSave === undefined) return true;
      const result = await writeFileCommand({
        environmentId,
        input: {
          cwd,
          relativePath,
          contents: contentsToSave,
          expectedContentHash: force
            ? undefined
            : (draftHashRef.current ?? file.data?.contentHash ?? undefined),
        },
      });

      if (result._tag === "Success") {
        setProjectFileQueryData(environmentId, cwd, relativePath, contentsToSave);
        // A newer edit made during the write must survive this save.
        const draftUnchanged = draftRevisionRef.current === revisionToSave;
        if (draftUnchanged) resetDraft();
        setConflict(null);
        file.refresh();
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "File saved",
            description: relativePath,
          }),
        );
        return draftUnchanged;
      }

      const err = (result as any).error;
      const isConflict =
        err?.failure === "conflict" ||
        err?._tag === "WorkspaceFileConflictError" ||
        (err instanceof Error && err.message.includes("conflict"));

      if (isConflict) {
        const latest = await readFileCommand({
          environmentId,
          input: { cwd, relativePath },
        });
        setConflict({
          diskContents: latest._tag === "Success" ? latest.value.contents : undefined,
          actualHash: latest._tag === "Success" ? latest.value.contentHash : undefined,
        });
        return false;
      }

      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Save failed",
          description: err instanceof Error ? err.message : "Failed to save file.",
        }),
      );
      return false;
    },
    [
      cwd,
      environment,
      environmentId,
      file,
      isEnvironmentOffline,
      readFileCommand,
      relativePath,
      writeFileCommand,
    ],
  );

  const handleDiscardAndReload = useCallback(async () => {
    if (!relativePath) return;
    let diskText = conflict?.diskContents;
    if (diskText === undefined) {
      const latest = await readFileCommand({ environmentId, input: { cwd, relativePath } });
      if (latest._tag === "Success") {
        diskText = latest.value.contents;
      }
    }
    if (diskText !== undefined) {
      setProjectFileQueryData(environmentId, cwd, relativePath, diskText);
      resetDraft();
      setConflict(null);
      setShowDiffModal(false);
      setReloadKey((k) => k + 1);
      file.refresh();
    } else {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Reload failed",
          description: "Could not read file from disk.",
        }),
      );
    }
  }, [conflict?.diskContents, cwd, environmentId, file, readFileCommand, relativePath, resetDraft]);

  useEffect(() => {
    if (!explicitSave) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [explicitSave, handleSave]);

  useEffect(() => {
    if (!paneId || !explicitSave) return;
    const ask = (reason: "close" | "switch") =>
      new Promise<"cancel" | "discard" | "save">((resolve) => {
        setCloseReason(reason);
        closeResolverRef.current = resolve;
        setShowCloseModal(true);
      });
    return useWorkbenchStore.getState().registerCloseGuard(paneId, {
      isDirty: () => draftContentsRef.current !== null,
      revision: () => draftRevisionRef.current,
      confirmClose: async (reason = "close") => {
        const choice = await ask(reason);
        if (choice === "discard") {
          resetDraft();
          return true;
        }
        return choice === "save" ? handleSave() : false;
      },
      prepareClose: async () => {
        const choice = await ask("close");
        if (choice === "cancel") return null;
        return { commit: () => (choice === "discard" ? (resetDraft(), true) : handleSave()) };
      },
    });
  }, [paneId, explicitSave, isDirty, handleSave, resetDraft]);

  const handleOpenFileWithGuard = useCallback(
    (path: string) => {
      if (explicitSave && isDirty && !navigationManaged) {
        setPendingSwitchPath(path);
        setShowSwitchModal(true);
      } else {
        onOpenFile?.(path);
      }
    },
    [explicitSave, isDirty, onOpenFile, navigationManaged],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-transparent">
      {relativePath && attachment === undefined ? (
        <div className={FILE_SURFACE_SUBHEADER_CLASS} data-surface-subheader>
          <ScrollArea
            ref={breadcrumbRef}
            hideScrollbars
            scrollFade
            className="min-w-0 flex-1 rounded-none"
            data-file-breadcrumbs
          >
            <div className="flex h-full w-max min-w-full items-center text-xs">
              <FileBreadcrumbs
                cwd={cwd}
                environmentId={environmentId}
                onOpenFile={handleOpenFileWithGuard}
                isDirty={isDirty}
                projectName={projectName}
                relativePath={relativePath}
                workspaceMutationId={workspaceMutationId}
              />
            </div>
          </ScrollArea>
          {absolutePath &&
          (environmentId === primaryEnvironmentId || remoteOpenState.mode !== "local-exec") ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={absolutePath}
              compact
              enableShortcut={false}
            />
          ) : null}
          {canToggleRendered && renderedMode ? (
            <FileSurfaceAction
              label={renderedToggleLabel(renderedMode, rendered)}
              pressed={rendered}
              onPress={() => {
                const pressed = !rendered;
                setRenderedPreferred(pressed);
                setHandledReveal(
                  pressed && relativePath !== null
                    ? { path: relativePath, requestId: revealRequestId }
                    : null,
                );
              }}
            >
              {rendered ? (
                <Code2 className="size-3.5" />
              ) : renderedMode === "table" ? (
                <Table2 className="size-3.5" />
              ) : (
                <Eye className="size-3.5" />
              )}
            </FileSurfaceAction>
          ) : null}
          {explicitSave && relativePath && showsRawText ? (
            <FileSurfaceAction
              label={isDirty ? "Save file (Cmd+S)" : "Saved"}
              pressed={isDirty}
              onPress={() => void handleSave()}
            >
              <Save
                className={cn("size-3.5", isDirty ? "text-primary" : "text-muted-foreground")}
              />
            </FileSurfaceAction>
          ) : null}
          {showsRawText ? (
            <FileSurfaceAction
              label={wordWrap ? "Disable word wrap" : "Enable word wrap"}
              pressed={wordWrap}
              onPress={() => updateClientSettings({ wordWrap: !wordWrap })}
            >
              <WrapTextIcon className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {canOpenInBrowser ? (
            <FileSurfaceAction label="Open file in preview browser" onPress={handleOpenInBrowser}>
              <Globe2 className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
          {!isHostFile ? (
            <FileSurfaceAction
              label={explorerOpen ? "Hide file explorer" : "Show file explorer"}
              pressed={explorerOpen}
              onPress={toggleExplorer}
            >
              <FolderTree className="size-3.5" />
            </FileSurfaceAction>
          ) : null}
        </div>
      ) : null}
      {conflict ? (
        <div
          role="alert"
          data-testid="file-conflict-banner"
          className="flex shrink-0 items-center justify-between border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          <span>Conflict: This file was modified externally on disk.</span>
          <div className="flex items-center gap-2">
            <Button size="xs" variant="outline" onClick={() => setShowDiffModal(true)}>
              Compare Diff
            </Button>
            <Button size="xs" variant="destructive" onClick={() => void handleSave(true)}>
              Overwrite
            </Button>
            <Button size="xs" variant="outline" onClick={() => void handleDiscardAndReload()}>
              Discard & Reload
            </Button>
          </div>
        </div>
      ) : null}
      {isEnvironmentOffline ? (
        <div
          role="status"
          data-testid="file-offline-banner"
          className="flex shrink-0 items-center justify-between border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-xs text-warning"
        >
          <span>
            {environment?.label ?? "Remote environment"} is{" "}
            {environment?.connection.phase === "reconnecting" ? "reconnecting" : "offline"}. File is
            read-only.
          </span>
          <span className="opacity-70 font-mono text-[10px] uppercase">
            {environment?.connection.phase ?? "Offline"}
          </span>
        </div>
      ) : null}
      {relativePath &&
      attachment === undefined &&
      !isMedia &&
      !renderBrowserFile &&
      file.data?.truncated ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground">
          Preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()} byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && attachment ? (
            <AttachmentFilePreview
              key={`${environmentId}:${attachment.id}`}
              name={attachment.name}
              mimeType={attachment.mimeType}
              sizeBytes={attachment.sizeBytes}
              asset={{ environmentId, attachmentId: attachment.id }}
            />
          ) : relativePath && isVideo && absolutePath ? (
            <WorkspaceVideoPreview
              key={`${environmentId}:${effectiveThreadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={effectiveThreadRef}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && isAudio && absolutePath ? (
            <WorkspaceAudioPreview
              key={`${environmentId}:${effectiveThreadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={effectiveThreadRef}
              absolutePath={absolutePath}
              name={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={effectiveThreadRef}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              alt={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && renderBrowserFile && absolutePath ? (
            <WorkspaceBrowserPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={effectiveThreadRef}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              title={relativePath}
              workspaceMutationId={workspaceMutationId}
            />
          ) : relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
              {file.error}
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <Spinner className="size-5" />
            </div>
          ) : relativePath && file.data ? (
            isMarkdown && renderMarkdown ? (
              // Markdown reconciles in place across text updates, so a file
              // switch needs a new key or the previous file's disclosure and
              // wrap state carries into the next document.
              <RenderedMarkdownSurface
                key={relativePath}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={effectiveThreadRef}
                contents={file.data.contents}
                readOnly={isHostFile}
                onPendingChange={onPendingChange}
              />
            ) : tableDelimiter && renderTable ? (
              <DelimitedTablePreview
                key={relativePath}
                name={relativePath}
                text={file.data.contents}
                delimiter={tableDelimiter}
              />
            ) : file.data.truncated || isHostFile || isEnvironmentOffline ? (
              <SourceFilePreview
                name={relativePath}
                text={file.data.contents}
                cacheKey={projectFileCacheKey(cwd, relativePath, file.data.contents)}
                onPostRender={onFilePostRender}
              />
            ) : (
              <DiffWorkerPoolProvider>
                <EditableFileSurface
                  key={buildFileEditorKey(relativePath, resolvedTheme, reloadKey)}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  composerDraftTarget={composerDraftTarget}
                  contents={
                    (restoredDraft?.path === relativePath ? initialContents : undefined) ??
                    file.data.contents
                  }
                  resolvedTheme={resolvedTheme}
                  revealRequestId={revealRequestId}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                  onPendingChange={onPendingChange}
                  explicitSave={explicitSave}
                  onDraftChange={handleDraftChange}
                />
              </DiffWorkerPoolProvider>
            )
          ) : null}
        </div>
        {showExplorer ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-transparent",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              selectedPath={relativePath}
              selectedPathRevealId={revealRequestId}
              onOpenFile={handleOpenFileWithGuard}
              workspaceMutationId={workspaceMutationId}
              {...(relativePath && !isMedia && !isPdf
                ? { onRefreshSelectedFile: file.refresh }
                : {})}
            />
          </aside>
        ) : null}
      </div>
      {showSwitchModal ? (
        <Dialog
          open={showSwitchModal}
          onOpenChange={(open) => {
            if (!open) {
              setShowSwitchModal(false);
              setPendingSwitchPath(null);
            }
          }}
        >
          <DialogPopup showCloseButton={false} className="max-w-md">
            <DialogHeader>
              <DialogTitle>Unsaved Changes</DialogTitle>
              <DialogDescription>
                Do you want to save the changes you made to {relativePath} before switching?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter variant="bare">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setShowSwitchModal(false);
                  setPendingSwitchPath(null);
                }}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  resetDraft();
                  setShowSwitchModal(false);
                  if (pendingSwitchPath) onOpenFile?.(pendingSwitchPath);
                  setPendingSwitchPath(null);
                }}
              >
                Don't Save
              </Button>
              <Button
                variant="default"
                size="sm"
                onClick={async () => {
                  const saved = await handleSave();
                  if (saved) {
                    setShowSwitchModal(false);
                    if (pendingSwitchPath) onOpenFile?.(pendingSwitchPath);
                    setPendingSwitchPath(null);
                  }
                }}
              >
                Save
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}

      {showCloseModal ? (
        <Dialog
          open={showCloseModal}
          onOpenChange={(open) => {
            if (!open) resolveCloseChoice("cancel");
          }}
        >
          <DialogPopup showCloseButton={false} className="max-w-md">
            <DialogHeader>
              <DialogTitle>Unsaved Changes</DialogTitle>
              <DialogDescription>
                Do you want to save the changes you made to {relativePath} before{" "}
                {closeReason === "switch" ? "switching files" : "closing"}?
              </DialogDescription>
            </DialogHeader>
            <DialogFooter variant="bare">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  resolveCloseChoice("cancel");
                }}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  resolveCloseChoice("discard");
                }}
              >
                Don't Save
              </Button>
              <Button variant="default" size="sm" onClick={() => resolveCloseChoice("save")}>
                Save
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}

      {showDiffModal && conflict ? (
        <Dialog
          open={showDiffModal}
          onOpenChange={(open) => {
            if (!open) setShowDiffModal(false);
          }}
        >
          <DialogPopup showCloseButton className="max-w-4xl max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>File Conflict: {relativePath}</DialogTitle>
              <DialogDescription>
                Compare your unsaved draft (incoming changes) with the disk version (current).
              </DialogDescription>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-auto rounded-md border text-xs my-2">
              {conflictDiff ? (
                <FileDiff
                  fileDiff={conflictDiff}
                  options={{
                    diffStyle: "unified",
                    theme: resolveDiffThemeName(resolvedTheme),
                    overflow: "wrap",
                  }}
                />
              ) : (
                <div className="p-4 text-muted-foreground text-center">
                  Diff comparison unavailable.
                </div>
              )}
            </div>
            <DialogFooter variant="bare">
              <Button variant="outline" size="sm" onClick={() => setShowDiffModal(false)}>
                Close
              </Button>
              <Button variant="outline" size="sm" onClick={() => void handleDiscardAndReload()}>
                Discard & Reload
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={async () => {
                  const saved = await handleSave(true);
                  if (saved) setShowDiffModal(false);
                }}
              >
                Overwrite
              </Button>
            </DialogFooter>
          </DialogPopup>
        </Dialog>
      ) : null}
    </div>
  );
}
