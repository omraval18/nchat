import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import {
  directConversationId,
  encodePlaintextPayload,
  serverWsEventSchema,
  type Connection,
  type DeviceKeyBundle,
  type DirectMessagePayload,
  type Group,
  type MessageStatus,
} from "@nchat/protocol";
import WebSocket from "ws";
import { ApiClient } from "./api-client.js";
import type { ClientConfig } from "./config.js";
import { createDeviceKeys } from "./device-keys.js";
import { decryptDirectPayload, encryptDirectPayload } from "./e2ee.js";
import { LocalStore, type LocalAccount, type LocalMessage, type OutboxItem } from "./local-store.js";

export type GatewayEvents = {
  message: [LocalMessage];
  status: [GatewayStatus];
  connections: [Connection[]];
  groups: [Group[]];
};

export type GatewayStatus = {
  websocket: "disconnected" | "connecting" | "connected";
  activePeer?: string;
  lastError?: string;
};

export class ClientGateway extends EventEmitter<GatewayEvents> {
  private readonly api: ApiClient;
  private ws: WebSocket | null = null;
  private status: GatewayStatus = { websocket: "disconnected" };
  private outboxTimer: NodeJS.Timeout | null = null;
  private pendingAcks = new Map<string, (status: MessageStatus, reason?: string) => void>();
  private stopped = true;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ClientConfig,
    private readonly store: LocalStore,
  ) {
    super();
    this.api = new ApiClient(config.serverUrl);
  }

  async signup(input: { username: string; displayName: string; password: string; deviceName: string }): Promise<LocalAccount> {
    const keys = createDeviceKeys();
    const auth = await this.api.signup({
      username: input.username,
      displayName: input.displayName,
      password: input.password,
      deviceName: input.deviceName,
      publicIdentityKey: keys.publicIdentityKey,
    });
    this.store.saveAccount(auth, keys.privateIdentityKey);
    return this.requireAccount();
  }

  async login(input: { username: string; password: string; deviceName: string }): Promise<LocalAccount> {
    const keys = createDeviceKeys();
    const auth = await this.api.login({
      username: input.username,
      password: input.password,
      deviceName: input.deviceName,
      publicIdentityKey: keys.publicIdentityKey,
    });
    this.store.saveAccount(auth, keys.privateIdentityKey);
    return this.requireAccount();
  }

  logout(): void {
    this.stop();
    this.store.clearAccount();
  }

  getAccount(): LocalAccount | null {
    return this.store.getAccount();
  }

  async refreshConnections(): Promise<Connection[]> {
    const account = await this.accountWithFreshToken();
    const connections = await this.api.listConnections(account.accessToken);
    this.store.upsertConnections(connections);
    this.emit("connections", connections);
    return connections;
  }

  async refreshGroups(): Promise<Group[]> {
    const account = await this.accountWithFreshToken();
    const groups = await this.api.listGroups(account.accessToken);
    this.store.upsertGroups(groups);
    this.emit("groups", groups);
    return groups;
  }

  listCachedGroups(): Group[] {
    return this.store.listGroups();
  }

  async createGroup(name: string): Promise<Group> {
    const account = await this.accountWithFreshToken();
    const group = await this.api.createGroup(name, account.accessToken);
    await this.refreshGroups();
    return group;
  }

  async addGroupMember(groupId: string, username: string): Promise<void> {
    const account = await this.accountWithFreshToken();
    await this.api.addGroupMember(groupId, username, account.accessToken);
    await this.refreshGroups();
  }

  listCachedConnections(): Connection[] {
    return this.store.listConnections();
  }

  async connect(username: string): Promise<void> {
    const account = await this.accountWithFreshToken();
    await this.api.connect(username, account.accessToken);
    await this.refreshConnections();
  }

  async listUserDevices(username: string): Promise<DeviceKeyBundle[]> {
    const account = await this.accountWithFreshToken();
    const devices = await this.api.listUserDevices(username, account.accessToken);
    this.store.rememberDeviceKeys(username, devices);
    return devices;
  }

  getMessages(peerUsername: string): LocalMessage[] {
    return this.store.listMessages(peerUsername);
  }

  getGroupMessages(groupId: string): LocalMessage[] {
    return this.store.listMessages(groupConversationKey(groupId));
  }

  async sendMessage(peerUsername: string, body: string): Promise<LocalMessage> {
    const account = this.requireAccount();
    const connection = this.store.getConnection(peerUsername) ?? (await this.refreshConnections()).find((item) => item.username === peerUsername);
    if (!connection) {
      throw new Error(`not connected to ${peerUsername}`);
    }

    const createdAt = Date.now();
    const messageId = randomUUID();
    const message: LocalMessage = {
      id: messageId,
      conversationId: directConversationId(account.userId, connection.userId),
      peerUsername,
      senderUsername: account.username,
      body,
      direction: "outgoing",
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    const recipientDevices = await this.listUserDevices(peerUsername);
    const payload = encryptDirectPayload({
      account,
      messageId,
      recipientDevices,
      body,
    });
    this.store.insertMessage(message);
    this.store.enqueue({
      id: randomUUID(),
      messageId: message.id,
      toUsername: peerUsername,
      payload: JSON.stringify(payload),
      status: "queued",
      attempts: 0,
      nextAttemptAt: Date.now(),
    });
    this.emit("message", message);
    void this.flushOutbox();
    return message;
  }

  async sendGroupMessage(groupId: string, body: string): Promise<LocalMessage> {
    const account = this.requireAccount();
    const group = this.store.getGroupByIdOrName(groupId) ?? (await this.refreshGroups()).find((item) => item.id === groupId);
    if (!group) {
      throw new Error(`unknown group ${groupId}`);
    }

    const createdAt = Date.now();
    const message: LocalMessage = {
      id: randomUUID(),
      conversationId: group.id,
      peerUsername: groupConversationKey(group.id),
      senderUsername: account.username,
      body,
      direction: "outgoing",
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };
    this.store.insertMessage(message);
    this.store.enqueue({
      id: randomUUID(),
      messageId: message.id,
      toUsername: groupConversationKey(group.id),
      payload: JSON.stringify(encodePlaintextPayload(body)),
      status: "queued",
      attempts: 0,
      nextAttemptAt: Date.now(),
    });
    this.emit("message", message);
    void this.flushOutbox();
    return message;
  }

  async sendMessageAndWait(peerUsername: string, body: string, timeoutMs = 8_000): Promise<MessageStatus> {
    const message = await this.sendMessage(peerUsername, body);
    if (message.status !== "pending") return message.status;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(message.id);
        resolve("pending");
      }, timeoutMs);
      this.pendingAcks.set(message.id, (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
  }

  async sendGroupMessageAndWait(groupId: string, body: string, timeoutMs = 8_000): Promise<MessageStatus> {
    const message = await this.sendGroupMessage(groupId, body);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(message.id);
        resolve("pending");
      }, timeoutMs);
      this.pendingAcks.set(message.id, (status) => {
        clearTimeout(timer);
        resolve(status);
      });
    });
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.store.resetSendingOutbox();

    try {
      await this.refreshConnections();
    } catch (error) {
      this.recordError(error);
      this.emit("connections", this.store.listConnections());
    }

    try {
      await this.refreshGroups();
    } catch (error) {
      this.recordError(error);
      this.emit("groups", this.store.listGroups());
    }

    try {
      await this.connectWebSocket();
    } catch (error) {
      this.recordError(error);
      this.scheduleReconnect();
    }

    this.outboxTimer = setInterval(() => void this.flushOutbox(), 2_000);
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.outboxTimer) clearInterval(this.outboxTimer);
    this.outboxTimer = null;
    this.ws?.close();
    this.ws = null;
    this.setStatus({ websocket: "disconnected" });
  }

  setActivePeer(username: string | undefined): void {
    this.setStatus({ ...this.status, activePeer: username });
  }

  getStatus(): GatewayStatus {
    return this.status;
  }

  private async connectWebSocket(): Promise<void> {
    const account = await this.accountWithFreshToken();
    this.setStatus({ websocket: "connecting", activePeer: this.status.activePeer });
    const ws = new WebSocket(`${this.config.wsUrl}/ws?token=${encodeURIComponent(account.accessToken)}`);
    this.ws = ws;

    ws.on("open", () => {
      this.setStatus({ websocket: "connected", activePeer: this.status.activePeer });
      void this.flushOutbox();
    });

    ws.on("message", (raw) => this.handleWsMessage(raw.toString("utf8")));

    ws.on("close", () => {
      if (this.ws === ws) this.ws = null;
      this.setStatus({ websocket: "disconnected", activePeer: this.status.activePeer });
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });

    ws.on("error", (error) => this.recordError(error));
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectWebSocket().catch((error) => {
        this.recordError(error);
        this.scheduleReconnect();
      });
    }, 2_000);
  }

  private async flushOutbox(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    let item: OutboxItem | null;
    while ((item = this.store.nextOutboxItem())) {
      this.store.markOutboxSending(item.id);
      const event = {
        type: item.toUsername.startsWith("group:") ? ("group.message.send" as const) : ("message.send" as const),
        messageId: item.messageId,
        ...(item.toUsername.startsWith("group:")
          ? { groupId: item.toUsername.slice("group:".length) }
          : { toUsername: item.toUsername }),
        payload: JSON.parse(item.payload) as DirectMessagePayload,
        createdAt: Date.now(),
      };
      this.ws.send(JSON.stringify(event));
      this.store.updateMessageStatus(item.messageId, "sent");
    }
  }

  private handleWsMessage(raw: string): void {
    const parsed = serverWsEventSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      this.recordError(new Error(parsed.error.message));
      return;
    }

    if (parsed.data.type === "group.message.incoming") {
      const body =
        parsed.data.payload.kind === "plaintext.v1"
          ? parsed.data.payload.body
          : "[encrypted group payload is not supported by this client]";
      const message: LocalMessage = {
        id: parsed.data.messageId,
        conversationId: parsed.data.groupId,
        peerUsername: groupConversationKey(parsed.data.groupId),
        senderUsername: parsed.data.fromUsername,
        body,
        direction: "incoming",
        status: "delivered",
        createdAt: parsed.data.createdAt,
        updatedAt: Date.now(),
      };
      this.store.insertMessage(message);
      this.emit("message", message);
      return;
    }

    if (parsed.data.type === "message.incoming") {
      const account = this.requireAccount();
      const connection = this.store.getConnection(parsed.data.fromUsername);
      let body: string;
      try {
        body = decryptDirectPayload({
          account,
          messageId: parsed.data.messageId,
          payload: parsed.data.payload,
        });
      } catch (error) {
        this.recordError(error);
        body = "[unable to decrypt message for this device]";
      }
      const message: LocalMessage = {
        id: parsed.data.messageId,
        conversationId: directConversationId(account.userId, parsed.data.fromUserId),
        peerUsername: parsed.data.fromUsername,
        senderUsername: parsed.data.fromUsername,
        body,
        direction: "incoming",
        status: "delivered",
        createdAt: parsed.data.createdAt,
        updatedAt: Date.now(),
      };
      if (connection) this.store.insertMessage(message);
      this.emit("message", message);
      return;
    }

    if (parsed.data.type === "message.ack") {
      const status: MessageStatus = parsed.data.status === "failed" ? "failed" : "delivered";
      this.store.updateMessageStatus(parsed.data.messageId, status);
      if (status === "delivered") {
        this.store.markOutboxSentByMessage(parsed.data.messageId);
      } else {
        this.store.markOutboxFailedByMessage(parsed.data.messageId, Date.now() + 10_000);
      }
      this.pendingAcks.get(parsed.data.messageId)?.(status, parsed.data.reason);
      this.pendingAcks.delete(parsed.data.messageId);
      this.emit("status", this.status);
      return;
    }

    if (parsed.data.type === "presence.update") {
      this.store.setConnectionPresence(parsed.data.username, parsed.data.online);
      this.emit("connections", this.store.listConnections());
      return;
    }

    if (parsed.data.type === "error") {
      this.recordError(new Error(parsed.data.message));
    }
  }

  private async accountWithFreshToken(): Promise<LocalAccount> {
    const account = this.requireAccount();
    if (!isTokenExpiring(account.accessToken)) {
      return account;
    }
    const refreshed = await this.api.refresh(account.refreshToken);
    this.store.updateAccessToken(refreshed.accessToken);
    return this.requireAccount();
  }

  private requireAccount(): LocalAccount {
    const account = this.store.getAccount();
    if (!account) throw new Error("not logged in; run nchat login or nchat signup first");
    return account;
  }

  private setStatus(status: GatewayStatus): void {
    this.status = status;
    this.emit("status", status);
  }

  private recordError(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus({ ...this.status, lastError: message });
  }
}

export function groupConversationKey(groupId: string): string {
  return `group:${groupId}`;
}

function isTokenExpiring(accessToken: string): boolean {
  const [, payload] = accessToken.split(".");
  if (!payload) return true;
  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
    if (typeof decoded.exp !== "number") return true;
    const expiresAtMs = decoded.exp * 1000;
    return expiresAtMs - Date.now() < 60_000;
  } catch {
    return true;
  }
}
