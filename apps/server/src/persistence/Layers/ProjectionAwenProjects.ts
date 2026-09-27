import {
  AwenProjectId,
  awenProjectIdForAwenProject,
  ProjectId,
  ThreadId,
  WorkspaceId,
} from "@awen/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlError } from "../Errors.ts";
import {
  mapProjectionAwenProjectRows,
  ProjectionAwenProjectRepository,
  ProjectionAwenAgentSessionRow,
  ProjectionAwenProjectRow,
  type ProjectionAwenProjectRepositoryShape,
} from "../Services/ProjectionAwenProjects.ts";

const ProjectIdInput = Schema.Struct({ projectId: ProjectId });
const ThreadIdInput = Schema.Struct({ threadId: ThreadId });
const AwenProjectIdInput = Schema.Struct({ awenProjectId: AwenProjectId });

const makeRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getWorkspaceForAwenProject = SqlSchema.findOneOption({
    Request: ProjectIdInput,
    Result: Schema.Struct({ workspaceId: WorkspaceId, awenProjectId: AwenProjectId }),
    execute: ({ projectId }) => sql`
      SELECT 'workspace:' || project_id AS "workspaceId", awen_project_id AS "awenProjectId"
      FROM projection_awen_workspaces
      WHERE project_id = ${projectId}
      LIMIT 1
    `,
  });

  const upsert: ProjectionAwenProjectRepositoryShape["upsertForAwenProject"] = (input) =>
    Effect.gen(function* () {
      const attached = input.awenProjectId !== undefined;
      const awenProjectId = input.awenProjectId ?? awenProjectIdForAwenProject(input.projectId);
      const role = input.role ?? "main";
      const origin = input.origin ?? null;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (attached) {
            const target = yield* sql`
            SELECT awen_project_id
            FROM projection_awen_projects
            WHERE awen_project_id = ${awenProjectId}
            LIMIT 1
          `;
            if (target.length === 0) {
              return yield* new PersistenceSqlError({
                operation: "ProjectionAwenProjectRepository.upsert",
                detail: `No Awen Project '${awenProjectId}' exists to attach orchestration project '${input.projectId}' to.`,
              });
            }
          } else {
            // Product Project titles are independent of directory titles.
            yield* sql`
            INSERT INTO projection_awen_projects (
              awen_project_id, title, created_at, updated_at
            )
            SELECT ${awenProjectId}, ${input.title}, ${input.createdAt}, ${input.updatedAt}
            WHERE NOT EXISTS (
              SELECT 1 FROM projection_awen_workspaces
              WHERE project_id = ${input.projectId}
                AND awen_project_id <> ${awenProjectId}
            )
            ON CONFLICT (awen_project_id) DO NOTHING
          `;
          }
          // Ownership, role, and origin are creation facts. Directory metadata
          // is read from projection_projects and never duplicated here.
          yield* sql`
          INSERT INTO projection_awen_workspaces (
            awen_project_id,
            project_id,
            role,
            origin
          ) VALUES (
            ${awenProjectId}, ${input.projectId}, ${role}, ${origin}
          )
          ON CONFLICT (project_id) DO NOTHING
        `;
        }),
      );
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(PersistenceSqlError)(error)
          ? error
          : toPersistenceSqlError("ProjectionAwenProjectRepository.upsert")(error),
      ),
    );

  const upsertAgentSession: ProjectionAwenProjectRepositoryShape["upsertAgentSession"] = (input) =>
    Effect.gen(function* () {
      const workspace = yield* getWorkspaceForAwenProject({
        projectId: input.projectId,
      });
      if (Option.isNone(workspace)) {
        return yield* new PersistenceSqlError({
          operation: "ProjectionAwenProjectRepository.upsertAgentSession",
          detail: `No Awen Workspace is bound to project '${input.projectId}'.`,
        });
      }
      yield* sql`
        INSERT INTO projection_awen_agent_sessions (
          workspace_id,
          project_id,
          thread_id,
          title,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        ) VALUES (
          ${workspace.value.workspaceId},
          ${input.projectId},
          ${input.threadId},
          ${input.title},
          ${input.createdAt},
          ${input.updatedAt},
          NULL,
          NULL
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          workspace_id = excluded.workspace_id,
          project_id = excluded.project_id,
          title = excluded.title,
          updated_at = excluded.updated_at,
          archived_at = NULL,
          deleted_at = NULL
      `;
    }).pipe(
      Effect.mapError((error) =>
        Schema.is(PersistenceSqlError)(error)
          ? error
          : toPersistenceSqlError("ProjectionAwenProjectRepository.upsertAgentSession")(error),
      ),
    );

  const updateAgentSession: ProjectionAwenProjectRepositoryShape["updateAgentSession"] = (input) =>
    sql`
      UPDATE projection_awen_agent_sessions
      SET
        title = COALESCE(${input.title ?? null}, title),
        updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.updateAgentSession")),
    );

  const archiveAgentSession: ProjectionAwenProjectRepositoryShape["archiveAgentSession"] = (
    input,
  ) =>
    sql`
      UPDATE projection_awen_agent_sessions
      SET archived_at = ${input.archivedAt}, updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.archiveAgentSession")),
    );

  const unarchiveAgentSession: ProjectionAwenProjectRepositoryShape["unarchiveAgentSession"] = (
    input,
  ) =>
    sql`
      UPDATE projection_awen_agent_sessions
      SET archived_at = NULL, deleted_at = NULL, updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId}
    `.pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionAwenProjectRepository.unarchiveAgentSession"),
      ),
    );

  const deleteAgentSession: ProjectionAwenProjectRepositoryShape["deleteAgentSession"] = (input) =>
    sql`
      UPDATE projection_awen_agent_sessions
      SET deleted_at = ${input.deletedAt}, updated_at = ${input.deletedAt}
      WHERE thread_id = ${input.threadId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.deleteAgentSession")),
    );

  const getRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionAwenProjectRow,
    execute: () => sql`
      SELECT
        projects.awen_project_id AS "awenProjectId",
        projects.title AS "projectTitle",
        projects.created_at AS "projectCreatedAt",
        projects.updated_at AS "projectUpdatedAt",
        'workspace:' || workspaces.project_id AS "workspaceId",
        workspaces.project_id AS "projectId",
        directories.title AS "workspaceTitle",
        directories.workspace_root AS "workspaceRoot",
        workspaces.role AS "workspaceRole",
        workspaces.origin AS "workspaceOrigin",
        directories.created_at AS "workspaceCreatedAt",
        directories.updated_at AS "workspaceUpdatedAt"
      FROM projection_awen_projects AS projects
      INNER JOIN projection_awen_workspaces AS workspaces
        ON workspaces.awen_project_id = projects.awen_project_id
      INNER JOIN projection_projects AS directories
        ON directories.project_id = workspaces.project_id AND directories.deleted_at IS NULL
      ORDER BY projects.created_at ASC, projects.awen_project_id ASC,
        directories.created_at ASC, workspaces.project_id ASC
    `,
  });

  const getRowsForAwenProject = SqlSchema.findAll({
    Request: AwenProjectIdInput,
    Result: ProjectionAwenProjectRow,
    execute: ({ awenProjectId }) => sql`
      SELECT
        projects.awen_project_id AS "awenProjectId",
        projects.title AS "projectTitle",
        projects.created_at AS "projectCreatedAt",
        projects.updated_at AS "projectUpdatedAt",
        'workspace:' || workspaces.project_id AS "workspaceId",
        workspaces.project_id AS "projectId",
        directories.title AS "workspaceTitle",
        directories.workspace_root AS "workspaceRoot",
        workspaces.role AS "workspaceRole",
        workspaces.origin AS "workspaceOrigin",
        directories.created_at AS "workspaceCreatedAt",
        directories.updated_at AS "workspaceUpdatedAt"
      FROM projection_awen_projects AS projects
      INNER JOIN projection_awen_workspaces AS workspaces
        ON workspaces.awen_project_id = projects.awen_project_id
      INNER JOIN projection_projects AS directories
        ON directories.project_id = workspaces.project_id AND directories.deleted_at IS NULL
      WHERE projects.awen_project_id = ${awenProjectId}
      ORDER BY directories.created_at ASC, workspaces.project_id ASC
    `,
  });

  const getRowsForProject = SqlSchema.findAll({
    Request: ProjectIdInput,
    Result: ProjectionAwenProjectRow,
    execute: ({ projectId }) => sql`
      SELECT
        projects.awen_project_id AS "awenProjectId",
        projects.title AS "projectTitle",
        projects.created_at AS "projectCreatedAt",
        projects.updated_at AS "projectUpdatedAt",
        'workspace:' || workspaces.project_id AS "workspaceId",
        workspaces.project_id AS "projectId",
        directories.title AS "workspaceTitle",
        directories.workspace_root AS "workspaceRoot",
        workspaces.role AS "workspaceRole",
        workspaces.origin AS "workspaceOrigin",
        directories.created_at AS "workspaceCreatedAt",
        directories.updated_at AS "workspaceUpdatedAt"
      FROM projection_awen_projects AS projects
      INNER JOIN projection_awen_workspaces AS workspaces
        ON workspaces.awen_project_id = projects.awen_project_id
      INNER JOIN projection_projects AS directories
        ON directories.project_id = workspaces.project_id AND directories.deleted_at IS NULL
      WHERE workspaces.project_id = ${projectId}
      LIMIT 1
    `,
  });

  const getActiveSessionRows = SqlSchema.findAll({
    Request: Schema.Struct({ projectId: Schema.optional(ProjectId) }),
    Result: ProjectionAwenAgentSessionRow,
    execute: ({ projectId }) => sql`
      SELECT
        sessions.thread_id AS "agentSessionId",
        sessions.workspace_id AS "workspaceId",
        sessions.project_id AS "projectId",
        sessions.thread_id AS "threadId",
        sessions.title,
        sessions.created_at AS "createdAt",
        sessions.updated_at AS "updatedAt",
        sessions.archived_at AS "archivedAt",
        sessions.deleted_at AS "deletedAt"
      FROM projection_awen_agent_sessions AS sessions
      WHERE sessions.deleted_at IS NULL
        AND (${projectId ?? null} IS NULL OR sessions.project_id = ${projectId ?? null})
      ORDER BY sessions.created_at ASC, sessions.thread_id ASC
    `,
  });

  const getRowsForThread = SqlSchema.findAll({
    Request: ThreadIdInput,
    Result: ProjectionAwenProjectRow,
    execute: ({ threadId }) => sql`
      SELECT
        projects.awen_project_id AS "awenProjectId",
        projects.title AS "projectTitle",
        projects.created_at AS "projectCreatedAt",
        projects.updated_at AS "projectUpdatedAt",
        'workspace:' || workspaces.project_id AS "workspaceId",
        workspaces.project_id AS "projectId",
        directories.title AS "workspaceTitle",
        directories.workspace_root AS "workspaceRoot",
        workspaces.role AS "workspaceRole",
        workspaces.origin AS "workspaceOrigin",
        directories.created_at AS "workspaceCreatedAt",
        directories.updated_at AS "workspaceUpdatedAt"
      FROM projection_awen_agent_sessions AS sessions
      INNER JOIN projection_awen_workspaces AS workspaces
        ON workspaces.project_id = sessions.project_id
      INNER JOIN projection_awen_projects AS projects
        ON projects.awen_project_id = workspaces.awen_project_id
      INNER JOIN projection_projects AS directories
        ON directories.project_id = workspaces.project_id AND directories.deleted_at IS NULL
      WHERE sessions.thread_id = ${threadId}
      LIMIT 1
    `,
  });

  const getSessionRowForThread = SqlSchema.findOneOption({
    Request: ThreadIdInput,
    Result: ProjectionAwenAgentSessionRow,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "agentSessionId",
        workspace_id AS "workspaceId",
        project_id AS "projectId",
        thread_id AS "threadId",
        title,
        created_at AS "createdAt",
        updated_at AS "updatedAt",
        archived_at AS "archivedAt",
        deleted_at AS "deletedAt"
      FROM projection_awen_agent_sessions
      WHERE thread_id = ${threadId}
      LIMIT 1
    `,
  });

  const remove: ProjectionAwenProjectRepositoryShape["removeForProject"] = (projectId) =>
    Effect.gen(function* () {
      // The owning Project is a creation fact on the workspace row, not a
      // derivation: attached Workspaces share their Project with siblings, so
      // the deterministic id would point at a Project that does not exist.
      const workspace = yield* getWorkspaceForAwenProject({ projectId });
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
          DELETE FROM projection_awen_agent_sessions
          WHERE project_id = ${projectId}
        `;
          yield* sql`
          DELETE FROM projection_awen_workspaces
          WHERE project_id = ${projectId}
        `;
          if (Option.isSome(workspace)) {
            const awenProjectId = workspace.value.awenProjectId;
            yield* sql`
            DELETE FROM projection_awen_projects
            WHERE awen_project_id = ${awenProjectId}
              AND NOT EXISTS (
                SELECT 1 FROM projection_awen_workspaces
                WHERE awen_project_id = ${awenProjectId}
              )
          `;
          }
        }),
      );
    }).pipe(Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.remove")));

  const updateProjectTitle: ProjectionAwenProjectRepositoryShape["updateProjectTitle"] = (input) =>
    sql`
      UPDATE projection_awen_projects
      SET title = ${input.title}, updated_at = ${input.updatedAt}
      WHERE awen_project_id = ${input.awenProjectId}
    `.pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.updateProjectTitle")),
    );

  return {
    upsertForAwenProject: upsert,
    upsertAgentSession,
    updateAgentSession,
    archiveAgentSession,
    unarchiveAgentSession,
    deleteAgentSession,
    removeForProject: remove,
    updateProjectTitle,
    listTree: () =>
      Effect.all([getRows(undefined), getActiveSessionRows({})]).pipe(
        Effect.map(([rows, sessions]) => mapProjectionAwenProjectRows(rows, sessions)),
        Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.listTree")),
      ),
    getProjectById: (awenProjectId) =>
      Effect.all([getRowsForAwenProject({ awenProjectId }), getActiveSessionRows({})]).pipe(
        Effect.map(([rows, sessions]) =>
          Option.fromNullishOr(mapProjectionAwenProjectRows(rows, sessions)[0]),
        ),
        Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.getProjectById")),
      ),
    getByProjectId: (projectId) =>
      Effect.gen(function* () {
        const matchingRows = yield* getRowsForProject({ projectId });
        const matchingRow = matchingRows[0];
        if (matchingRow === undefined) return Option.none();
        const rows = yield* getRowsForAwenProject({
          awenProjectId: matchingRow.awenProjectId,
        });
        const sessions = yield* getActiveSessionRows({});
        return Option.fromNullishOr(mapProjectionAwenProjectRows(rows, sessions)[0]);
      }).pipe(
        Effect.mapError(
          toPersistenceSqlError("ProjectionAwenProjectRepository.getByAwenProjectId"),
        ),
      ),
    getWorkspaceById: (workspaceId) =>
      Effect.all([getRows(undefined), getActiveSessionRows({})]).pipe(
        Effect.map(([rows, sessions]) =>
          Option.fromNullishOr(
            mapProjectionAwenProjectRows(rows, sessions)
              .flatMap((project) => project.workspaces)
              .find((workspace) => workspace.id === workspaceId),
          ),
        ),
        Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.getWorkspaceById")),
      ),
    getByThreadId: (threadId) =>
      Effect.gen(function* () {
        const matchingRows = yield* getRowsForThread({ threadId });
        const matchingRow = matchingRows[0];
        if (matchingRow === undefined) return Option.none();
        const rows = yield* getRowsForAwenProject({
          awenProjectId: matchingRow.awenProjectId,
        });
        const sessions = yield* getActiveSessionRows({});
        return Option.fromNullishOr(mapProjectionAwenProjectRows(rows, sessions)[0]);
      }).pipe(
        Effect.mapError(toPersistenceSqlError("ProjectionAwenProjectRepository.getByThreadId")),
      ),
    getAgentSessionByThreadId: (threadId) =>
      getSessionRowForThread({ threadId }).pipe(
        Effect.map(
          Option.map((row) => ({
            kind: "agent" as const,
            id: row.agentSessionId,
            workspaceId: row.workspaceId,
            threadId: row.threadId,
            title: row.title,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
          })),
        ),
        Effect.mapError(
          toPersistenceSqlError("ProjectionAwenProjectRepository.getAgentSessionByThreadId"),
        ),
      ),
  } satisfies ProjectionAwenProjectRepositoryShape;
});

export const ProjectionAwenProjectRepositoryLive = Layer.effect(
  ProjectionAwenProjectRepository,
  makeRepository,
);
