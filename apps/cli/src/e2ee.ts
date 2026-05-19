import {
  createHash,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import type { DeviceKeyBundle, DirectMessagePayload, EncryptedDirectPayload } from "@nchat/protocol";
import type { LocalAccount } from "./local-store.js";

const algorithm = "aes-256-gcm";
const keyLength = 32;
const nonceLength = 12;

export function encryptDirectPayload(input: {
  account: LocalAccount;
  messageId: string;
  recipientDevices: DeviceKeyBundle[];
  body: string;
}): EncryptedDirectPayload {
  if (input.recipientDevices.length === 0) {
    throw new Error("recipient has no registered devices");
  }

  const plaintext = Buffer.from(JSON.stringify({ body: input.body }), "utf8");
  return {
    kind: "direct.e2ee.v1",
    senderDeviceId: input.account.deviceId,
    senderPublicIdentityKey: input.account.publicIdentityKey,
    recipients: input.recipientDevices.map((device) => {
      const nonce = randomBytes(nonceLength);
      const key = deriveDirectKey({
        privateIdentityKey: input.account.privateIdentityKey,
        peerPublicIdentityKey: device.publicIdentityKey,
        senderDeviceId: input.account.deviceId,
        recipientDeviceId: device.deviceId,
        messageId: input.messageId,
      });
      const cipher = createCipheriv(algorithm, key, nonce);
      cipher.setAAD(associatedData(input.messageId, input.account.deviceId, device.deviceId));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      return {
        deviceId: device.deviceId,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      };
    }),
  };
}

export function decryptDirectPayload(input: {
  account: LocalAccount;
  messageId: string;
  payload: DirectMessagePayload;
}): string {
  if (input.payload.kind === "plaintext.v1") {
    return input.payload.body;
  }

  const recipient = input.payload.recipients.find((item) => item.deviceId === input.account.deviceId);
  if (!recipient) {
    throw new Error("message was not encrypted for this device");
  }

  const key = deriveDirectKey({
    privateIdentityKey: input.account.privateIdentityKey,
    peerPublicIdentityKey: input.payload.senderPublicIdentityKey,
    senderDeviceId: input.payload.senderDeviceId,
    recipientDeviceId: input.account.deviceId,
    messageId: input.messageId,
  });
  const decipher = createDecipheriv(algorithm, key, Buffer.from(recipient.nonce, "base64url"));
  decipher.setAAD(associatedData(input.messageId, input.payload.senderDeviceId, input.account.deviceId));
  decipher.setAuthTag(Buffer.from(recipient.tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(recipient.ciphertext, "base64url")),
    decipher.final(),
  ]);
  const parsed = JSON.parse(plaintext.toString("utf8")) as { body?: unknown };
  if (typeof parsed.body !== "string") {
    throw new Error("invalid encrypted message body");
  }
  return parsed.body;
}

export function publicKeyFingerprint(publicIdentityKey: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicIdentityKey, "base64url")).digest("hex");
  return digest.match(/.{1,4}/g)?.slice(0, 8).join(" ") ?? digest;
}

function deriveDirectKey(input: {
  privateIdentityKey: string;
  peerPublicIdentityKey: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  messageId: string;
}): Buffer {
  const sharedSecret = diffieHellman({
    privateKey: createPrivateKey({
      key: Buffer.from(input.privateIdentityKey, "base64url"),
      format: "der",
      type: "pkcs8",
    }),
    publicKey: createPublicKey({
      key: Buffer.from(input.peerPublicIdentityKey, "base64url"),
      format: "der",
      type: "spki",
    }),
  });
  return Buffer.from(
    hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.from(`nchat-direct-v1:${input.messageId}`, "utf8"),
      Buffer.from(`${input.senderDeviceId}:${input.recipientDeviceId}`, "utf8"),
      keyLength,
    ),
  );
}

function associatedData(messageId: string, senderDeviceId: string, recipientDeviceId: string): Buffer {
  return Buffer.from(`nchat-direct-v1:${messageId}:${senderDeviceId}:${recipientDeviceId}`, "utf8");
}
