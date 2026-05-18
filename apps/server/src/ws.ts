import type { IncomingMessage } from "node:http";
import {
  clientWsEventSchema,
  serverMessageAckSchema,
  serverMessageIncomingSchema,
  type ServerWsEvent,
} from "@nchat/protocol";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { AuthenticatedSession } from "./auth.js";
import { verifyAccessToken } from "./auth.js";
import type { ServerConfig } from "./config.js";
import type { Db } from "./db.js";

type ClientSocket = {
  ws: WebSocket;
  session: AuthenticatedSession;
};

export type RealtimeHub = {
  onlineUsers: ReadonlySet<string>;
  handleUpgrade(req: IncomingMessage, socket: import("node:net").Socket, head: Buffer): void;
};

export function createRealtimeHub(db: Db, config: ServerConfig): RealtimeHub {
  const wss = new WebSocketServer({ noServer: true });
  const socketsByUserId = new Map<string, Set<ClientSocket>>();

  wss.on("connection", (ws, req) => {
    const session = (req as IncomingMessage & { session?: AuthenticatedSession }).session;
    if (!session) {
      ws.close(1008, "missing session");
      return;
    }
    const client: ClientSocket = { ws, session };
    addSocket(socketsByUserId, client);

    void db.query(`UPDATE devices SET last_seen_at = now() WHERE id = $1`, [session.deviceId]);
    broadcastPresence(socketsByUserId, session.username, true);

    ws.on("message", (raw) => {
      void handleSocketMessage(db, socketsByUserId, client, raw.toString("utf8"));
    });

    ws.on("close", () => {
      removeSocket(socketsByUserId, client);
      if (!socketsByUserId.has(session.userId)) {
        broadcastPresence(socketsByUserId, session.username, false);
      }
    });
  });

  return {
    get onlineUsers() {
      return new Set(socketsByUserId.keys());
    },
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? "/", "http://localhost");
      const token = url.searchParams.get("token");
      if (!token) {
        socket.destroy();
        return;
      }
      verifyAccessToken(config, token)
        .then((session) => {
          (req as IncomingMessage & { session?: AuthenticatedSession }).session = session;
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        })
        .catch(() => socket.destroy());
    },
  };
}

async function handleSocketMessage(
  db: Db,
  socketsByUserId: Map<string, Set<ClientSocket>>,
  client: ClientSocket,
  raw: string,
): Promise<void> {
  const parsed = clientWsEventSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    send(client.ws, { type: "error", code: "invalid_event", message: parsed.error.message });
    return;
  }

  if (parsed.data.type === "message.send") {
    const recipient = await db.query(`SELECT id, username FROM users WHERE username = $1`, [
      parsed.data.toUsername,
    ]);
    if (recipient.rowCount === 0) {
      sendAck(client.ws, parsed.data.messageId, "failed", "recipient_not_found");
      return;
    }

    const recipientUserId = recipient.rows[0].id as string;
    const [userLow, userHigh] = [client.session.userId, recipientUserId].sort();
    const connection = await db.query(
      `SELECT 1 FROM direct_connections WHERE user_low = $1 AND user_high = $2`,
      [userLow, userHigh],
    );
    if (connection.rowCount === 0) {
      sendAck(client.ws, parsed.data.messageId, "failed", "not_connected");
      return;
    }

    const recipientSockets = socketsByUserId.get(recipientUserId);
    if (!recipientSockets || recipientSockets.size === 0) {
      sendAck(client.ws, parsed.data.messageId, "failed", "recipient_offline");
      return;
    }

    const incoming = serverMessageIncomingSchema.parse({
      type: "message.incoming",
      messageId: parsed.data.messageId,
      fromUsername: client.session.username,
      fromUserId: client.session.userId,
      payload: parsed.data.payload,
      createdAt: parsed.data.createdAt,
    });
    for (const recipientClient of recipientSockets) {
      send(recipientClient.ws, incoming);
    }
    sendAck(client.ws, parsed.data.messageId, "delivered");
  }
}

function addSocket(socketsByUserId: Map<string, Set<ClientSocket>>, client: ClientSocket): void {
  const existing = socketsByUserId.get(client.session.userId) ?? new Set<ClientSocket>();
  existing.add(client);
  socketsByUserId.set(client.session.userId, existing);
}

function removeSocket(socketsByUserId: Map<string, Set<ClientSocket>>, client: ClientSocket): void {
  const existing = socketsByUserId.get(client.session.userId);
  if (!existing) return;
  existing.delete(client);
  if (existing.size === 0) socketsByUserId.delete(client.session.userId);
}

function broadcastPresence(
  socketsByUserId: Map<string, Set<ClientSocket>>,
  username: string,
  online: boolean,
): void {
  for (const sockets of socketsByUserId.values()) {
    for (const client of sockets) {
      send(client.ws, { type: "presence.update", username, online });
    }
  }
}

function sendAck(
  ws: WebSocket,
  messageId: string,
  status: "accepted" | "delivered" | "failed",
  reason?: string,
): void {
  send(ws, serverMessageAckSchema.parse({ type: "message.ack", messageId, status, reason }));
}

function send(ws: WebSocket, event: ServerWsEvent): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(event));
  }
}
