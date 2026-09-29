import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => {
  let nextId = 0;
  const create = vi.fn(async () => ({ _tag: "Success", value: {} }));
  const openTarget = vi.fn();
  const navigate = vi.fn(async () => undefined);
  const setWorkspaceDraftThreadId = vi.fn();
  const clearDraftThread = vi.fn();
  const store = {
    setWorkspaceDraftThreadId,
    clearDraftThread,
    applyStickyState: vi.fn(),
    setModelSelection: vi.fn(),
  };
  return {
    create,
    openTarget,
    navigate,
    store,
    nextThreadId: () => `thread-${++nextId}`,
    reset: () => {
      nextId = 0;
      create.mockReset().mockResolvedValue({ _tag: "Success", value: {} });
      openTarget.mockReset();
      navigate.mockReset().mockResolvedValue(undefined);
      setWorkspaceDraftThreadId.mockReset();
      clearDraftThread.mockReset();
      store.applyStickyState.mockReset();
      store.setModelSelection.mockReset();
    },
  };
});

vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () =>
    new Map([
      [
        "env",
        {
          settings: {
            defaultThreadEnvMode: "local",
            newWorktreesStartFromOrigin: false,
            defaultModelSelection: null,
            defaultRuntimeMode: "full-access",
          },
        },
      ],
    ]),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => ({ state: { matches: [{ params: {} }] }, navigate: state.navigate }),
}));
vi.mock("../composerDraftStore", () => ({
  DraftId: { make: (value: string) => value },
  useComposerDraftStore: Object.assign(() => null, { getState: () => state.store }),
}));
vi.mock("../lib/utils", () => ({
  newThreadId: () => state.nextThreadId(),
  randomHex: () => "12345678",
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    { id: "project", environmentId: "env", workspaceRoot: "/project" },
    { id: "project-test", environmentId: "env", workspaceRoot: "/project-test" },
  ],
  readThreadShell: () => null,
  useAwenProjects: () => [
    {
      environmentId: "env",
      workspaces: [
        {
          id: "workspace",
          awenProjectId: "project",
          workspaceRoot: "/project",
          role: "main",
        },
        {
          id: "workspace-test",
          awenProjectId: "project-test",
          workspaceRoot: "/project-test",
          role: "worktree",
        },
      ],
    },
  ],
}));
vi.mock("@awen/shared/projectSettings", () => ({
  resolveProjectSettings: (settings: Record<string, unknown>) => ({
    settings,
    sources: { defaultThreadEnvMode: "environment" },
  }),
}));
vi.mock("@awen/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: ({ globalDefault }: { globalDefault: string }) => globalDefault,
}));
vi.mock("../lib/awenProjectFileDefaults", () => ({
  readAwenProjectFileDefaultThreadEnvMode: async () => null,
}));
vi.mock("../lib/chatThreadActions", () => ({
  resolveNewDraftStartFromOrigin: () => false,
}));
vi.mock("../providerInstances", () => ({
  NO_PROVIDER_MODEL_SELECTION: { instanceId: "none", model: "" },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.create }));
vi.mock("../state/threads", () => ({ threadEnvironment: { create: "create" } }));
vi.mock("../workbench/workbenchStore", () => ({
  useWorkbenchStore: Object.assign(() => null, {
    getState: () => ({ openTarget: state.openTarget }),
  }),
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));

import { useNewThreadHandler } from "./useHandleNewThread";

const projectRef = { environmentId: "env", projectId: "project" } as never;

beforeEach(() => state.reset());

describe("creating Agent Sessions", () => {
  it("creates two durable empty Sessions and opens each by its stable Thread identity", async () => {
    const createSession = useNewThreadHandler();
    const first = await createSession(projectRef);
    const second = await createSession(projectRef);

    expect(first?.threadId).toBe("thread-1");
    expect(second?.threadId).toBe("thread-2");
    expect(state.create).toHaveBeenCalledTimes(2);
    expect(state.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: expect.objectContaining({ threadId: "thread-1", worktreePath: null }),
      }),
    );
    expect(state.openTarget).toHaveBeenNthCalledWith(1, {
      kind: "agentSession",
      environmentId: "env",
      agentSessionId: "thread-1",
    });
    expect(state.openTarget).toHaveBeenNthCalledWith(2, {
      kind: "agentSession",
      environmentId: "env",
      agentSessionId: "thread-2",
    });
    expect(state.navigate).toHaveBeenLastCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "env", threadId: "thread-2" },
      replace: false,
    });
    expect(state.store.setWorkspaceDraftThreadId).toHaveBeenCalledTimes(2);
  });

  it("keeps pending send options on the same Thread and does not open a failed Session", async () => {
    const createSession = useNewThreadHandler();
    const created = await createSession(projectRef, { envMode: "worktree", startFromOrigin: true });
    expect(state.store.setWorkspaceDraftThreadId).toHaveBeenCalledWith(
      "workspace",
      projectRef,
      created?.draftId,
      expect.objectContaining({
        threadId: created?.threadId,
        envMode: "worktree",
        startFromOrigin: true,
      }),
    );
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ threadId: created?.threadId, worktreePath: null }),
      }),
    );
    state.create.mockResolvedValueOnce({ _tag: "Failure", cause: new Error("offline") } as never);
    await expect(createSession(projectRef)).rejects.toBeDefined();
    expect(state.store.clearDraftThread).toHaveBeenCalledWith("thread-2");
    expect(state.openTarget).toHaveBeenCalledTimes(1);
  });

  it("binds a new Session to the selected sibling Workspace identity", async () => {
    const createSession = useNewThreadHandler();
    await createSession(projectRef, { worktreePath: "/project-test", branch: "test" });
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          projectId: "project-test",
          worktreePath: "/project-test",
        }),
      }),
    );
    expect(state.store.setWorkspaceDraftThreadId).toHaveBeenCalledWith(
      "workspace-test",
      { environmentId: "env", projectId: "project-test" },
      expect.anything(),
      expect.anything(),
    );
  });
});
