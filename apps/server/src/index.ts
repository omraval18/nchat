import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { createDb, runMigrations } from "./db.js";
import { handleHttp } from "./http.js";
import { createRealtimeHub } from "./ws.js";

const config = loadConfig();
const db = createDb(config.databaseUrl);
await runMigrations(db);

const hub = createRealtimeHub(db, config);
const server = createServer((req, res) => {
  void handleHttp(req, res, { db, config, onlineUsers: hub.onlineUsers });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/ws") {
    hub.handleUpgrade(req, socket, head);
    return;
  }
  socket.destroy();
});

server.listen(config.port, () => {
  console.log(`nchat transport server listening on http://localhost:${config.port}`);
});

process.on("SIGINT", () => shutdown());
process.on("SIGTERM", () => shutdown());

function shutdown(): void {
  server.close(() => {
    process.exit(0);
  });
}
