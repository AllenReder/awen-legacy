import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@awen/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = Layer.mergeAll(NodeSqliteClient.layerMemory());

const summaryColumns = [
  "latest_user_message_at",
  "pending_approval_count",
  "pending_user_input_count",
  "has_actionable_proposed_plan",
] as const;

const projectionThreadColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  return new Set(rows.map((row) => row.name));
});

it.layer(layer)("023_ProjectionThreadShellSummary", (it) => {
  it.effect("adds every shell summary column", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 22 });
      yield* runMigrations({ toMigrationInclusive: 23 });

      const columns = yield* projectionThreadColumns;
      for (const column of summaryColumns) {
        assert.isTrue(columns.has(column));
      }
    }),
  );
});

it.layer(layer)("023_ProjectionThreadShellSummary existing column", (it) => {
  it.effect("keeps a column that is already present instead of failing", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 22 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN latest_user_message_at TEXT
      `;

      yield* runMigrations({ toMigrationInclusive: 23 });

      const columns = yield* projectionThreadColumns;
      for (const column of summaryColumns) {
        assert.isTrue(columns.has(column));
      }
      const recorded = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS "migrationId"
        FROM effect_sql_migrations
        WHERE migration_id = 23
      `;
      assert.deepEqual(recorded, [{ migrationId: 23 }]);
    }),
  );
});

it.layer(layer)("023_ProjectionThreadShellSummary other errors", (it) => {
  it.effect("fails the migration and records nothing when the table is missing", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 22 });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DROP TABLE projection_threads`;

      const exit = yield* runMigrations({ toMigrationInclusive: 23 }).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));

      const recorded = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS "migrationId"
        FROM effect_sql_migrations
        WHERE migration_id = 23
      `;
      assert.deepEqual(recorded, []);
    }),
  );
});
