import { scopeThreadRef } from "@awen/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@awen/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  browserMiniPlayerSource,
  selectThreadPreviewMiniPlayer,
  selectThreadPreviewMiniPlayerTabId,
  usePreviewMiniPlayerStore,
} from "./previewMiniPlayerStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const tabA = browserMiniPlayerSource("tab-a");
const tabB = browserMiniPlayerSource("tab-b");

beforeEach(() => {
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
});

describe("previewMiniPlayerStore", () => {
  it("keeps floating previews scoped to their thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refB, tabB);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ source: tabA });
    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refB),
    ).toMatchObject({ source: tabB });
  });

  it("preserves position when switching the floating tab within one thread", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().move(refA, "browser:tab-a", { x: 24, y: 48 });
    usePreviewMiniPlayerStore.getState().open(refA, tabB);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      source: tabB,
      position: { x: 24, y: 48 },
      width: null,
    });
  });

  it("ignores stale drag updates after the floating tab changes", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().open(refA, tabB);
    usePreviewMiniPlayerStore.getState().move(refA, "browser:tab-a", { x: 100, y: 100 });

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toEqual({
      source: tabB,
      position: null,
      width: null,
    });
  });

  it("preserves a thread-bound width while switching tabs", () => {
    usePreviewMiniPlayerStore.getState().open(refA, tabA);
    usePreviewMiniPlayerStore.getState().resize(refA, "browser:tab-a", 480);
    usePreviewMiniPlayerStore.getState().open(refA, tabB);

    expect(
      selectThreadPreviewMiniPlayer(usePreviewMiniPlayerStore.getState().byThreadKey, refA),
    ).toMatchObject({ source: tabB, width: 480 });
  });
});
