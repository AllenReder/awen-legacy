import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE checkpoint_execution_contexts (
      thread_id TEXT NOT NULL,
      context_key TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      root_path TEXT NOT NULL,
      git_common_dir TEXT NOT NULL,
      head_ref TEXT,
      head_commit TEXT NOT NULL,
      checkpoint_oid TEXT,
      PRIMARY KEY (thread_id, context_key)
    )
  `;
});
