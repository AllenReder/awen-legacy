import { projectTerminalSessions } from "@awen/contracts";
import type {
  AwenProjectId,
  AwenProjectShell,
  EnvironmentId,
  OrchestrationShellSnapshot,
  WorkspaceId,
  TerminalSummary,
} from "@awen/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentAwenProject } from "./models.ts";
import { enabledEnvironmentIds, type EnvironmentCatalogState } from "./connections.ts";

const EMPTY_PROJECTS: ReadonlyArray<EnvironmentAwenProject> = Object.freeze([]);
const EMPTY_UNASSIGNED_TERMINALS: ReadonlyArray<EnvironmentUnassignedTerminal> = Object.freeze([]);

/**
 * A Terminal Session with no Workspace assignment, shown in its Environment's
 * unassigned group. The assignment is mutable metadata; the identity and any
 * open Pane are unchanged.
 */
export interface EnvironmentUnassignedTerminal {
  readonly environmentId: EnvironmentId;
  readonly summary: TerminalSummary;
}

function snapshotProjects(
  snapshot: OrchestrationShellSnapshot | null,
): ReadonlyArray<AwenProjectShell> {
  return snapshot?.awenProjects ?? EMPTY_PROJECTS;
}

export function createEnvironmentWorkspaceAtoms(input: {
  readonly terminalMetadataAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyArray<TerminalSummary> | null>;
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentAwenProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyArray<EnvironmentAwenProject> =>
      (() => {
        const projects = snapshotProjects(get(input.snapshotAtom(environmentId)));
        const terminals = input.terminalMetadataAtom
          ? get(input.terminalMetadataAtom(environmentId))
          : null;
        return terminals === null ? projects : projectTerminalSessions(projects, terminals);
      })().map((project) => ({
        ...project,
        environmentId,
      })),
    ).pipe(Atom.withLabel(`environment-awen-projects:${environmentId}`)),
  );

  const awenProjectsAtom = Atom.make((get): ReadonlyArray<EnvironmentAwenProject> => {
    const projects: EnvironmentAwenProject[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      projects.push(...get(environmentAwenProjectsAtom(environmentId)));
    }
    return projects.length === 0 ? EMPTY_PROJECTS : projects;
  }).pipe(Atom.withLabel("environment-awen-project-list"));

  const environmentUnassignedTerminalsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyArray<EnvironmentUnassignedTerminal> => {
      const terminals = input.terminalMetadataAtom
        ? get(input.terminalMetadataAtom(environmentId))
        : null;
      if (terminals === null) return EMPTY_UNASSIGNED_TERMINALS;
      const unassigned = terminals.filter(
        (terminal) => terminal.workspaceId === undefined && terminal.status !== "closed",
      );
      return unassigned.length === 0
        ? EMPTY_UNASSIGNED_TERMINALS
        : unassigned.map((summary) => ({ environmentId, summary }));
    }).pipe(Atom.withLabel(`environment-unassigned-terminals:${environmentId}`)),
  );

  const unassignedTerminalsAtom = Atom.make((get): ReadonlyArray<EnvironmentUnassignedTerminal> => {
    const terminals: EnvironmentUnassignedTerminal[] = [];
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      terminals.push(...get(environmentUnassignedTerminalsAtom(environmentId)));
    }
    return terminals.length === 0 ? EMPTY_UNASSIGNED_TERMINALS : terminals;
  }).pipe(Atom.withLabel("environment-unassigned-terminal-list"));

  const awenProjectAtom = Atom.family((key: string) => {
    const [environmentId, projectId] = JSON.parse(key) as [EnvironmentId, AwenProjectId];
    return Atom.make(
      (get) =>
        get(environmentAwenProjectsAtom(environmentId)).find(
          (project) => project.id === projectId,
        ) ?? null,
    ).pipe(Atom.withLabel(`environment-awen-project:${key}`));
  });

  const workspaceAtom = Atom.family((key: string) => {
    const [environmentId, workspaceId] = JSON.parse(key) as [EnvironmentId, WorkspaceId];
    return Atom.make((get) => {
      for (const project of get(environmentAwenProjectsAtom(environmentId))) {
        const workspace = project.workspaces.find((candidate) => candidate.id === workspaceId);
        if (workspace !== undefined) return { ...workspace, environmentId };
      }
      return null;
    }).pipe(Atom.withLabel(`environment-workspace:${key}`));
  });

  return {
    environmentAwenProjectsAtom,
    awenProjectsAtom,
    environmentUnassignedTerminalsAtom,
    unassignedTerminalsAtom,
    awenProjectAtom: (ref: {
      readonly environmentId: EnvironmentId;
      readonly projectId: AwenProjectId;
    }) =>
      awenProjectAtom(
        JSON.stringify([ref.environmentId, ref.projectId] satisfies ReadonlyArray<string>),
      ),
    workspaceAtom: (ref: {
      readonly environmentId: EnvironmentId;
      readonly workspaceId: WorkspaceId;
    }) =>
      workspaceAtom(
        JSON.stringify([ref.environmentId, ref.workspaceId] satisfies ReadonlyArray<string>),
      ),
  };
}
