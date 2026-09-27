import { describe, expect, it } from "vite-plus/test";

import type {
  AwenProjectId,
  AgentSessionId,
  EnvironmentId,
  ProjectId,
  TerminalSessionId,
  ThreadId,
  WorkspaceId,
} from "@awen/contracts";
import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";

import { deepLinkInputFromParams, resolveDeepLink, sessionRouteForTarget } from "./deepLinks";

const ENV: EnvironmentId = "env-a" as EnvironmentId;
const WS: WorkspaceId = "ws-a" as WorkspaceId;
const AGENT: AgentSessionId = "thread-x" as AgentSessionId;
const TERMINAL: TerminalSessionId = "terminal-x" as TerminalSessionId;
const THREAD: ThreadId = "thread-x" as ThreadId;
const PROJECT_ID: ProjectId = "project-a" as ProjectId;
const AWEN_PROJECT_ID: AwenProjectId = "awen-project-a" as AwenProjectId;

const ENVIRONMENT_READY = {
  catalogReady: true,
  environmentExists: true,
  environmentEnabled: true,
  environmentSnapshotPresent: true,
};

function project(
  workspaces: ReadonlyArray<{
    readonly id: WorkspaceId;
    readonly sessions?: EnvironmentAwenProject["workspaces"][number]["sessions"];
    readonly historySessions?: EnvironmentAwenProject["workspaces"][number]["historySessions"];
  }>,
): EnvironmentAwenProject {
  return {
    id: AWEN_PROJECT_ID,
    environmentId: ENV,
    title: "Project A",
    workspaces: workspaces.map((workspace) => ({
      id: workspace.id,
      projectId: AWEN_PROJECT_ID,
      awenProjectId: PROJECT_ID,
      title: "Workspace",
      workspaceRoot: "/tmp/a",
      role: "main" as const,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
      ...(workspace.sessions ? { sessions: workspace.sessions } : {}),
      ...(workspace.historySessions ? { historySessions: workspace.historySessions } : {}),
    })),
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

const agentTarget = {
  kind: "agentSession",
  environmentId: ENV,
  agentSessionId: AGENT,
} as const;

const terminalTarget = {
  kind: "workspaceTerminal",
  environmentId: ENV,
  terminalSessionId: TERMINAL,
} as const;

describe("canonical Session links", () => {
  it("addresses both Session kinds without a Workspace", () => {
    expect(sessionRouteForTarget(agentTarget)).toEqual({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENV, threadId: AGENT },
    });
    expect(sessionRouteForTarget(terminalTarget)).toEqual({
      to: "/$environmentId/terminal-sessions/$terminalSessionId",
      params: { environmentId: ENV, terminalSessionId: TERMINAL },
    });
  });

  it("parses canonical links and rejects mixed identities", () => {
    expect(deepLinkInputFromParams({ environmentId: ENV, threadId: THREAD })).toEqual({
      kind: "agentSession",
      environmentId: ENV,
      threadId: THREAD,
    });
    expect(deepLinkInputFromParams({ environmentId: ENV, terminalSessionId: TERMINAL })).toEqual({
      kind: "workspaceTerminal",
      environmentId: ENV,
      terminalSessionId: TERMINAL,
    });
    expect(
      deepLinkInputFromParams({
        environmentId: ENV,
        workspaceId: WS,
        terminalSessionId: TERMINAL,
      }),
    ).toBeNull();
    expect(
      deepLinkInputFromParams({
        environmentId: ENV,
        workspaceId: WS,
        threadId: THREAD,
      }),
    ).toBeNull();
    expect(deepLinkInputFromParams({ environmentId: ENV, workspaceId: WS })).toBeNull();
  });
});

describe("resolving Session links", () => {
  const assignedWorkspace = "ws-moved" as WorkspaceId;
  const projects = [
    project([
      {
        id: WS,
        sessions: [
          {
            kind: "terminal",
            id: TERMINAL,
            workspaceId: WS,
            title: "Terminal",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
      {
        id: assignedWorkspace,
        sessions: [
          {
            kind: "agent",
            id: AGENT,
            workspaceId: assignedWorkspace,
            threadId: THREAD,
            title: "Agent",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
        historySessions: [
          {
            kind: "agent",
            id: "closed-thread" as AgentSessionId,
            workspaceId: assignedWorkspace,
            threadId: "closed-thread" as ThreadId,
            title: "Closed Agent",
            status: "closed",
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      },
    ]),
  ];

  it("waits for the environment snapshot", () => {
    const input = deepLinkInputFromParams({ environmentId: ENV, threadId: THREAD });
    expect(
      resolveDeepLink(
        input,
        projects,
        {
          ...ENVIRONMENT_READY,
          environmentSnapshotPresent: false,
        },
        [],
      ),
    ).toEqual({ state: "pending" });
  });

  it("reopens the same Agent Session after its Workspace changes", () => {
    expect(
      resolveDeepLink(
        deepLinkInputFromParams({ environmentId: ENV, threadId: THREAD }),
        projects,
        ENVIRONMENT_READY,
        [],
      ),
    ).toMatchObject({ state: "ready", target: agentTarget });
    expect(
      resolveDeepLink(
        deepLinkInputFromParams({ environmentId: ENV, threadId: "closed-thread" }),
        projects,
        ENVIRONMENT_READY,
        [],
      ),
    ).toMatchObject({ state: "ready", target: { agentSessionId: "closed-thread" } });
  });

  it("resolves a Terminal Session from its stable id and current assignment", () => {
    expect(
      resolveDeepLink(
        deepLinkInputFromParams({ environmentId: ENV, terminalSessionId: TERMINAL }),
        projects,
        ENVIRONMENT_READY,
        [],
      ),
    ).toMatchObject({
      state: "ready",
      target: {
        kind: "workspaceTerminal",
        environmentId: ENV,
        terminalSessionId: TERMINAL,
        workspaceId: WS,
      },
    });
  });

  it("resolves an unassigned Terminal Session from the metadata stream", () => {
    const unassigned = {
      kind: "workspaceTerminal",
      environmentId: ENV,
      terminalSessionId: TERMINAL,
    } as const;
    expect(
      resolveDeepLink(
        deepLinkInputFromParams({ environmentId: ENV, terminalSessionId: TERMINAL }),
        projects,
        ENVIRONMENT_READY,
        [
          {
            terminalId: TERMINAL,
            sessionId: TERMINAL,
            kind: "terminal",
            cwd: "/tmp/a",
            worktreePath: null,
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: "2026-01-01T00:00:00Z",
          },
        ],
      ),
    ).toMatchObject({ state: "ready", target: unassigned });
  });

  it("reports a missing Session without requiring its old Workspace", () => {
    expect(
      resolveDeepLink(
        deepLinkInputFromParams({ environmentId: ENV, threadId: "missing" }),
        projects,
        ENVIRONMENT_READY,
        [],
      ),
    ).toEqual({ state: "missing", reason: "session" });
    expect(
      resolveDeepLink(
        deepLinkInputFromParams({
          environmentId: ENV,
          terminalSessionId: "missing" as TerminalSessionId,
        }),
        projects,
        ENVIRONMENT_READY,
        [],
      ),
    ).toEqual({ state: "missing", reason: "session" });
  });
});
