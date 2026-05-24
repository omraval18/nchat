import {
  CombinedAutocompleteProvider,
  Editor,
  ProcessTerminal,
  TUI,
  truncateToWidth,
  type AutocompleteItem,
  type Component,
  type EditorTheme,
  type SlashCommand,
} from "@earendil-works/pi-tui";
import type { Connection, Group } from "@nchat/protocol";
import {
  groupConversationKey,
  type ClientGateway,
  type GatewayStatus,
} from "./gateway.js";
import type { LocalMessage } from "./local-store.js";

const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
};

const cyan = (text: string): string => `${ansi.cyan}${text}${ansi.reset}`;
const green = (text: string): string => `${ansi.green}${text}${ansi.reset}`;
const yellow = (text: string): string => `${ansi.yellow}${text}${ansi.reset}`;
const red = (text: string): string => `${ansi.red}${text}${ansi.reset}`;
const dim = (text: string): string => `${ansi.dim}${text}${ansi.reset}`;
const bold = (text: string): string => `${ansi.bold}${text}${ansi.reset}`;

const editorTheme: EditorTheme = {
  borderColor: cyan,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: red,
  },
};

type UiEntry = {
  role: "system" | "incoming" | "outgoing" | "error";
  text: string;
};

export class NchatTui {
  private readonly terminal = new ProcessTerminal();
  private readonly tui = new TUI(this.terminal);
  private readonly editor = new Editor(this.tui, editorTheme, { paddingX: 1 });
  private readonly transcript = new TranscriptLog();
  private readonly statusLine = new StatusLine("starting...");

  private activePeer: string | undefined;
  private activeGroup: Group | undefined;
  private connections: Connection[] = [];
  private groups: Group[] = [];
  private status: GatewayStatus = { websocket: "disconnected" };
  private stopped = false;

  constructor(private readonly gateway: ClientGateway) {}

