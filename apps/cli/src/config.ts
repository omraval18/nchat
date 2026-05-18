import { homedir } from "node:os";
import { join } from "node:path";

export type ClientConfig = {
  homeDir: string;
  dbPath: string;
  serverUrl: string;
  wsUrl: string;
};

export function loadClientConfig(): ClientConfig {
  const homeDir = process.env.NCHAT_HOME ?? join(homedir(), ".nchat");
  const serverUrl = process.env.NCHAT_SERVER_URL ?? "http://localhost:8787";
  const wsUrl = serverUrl.replace(/^http/, "ws");
  return {
    homeDir,
    dbPath: join(homeDir, "nchat.sqlite"),
    serverUrl,
    wsUrl,
  };
}
