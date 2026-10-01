import { WorkspaceId, type CheckpointRef, type ThreadId, type VcsError } from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import type * as PlatformError from "effect/PlatformError";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type * as SqlError from "effect/unstable/sql/SqlError";
import { VcsProcess } from "../vcs/VcsProcess.ts";

export interface ExecutionContext {
  readonly workspaceId: WorkspaceId;
  readonly rootPath: string;
  readonly gitCommonDir: string;
  readonly headRef: string | null;
  readonly headCommit: string;
}

export interface StoredExecutionContext extends ExecutionContext {
  readonly checkpointOid: string | null;
}

class GitCheckoutIdentityUnavailable extends Error {
  readonly _tag = "GitCheckoutIdentityUnavailable";
}
class ExecutionContextConflict extends Error {
  readonly _tag = "ExecutionContextConflict";
}

type ExecutionContextError =
  | VcsError
  | PlatformError.PlatformError
  | SqlError.SqlError
  | GitCheckoutIdentityUnavailable
  | ExecutionContextConflict;

export class ExecutionContextStore extends Context.Service<
  ExecutionContextStore,
  {
    readonly inspect: (
      cwd: string,
      workspaceId: WorkspaceId,
    ) => Effect.Effect<ExecutionContext, ExecutionContextError>;
    readonly remember: (
      threadId: ThreadId,
      key: string,
      context: ExecutionContext,
      checkpointOid?: string | null,
    ) => Effect.Effect<void, ExecutionContextError>;
    readonly find: (
      threadId: ThreadId,
      key: string,
    ) => Effect.Effect<StoredExecutionContext | undefined, ExecutionContextError>;
    readonly oidForRef: (
      cwd: string,
      ref: CheckpointRef,
    ) => Effect.Effect<string | null, ExecutionContextError>;
    readonly forget: (
      threadId: ThreadId,
      keys: ReadonlyArray<string>,
    ) => Effect.Effect<void, ExecutionContextError>;
    readonly compatible: (
      saved: ExecutionContext,
      current: ExecutionContext,
    ) => Effect.Effect<boolean, ExecutionContextError>;
  }
>()("@awen/server/checkpointing/ExecutionContext/ExecutionContextStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const vcs = yield* VcsProcess;
  const fs = yield* FileSystem.FileSystem;

  const git = (cwd: string, args: ReadonlyArray<string>, allowNonZeroExit = false) =>
    vcs.run({
      operation: "checkpoint.executionContext",
      command: "git",
      cwd,
      args,
      allowNonZeroExit,
    });

  const inspect = Effect.fn("ExecutionContext.inspect")(function* (
    cwd: string,
    workspaceId: WorkspaceId,
  ) {
    const root = (yield* git(cwd, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const common = (yield* git(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ])).stdout.trim();
    const ref = yield* git(cwd, ["symbolic-ref", "-q", "HEAD"], true);
    const commit = (yield* git(cwd, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    if (!root || !common || !commit) {
      return yield* Effect.fail(
        new GitCheckoutIdentityUnavailable("Git checkout identity is unavailable."),
      );
    }
    return {
      workspaceId,
      rootPath: yield* fs.realPath(root),
      gitCommonDir: yield* fs.realPath(common),
      headRef: ref.exitCode === 0 ? ref.stdout.trim() : null,
      headCommit: commit,
    } satisfies ExecutionContext;
  });

  const oidForRef = Effect.fn("ExecutionContext.oidForRef")(function* (
    cwd: string,
    ref: CheckpointRef,
  ) {
    const result = yield* git(cwd, ["rev-parse", "--verify", ref], true);
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  });

  const remember = Effect.fn("ExecutionContext.remember")(function* (
    threadId: ThreadId,
    key: string,
    context: ExecutionContext,
    checkpointOid: string | null = null,
  ) {
    yield* sql`
      INSERT INTO checkpoint_execution_contexts
        (thread_id, context_key, workspace_id, root_path, git_common_dir, head_ref, head_commit, checkpoint_oid)
      VALUES
        (${threadId}, ${key}, ${context.workspaceId}, ${context.rootPath}, ${context.gitCommonDir}, ${context.headRef}, ${context.headCommit}, ${checkpointOid})
      ON CONFLICT (thread_id, context_key) DO NOTHING
    `;
    const saved = yield* find(threadId, key);
    if (
      !saved ||
      saved.workspaceId !== context.workspaceId ||
      saved.rootPath !== context.rootPath ||
      saved.gitCommonDir !== context.gitCommonDir ||
      saved.headRef !== context.headRef ||
      saved.headCommit !== context.headCommit ||
      saved.checkpointOid !== checkpointOid
    ) {
      return yield* Effect.fail(
        new ExecutionContextConflict("Checkpoint context conflicts with its original checkout."),
      );
    }
  });

  const find = Effect.fn("ExecutionContext.find")(function* (threadId: ThreadId, key: string) {
    const rows = yield* sql<{
      readonly workspaceId: string;
      readonly rootPath: string;
      readonly gitCommonDir: string;
      readonly headRef: string | null;
      readonly headCommit: string;
      readonly checkpointOid: string | null;
    }>`
      SELECT workspace_id AS "workspaceId", root_path AS "rootPath",
        git_common_dir AS "gitCommonDir", head_ref AS "headRef", head_commit AS "headCommit",
        checkpoint_oid AS "checkpointOid"
      FROM checkpoint_execution_contexts
      WHERE thread_id = ${threadId} AND context_key = ${key}
    `;
    const row = rows[0];
    return row ? { ...row, workspaceId: WorkspaceId.make(row.workspaceId) } : undefined;
  });

  const forget = Effect.fn("ExecutionContext.forget")(function* (
    threadId: ThreadId,
    keys: ReadonlyArray<string>,
  ) {
    for (const key of keys) {
      yield* sql`DELETE FROM checkpoint_execution_contexts WHERE thread_id = ${threadId} AND context_key = ${key}`;
    }
  });

  const compatible = Effect.fn("ExecutionContext.compatible")(function* (
    saved: ExecutionContext,
    current: ExecutionContext,
  ) {
    if (
      saved.workspaceId !== current.workspaceId ||
      saved.rootPath !== current.rootPath ||
      saved.gitCommonDir !== current.gitCommonDir
    )
      return false;
    if (saved.headRef === null && current.headRef === null) {
      return saved.headCommit === current.headCommit;
    }
    const ancestry = yield* git(
      current.rootPath,
      ["merge-base", "--is-ancestor", saved.headCommit, current.headCommit],
      true,
    );
    if (ancestry.exitCode !== 0) return false;
    return saved.headRef === current.headRef;
  });

  return { inspect, remember, find, forget, compatible, oidForRef };
});

export const layer = Layer.effect(ExecutionContextStore, make);
