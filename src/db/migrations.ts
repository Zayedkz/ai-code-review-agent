import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { DbClient } from "../storage/eventStore.js";

export type AppliedMigration = {
  file: string;
};

export async function runSqlMigrations(
  db: DbClient,
  migrationsDir = path.resolve(process.cwd(), "migrations"),
): Promise<AppliedMigration[]> {
  const files = (await readdir(migrationsDir))
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) => left.localeCompare(right));

  const applied: AppliedMigration[] = [];
  for (const file of files) {
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    if (!sql.trim()) {
      continue;
    }

    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query("COMMIT");
      applied.push({ file });
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }

  return applied;
}
