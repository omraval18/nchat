import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthResponse, Connection, MessageStatus } from "@nchat/protocol";

export type LocalAccount = {
  userId: string;
  username: string;
  displayName: string;
  deviceId: string;
  publicIdentityKey: string;
  privateIdentityKey: string;
  accessToken: string;
  refreshToken: string;
};

export type LocalMessage = {
  id: string;
  conversationId: string;
  peerUsername: string;
  senderUsername: string;
  body: string;
  direction: "incoming" | "outgoing";
  status: MessageStatus;
  createdAt: number;
  updatedAt: number;
};

export type OutboxItem = {
  id: string;
  messageId: string;
  toUsername: string;
  payload: string;
  status: "queued" | "sending" | "sent" | "failed";
  attempts: number;
  nextAttemptAt: number;
};

export class LocalStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.migrate();
  }

  saveAccount(auth: AuthResponse, privateIdentityKey: string): void {
    this.db
      .prepare(
        `INSERT INTO local_account (
          id, user_id, username, display_name, device_id, public_identity_key,
          private_identity_key, access_token, refresh_token, updated_at
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          user_id = excluded.user_id,
          username = excluded.username,
          display_name = excluded.display_name,
          device_id = excluded.device_id,
          public_identity_key = excluded.public_identity_key,
          private_identity_key = excluded.private_identity_key,
          access_token = excluded.access_token,
          refresh_token = excluded.refresh_token,
          updated_at = excluded.updated_at`,
      )
      .run(
        auth.user.id,
        auth.user.username,
        auth.user.displayName,
        auth.device.id,
        auth.device.publicIdentityKey,
        privateIdentityKey,
        auth.accessToken,
        auth.refreshToken,
        Date.now(),
      );
  }

  updateAccessToken(accessToken: string): void {
    this.db.prepare(`UPDATE local_account SET access_token = ?, updated_at = ? WHERE id = 1`).run(accessToken, Date.now());
  }

  getAccount(): LocalAccount | null {
    const row = this.db.prepare(`SELECT * FROM local_account WHERE id = 1`).get() as AccountRow | undefined;
    if (!row) return null;
    return {
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      deviceId: row.device_id,
      publicIdentityKey: row.public_identity_key,
      privateIdentityKey: row.private_identity_key,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
    };
  }

  clearAccount(): void {
    this.db.exec(`DELETE FROM local_account`);
  }

  upsertConnections(connections: Connection[]): void {
    const statement = this.db.prepare(
      `INSERT INTO connections (user_id, username, display_name, online, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         user_id = excluded.user_id,
         display_name = excluded.display_name,
         online = excluded.online,
         updated_at = excluded.updated_at`,
    );
    const now = Date.now();
    for (const connection of connections) {
      statement.run(connection.userId, connection.username, connection.displayName, connection.online ? 1 : 0, now);
    }
  }

  listConnections(): Connection[] {
    const rows = this.db.prepare(`SELECT * FROM connections ORDER BY username ASC`).all() as ConnectionRow[];
    return rows.map((row) => ({
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      online: row.online === 1,
    }));
  }

  setConnectionPresence(username: string, online: boolean): void {
    this.db.prepare(`UPDATE connections SET online = ?, updated_at = ? WHERE username = ?`).run(online ? 1 : 0, Date.now(), username);
  }

  getConnection(username: string): Connection | null {
    const row = this.db.prepare(`SELECT * FROM connections WHERE username = ?`).get(username) as ConnectionRow | undefined;
    if (!row) return null;
    return { userId: row.user_id, username: row.username, displayName: row.display_name, online: row.online === 1 };
  }

  insertMessage(message: LocalMessage): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messages (
          id, conversation_id, peer_username, sender_username, body, direction, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        message.id,
        message.conversationId,
        message.peerUsername,
        message.senderUsername,
        message.body,
        message.direction,
        message.status,
        message.createdAt,
        message.updatedAt,
      );
  }

  listMessages(peerUsername: string, limit = 80): LocalMessage[] {
    const rows = this.db
      .prepare(`SELECT * FROM messages WHERE peer_username = ? ORDER BY created_at DESC LIMIT ?`)
      .all(peerUsername, limit) as MessageRow[];
    return rows.reverse().map(rowToMessage);
  }

  updateMessageStatus(messageId: string, status: MessageStatus): void {
    this.db.prepare(`UPDATE messages SET status = ?, updated_at = ? WHERE id = ?`).run(status, Date.now(), messageId);
  }

  enqueue(item: OutboxItem): void {
    this.db
      .prepare(
        `INSERT INTO outbox (id, message_id, to_username, payload, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(item.id, item.messageId, item.toUsername, item.payload, item.status, item.attempts, item.nextAttemptAt, Date.now());
  }

  nextOutboxItem(): OutboxItem | null {
    const row = this.db
      .prepare(
        `SELECT * FROM outbox
         WHERE status IN ('queued', 'failed') AND next_attempt_at <= ?
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(Date.now()) as OutboxRow | undefined;
    return row ? rowToOutbox(row) : null;
  }

  markOutboxSending(id: string): void {
    this.db.prepare(`UPDATE outbox SET status = 'sending', attempts = attempts + 1 WHERE id = ?`).run(id);
  }

  markOutboxSent(id: string): void {
    this.db.prepare(`UPDATE outbox SET status = 'sent' WHERE id = ?`).run(id);
  }

  markOutboxFailed(id: string, retryAt: number): void {
    this.db.prepare(`UPDATE outbox SET status = 'failed', next_attempt_at = ? WHERE id = ?`).run(retryAt, id);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_account (
        id integer PRIMARY KEY CHECK (id = 1),
        user_id text NOT NULL,
        username text NOT NULL,
        display_name text NOT NULL,
        device_id text NOT NULL,
        public_identity_key text NOT NULL,
        private_identity_key text NOT NULL,
        access_token text NOT NULL,
        refresh_token text NOT NULL,
        updated_at integer NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connections (
        user_id text NOT NULL,
        username text PRIMARY KEY,
        display_name text NOT NULL,
        online integer NOT NULL DEFAULT 0,
        updated_at integer NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id text PRIMARY KEY,
        conversation_id text NOT NULL,
        peer_username text NOT NULL,
        sender_username text NOT NULL,
        body text NOT NULL,
        direction text NOT NULL,
        status text NOT NULL,
        created_at integer NOT NULL,
        updated_at integer NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id text PRIMARY KEY,
        message_id text NOT NULL,
        to_username text NOT NULL,
        payload text NOT NULL,
        status text NOT NULL,
        attempts integer NOT NULL,
        next_attempt_at integer NOT NULL,
        created_at integer NOT NULL
      );

      CREATE INDEX IF NOT EXISTS messages_peer_created_idx ON messages(peer_username, created_at);
      CREATE INDEX IF NOT EXISTS outbox_status_next_idx ON outbox(status, next_attempt_at);
    `);
  }
}

type AccountRow = {
  user_id: string;
  username: string;
  display_name: string;
  device_id: string;
  public_identity_key: string;
  private_identity_key: string;
  access_token: string;
  refresh_token: string;
};

type ConnectionRow = {
  user_id: string;
  username: string;
  display_name: string;
  online: number;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  peer_username: string;
  sender_username: string;
  body: string;
  direction: "incoming" | "outgoing";
  status: MessageStatus;
  created_at: number;
  updated_at: number;
};

type OutboxRow = {
  id: string;
  message_id: string;
  to_username: string;
  payload: string;
  status: "queued" | "sending" | "sent" | "failed";
  attempts: number;
  next_attempt_at: number;
};

function rowToMessage(row: MessageRow): LocalMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    peerUsername: row.peer_username,
    senderUsername: row.sender_username,
    body: row.body,
    direction: row.direction,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToOutbox(row: OutboxRow): OutboxItem {
  return {
    id: row.id,
    messageId: row.message_id,
    toUsername: row.to_username,
    payload: row.payload,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
  };
}
