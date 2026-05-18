import readline from "node:readline";
import type { Connection } from "@nchat/protocol";
import type { ClientGateway, GatewayStatus } from "./gateway.js";
import type { LocalMessage } from "./local-store.js";

export class NchatTui {
  private input = "";
  private activePeer: string | undefined;
  private connections: Connection[] = [];
  private messages: LocalMessage[] = [];
  private status: GatewayStatus = { websocket: "disconnected" };
  private selectedSuggestion = 0;

  constructor(private readonly gateway: ClientGateway) {}

  async run(): Promise<void> {
    this.connections = await this.gateway.refreshConnections();
    this.activePeer = this.connections[0]?.username;
    this.gateway.setActivePeer(this.activePeer);
    this.messages = this.activePeer ? this.gateway.getMessages(this.activePeer) : [];

    this.gateway.on("message", (message) => {
      if (message.peerUsername === this.activePeer) {
        this.messages = this.gateway.getMessages(this.activePeer);
      }
      this.render();
    });
    this.gateway.on("connections", (connections) => {
      this.connections = connections;
      this.render();
    });
    this.gateway.on("status", (status) => {
      this.status = status;
      this.render();
    });

    await this.gateway.start();
    this.setupInput();
    this.render();
  }

  private setupInput(): void {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", (_str, key) => {
      if (key.ctrl && key.name === "c") {
        this.close();
        return;
      }
      if (key.name === "return") {
        void this.submit();
        return;
      }
      if (key.name === "backspace") {
        this.input = this.input.slice(0, -1);
        this.selectedSuggestion = 0;
        this.render();
        return;
      }
      if (key.name === "tab") {
        this.applySuggestion();
        return;
      }
      if (key.name === "up") {
        this.moveSuggestion(-1);
        return;
      }
      if (key.name === "down") {
        this.moveSuggestion(1);
        return;
      }
      if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
        this.input += key.sequence;
        this.selectedSuggestion = 0;
        this.render();
      }
    });
  }

  private async submit(): Promise<void> {
    const value = this.input.trim();
    this.input = "";
    if (!value) {
      this.render();
      return;
    }

    if (value.startsWith("/ping")) {
      const [, username] = value.split(/\s+/, 2);
      if (username) {
        await this.switchPeer(username);
      }
      this.render();
      return;
    }

    if (value === "/help") {
      this.messages = [
        ...this.messages,
        systemMessage("Commands: /ping <username> switches direct chat. Type text to send to active chat."),
      ];
      this.render();
      return;
    }

    if (!this.activePeer) {
      this.messages = [...this.messages, systemMessage("No active chat. Use /ping <username> first.")];
      this.render();
      return;
    }

    await this.gateway.sendMessage(this.activePeer, value);
    this.messages = this.gateway.getMessages(this.activePeer);
    this.render();
  }

  private async switchPeer(username: string): Promise<void> {
    const connection = this.connections.find((item) => item.username === username);
    if (!connection) {
      this.messages = [...this.messages, systemMessage(`No connection named ${username}.`)] ;
      return;
    }
    this.activePeer = username;
    this.gateway.setActivePeer(username);
    this.messages = this.gateway.getMessages(username);
  }

  private applySuggestion(): void {
    const suggestions = this.suggestions();
    const selected = suggestions[this.selectedSuggestion];
    if (!selected) return;
    this.input = `/ping ${selected.username}`;
    this.render();
  }

  private moveSuggestion(direction: number): void {
    const suggestions = this.suggestions();
    if (suggestions.length === 0) return;
    this.selectedSuggestion = (this.selectedSuggestion + direction + suggestions.length) % suggestions.length;
    this.render();
  }

  private suggestions(): Connection[] {
    if (!this.input.startsWith("/ping")) return [];
    const rest = this.input.slice("/ping".length).trimStart().toLowerCase();
    return this.connections
      .filter((connection) => connection.username.toLowerCase().includes(rest) || connection.displayName.toLowerCase().includes(rest))
      .slice(0, 8);
  }

  private render(): void {
    const width = process.stdout.columns || 100;
    const height = process.stdout.rows || 32;
    const suggestions = this.suggestions();
    const transcriptHeight = Math.max(6, height - 8 - suggestions.length);
    const visibleMessages = this.messages.slice(-transcriptHeight);

    process.stdout.write("\x1b[2J\x1b[H");
    writeLine(boxLine(width));
    writeLine(pad(` nchat ${this.status.websocket} ${this.activePeer ? `| direct: ${this.activePeer}` : "| no chat selected"}`, width));
    writeLine(boxLine(width));

    for (const message of visibleMessages) {
      const prefix = message.direction === "outgoing" ? "me" : message.senderUsername;
      const status = message.direction === "outgoing" ? ` [${message.status}]` : "";
      writeLine(pad(` ${prefix}: ${message.body}${status}`, width));
    }

    for (let index = visibleMessages.length; index < transcriptHeight; index += 1) {
      writeLine(pad("", width));
    }

    writeLine(boxLine(width));
    writeLine(pad(` > ${this.input}`, width));
    for (const [index, suggestion] of suggestions.entries()) {
      const marker = index === this.selectedSuggestion ? ">" : " ";
      const online = suggestion.online ? "online" : "offline";
      writeLine(pad(` ${marker} ${suggestion.username.padEnd(18)} ${suggestion.displayName.padEnd(28)} ${online}`, width));
    }
    writeLine(pad(" /ping <username> switches chat | /help | Tab completes | Ctrl-C exits", width));
  }

  private close(): void {
    this.gateway.stop();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdout.write("\x1b[2J\x1b[H");
    process.exit(0);
  }
}

function systemMessage(body: string): LocalMessage {
  const now = Date.now();
  return {
    id: `system:${now}`,
    conversationId: "system",
    peerUsername: "system",
    senderUsername: "system",
    body,
    direction: "incoming",
    status: "delivered",
    createdAt: now,
    updatedAt: now,
  };
}

function boxLine(width: number): string {
  return "-".repeat(width);
}

function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width);
  return value.padEnd(width, " ");
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}
