import {
  AwenProjectId,
  AgentSessionId,
  ThreadId,
  type TerminalSummary,
  EnvironmentId,
  ProjectId,
  WorkspaceId,
  TerminalSessionId,
  type OrchestrationShellSnapshot,
} from "@awen/contracts";
import { describe, expect, it } from "@effect/vitest";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentCatalogState } from "./connections.ts";
import { createEnvironmentWorkspaceAtoms } from "./workspaceEntities.ts";

const LOCAL = EnvironmentId.make("daemon-local");
const REMOTE = EnvironmentId.make("daemon-remote");
const AWEN_PROJECT_ID = AwenProjectId.make("awen-project:shared-local-id");
const WORKSPACE_ID = WorkspaceId.make("workspace:shared-local-id");
const PROJECT_ID = ProjectId.make("shared-local-id");

function snapshot(title: string): OrchestrationShellSnapshot {
  return {
    snapshotSequence: 1,
    projects: [],
    threads: [],
    awenProjects: [
      {
        id: AWEN_PROJECT_ID,
        title,
        workspaces: [
          {
            id: WORKSPACE_ID,
            projectId: AWEN_PROJECT_ID,
            awenProjectId: PROJECT_ID,
            title,
            workspaceRoot: "/same/path/on/both/daemons",
            role: "main",
            createdAt: "2026-09-18T00:00:00Z",
            updatedAt: "2026-09-18T00:00:00Z",
          },
        ],
        createdAt: "2026-09-18T00:00:00Z",
        updatedAt: "2026-09-18T00:00:00Z",
      },
    ],
    updatedAt: "2026-09-18T00:00:00Z",
  };
}

describe("environment Awen workspace entities", () => {
  it("keeps identical local ids and paths scoped to their daemon", () => {
    const snapshotAtoms = Atom.family((environmentId: EnvironmentId) =>
      Atom.make<OrchestrationShellSnapshot | null>(
        environmentId === LOCAL ? snapshot("Local checkout") : snapshot("Remote checkout"),
      ),
    );
    const catalogValueAtom = Atom.make({
      isReady: true,
      entries: new Map([
        [LOCAL, { enabled: true }],
        [REMOTE, { enabled: true }],
      ]),
    } as unknown as EnvironmentCatalogState);
    const workspaceEntities = createEnvironmentWorkspaceAtoms({
      catalogValueAtom,
      snapshotAtom: snapshotAtoms,
    });
    const registry = AtomRegistry.make();

    const projects = registry.get(workspaceEntities.awenProjectsAtom);
    expect(projects).toHaveLength(2);
    expect(projects.map((project) => [project.environmentId, project.id])).toEqual([
      [LOCAL, AWEN_PROJECT_ID],
      [REMOTE, AWEN_PROJECT_ID],
    ]);
    expect(
      registry.get(
        workspaceEntities.workspaceAtom({ environmentId: LOCAL, workspaceId: WORKSPACE_ID }),
      ),
    ).toMatchObject({ environmentId: LOCAL, title: "Local checkout" });
    expect(
      registry.get(
        workspaceEntities.workspaceAtom({ environmentId: REMOTE, workspaceId: WORKSPACE_ID }),
      ),
    ).toMatchObject({ environmentId: REMOTE, title: "Remote checkout" });

    registry.dispose();
  });
});

