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
import { and, asc, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db.js";
import {
  createSession,
  hashPassword,
  hashRefreshToken,
  signAccessToken,
  verifyAccessToken,
  verifyPassword,
} from "./auth.js";
import {
  devices,
  directConnections,
  groupMembers,
  groups,
  sessions,
  users,
} from "./schema.js";

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
      const rows = await context.db
        .select({ userId: users.id, username: users.username, displayName: users.displayName })
        .from(directConnections)
        .innerJoin(
          users,
          eq(
            users.id,
            sql<string>`CASE WHEN ${directConnections.userLow} = ${session.userId}::uuid THEN ${directConnections.userHigh} ELSE ${directConnections.userLow} END`,
          ),
        )
        .where(
          or(
            eq(directConnections.userLow, session.userId),
            eq(directConnections.userHigh, session.userId),
          ),
        )
        .orderBy(asc(users.username));
      const connections = rows.map((row) =>
        connectionSchema.parse({ ...row, online: context.onlineUsers.has(row.userId) }),
      );
      sendJson(res, 200, { connections });
      return;
    }

    if (req.method === "POST" && url.pathname === "/connections") {
      const session = await requireAuth(req, context.config);
      const body = await readJson(req);
      const username = usernameSchema.parse(body.username);
      const [target] = await context.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username));
      if (!target) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }
      if (target.id === session.userId) {
        sendJson(res, 400, { error: "cannot_connect_self" });
        return;
      }
      const [userLow, userHigh] = [session.userId, target.id].sort() as [string, string];
      await context.db
        .insert(directConnections)
        .values({ userLow, userHigh })
        .onConflictDoNothing();
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
      const [target] = await context.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username));
      if (!target) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }
      if (target.id !== session.userId) {
        const [userLow, userHigh] = [session.userId, target.id].sort() as [string, string];
        const [connection] = await context.db
          .select()
          .from(directConnections)
          .where(
            and(
              eq(directConnections.userLow, userLow),
              eq(directConnections.userHigh, userHigh),
            ),
          );
        if (!connection) {
          sendJson(res, 403, { error: "not_connected" });
          return;
        }
      }
      const deviceRows = await context.db
        .select({
          id: devices.id,
          deviceName: devices.deviceName,
          publicIdentityKey: devices.publicIdentityKey,
          lastSeenAt: devices.lastSeenAt,
        })
        .from(devices)
        .where(eq(devices.userId, target.id))
        .orderBy(asc(devices.createdAt));
      sendJson(res, 200, {
        devices: deviceRows.map((row) =>
          deviceKeyBundleSchema.parse({
            deviceId: row.id,
            deviceName: row.deviceName,
            publicIdentityKey: row.publicIdentityKey,
            lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
          }),
        ),
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/groups") {
      const session = await requireAuth(req, context.config);
      const gmAll = alias(groupMembers, "gm_all");
      const rows = await context.db
        .select({
          id: groups.id,
          name: groups.name,
          ownerUserId: groups.ownerUserId,
          memberCount: count(gmAll.userId),
        })
        .from(groupMembers)
        .innerJoin(groups, eq(groups.id, groupMembers.groupId))
        .innerJoin(gmAll, eq(gmAll.groupId, groups.id))
        .where(eq(groupMembers.userId, session.userId))
        .groupBy(groups.id)
        .orderBy(asc(groups.name));
      sendJson(res, 200, {
        groups: rows.map((row) => groupSchema.parse(row)),
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
      await context.db.transaction(async (tx) => {
        await tx.insert(groups).values({ id: groupId, name, ownerUserId: session.userId });
        await tx.insert(groupMembers).values({ groupId, userId: session.userId, role: "owner" });
      });
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
      const groupId = groupMemberMatch[1]!;
      const body = await readJson(req);
      const username = usernameSchema.parse(body.username);
      const [group] = await context.db
        .select({ ownerUserId: groups.ownerUserId })
        .from(groups)
        .where(eq(groups.id, groupId));
      if (!group) {
        sendJson(res, 404, { error: "group_not_found" });
        return;
      }
      if (group.ownerUserId !== session.userId) {
        sendJson(res, 403, { error: "group_owner_required" });
        return;
      }
      const [target] = await context.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username));
      if (!target) {
        sendJson(res, 404, { error: "user_not_found" });
        return;
      }
      if (target.id !== session.userId) {
        const [userLow, userHigh] = [session.userId, target.id].sort() as [string, string];
        const [connection] = await context.db
          .select()
          .from(directConnections)
          .where(
            and(
              eq(directConnections.userLow, userLow),
              eq(directConnections.userHigh, userHigh),
            ),
          );
        if (!connection) {
          sendJson(res, 403, { error: "not_connected" });
          return;
        }
      }
      await context.db
        .insert(groupMembers)
        .values({ groupId, userId: target.id, role: "member" })
        .onConflictDoNothing();
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
    const session = await db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        username: body.username,
        displayName: body.displayName,
        passwordHash,
      });
      await tx.insert(devices).values({
        id: deviceId,
        userId,
        deviceName: body.deviceName,
        publicIdentityKey: body.publicIdentityKey,
      });
      return createSession(tx, config, { id: userId, username: body.username }, deviceId);
    });

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
  const [user] = await db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.username, body.username));
  if (!user) {
    sendJson(res, 401, { error: "invalid_credentials" });
    return;
  }
  if (!(await verifyPassword(user.passwordHash, body.password))) {
    sendJson(res, 401, { error: "invalid_credentials" });
    return;
  }

  const deviceId = randomUUID();
  await db.insert(devices).values({
    id: deviceId,
    userId: user.id,
    deviceName: body.deviceName,
    publicIdentityKey: body.publicIdentityKey,
  });
  const session = await createSession(db, config, { id: user.id, username: user.username }, deviceId);

  sendJson(
    res,
    200,
    authResponseSchema.parse({
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      user: { id: user.id, username: user.username, displayName: user.displayName },
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
  const [row] = await db
    .select({
      sessionId: sessions.id,
      userId: sessions.userId,
      deviceId: sessions.deviceId,
      username: users.username,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.refreshTokenHash, refreshTokenHash),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, sql`now()`),
      ),
    );
  if (!row) {
    sendJson(res, 401, { error: "invalid_refresh_token" });
    return;
  }
  const accessToken = await signAccessToken(config, {
    sub: row.userId,
    username: row.username,
    deviceId: row.deviceId,
    sessionId: row.sessionId,
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