  async run(): Promise<void> {
    try {
      this.connections = await this.gateway.refreshConnections();
    } catch {
      this.connections = this.gateway.listCachedConnections();
    }

    try {
      this.groups = await this.gateway.refreshGroups();
    } catch {
      this.groups = this.gateway.listCachedGroups();
    }
    this.activePeer = this.connections[0]?.username;
    this.gateway.setActivePeer(this.activePeer);

    this.bindGatewayEvents();

    await this.gateway.start();

    this.editor.setAutocompleteProvider(this.createAutocompleteProvider());
    this.editor.onSubmit = (value) => {
      void this.submit(value);
    };

    this.tui.addChild(this.transcript);
    this.tui.addChild(this.statusLine);
    this.tui.addChild(this.editor);
    this.tui.setFocus(this.editor);

    this.tui.addInputListener((data) => {
      if (data.length === 1 && data.charCodeAt(0) === 3) {
        this.stop();
        return { consume: true };
      }
      return undefined;
    });

    this.syncTranscriptFromActiveConversation();
    this.pushSystem("Commands: /ping /group /group create /grpadd /help /exit");
    this.updateFooter();

    this.tui.start();
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (this.stopped) {
          clearInterval(timer);
          resolve();
        }
      }, 25);
    });
  }

  private bindGatewayEvents(): void {
    this.gateway.on("message", (message) => {
      const activeKey = this.activeGroup
        ? groupConversationKey(this.activeGroup.id)
        : this.activePeer;
      if (message.peerUsername === activeKey) {
        this.syncTranscriptFromActiveConversation();
      }
      this.tui.requestRender(true);
    });

    this.gateway.on("connections", (connections) => {
      this.connections = connections;
      this.updateFooter();
      this.tui.requestRender(true);
    });

    this.gateway.on("groups", (groups) => {
      this.groups = groups;
      this.updateFooter();
      this.tui.requestRender(true);
    });

    this.gateway.on("status", (status) => {
      this.status = status;
      this.updateFooter();
      this.tui.requestRender(true);
    });
  }

  private async submit(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value) return;

    this.editor.addToHistory(value);
    this.editor.setText("");

    try {
      if (await this.handleCommand(value)) {
        this.tui.requestRender(true);
        return;
      }
    } catch (error) {
      this.pushError(error instanceof Error ? error.message : String(error));
      this.tui.requestRender(true);
      return;
    }

    if (!this.activePeer && !this.activeGroup) {
      this.pushSystem(
        "No active chat. Use /ping <username> or /group <name> first.",
      );
      this.tui.requestRender(true);
      return;
    }

    try {
      if (this.activeGroup) {
        await this.gateway.sendGroupMessage(this.activeGroup.id, value);
      } else if (this.activePeer) {
        await this.gateway.sendMessage(this.activePeer, value);
      }
      this.syncTranscriptFromActiveConversation();
    } catch (error) {
      this.pushError(error instanceof Error ? error.message : String(error));
    }

    this.tui.requestRender(true);
  }

  private async handleCommand(value: string): Promise<boolean> {
    if (value === "/exit" || value === "/quit") {
      this.stop();
      return true;
    }

    if (value === "/help") {
      this.pushSystem(
        "/ping <username> | /group <name> | /group create <name> | /grpadd <username> | /exit",
      );
      return true;
    }

    if (value.startsWith("/ping")) {
      const [, username] = value.split(/\s+/, 2);
      if (!username) {
        this.pushError("Use /ping <username>");
        return true;
      }
      await this.switchPeer(username);
      return true;
    }

    if (value.startsWith("/group create ")) {
      const name = value.slice("/group create ".length).trim();
      if (!name) {
        this.pushError("Use /group create <name>");
        return true;
      }
      const group = await this.gateway.createGroup(name);
      await this.switchGroup(group.name);
      this.pushSystem(
        `Created group ${group.name}. Use /grpadd <username> to add members.`,
      );
      return true;
    }

    if (value.startsWith("/group")) {
      const [, groupName] = value.split(/\s+/, 2);
      if (!groupName) {
        this.pushError("Use /group <name>");
        return true;
      }
      await this.switchGroup(groupName);
      return true;
    }

    if (value.startsWith("/grpadd")) {
      const [, username] = value.split(/\s+/, 2);
      if (!this.activeGroup) {
        this.pushError("Switch to a group before using /grpadd.");
        return true;
      }
      if (!username) {
        this.pushError("Use /grpadd <username>");
        return true;
      }
      await this.gateway.addGroupMember(this.activeGroup.id, username);
      this.pushSystem(`Added ${username} to ${this.activeGroup.name}.`);
      return true;
    }

    return false;
  }

  private async switchPeer(username: string): Promise<void> {
    const connection = this.connections.find(
      (item) => item.username === username,
    );
    if (!connection) {
      this.pushError(`No connection named ${username}.`);
      return;
    }

    this.activePeer = username;
    this.activeGroup = undefined;
    this.gateway.setActivePeer(username);
    this.syncTranscriptFromActiveConversation();
    this.updateFooter();
  }

  private async switchGroup(value: string): Promise<void> {
    const group = this.groups.find(
      (item) =>
        item.id === value || item.name.toLowerCase() === value.toLowerCase(),
    );
    if (!group) {
      this.pushError(`No group named ${value}.`);
      return;
    }

    this.activeGroup = group;
    this.activePeer = undefined;
    this.gateway.setActivePeer(`#${group.name}`);
    this.syncTranscriptFromActiveConversation();
    this.updateFooter();
  }

  private syncTranscriptFromActiveConversation(): void {
    const messages = this.activeGroup
      ? this.gateway.getGroupMessages(this.activeGroup.id)
      : this.activePeer
        ? this.gateway.getMessages(this.activePeer)
        : [];

    this.transcript.replaceConversationEntries(
      messages.map((message) => toUiEntry(message)),
    );
  }

  private updateFooter(): void {
    const account = this.gateway.getAccount();
    const identity = account
      ? `${account.username}@${account.deviceId.slice(0, 8)}`
      : "guest";
    const target = this.activeGroup
      ? `group:${this.activeGroup.name}`
      : this.activePeer
        ? `${this.activePeer}`
        : "no-chat";
    const ws = this.status.websocket;
    this.statusLine.setText(
      `nchat | status:${ws} | me:${identity} | to:${target}`,
    );
  }

  private pushSystem(text: string): void {
    this.transcript.push({ role: "system", text });
  }

  private pushError(text: string): void {
    this.transcript.push({ role: "error", text });
  }

  private createAutocompleteProvider(): CombinedAutocompleteProvider {
    const commands: SlashCommand[] = [
      {
        name: "ping",
        description: "Switch to a direct chat",
        getArgumentCompletions: (prefix) => this.connectionCompletions(prefix),
      },
      {
        name: "group",
        description: "Switch to a group or create one",
        getArgumentCompletions: (prefix) => this.groupCompletions(prefix),
      },
      {
        name: "grpadd",
        description: "Add connection to current group",
        getArgumentCompletions: (prefix) => this.connectionCompletions(prefix),
      },
      { name: "help", description: "Show commands" },
      { name: "exit", description: "Quit nchat" },
      { name: "quit", description: "Quit nchat" },
    ];

    return new CombinedAutocompleteProvider(commands, process.cwd());
  }

  private connectionCompletions(prefix: string): AutocompleteItem[] | null {
    const q = prefix.toLowerCase().trim();
    const items = this.connections.map((connection) => ({
      value: connection.username,
      label: connection.username,
      description: `${connection.displayName} (${connection.online ? "online" : "offline"})`,
    }));
    const filtered = items.filter(
      (item) =>
        item.value.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        (item.description?.toLowerCase().includes(q) ?? false),
    );
    return filtered.length > 0 ? filtered.slice(0, 30) : null;
  }

  private groupCompletions(prefix: string): AutocompleteItem[] | null {
    const q = prefix.toLowerCase().trim();
    const create: AutocompleteItem[] =
      "create".startsWith(q) || q.startsWith("create")
        ? [{ value: "create", label: "create", description: "create a group" }]
        : [];

    const groups = this.groups.map((group) => ({
      value: group.name,
      label: group.name,
      description: `${group.memberCount} members`,
    }));

    const filteredGroups = groups.filter(
      (item) =>
        item.value.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        (item.description?.toLowerCase().includes(q) ?? false),
    );

    const merged = [...create, ...filteredGroups];
    return merged.length > 0 ? merged.slice(0, 30) : null;
  }

  private stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.gateway.stop();
    this.tui.stop();
  }
}

