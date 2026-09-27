import {
  AwenAgentSessionShell,
  AwenProjectId,
  AwenProjectShell,
  AwenSessionShell,
  AwenWorkspaceShell,
  AgentSessionId,
  ProjectId,
  ThreadId,
  WorkspaceId,
  WorkspaceOrigin,
  WorkspaceRole,
  IsoDateTime,
  TrimmedNonEmptyString,
} from "@awen/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionAwenProjectRow = Schema.Struct({
  awenProjectId: AwenProjectId,
  projectTitle: TrimmedNonEmptyString,
  projectCreatedAt: IsoDateTime,
  projectUpdatedAt: IsoDateTime,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  workspaceTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  workspaceRole: WorkspaceRole,
  workspaceOrigin: Schema.NullOr(WorkspaceOrigin),
  workspaceCreatedAt: IsoDateTime,
  workspaceUpdatedAt: IsoDateTime,
});
export type ProjectionAwenProjectRow = typeof ProjectionAwenProjectRow.Type;

export const ProjectionAwenAgentSessionRow = Schema.Struct({
  agentSessionId: AgentSessionId,
  workspaceId: WorkspaceId,
  projectId: ProjectId,
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type ProjectionAwenAgentSessionRow = typeof ProjectionAwenAgentSessionRow.Type;

export interface UpsertProjectionAwenProjectInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Attach the Workspace to this existing Awen Project instead of deriving a
   * fresh `awen-project:<awenProjectId>` Project. Set by the workspace
   * management flows; absent for legacy project registration.
   */
  readonly awenProjectId?: AwenProjectId;
  /** Defaults to "main" when the Workspace is not attached to another Project. */
  readonly role?: WorkspaceRole;
  /** Only meaningful for attached "worktree" Workspaces; persisted as NULL otherwise. */
  readonly origin?: WorkspaceOrigin;
}

export interface UpsertProjectionAwenAgentSessionInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpdateProjectionAwenAgentSessionInput {
  readonly threadId: ThreadId;
  readonly title?: string;
  readonly updatedAt: string;
}

export interface ProjectionAwenProjectRepositoryShape {
  /** Upsert the Awen Project and its main Workspace mapping for a Awen project. */
  readonly upsertForAwenProject: (
    input: UpsertProjectionAwenProjectInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Create or restore the stable Awen session bound to a Awen thread. */
  readonly upsertAgentSession: (
    input: UpsertProjectionAwenAgentSessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Update session metadata without changing its Awen identity or binding. */
  readonly updateAgentSession: (
    input: UpdateProjectionAwenAgentSessionInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly archiveAgentSession: (input: {
    readonly threadId: ThreadId;
    readonly archivedAt: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly unarchiveAgentSession: (input: {
    readonly threadId: ThreadId;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly deleteAgentSession: (input: {
    readonly threadId: ThreadId;
    readonly deletedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Remove the Awen mapping when its backing Awen project is deleted. */
  readonly removeForProject: (
    projectId: ProjectId,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Change an Awen Project display title without changing its Workspaces. */
  readonly updateProjectTitle: (input: {
    readonly awenProjectId: AwenProjectId;
    readonly title: string;
    readonly updatedAt: string;
  }) => Effect.Effect<void, ProjectionRepositoryError>;
  /** Read the complete active Project → Workspace tree. */
  readonly listTree: () => Effect.Effect<
    ReadonlyArray<AwenProjectShell>,
    ProjectionRepositoryError
  >;
  /** Read one Awen Project with its Workspaces by its stable identity. */
  readonly getProjectById: (
    awenProjectId: AwenProjectId,
  ) => Effect.Effect<Option.Option<AwenProjectShell>, ProjectionRepositoryError>;
  /** Read the tree row containing one Awen project for shell stream updates. */
  readonly getByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<Option.Option<AwenProjectShell>, ProjectionRepositoryError>;
  /** Read the Awen Workspace owning a stable WorkspaceId. */
  readonly getWorkspaceById: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<Option.Option<AwenWorkspaceShell>, ProjectionRepositoryError>;
  /** Read the owning Awen tree even after a session leaves the active shell. */
  readonly getByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<AwenProjectShell>, ProjectionRepositoryError>;
  /** Read a durable session binding regardless of active/archive shell state. */
  readonly getAgentSessionByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<Option.Option<AwenAgentSessionShell>, ProjectionRepositoryError>;
}

export class ProjectionAwenProjectRepository extends Context.Service<
  ProjectionAwenProjectRepository,
  ProjectionAwenProjectRepositoryShape
>()("@awen/server/persistence/Services/ProjectionAwenProjects/ProjectionAwenProjectRepository") {}

export function mapProjectionAwenProjectRows(
  rows: ReadonlyArray<ProjectionAwenProjectRow>,
  sessionRows: ReadonlyArray<ProjectionAwenAgentSessionRow> = [],
): ReadonlyArray<AwenProjectShell> {
  const activeSessionsByWorkspace = new Map<WorkspaceId, ReadonlyArray<AwenSessionShell>>();
  const historySessionsByWorkspace = new Map<WorkspaceId, ReadonlyArray<AwenSessionShell>>();
  for (const row of sessionRows) {
    if (row.deletedAt !== null) continue;
    const isClosed = row.archivedAt !== null;
    const session: AwenAgentSessionShell = {
      kind: "agent",
      id: row.agentSessionId,
      workspaceId: row.workspaceId,
      threadId: row.threadId,
      title: row.title,
      status: isClosed ? "closed" : "open",
      ...(isClosed ? { closedAt: row.archivedAt } : {}),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
    if (isClosed) {
      historySessionsByWorkspace.set(row.workspaceId, [
        ...(historySessionsByWorkspace.get(row.workspaceId) ?? []),
        session,
      ]);
    } else {
      activeSessionsByWorkspace.set(row.workspaceId, [
        ...(activeSessionsByWorkspace.get(row.workspaceId) ?? []),
        session,
      ]);
    }
  }

  const workspaces = new Map<WorkspaceId, AwenWorkspaceShell>();
  for (const row of rows) {
    workspaces.set(row.workspaceId, {
      id: row.workspaceId,
      projectId: row.awenProjectId,
      awenProjectId: row.projectId,
      title: row.workspaceTitle,
      workspaceRoot: row.workspaceRoot,
      role: row.workspaceRole,
      ...(row.workspaceOrigin !== null ? { origin: row.workspaceOrigin } : {}),
      sessions: activeSessionsByWorkspace.get(row.workspaceId) ?? [],
      historySessions: historySessionsByWorkspace.get(row.workspaceId) ?? [],
      createdAt: row.workspaceCreatedAt,
      updatedAt: row.workspaceUpdatedAt,
    });
  }

  const projects = new Map<AwenProjectId, AwenProjectShell>();
  for (const row of rows) {
    const workspace = workspaces.get(row.workspaceId);
    if (workspace === undefined) continue;
    const latestSessionUpdatedAt = (workspace.sessions ?? []).reduce(
      (latest, session) => (session.updatedAt > latest ? session.updatedAt : latest),
      row.projectUpdatedAt,
    );
    const existing = projects.get(row.awenProjectId);
    if (existing === undefined) {
      projects.set(row.awenProjectId, {
        id: row.awenProjectId,
        title: row.projectTitle,
        workspaces: [workspace],
        createdAt: row.projectCreatedAt,
        updatedAt:
          row.projectUpdatedAt > latestSessionUpdatedAt
            ? row.projectUpdatedAt
            : latestSessionUpdatedAt,
      });
      continue;
    }
    projects.set(row.awenProjectId, {
      ...existing,
      title: row.projectTitle,
      workspaces: existing.workspaces.some((candidate) => candidate.id === workspace.id)
        ? existing.workspaces.map((candidate) =>
            candidate.id === workspace.id ? workspace : candidate,
          )
        : [...existing.workspaces, workspace],
      updatedAt:
        existing.updatedAt > latestSessionUpdatedAt ? existing.updatedAt : latestSessionUpdatedAt,
    });
  }
  return [...projects.values()];
}
