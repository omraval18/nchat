#!/usr/bin/env node
import { Command } from "commander";
import { loadClientConfig } from "./config.js";
import { ClientGateway } from "./gateway.js";
import { LocalStore } from "./local-store.js";
import { NchatTui } from "./tui.js";

const config = loadClientConfig();
const store = new LocalStore(config.dbPath);
const gateway = new ClientGateway(config, store);

const program = new Command();
program.name("nchat").description("Local-first terminal messenger").version("0.0.0");

program
  .command("signup")
  .argument("<username>")
  .requiredOption("--password <password>")
  .option("--name <displayName>")
  .option("--device <deviceName>", "device name", defaultDeviceName())
  .action(async (username: string, options: { password: string; name?: string; device: string }) => {
    const account = await gateway.signup({
      username,
      displayName: options.name ?? username,
      password: options.password,
      deviceName: options.device,
    });
    console.log(`signed in as ${account.username}`);
  });

program
  .command("login")
  .argument("<username>")
  .requiredOption("--password <password>")
  .option("--device <deviceName>", "device name", defaultDeviceName())
  .action(async (username: string, options: { password: string; device: string }) => {
    const account = await gateway.login({ username, password: options.password, deviceName: options.device });
    console.log(`signed in as ${account.username}`);
  });

program.command("logout").action(() => {
  gateway.logout();
  console.log("logged out");
});

program
  .command("connect")
  .argument("<username>")
  .description("create a direct connection with another user")
  .action(async (username: string) => {
    await gateway.connect(username);
    console.log(`connected to ${username}`);
  });

program
  .command("connections")
  .description("list direct connections")
  .action(async () => {
    const connections = await gateway.refreshConnections();
    if (connections.length === 0) {
      console.log("no connections yet");
      return;
    }
    for (const connection of connections) {
      console.log(`${connection.username}\t${connection.displayName}\t${connection.online ? "online" : "offline"}`);
    }
  });

program
  .command("groups")
  .description("list groups")
  .action(async () => {
    const groups = await gateway.refreshGroups();
    if (groups.length === 0) {
      console.log("no groups yet");
      return;
    }
    for (const group of groups) {
      console.log(`${group.name}\t${group.id}\t${group.memberCount} members`);
    }
  });

program
  .command("group-create")
  .argument("<name>")
  .description("create a group")
  .action(async (name: string) => {
    const group = await gateway.createGroup(name);
    console.log(`created group ${group.name} (${group.id})`);
    console.log(`use /grpadd <username> in the TUI or nchat group-add ${group.id} <username>`);
  });

program
  .command("group-add")
  .argument("<group>")
  .argument("<username>")
  .description("add a direct connection to a group you own")
  .action(async (groupValue: string, username: string) => {
    const groups = await gateway.refreshGroups();
    const group = groups.find((item) => item.id === groupValue || item.name.toLowerCase() === groupValue.toLowerCase());
    if (!group) throw new Error(`unknown group ${groupValue}`);
    await gateway.addGroupMember(group.id, username);
    console.log(`added ${username} to ${group.name}`);
  });

program
  .command("group-send")
  .argument("<group>")
  .requiredOption("--message <message>")
  .description("send a text message to a group")
  .action(async (groupValue: string, options: { message: string }) => {
    await gateway.start();
    const groups = gateway.listCachedGroups();
    const group = groups.find((item) => item.id === groupValue || item.name.toLowerCase() === groupValue.toLowerCase());
    if (!group) throw new Error(`unknown group ${groupValue}`);
    const status = await gateway.sendGroupMessageAndWait(group.id, options.message);
    gateway.stop();
    if (status === "failed") {
      console.error(`failed to send to group ${group.name}`);
      process.exitCode = 1;
      return;
    }
    console.log(`sent to group ${group.name}`);
  });

program
  .command("ping")
  .argument("<username>")
  .requiredOption("--message <message>")
  .description("send a one-to-one text message")
  .action(async (username: string, options: { message: string }) => {
    await gateway.start();
    const status = await gateway.sendMessageAndWait(username, options.message);
    gateway.stop();
    if (status === "failed") {
      console.error(`failed to send to ${username}`);
      process.exitCode = 1;
      return;
    }
    console.log(`sent to ${username}`);
  });

program
  .command("tui", { isDefault: true })
  .description("open the interactive terminal messenger")
  .action(async () => {
    const tui = new NchatTui(gateway);
    await tui.run();
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

function defaultDeviceName(): string {
  return `${process.env.USER ?? "user"}@${process.env.HOSTNAME ?? "localhost"}`;
}