class StatusLine implements Component {
  constructor(private text: string) {}

  setText(text: string): void {
    this.text = text;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return [truncateToWidth(dim(this.text), width)];
  }
}

class TranscriptLog implements Component {
  private entries: UiEntry[] = [];

  setEntries(entries: UiEntry[]): void {
    this.entries = entries;
  }

  replaceConversationEntries(entries: UiEntry[]): void {
    const systemEntries = this.entries.filter(
      (entry) => entry.role === "system" || entry.role === "error",
    );
    this.entries = [...systemEntries, ...entries];
  }

  push(entry: UiEntry): void {
    this.entries = [...this.entries, entry];
  }

  invalidate(): void {}

  render(width: number): string[] {
    const lines: string[] = [];
    const contentWidth = Math.max(12, width - 2);

    for (const entry of this.entries) {
      lines.push(truncateToWidth(this.label(entry.role), width));
      for (const rawLine of (entry.text || "").split("\n")) {
        for (const wrapped of wrapPlainLine(`  ${rawLine}`, contentWidth)) {
          lines.push(truncateToWidth(wrapped, width));
        }
      }
      lines.push("");
    }

    if (lines.length === 0) {
      lines.push(dim("No messages yet."));
    }

    return lines;
  }

  private label(role: UiEntry["role"]): string {
    if (role === "outgoing") return cyan("you");
    if (role === "incoming") return green("peer");
    if (role === "error") return red("error");
    return yellow("nchat");
  }
}

function toUiEntry(message: LocalMessage): UiEntry {
  const prefix =
    message.direction === "outgoing"
      ? `to ${message.peerUsername}`
      : `from ${message.senderUsername}`;
  const status = message.direction === "outgoing" ? ` [${message.status}]` : "";
  const ts = new Date(message.createdAt).toLocaleTimeString();
  return {
    role: message.direction === "outgoing" ? "outgoing" : "incoming",
    text: `${prefix} · ${ts}\n${message.body}${status}`,
  };
}

function wrapPlainLine(line: string, width: number): string[] {
  if (width <= 0) return [""];
  if (line.length <= width) return [line];

  const lines: string[] = [];
  let rest = line;

  while (rest.length > width) {
    let splitAt = rest.lastIndexOf(" ", width);
    if (splitAt < 1 || rest.slice(0, splitAt).trim().length === 0)
      splitAt = width;
    lines.push(rest.slice(0, splitAt));
    rest = `${width > 2 ? "  " : ""}${rest.slice(splitAt).trimStart()}`;
  }

  lines.push(rest);
  return lines;
}
