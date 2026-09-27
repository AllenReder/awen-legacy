import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Keep only product ownership and creation facts beside the directory record. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE projection_awen_workspace_owners (
      project_id TEXT PRIMARY KEY,
      awen_project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      origin TEXT
    )
  `;
  yield* sql`
    INSERT INTO projection_awen_workspace_owners (project_id, awen_project_id, role, origin)
    SELECT project_id, awen_project_id, role, origin
    FROM projection_awen_workspaces
  `;
  yield* sql`DROP TABLE projection_awen_workspaces`;
  yield* sql`ALTER TABLE projection_awen_workspace_owners RENAME TO projection_awen_workspaces`;
  yield* sql`
    CREATE INDEX idx_projection_awen_workspaces_project_id
    ON projection_awen_workspaces(awen_project_id)
  `;
});
