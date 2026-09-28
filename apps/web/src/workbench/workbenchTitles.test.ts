import { describe, expect, it } from "vite-plus/test";
import type {
  AwenProjectId,
  AgentSessionId,
  EnvironmentId,
  TerminalSessionId,
  WorkspaceId,
} from "@awen/contracts";

import type { EnvironmentAwenProject } from "@awen/client-runtime/state/models";
import type { ViewTarget } from "./viewRegistry";
import {
  resolveTargetBreadcrumbs,
  resolveTargetContext,
  resolveTargetTitle,
} from "./workbenchTitles";

const environmentId = "env-a" as EnvironmentId;
const workspaceId = "ws-a" as WorkspaceId;
const projectId = "project-a" as AwenProjectId;
const agentSessionId = "agent-a" as AgentSessionId;
const terminalSessionId = "terminal-a" as TerminalSessionId;
const now = "2026-09-20T00:00:00.000Z";
const agentTarget = {
  kind: "agentSession",
  environmentId,
  agentSessionId,
} satisfies ViewTarget;

const projects: ReadonlyArray<EnvironmentAwenProject> = [
  {
    id: projectId,
    environmentId,
    title: "Awen",
    createdAt: now,
    updatedAt: now,
    workspaces: [
      {
        id: workspaceId,
        projectId,
        awenProjectId: "awen-project-a" as never,
        title: "Main checkout",
        workspaceRoot: "/workspace",
        role: "main",
        createdAt: now,
        updatedAt: now,
        sessions: [
          {
            kind: "agent",
            id: agentSessionId,
            workspaceId,
            title: "Implement tabs",
            status: "open",
            createdAt: now,
            updatedAt: now,
            threadId: "thread-a" as never,
          },
          {
            kind: "terminal",
            id: terminalSessionId,
            workspaceId,
            title: "Dev server",
            status: "open",
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
    ],
  },
];

describe("resolveTargetTitle", () => {
  it.each([
    [
      {
        kind: "workspace",
        definitionId: "fileView",
        environmentId,
        workspaceId,
      } satisfies ViewTarget,
      "Main checkout: Files",
    ],
    [{ kind: "project", environmentId, projectId } satisfies ViewTarget, "Awen"],
    [agentTarget, "Implement tabs"],
    [
      {
        kind: "workspaceTerminal",
        environmentId,
        workspaceId,
        terminalSessionId,
      } satisfies ViewTarget,
      "Dev server",
    ],
  ])("uses projected titles for %#", (target, expected) => {
    expect(resolveTargetTitle(target, projects)).toBe(expected);
  });

  it("resolves titles and breadcrumbs for workspace fileView", () => {
    const fileViewTarget = {
      kind: "workspace",
      definitionId: "fileView",
      environmentId,
      workspaceId,
    } satisfies ViewTarget;

    expect(resolveTargetTitle(fileViewTarget, projects)).toBe("Main checkout: Files");
    expect(resolveTargetBreadcrumbs(fileViewTarget, projects)).toEqual([
      "Awen",
      "Main checkout",
      "Files",
    ]);
  });

  it("resolves titles and breadcrumbs for workspace gitView", () => {
    const gitViewTarget = {
      kind: "workspace",
      definitionId: "gitView",
      environmentId,
      workspaceId,
    } satisfies ViewTarget;

    expect(resolveTargetTitle(gitViewTarget, projects)).toBe("Main checkout: Changes");
    expect(resolveTargetBreadcrumbs(gitViewTarget, projects)).toEqual([
      "Awen",
      "Main checkout",
      "Changes",
    ]);
  });

  it("uses a stable fallback when the target is offline or not present", () => {
    expect(
      resolveTargetTitle(
        {
          kind: "agentSession",
          environmentId,
          agentSessionId: "missing" as AgentSessionId,
        },
        projects,
      ),
    ).toBe("Agent");
  });

  it("resolves the Workspace context separately from the View title", () => {
    expect(resolveTargetContext(agentTarget, projects)).toBe("Main checkout");
  });

  it("builds Project, Workspace, and View breadcrumbs for Session Panes", () => {
    expect(resolveTargetBreadcrumbs(agentTarget, projects)).toEqual([
      "Awen",
      "Main checkout",
      "Implement tabs",
    ]);
    expect(
      resolveTargetBreadcrumbs(
        {
          kind: "workspaceTerminal",
          environmentId,
          workspaceId,
          terminalSessionId,
        } satisfies ViewTarget,
        projects,
      ),
    ).toEqual(["Awen", "Main checkout", "Dev server"]);
  });

  it("keeps stable breadcrumb fallbacks while a target is offline", () => {
    expect(
      resolveTargetBreadcrumbs(
        {
          kind: "agentSession",
          environmentId,
          agentSessionId: "missing" as AgentSessionId,
        },
        projects,
      ),
    ).toEqual(["Project", "Workspace", "Agent"]);
    expect(resolveTargetBreadcrumbs({ kind: "welcome" }, projects)).toEqual(["Welcome"]);
  });
});
