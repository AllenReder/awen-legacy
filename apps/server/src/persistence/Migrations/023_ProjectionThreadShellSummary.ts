import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Adds the thread shell summary columns.
 *
 * Each column is added only when `PRAGMA table_info` reports it missing: a
 * plain `ADD COLUMN` fails with "duplicate column name" on a database that
 * already carries it, and catching that failure wholesale (the previous
 * `Effect.catch(() => Effect.void)`) also swallowed every other error — a
 * missing table or a disk failure — while the migrator still recorded this
 * migration as applied.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const existingColumns = new Set(columns.map((column) => column.name));

  if (!existingColumns.has("latest_user_message_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN latest_user_message_at TEXT
    `;
  }

  if (!existingColumns.has("pending_approval_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_approval_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!existingColumns.has("pending_user_input_count")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pending_user_input_count INTEGER NOT NULL DEFAULT 0
    `;
  }

  if (!existingColumns.has("has_actionable_proposed_plan")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0
    `;
  }
});
