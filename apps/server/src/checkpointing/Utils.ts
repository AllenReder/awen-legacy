import * as Encoding from "effect/Encoding";
import { CheckpointRef, ProjectId, type ThreadId, type TurnId } from "@awen/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/awen/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function checkpointBaselineRefForTurn(threadId: ThreadId, turnId: TurnId): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/baseline/${Encoding.encodeBase64Url(turnId)}`,
  );
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
