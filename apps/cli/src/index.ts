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
