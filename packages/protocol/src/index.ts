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

export const directMessagePayloadSchema = z.object({
  kind: z.literal("plaintext.v1"),
  body: messageBodySchema,
});

export const clientMessageSendSchema = z.object({
  type: z.literal("message.send"),
  messageId: z.string().uuid(),
  toUsername: usernameSchema,
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

export const clientWsEventSchema = z.discriminatedUnion("type", [clientMessageSendSchema]);
export const serverWsEventSchema = z.discriminatedUnion("type", [
  serverMessageIncomingSchema,
  serverMessageAckSchema,
  serverPresenceSchema,
  serverErrorSchema,
]);

export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type AuthResponse = z.infer<typeof authResponseSchema>;
export type Connection = z.infer<typeof connectionSchema>;
export type DirectMessagePayload = z.infer<typeof directMessagePayloadSchema>;
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
