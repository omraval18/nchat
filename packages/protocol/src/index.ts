import { z } from "zod";

export const usernameSchema = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[a-zA-Z0-9_]+$/, "usernames may contain letters, numbers, and underscores");

export const displayNameSchema = z.string().min(1).max(80);
export const passwordSchema = z.string().min(8).max(256);
export const messageBodySchema = z.string().min(1).max(8_000);
export const publicKeySchema = z.string().min(16).max(512);

export const signupRequestSchema = z.object({
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  deviceName: z.string().min(1).max(80),
  publicIdentityKey: publicKeySchema,
});

export const loginRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  deviceName: z.string().min(1).max(80),
  publicIdentityKey: publicKeySchema,
});

export const authResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  user: z.object({
    id: z.string().uuid(),
    username: usernameSchema,
    displayName: displayNameSchema,
  }),
  device: z.object({
    id: z.string().uuid(),
    publicIdentityKey: publicKeySchema,
  }),
});

export const connectionSchema = z.object({
  userId: z.string().uuid(),
  username: usernameSchema,
  displayName: displayNameSchema,
  online: z.boolean(),
});

export const groupSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  ownerUserId: z.string().uuid(),
  memberCount: z.number().int().nonnegative(),
});

export const deviceKeyBundleSchema = z.object({
  deviceId: z.string().uuid(),
  deviceName: z.string().min(1).max(80),
  publicIdentityKey: publicKeySchema,
  lastSeenAt: z.string().nullable(),
});

export const plaintextPayloadSchema = z.object({
  kind: z.literal("plaintext.v1"),
  body: messageBodySchema,
});

export const encryptedDirectPayloadSchema = z.object({
  kind: z.literal("direct.e2ee.v1"),
  senderDeviceId: z.string().uuid(),
  senderPublicIdentityKey: publicKeySchema,
  recipients: z.array(
    z.object({
      deviceId: z.string().uuid(),
      nonce: z.string().min(1),
      ciphertext: z.string().min(1),
      tag: z.string().min(1),
    }),
  ),
});

export const directMessagePayloadSchema = z.discriminatedUnion("kind", [
  plaintextPayloadSchema,
  encryptedDirectPayloadSchema,
]);

export const clientMessageSendSchema = z.object({
  type: z.literal("message.send"),
  messageId: z.string().uuid(),
  toUsername: usernameSchema,
  payload: directMessagePayloadSchema,
  createdAt: z.number().int().positive(),
});

export const clientGroupMessageSendSchema = z.object({
  type: z.literal("group.message.send"),
  messageId: z.string().uuid(),
  groupId: z.string().uuid(),
  payload: directMessagePayloadSchema,
  createdAt: z.number().int().positive(),
});

export const serverMessageIncomingSchema = z.object({
  type: z.literal("message.incoming"),
  messageId: z.string().uuid(),
  fromUsername: usernameSchema,
  fromUserId: z.string().uuid(),
  payload: directMessagePayloadSchema,
  createdAt: z.number().int().positive(),
});

export const serverGroupMessageIncomingSchema = z.object({
  type: z.literal("group.message.incoming"),
  messageId: z.string().uuid(),
  groupId: z.string().uuid(),
  groupName: z.string().min(1).max(80),
  fromUsername: usernameSchema,
  fromUserId: z.string().uuid(),
  payload: directMessagePayloadSchema,
  createdAt: z.number().int().positive(),
});

export const serverMessageAckSchema = z.object({
  type: z.literal("message.ack"),
  messageId: z.string().uuid(),
  status: z.enum(["accepted", "delivered", "failed"]),
  reason: z.string().optional(),
});

export const serverPresenceSchema = z.object({
  type: z.literal("presence.update"),
  username: usernameSchema,
  online: z.boolean(),
});

export const serverErrorSchema = z.object({
  type: z.literal("error"),
  code: z.string(),
  message: z.string(),
});

export const clientWsEventSchema = z.discriminatedUnion("type", [
  clientMessageSendSchema,
  clientGroupMessageSendSchema,
]);
export const serverWsEventSchema = z.discriminatedUnion("type", [
  serverMessageIncomingSchema,
  serverGroupMessageIncomingSchema,
  serverMessageAckSchema,
  serverPresenceSchema,
  serverErrorSchema,
]);

export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type Group = z.infer<typeof groupSchema>;
export type DeviceKeyBundle = z.infer<typeof deviceKeyBundleSchema>;
export type DirectMessagePayload = z.infer<typeof directMessagePayloadSchema>;
export type PlaintextPayload = z.infer<typeof plaintextPayloadSchema>;
export type EncryptedDirectPayload = z.infer<typeof encryptedDirectPayloadSchema>;
export type ClientWsEvent = z.infer<typeof clientWsEventSchema>;
export type ServerWsEvent = z.infer<typeof serverWsEventSchema>;

export type ConversationType = "direct" | "group";
export type MessageDirection = "incoming" | "outgoing";
export type MessageStatus = "pending" | "sent" | "delivered" | "failed";

export function directConversationId(aUserId: string, bUserId: string): string {
  return [aUserId, bUserId].sort().join(":");
}

export function encodePlaintextPayload(body: string): DirectMessagePayload {
  return { kind: "plaintext.v1", body };
}
