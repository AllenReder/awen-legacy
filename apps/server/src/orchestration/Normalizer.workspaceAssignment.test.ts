import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { resolveThreadMetadataUpdateForNextTurn } from "../../../web/src/components/chat/threadSettings.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";

const testLayer = Layer.mergeAll(
  WorkspacePaths.layer,
  ServerConfig.layerTest(process.cwd(), {
    prefix: "awen-normalizer-workspace-assignment-",
  }),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("normalizeDispatchCommand workspace assignment authority", () => {
  it.effect("refuses a client thread.meta.update that reassigns the Project", () =>
    Effect.gen(function* () {
      const command: ClientOrchestrationCommand = {
        type: "thread.meta.update",
        commandId: CommandId.make("command-1"),
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-2"),
        expectedProjectId: ProjectId.make("project-1"),
      };

      const error = yield* normalizeDispatchCommand(command).pipe(Effect.flip);

      expect(error.message).toContain("awenSession.migrateToWorkspace");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("still normalizes a branch-only thread.meta.update", () =>
    Effect.gen(function* () {
      const command: ClientOrchestrationCommand = {
        type: "thread.meta.update",
        commandId: CommandId.make("command-2"),
        threadId: ThreadId.make("thread-1"),
        branch: "feature",
      };

      const normalized = yield* normalizeDispatchCommand(command);

      expect(normalized.type).toBe("thread.meta.update");
    }).pipe(Effect.provide(testLayer)),
  );
  it.effect("accepts the next send's metadata after an agent switches branches", () =>
    Effect.gen(function* () {
      const update = resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        currentBranch: "main",
        nextBranch: "feature/agent",
      });
      const normalized = yield* normalizeDispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.make("command-after-switch"),
        threadId: ThreadId.make("thread-1"),
        ...update,
      });
      expect(normalized).toMatchObject({ branch: "feature/agent" });
      expect(normalized).not.toHaveProperty("worktreePath");
    }).pipe(Effect.provide(testLayer)),
  );
});
