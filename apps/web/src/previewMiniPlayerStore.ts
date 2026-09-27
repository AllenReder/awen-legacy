import { scopedThreadKey } from "@awen/client-runtime/environment";
import type { ScopedThreadRef } from "@awen/contracts";
import { create } from "zustand";

export interface PreviewMiniPlayerPosition {
  readonly x: number;
  readonly y: number;
}

export interface PreviewMiniPlayerSize {
  readonly width: number;
  readonly height: number;
}

/** The browser tab mirrored by the floating player. */
export type PreviewMiniPlayerSource = { readonly kind: "browser"; readonly tabId: string };

export interface PreviewMiniPlayerState {
  readonly source: PreviewMiniPlayerSource;
  readonly position: PreviewMiniPlayerPosition | null;
  /** Height always follows the mirrored source's aspect ratio. */
  readonly width: number | null;
}

interface PreviewMiniPlayerStoreState {
  readonly byThreadKey: Record<string, PreviewMiniPlayerState>;
  readonly open: (ref: ScopedThreadRef, source: PreviewMiniPlayerSource) => void;
  readonly close: (ref: ScopedThreadRef) => void;
  /** `sourceKey` guards against a drag that outlives the source it started on. */
  readonly move: (
    ref: ScopedThreadRef,
    sourceKey: string,
    position: PreviewMiniPlayerPosition,
  ) => void;
  readonly resize: (ref: ScopedThreadRef, sourceKey: string, width: number) => void;
  readonly removeThread: (ref: ScopedThreadRef) => void;
}

export function previewMiniPlayerSourceKey(source: PreviewMiniPlayerSource): string {
  return `browser:${source.tabId}`;
}

export const browserMiniPlayerSource = (tabId: string): PreviewMiniPlayerSource => ({
  kind: "browser",
  tabId,
});

export const usePreviewMiniPlayerStore = create<PreviewMiniPlayerStoreState>()((set) => ({
  byThreadKey: {},
  open: (ref, source) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (
        current &&
        previewMiniPlayerSourceKey(current.source) === previewMiniPlayerSourceKey(source)
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: {
            source,
            position: current?.position ?? null,
            width: current?.width ?? null,
          },
        },
      };
    }),
  close: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _closed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
  move: (ref, sourceKey, position) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (!current || previewMiniPlayerSourceKey(current.source) !== sourceKey) return state;
      if (current.position?.x === position.x && current.position.y === position.y) return state;
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, position },
        },
      };
    }),
  resize: (ref, sourceKey, width) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      const current = state.byThreadKey[threadKey];
      if (
        !current ||
        previewMiniPlayerSourceKey(current.source) !== sourceKey ||
        current.width === width
      ) {
        return state;
      }
      return {
        byThreadKey: {
          ...state.byThreadKey,
          [threadKey]: { ...current, width },
        },
      };
    }),
  removeThread: (ref) =>
    set((state) => {
      const threadKey = scopedThreadKey(ref);
      if (!(threadKey in state.byThreadKey)) return state;
      const { [threadKey]: _removed, ...byThreadKey } = state.byThreadKey;
      return { byThreadKey };
    }),
}));

export function selectThreadPreviewMiniPlayer(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): PreviewMiniPlayerState | null {
  if (!ref) return null;
  return byThreadKey[scopedThreadKey(ref)] ?? null;
}

/** The floating browser tab, or null when nothing floats. */
export function selectThreadPreviewMiniPlayerTabId(
  byThreadKey: Record<string, PreviewMiniPlayerState>,
  ref: ScopedThreadRef | null | undefined,
): string | null {
  const source = selectThreadPreviewMiniPlayer(byThreadKey, ref)?.source;
  return source?.kind === "browser" ? source.tabId : null;
}
