import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl, max: 20 });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

export async function runMigrations(db: Db): Promise<void> {
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
  await migrate(db, { migrationsFolder });
}
