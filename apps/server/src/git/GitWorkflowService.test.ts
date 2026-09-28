import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { VcsRepositoryDetectionError, type OrchestrationShellSnapshot } from "@awen/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as SessionExecutionLock from "../session/SessionExecutionLock.ts";

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            awenProjects: [],
            threads: [],
          } as unknown as OrchestrationShellSnapshot),
      }),
    ),
    Layer.provide(SessionExecutionLock.layer),
    Layer.provide(Path.layer),
  );
}

function makeCheckoutLayer(input: {
  readonly threads: ReadonlyArray<{ readonly projectId: string; readonly session: unknown }>;
  readonly switchRef: GitVcsDriver.GitVcsDriver["Service"]["switchRef"];
  readonly createRef?: GitVcsDriver.GitVcsDriver["Service"]["createRef"];
}) {
  const snapshot = {
    awenProjects: [
      {
        workspaces: [{ workspaceRoot: "/repo", awenProjectId: "project:repo" }],
      },
    ],
    threads: input.threads,
  } as unknown as OrchestrationShellSnapshot;
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () =>
          Effect.succeed({ kind: "git", driver: {} } as VcsDriverRegistry.VcsDriverHandle),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        execute: () => Effect.succeed({ stdout: "/repo\n", exitCode: 0 } as never),
        switchRef: input.switchRef,
        ...(input.createRef ? { createRef: input.createRef } : {}),
      }),
    ),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
        getShellSnapshot: () => Effect.succeed(snapshot),
      }),
    ),
    Layer.provide(SessionExecutionLock.layer),
    Layer.provide(Path.layer),
  );
}

describe("GitWorkflowService", () => {
  it.effect("rejects checkout while another Agent in the Workspace is executing", () => {
    const switchRef = vi.fn(() => Effect.succeed({ refName: "main" }));
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.switchRef({ cwd: "/repo", refName: "main" }).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "GitCommandError", cwd: "/repo" });
      expect(error.detail).toContain("Agent Session");
      expect(switchRef).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        makeCheckoutLayer({
          threads: [
            {
              projectId: "project:repo",
              session: { status: "running", activeTurnId: "turn:active" },
            },
          ],
          switchRef,
        }),
      ),
    );
  });

  it.effect("switches an idle Workspace while an Agent in another Workspace is executing", () => {
    const switchRef = vi.fn(() => Effect.succeed({ refName: "main" }));
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const result = yield* workflow.switchRef({ cwd: "/repo", refName: "main" });
      expect(result.refName).toBe("main");
      expect(switchRef).toHaveBeenCalledOnce();
    }).pipe(
      Effect.provide(
        makeCheckoutLayer({
          threads: [
            {
              projectId: "project:other",
              session: { status: "running", activeTurnId: "turn:active" },
            },
          ],
          switchRef,
        }),
      ),
    );
  });

  it.effect("rejects create-and-switch while an Agent in the Workspace is starting", () => {
    const switchRef = vi.fn(() => Effect.succeed({ refName: "feature" }));
    const createRef = vi.fn(() => Effect.succeed({ refName: "feature" }));
    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow
        .createRef({ cwd: "/repo", refName: "feature", switchRef: true })
        .pipe(Effect.flip);
      expect(error.detail).toContain("Agent Session");
      expect(createRef).not.toHaveBeenCalled();
      expect(switchRef).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(
        makeCheckoutLayer({
          threads: [
            {
              projectId: "project:repo",
              session: { status: "starting", activeTurnId: null },
            },
          ],
          switchRef,
          createRef,
        }),
      ),
    );
  });
  it.effect("reports a non-Git VCS repository as not a Git repository", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const isRepository = yield* workflow.isRepository("/jj-repo");

      assert.equal(isRepository, false);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
          getShellSnapshot: () =>
            Effect.succeed({
              awenProjects: [],
              threads: [],
            } as unknown as OrchestrationShellSnapshot),
        }),
      ),
      Layer.provide(SessionExecutionLock.layer),
      Layer.provide(Path.layer),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });
});
