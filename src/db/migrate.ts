import { Pool } from "pg";

import { loadSettings } from "../config/settings.js";
import { runSqlMigrations } from "./migrations.js";

const settings = loadSettings();
const pool = new Pool({ connectionString: settings.databaseUrl });

try {
  const applied = await runSqlMigrations(pool);
  for (const migration of applied) {
    console.log(`applied ${migration.file}`);
  }
  console.log(`migration complete: ${applied.length} file(s) applied`);
} finally {
  await pool.end();
}