it("projects live Terminal Sessions beside Agent Sessions and removes only the terminal on close", () => {
  const shell = snapshot("Project");
  const workspace = shell.awenProjects![0]!.workspaces[0]!;
  const agent = {
    kind: "agent" as const,
    id: AgentSessionId.make("agent-1"),
    workspaceId: WORKSPACE_ID,
    threadId: ThreadId.make("thread-1"),
    title: "Agent",
    createdAt: workspace.createdAt,
    updatedAt: workspace.updatedAt,
  };
  const snapshotAtom = Atom.make<OrchestrationShellSnapshot | null>({
    ...shell,
    awenProjects: [
      { ...shell.awenProjects![0]!, workspaces: [{ ...workspace, sessions: [agent] }] },
    ],
  });
  const terminal: TerminalSummary = {
    workspaceId: WORKSPACE_ID,
    terminalId: "term-1",
    sessionId: TerminalSessionId.make("term-1"),
    kind: "terminal",
    cwd: workspace.workspaceRoot,
    worktreePath: null,
    status: "running",
    pid: 42,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "zsh",
    title: "Primary shell",
    updatedAt: workspace.updatedAt,
  };
  const metadata = Atom.make<ReadonlyArray<TerminalSummary> | null>([terminal]);
  const entities = createEnvironmentWorkspaceAtoms({
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([[LOCAL, { enabled: true }]]),
    } as unknown as EnvironmentCatalogState),
    snapshotAtom: () => snapshotAtom,
    terminalMetadataAtom: () => metadata,
  });
  const registry = AtomRegistry.make();
  const atom = entities.workspaceAtom({ environmentId: LOCAL, workspaceId: WORKSPACE_ID });
  const unmount = registry.mount(atom);
  expect(registry.get(atom)?.sessions).toEqual([
    agent,
    {
      kind: "terminal",
      id: TerminalSessionId.make("term-1"),
      workspaceId: WORKSPACE_ID,
      title: "Primary shell",
      status: "open",
      createdAt: workspace.updatedAt,
      updatedAt: workspace.updatedAt,
    },
  ]);
  registry.set(metadata, []);
  expect(registry.get(atom)?.sessions).toEqual([agent]);
  unmount();
  registry.dispose();
});

it("lists unassigned non-closed terminals per Environment", () => {
  const makeTerminal = (
    terminalId: string,
    overrides: Partial<TerminalSummary> = {},
  ): TerminalSummary => ({
    terminalId,
    sessionId: TerminalSessionId.make(terminalId),
    kind: "terminal",
    cwd: "/tmp/somewhere",
    worktreePath: null,
    status: "running",
    pid: 42,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "zsh",
    updatedAt: "2026-09-18T00:00:00Z",
    ...overrides,
  });

  const localMetadata = Atom.make<ReadonlyArray<TerminalSummary> | null>([
    makeTerminal("term-local-unassigned"),
    makeTerminal("term-local-assigned", { workspaceId: WORKSPACE_ID }),
    makeTerminal("term-local-closed", { status: "closed" }),
  ]);
  const remoteMetadata = Atom.make<ReadonlyArray<TerminalSummary> | null>([
    makeTerminal("term-remote-unassigned"),
  ]);
  const entities = createEnvironmentWorkspaceAtoms({
    catalogValueAtom: Atom.make({
      isReady: true,
      entries: new Map([
        [LOCAL, { enabled: true }],
        [REMOTE, { enabled: true }],
      ]),
    } as unknown as EnvironmentCatalogState),
    snapshotAtom: () => Atom.make<OrchestrationShellSnapshot | null>(null),
    terminalMetadataAtom: (environmentId) =>
      environmentId === LOCAL ? localMetadata : remoteMetadata,
  });
  const registry = AtomRegistry.make();

  expect(
    registry
      .get(entities.environmentUnassignedTerminalsAtom(LOCAL))
      .map((entry) => [entry.environmentId, entry.summary.terminalId]),
  ).toEqual([[LOCAL, "term-local-unassigned"]]);
  expect(
    registry
      .get(entities.unassignedTerminalsAtom)
      .map((entry) => [entry.environmentId, entry.summary.terminalId]),
  ).toEqual([
    [LOCAL, "term-local-unassigned"],
    [REMOTE, "term-remote-unassigned"],
  ]);

  registry.set(localMetadata, [
    makeTerminal("term-local-unassigned", { workspaceId: WORKSPACE_ID }),
  ]);
  expect(registry.get(entities.environmentUnassignedTerminalsAtom(LOCAL))).toEqual([]);

  registry.dispose();
});
