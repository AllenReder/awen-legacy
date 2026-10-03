import type { ProjectReadFileResult } from "@awen/contracts";
import { EnvironmentId } from "@awen/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@awen/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // The confirmed read is a network round trip; the test drives its landing directly.
  executeAtomQuery: async () => ({ _tag: "Success", value: undefined }),
}));

import {
  clearProjectFileQueryData,
  confirmProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  resolveProjectFileQueryData,
  setConfirmedProjectFileQueryData,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

const environmentId = EnvironmentId.make("environment-project-files-query-test");

describe("project files queries", () => {
  afterEach(() => {
    clearProjectFileQueryData(environmentId, "/repo", "convex.json");
    vi.unstubAllGlobals();
  });

  it("keeps the latest optimistic draft when an older write finishes", () => {
    vi.stubGlobal("window", {});
    const initial = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
    } satisfies ProjectReadFileResult;
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}');
    setProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}');

    expect(getOptimisticProjectFileQueryData(environmentId, "/repo", "convex.json")?.contents).toBe(
      '{"nodeVersion":"22"}',
    );

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"220"}'),
    ).toBe(false);

    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", initial)).toEqual({
      relativePath: "convex.json",
      contents: '{"nodeVersion":"22"}',
      byteLength: 20,
      truncated: false,
    });

    expect(
      confirmProjectFileQueryData(environmentId, "/repo", "convex.json", '{"nodeVersion":"22"}'),
    ).toBe(true);
  });
});

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("confirmed file writes", () => {
  it("keeps the saved hash until the confirmed read lands, then yields to the query", async () => {
    vi.stubGlobal("window", {});
    const staleRead = {
      relativePath: "convex.json",
      contents: '{"nodeVersion":"20"}',
      byteLength: 20,
      truncated: false,
      contentHash: "hash-before",
    } satisfies ProjectReadFileResult;
    const savedContents = '{"nodeVersion":"22"}';

    setConfirmedProjectFileQueryData(
      environmentId,
      "/repo",
      "convex.json",
      savedContents,
      "hash-after",
    );

    // Until the confirmed read lands, readers keep seeing the saved bytes — with the hash the
    // server returned, because that hash is what the next save checks the file against. A
    // record without it would make every later save a blind overwrite.
    expect(resolveProjectFileQueryData(environmentId, "/repo", "convex.json", staleRead)).toEqual({
      relativePath: "convex.json",
      contents: savedContents,
      byteLength: 20,
      truncated: false,
      contentHash: "hash-after",
    });

    // Once the read behind the confirm lands, the optimistic record is retired and the query's
    // own data takes over — hash and all. The read may have moved on (somebody wrote the file
    // outside Awen in the meantime), and that newer version must win: a record that outlived the
    // read would keep feeding the stale hash to conflict checks.
    await flushMicrotasks();
    const externalRead = {
      ...staleRead,
      contents: '{"nodeVersion":"24"}',
      contentHash: "hash-external",
    } satisfies ProjectReadFileResult;
    expect(
      resolveProjectFileQueryData(environmentId, "/repo", "convex.json", externalRead),
    ).toEqual(externalRead);
  });
});
