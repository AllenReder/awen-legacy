import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@awen/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("054_AwenAgentSessions", (it) => {
  it.effect("backfills active Awen threads into their owning Awen workspace", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const timestamp = "2026-09-18T00:00:00.000Z";

      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-session', 'Session project', '/tmp/session-project', '[]',
          ${timestamp}, ${timestamp}, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_awen_projects (
          awen_project_id, title, created_at, updated_at
        ) VALUES (
          'awen-project:project-session', 'Session project', ${timestamp}, ${timestamp}
        )
      `;
      yield* sql`
        INSERT INTO projection_awen_workspaces (
          workspace_id, awen_project_id, project_id, title, workspace_root,
          role, created_at, updated_at
        ) VALUES (
          'workspace:project-session', 'awen-project:project-session', 'project-session',
          'Session project', '/tmp/session-project', 'main', ${timestamp}, ${timestamp}
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'thread-session', 'project-session', 'Persisted session',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          ${timestamp}, ${timestamp}, NULL, NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, archived_at, deleted_at
        ) VALUES (
          'thread-empty-two', 'project-session', 'Another empty session',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default',
          ${timestamp}, ${timestamp}, NULL, NULL
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 54 });

      const rows = yield* sql<{
        readonly agentSessionId: string;
        readonly workspaceId: string;
        readonly projectId: string;
        readonly threadId: string;
      }>`
        SELECT
          thread_id AS "agentSessionId",
          workspace_id AS "workspaceId",
          project_id AS "projectId",
          thread_id AS "threadId"
        FROM projection_awen_agent_sessions
        ORDER BY thread_id
      `;

      assert.deepEqual(rows, [
        {
          agentSessionId: "thread-empty-two",
          workspaceId: "workspace:project-session",
          projectId: "project-session",
          threadId: "thread-empty-two",
        },
        {
          agentSessionId: "thread-session",
          workspaceId: "workspace:project-session",
          projectId: "project-session",
          threadId: "thread-session",
        },
      ]);
      const columns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_awen_agent_sessions)
      `;
      assert.isFalse(columns.some((column) => column.name === "agent_session_id"));
    }),
  );
});
