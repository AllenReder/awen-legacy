import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProjectId,
  AwenProjectId,
  ThreadId,
  workspaceIdForAwenProject,
} from "@awen/contracts";
import type { OrchestrationShellSnapshot, OrchestrationThreadShell } from "@awen/contracts";
import { resolveSessionWorkspace } from "./sessionContext.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";

const environmentId = EnvironmentId.make("local");
const main = ProjectId.make("main-checkout");
const test = ProjectId.make("test-checkout");
const projectId = AwenProjectId.make("project");
const workspaces = [main, test].map((id) => ({
  id: workspaceIdForAwenProject(id),
  projectId,
  awenProjectId: id,
  title: id,
  workspaceRoot: id === main ? "/repo" : "/repo-test",
  role: id === main ? ("main" as const) : ("worktree" as const),
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
}));
const project = {
  id: projectId,
  title: "Project",
  workspaces,
  createdAt: workspaces[0]!.createdAt,
  updatedAt: workspaces[0]!.updatedAt,
};

describe("Session Workspace authority", () => {
  it.each([main, test])(
    "follows shell commits in both directions from %s, ignoring old execution paths",
    (birth) => {
      let snapshot = {
        snapshotSequence: 0,
        projects: [],
        threads: [],
        awenProjects: [project],
        updatedAt: project.updatedAt,
      } as OrchestrationShellSnapshot;
      const staleDraft = { worktreePath: birth === test ? "/repo-test" : null };
      for (const [sequence, target] of [birth, test, main, test, main].entries()) {
        const thread = {
          id: ThreadId.make("session"),
          projectId: target,
          worktreePath: staleDraft.worktreePath,
        } as OrchestrationThreadShell;
        snapshot = applyShellStreamEvent(snapshot, {
          kind: "thread-upserted",
          sequence: sequence + 1,
          thread,
          awenProject: project,
        });
        const context = resolveSessionWorkspace(
          snapshot.awenProjects!.map((p) => ({ ...p, environmentId })),
          { ...snapshot.threads[0]!, environmentId },
        );
        expect(context?.id).toBe(workspaceIdForAwenProject(target));
        expect(context?.workspaceRoot).toBe(target === main ? "/repo" : "/repo-test");
      }
    },
  );

  it("does not fall back across environments or invent a directory while its Workspace is missing", () => {
    expect(
      resolveSessionWorkspace([{ ...project, environmentId }], {
        environmentId: EnvironmentId.make("remote"),
        projectId: main,
      }),
    ).toBeNull();
    expect(resolveSessionWorkspace([], { environmentId, projectId: test })).toBeNull();
  });
});
