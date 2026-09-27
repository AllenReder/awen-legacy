import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Projects durable Threads into their current Workspace assignment. Runtime
 * and provider session identifiers do not participate in this key.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS projection_awen_agent_sessions (
      thread_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      deleted_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_awen_agent_sessions_workspace_id
    ON projection_awen_agent_sessions(workspace_id, archived_at, deleted_at, created_at)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_awen_agent_sessions_project_id
    ON projection_awen_agent_sessions(project_id)
  `;

  // The durable Thread is the Agent Session identity.
  yield* sql`
    INSERT OR IGNORE INTO projection_awen_agent_sessions (
      workspace_id,
      project_id,
      thread_id,
      title,
      created_at,
      updated_at,
      archived_at,
      deleted_at
    )
    SELECT
      workspaces.workspace_id,
      threads.project_id,
      threads.thread_id,
      threads.title,
      threads.created_at,
      threads.updated_at,
      threads.archived_at,
      threads.deleted_at
    FROM projection_threads AS threads
    INNER JOIN projection_awen_workspaces AS workspaces
      ON workspaces.project_id = threads.project_id
    WHERE threads.deleted_at IS NULL
  `;
});
