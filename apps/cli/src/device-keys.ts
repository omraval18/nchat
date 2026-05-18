import { generateKeyPairSync } from "node:crypto";

export type DeviceKeys = {
  publicIdentityKey: string;
  privateIdentityKey: string;
};

export function createDeviceKeys(): DeviceKeys {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicIdentityKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateIdentityKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}
