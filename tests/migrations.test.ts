import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runSqlMigrations } from "../src/db/migrations.js";
import type { DbClient } from "../src/storage/eventStore.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runSqlMigrations", () => {
  it("applies SQL migration files in filename order inside transactions", async () => {
    const migrationsDir = await mkdtemp(path.join(os.tmpdir(), "review-migrations-"));
    tempDirs.push(migrationsDir);
    await writeFile(path.join(migrationsDir, "20260704_0002_second.sql"), "SELECT 2;");
    await writeFile(path.join(migrationsDir, "20260704_0001_first.sql"), "SELECT 1;");
    await writeFile(path.join(migrationsDir, "README.md"), "not sql");

    const db = new RecordingDbClient();
    const applied = await runSqlMigrations(db, migrationsDir);

    expect(applied).toEqual([
      { file: "20260704_0001_first.sql" },
      { file: "20260704_0002_second.sql" },
    ]);
    expect(db.statements).toEqual([
      "BEGIN",
      "SELECT 1;",
      "COMMIT",
      "BEGIN",
      "SELECT 2;",
      "COMMIT",
    ]);
  });
});

class RecordingDbClient implements DbClient {
  readonly statements: string[] = [];

  async query(sql: string) {
    this.statements.push(sql);
    return { rows: [], command: "", rowCount: 0, oid: 0, fields: [] };
  }
}
