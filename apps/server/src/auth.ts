import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { sql } from "drizzle-orm";
import { jwtVerify, SignJWT } from "jose";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db.js";
import { sessions } from "./schema.js";

export type AuthenticatedSession = {
  userId: string;
  username: string;
  deviceId: string;
  sessionId: string;
};

type TokenPayload = {
  sub: string;
  username: string;
  deviceId: string;
  sessionId: string;
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

export function createRefreshToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

export async function signAccessToken(
  config: ServerConfig,
  payload: TokenPayload,
): Promise<string> {
  const key = new TextEncoder().encode(config.jwtSecret);
  return new SignJWT({
    username: payload.username,
    deviceId: payload.deviceId,
    sessionId: payload.sessionId,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${config.accessTokenTtlSeconds}s`)
    .sign(key);
}

export async function verifyAccessToken(
  config: ServerConfig,
  token: string,
): Promise<AuthenticatedSession> {
  const key = new TextEncoder().encode(config.jwtSecret);
  const result = await jwtVerify(token, key);
  const { payload } = result;

  if (
    typeof payload.sub !== "string" ||
    typeof payload.username !== "string" ||
    typeof payload.deviceId !== "string" ||
    typeof payload.sessionId !== "string"
  ) {
    throw new Error("invalid token payload");
  }

  return {
    userId: payload.sub,
    username: payload.username,
    deviceId: payload.deviceId,
    sessionId: payload.sessionId,
  };
}

export async function createSession(
  db: { insert: Db["insert"] },
  config: ServerConfig,
  user: { id: string; username: string },
  deviceId: string,
): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
  const sessionId = randomUUID();
  const refreshToken = createRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);

  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    deviceId,
    refreshTokenHash,
    expiresAt: sql`now() + (${config.refreshTokenTtlDays} * interval '1 day')`,
  });

  const accessToken = await signAccessToken(config, {
    sub: user.id,
    username: user.username,
    deviceId,
    sessionId,
  });

  return { accessToken, refreshToken, sessionId };
}
