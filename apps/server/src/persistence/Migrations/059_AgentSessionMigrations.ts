import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Recovery state for an interrupted Agent Session Workspace migration.
 *
 * A migration can move the provider execution context before publishing the
 * committed Workspace assignment. When that commit fails the provider and the
 * assignment disagree, so the row survives a restart and keeps sends blocked
 * until the provider is verified or restored against the committed assignment.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE agent_session_migrations (
      thread_id TEXT NOT NULL PRIMARY KEY,
      intended_workspace_id TEXT NOT NULL,
      intended_project_id TEXT NOT NULL,
      intended_cwd TEXT NOT NULL,
      committed_project_id TEXT NOT NULL,
      committed_cwd TEXT,
      provider_moved INTEGER NOT NULL,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
