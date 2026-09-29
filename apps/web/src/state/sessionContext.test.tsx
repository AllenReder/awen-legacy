import { describe, expect, it, vi } from "vite-plus/test";
import { act } from "react";
import { create } from "react-test-renderer";
import {
  AwenProjectId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  workspaceIdForAwenProject,
  type ScopedThreadRef,
} from "@awen/contracts";
import { useSessionExecutionContext } from "./sessionContext";

const envId = EnvironmentId.make("local");
const mainProjectId = ProjectId.make("main-project");
const testProjectId = ProjectId.make("test-project");
const awenProjectId = AwenProjectId.make("awen-project");

const mainWorkspace = {
  id: workspaceIdForAwenProject(mainProjectId),
  projectId: awenProjectId,
  awenProjectId: mainProjectId,
  title: "main",
  workspaceRoot: "/workspace/main",
  role: "main" as const,
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
};

const testWorkspace = {
  id: workspaceIdForAwenProject(testProjectId),
  projectId: awenProjectId,
  awenProjectId: testProjectId,
  title: "test",
  workspaceRoot: "/workspace/test",
  role: "worktree" as const,
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
};

const project = {
  id: awenProjectId,
  title: "Repo",
  environmentId: envId,
  workspaces: [mainWorkspace, testWorkspace],
  createdAt: mainWorkspace.createdAt,
  updatedAt: mainWorkspace.updatedAt,
};

let currentThreadShell: any = null;

vi.mock("./entities", () => ({
  useThreadShell: () => currentThreadShell,
  useAwenProjects: () => [project],
}));

function renderSessionContext(
  ref: ScopedThreadRef | null,
  proposedAssignment?: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  } | null,
) {
  let context: ReturnType<typeof useSessionExecutionContext> | null = null;
  function TestComponent() {
    context = useSessionExecutionContext(ref, proposedAssignment);
    return null;
  }
  act(() => {
    create(<TestComponent />);
  });
  return context!;
}

describe("useSessionExecutionContext", () => {
  const threadRef: ScopedThreadRef = {
    environmentId: envId,
    threadId: ThreadId.make("session-1"),
  };

  it("resolves the main checkout when committed to main, ignoring stale test draft paths", () => {
    // Session was born in test worktree, so draft context still holds test worktreePath
    const staleDraftContext = {
      environmentId: envId,
      projectId: testProjectId,
      worktreePath: "/workspace/test",
    };

    // Server has committed assignment to main checkout
    currentThreadShell = {
      environmentId: envId,
      id: threadRef.threadId,
      projectId: mainProjectId,
      worktreePath: null,
    };

    const result = renderSessionContext(threadRef, staleDraftContext);

    expect(result.workspace?.id).toBe(mainWorkspace.id);
    expect(result.cwd).toBe("/workspace/main");
    expect(result.worktreePath).toBeNull();
  });

  it("resolves the worktree checkout when committed to test worktree", () => {
    currentThreadShell = {
      environmentId: envId,
      id: threadRef.threadId,
      projectId: testProjectId,
      worktreePath: "/workspace/test",
    };

    const result = renderSessionContext(threadRef);

    expect(result.workspace?.id).toBe(testWorkspace.id);
    expect(result.cwd).toBe("/workspace/test");
    expect(result.worktreePath).toBe("/workspace/test");
  });

  it("follows migration back and forth between main and test workspaces", () => {
    const staleDraftContext = {
      environmentId: envId,
      projectId: testProjectId,
      worktreePath: "/workspace/test",
    };

    // 1. In test worktree
    currentThreadShell = {
      environmentId: envId,
      id: threadRef.threadId,
      projectId: testProjectId,
      worktreePath: "/workspace/test",
    };
    let result = renderSessionContext(threadRef, staleDraftContext);
    expect(result.cwd).toBe("/workspace/test");
    expect(result.worktreePath).toBe("/workspace/test");

    // 2. Migrated back to main checkout
    currentThreadShell = {
      environmentId: envId,
      id: threadRef.threadId,
      projectId: mainProjectId,
      worktreePath: null,
    };
    result = renderSessionContext(threadRef, staleDraftContext);
    expect(result.cwd).toBe("/workspace/main");
    expect(result.worktreePath).toBeNull();

    // 3. Migrated back to test worktree
    currentThreadShell = {
      environmentId: envId,
      id: threadRef.threadId,
      projectId: testProjectId,
      worktreePath: "/workspace/test",
    };
    result = renderSessionContext(threadRef, staleDraftContext);
    expect(result.cwd).toBe("/workspace/test");
    expect(result.worktreePath).toBe("/workspace/test");
  });

  it("falls back to proposedAssignment when server thread does not exist yet (pre-send draft)", () => {
    currentThreadShell = null;

    const draftAssignment = {
      environmentId: envId,
      projectId: testProjectId,
    };

    const result = renderSessionContext(threadRef, draftAssignment);
    expect(result.workspace?.id).toBe(testWorkspace.id);
    expect(result.cwd).toBe("/workspace/test");
    expect(result.worktreePath).toBe("/workspace/test");
  });

  it("returns null for cwd and worktreePath when neither server thread nor proposed assignment exists", () => {
    currentThreadShell = null;

    const result = renderSessionContext(null);
    expect(result.thread).toBeNull();
    expect(result.workspace).toBeNull();
    expect(result.cwd).toBeNull();
    expect(result.worktreePath).toBeNull();
  });
});
