import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  authResponseSchema,
  connectionSchema,
  deviceKeyBundleSchema,
  groupSchema,
  loginRequestSchema,
  signupRequestSchema,
  usernameSchema,
} from "@nchat/protocol";
import type { Db } from "./db.js";
import type { ServerConfig } from "./config.js";
import {
  createSession,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from "./auth.js";

const maxBodyBytes = 1_000_000;

type RouteContext = {
  db: Db;
  config: ServerConfig;
  onlineUsers: ReadonlySet<string>;
};

export async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  context: RouteContext,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/signup") {
      await handleSignup(req, res, context);
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/login") {
      await handleLogin(req, res, context);
      return;
    }

    if (req.method === "POST" && url.pathname === "/auth/refresh") {
      await handleRefresh(req, res, context);
      return;
    }

    if (req.method === "GET" && url.pathname === "/me") {
      const session = await requireAuth(req, context.config);
      sendJson(res, 200, session);
      return;
    }

    if (req.method === "GET" && url.pathname === "/connections") {
      const session = await requireAuth(req, context.config);
      const rows = await context.db.query(
        `SELECT u.id as user_id, u.username, u.display_name
         FROM direct_connections c
         JOIN users u ON u.id = CASE WHEN c.user_low = $1 THEN c.user_high ELSE c.user_low END
         WHERE c.user_low = $1 OR c.user_high = $1
         ORDER BY u.username ASC`,
        [session.userId],
      );
      const connections = rows.rows.map((row) =>
        connectionSchema.parse({
          userId: row.user_id,
          username: row.username,
          displayName: row.display_name,
          online: context.onlineUsers.has(row.user_id),
        }),
      );
      sendJson(res, 200, { connections });
      return;
    }

    if (req.method === "POST" && url.pathname === "/connections") {
      const session = await requireAuth(req, context.config);
      const body = await readJson(req);
      const username = usernameSchema.parse(body.username);
      const target = await context.db.query(
        `SELECT id FROM users WHERE username = $1`,
        [username],
      );
      if (target.rowCount === 0) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }
      const targetId = target.rows[0].id as string;
      if (targetId === session.userId) {
        sendJson(res, 400, { error: "cannot_connect_self" });
        return;
      }
      const [userLow, userHigh] = [session.userId, targetId].sort();
      await context.db.query(
        `INSERT INTO direct_connections (user_low, user_high)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userLow, userHigh],
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    const devicesMatch = url.pathname.match(/^\/users\/([^/]+)\/devices$/);
    if (req.method === "GET" && devicesMatch) {
      const session = await requireAuth(req, context.config);
      const encodedUsername = devicesMatch[1];
      if (!encodedUsername) {
        sendJson(res, 400, { error: "missing_username" });
        return;
      }
      const username = usernameSchema.parse(decodeURIComponent(encodedUsername));
      const target = await context.db.query(`SELECT id FROM users WHERE username = $1`, [username]);
      if (target.rowCount === 0) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }
      const targetId = target.rows[0].id as string;
      if (targetId !== session.userId) {
        const [userLow, userHigh] = [session.userId, targetId].sort();
        const connection = await context.db.query(
          `SELECT 1 FROM direct_connections WHERE user_low = $1 AND user_high = $2`,
          [userLow, userHigh],
        );
        if (connection.rowCount === 0) {
          sendJson(res, 403, { error: "not_connected" });
          return;
        }
      }
      const devices = await context.db.query(
        `SELECT id, device_name, public_identity_key, last_seen_at
         FROM devices
         WHERE user_id = $1
         ORDER BY created_at ASC`,
        [targetId],
      );
      sendJson(res, 200, {
        devices: devices.rows.map((row) =>
          deviceKeyBundleSchema.parse({
            deviceId: row.id,
            deviceName: row.device_name,
            publicIdentityKey: row.public_identity_key,
            lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
          }),
        ),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/groups") {
      const session = await requireAuth(req, context.config);
      const rows = await context.db.query(
        `SELECT g.id, g.name, g.owner_user_id, count(gm_all.user_id)::int as member_count
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         JOIN group_members gm_all ON gm_all.group_id = g.id
         WHERE gm.user_id = $1
         GROUP BY g.id
         ORDER BY g.name ASC`,
        [session.userId],
      );
      sendJson(res, 200, {
        groups: rows.rows.map((row) =>
          groupSchema.parse({
            id: row.id,
            name: row.name,
            ownerUserId: row.owner_user_id,
            memberCount: row.member_count,
          }),
        ),
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/groups") {
      const session = await requireAuth(req, context.config);
      const body = await readJson(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length === 0 || name.length > 80) {
        sendJson(res, 400, { error: "invalid_group_name" });
        return;
      }
      const groupId = randomUUID();
      await context.db.query("BEGIN");
      try {
        await context.db.query(`INSERT INTO groups (id, name, owner_user_id) VALUES ($1, $2, $3)`, [
          groupId,
          name,
          session.userId,
        ]);
        await context.db.query(
          `INSERT INTO group_members (group_id, user_id, role) VALUES ($1, $2, 'owner')`,
          [groupId, session.userId],
        );
        await context.db.query("COMMIT");
      } catch (error) {
        await context.db.query("ROLLBACK");
        throw error;
      }
      sendJson(
        res,
        201,
        groupSchema.parse({ id: groupId, name, ownerUserId: session.userId, memberCount: 1 }),
      );
      return;
    }

    const groupMemberMatch = url.pathname.match(/^\/groups\/([^/]+)\/members$/);
    if (req.method === "POST" && groupMemberMatch) {
      const session = await requireAuth(req, context.config);
      const groupId = groupMemberMatch[1];
      const body = await readJson(req);
      const username = usernameSchema.parse(body.username);
      const group = await context.db.query(`SELECT owner_user_id FROM groups WHERE id = $1`, [groupId]);
      if (group.rowCount === 0) {
        sendJson(res, 404, { error: "group_not_found" });
        return;
      }
      if (group.rows[0].owner_user_id !== session.userId) {
        sendJson(res, 403, { error: "group_owner_required" });
        return;
      }
      const target = await context.db.query(`SELECT id FROM users WHERE username = $1`, [username]);
      if (target.rowCount === 0) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }
      const targetId = target.rows[0].id as string;
      const [userLow, userHigh] = [session.userId, targetId].sort();
      const connection = await context.db.query(
        `SELECT 1 FROM direct_connections WHERE user_low = $1 AND user_high = $2`,
        [userLow, userHigh],
      );
      if (connection.rowCount === 0 && targetId !== session.userId) {
        sendJson(res, 403, { error: "not_connected" });
        return;
      }
      await context.db.query(
        `INSERT INTO group_members (group_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT DO NOTHING`,
        [groupId, targetId],
      );
      sendJson(res, 200, { ok: true });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "internal error";
    sendJson(res, 500, { error: "internal_error", message });
  }
}

async function handleSignup(
  req: IncomingMessage,
  res: ServerResponse,
  { db, config }: RouteContext,
): Promise<void> {
  const body = signupRequestSchema.parse(await readJson(req));
  const userId = randomUUID();
  const deviceId = randomUUID();
  const passwordHash = await hashPassword(body.password);

  try {
    await db.query("BEGIN");
    await db.query(
      `INSERT INTO users (id, username, display_name, password_hash)
       VALUES ($1, $2, $3, $4)`,
      [userId, body.username, body.displayName, passwordHash],
    );
    await db.query(
      `INSERT INTO devices (id, user_id, device_name, public_identity_key)
       VALUES ($1, $2, $3, $4)`,
      [deviceId, userId, body.deviceName, body.publicIdentityKey],
    );
    const session = await createSession(db, config, { id: userId, username: body.username }, deviceId);
    await db.query("COMMIT");

    sendJson(
      res,
      201,
      authResponseSchema.parse({
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
        user: { id: userId, username: body.username, displayName: body.displayName },
        device: { id: deviceId, publicIdentityKey: body.publicIdentityKey },
      }),
    );
  } catch (error) {
    await db.query("ROLLBACK");
    if (isUniqueViolation(error)) {
      sendJson(res, 409, { error: "username_taken" });
      return;
    }
    throw error;
  }
}

async function handleLogin(
  req: IncomingMessage,
  res: ServerResponse,
  { db, config }: RouteContext,
): Promise<void> {
  const body = loginRequestSchema.parse(await readJson(req));
  const userResult = await db.query(
    `SELECT id, username, display_name, password_hash FROM users WHERE username = $1`,
    [body.username],
  );
  if (userResult.rowCount === 0) {
    sendJson(res, 401, { error: "invalid_credentials" });
    return;
  }
  const user = userResult.rows[0];
  if (!(await verifyPassword(user.password_hash, body.password))) {
    sendJson(res, 401, { error: "invalid_credentials" });
    return;
  }

  const deviceId = randomUUID();
  await db.query(
    `INSERT INTO devices (id, user_id, device_name, public_identity_key)
     VALUES ($1, $2, $3, $4)`,
    [deviceId, user.id, body.deviceName, body.publicIdentityKey],
  );
  const session = await createSession(db, config, { id: user.id, username: user.username }, deviceId);

  sendJson(
    res,
    200,
    authResponseSchema.parse({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: { id: user.id, username: user.username, displayName: user.display_name },
      device: { id: deviceId, publicIdentityKey: body.publicIdentityKey },
    }),
  );
}

async function handleRefresh(
  req: IncomingMessage,
  res: ServerResponse,
  { db, config }: RouteContext,
): Promise<void> {
  const body = (await readJson(req)) as { refreshToken?: unknown };
  if (typeof body.refreshToken !== "string") {
    sendJson(res, 400, { error: "missing_refresh_token" });
    return;
  }
  const refreshTokenHash = hashRefreshToken(body.refreshToken);
  const result = await db.query(
    `SELECT s.id as session_id, s.user_id, s.device_id, u.username
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [refreshTokenHash],
  );
  if (result.rowCount === 0) {
    sendJson(res, 401, { error: "invalid_refresh_token" });
    return;
  }
  const row = result.rows[0];
  const accessToken = await signAccessToken(config, {
    sub: row.user_id,
    username: row.username,
    deviceId: row.device_id,
    sessionId: row.session_id,
  });
  sendJson(res, 200, { accessToken });
}

async function requireAuth(req: IncomingMessage, config: ServerConfig) {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) {
    throw new Error("missing bearer token");
  }
  return verifyAccessToken(config, authorization.slice("Bearer ".length));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBodyBytes) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
