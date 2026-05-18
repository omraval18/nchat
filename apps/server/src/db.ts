import { Pool } from "pg";

export type Db = Pool;

export function createDb(databaseUrl: string): Db {
  return new Pool({ connectionString: databaseUrl, max: 20 });
}

export async function migrate(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id uuid PRIMARY KEY,
      username text NOT NULL UNIQUE,
      display_name text NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS devices (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_name text NOT NULL,
      public_identity_key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      last_seen_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      refresh_token_hash text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz
    );

    CREATE TABLE IF NOT EXISTS direct_connections (
      user_low uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      user_high uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_low, user_high),
      CHECK (user_low < user_high)
    );

    CREATE INDEX IF NOT EXISTS devices_user_id_idx ON devices(user_id);
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS connections_low_idx ON direct_connections(user_low);
    CREATE INDEX IF NOT EXISTS connections_high_idx ON direct_connections(user_high);
  `);
}
