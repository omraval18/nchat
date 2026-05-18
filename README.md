# nchat

Local-first terminal messaging prototype.

Current implementation:

- `nchat` CLI app with interactive TUI and non-interactive commands.
- Central transport server backed by Postgres.
- Local client storage in SQLite on the user's machine.
- Username/password signup/login with Argon2id password hashing.
- Per-device identity key generation, stored for future E2EE integration.
- One-to-one direct messaging through WebSockets.
- Group creation, owner-only member add, group message relay.
- Slash-command TUI flow inspired by pi-agent: `/ping`, `/group`, `/grpadd` with dropdown-style suggestions.

Messages are stored locally by clients. The transport server stores users, devices, sessions, direct connections, groups, and group membership, but not message history.

## Local Postgres

Docker Compose is provided:

```bash
docker compose up -d postgres
```

If Docker is unavailable, run any local Postgres and point `DATABASE_URL` at it.

Default server database URL:

```bash
postgres://nchat:nchat@localhost:5432/nchat
```

## Server

```bash
DATABASE_URL=postgres://nchat:nchat@localhost:5432/nchat \
NCHAT_JWT_SECRET=replace-with-a-long-random-secret \
pnpm --filter @nchat/server dev
```

## CLI Auth

Use different `NCHAT_HOME` values to simulate multiple local users/devices.

```bash
NCHAT_HOME=.local/alice pnpm --filter nchat dev signup alice --password password123 --name Alice
NCHAT_HOME=.local/bob pnpm --filter nchat dev signup bob --password password123 --name Bob
```

## Direct Messaging

Create a connection:

```bash
NCHAT_HOME=.local/alice pnpm --filter nchat dev connect bob
```

Send a one-to-one message non-interactively:

```bash
NCHAT_HOME=.local/alice pnpm --filter nchat dev ping bob --message "Hey!"
```

On success:

```text
sent to bob
```

## Groups

Create a group:

```bash
NCHAT_HOME=.local/alice pnpm --filter nchat dev group-create friends
```

Add a direct connection to a group you own:

```bash
NCHAT_HOME=.local/alice pnpm --filter nchat dev group-add friends bob
```

Send a group message:

```bash
NCHAT_HOME=.local/alice pnpm --filter nchat dev group-send friends --message "hello group"
```

## TUI

```bash
NCHAT_HOME=.local/alice pnpm --filter nchat dev tui
```

Supported slash commands:

- `/ping <username>` switches to a direct chat.
- `/group <name>` switches to a group chat.
- `/group create <name>` creates a group and switches to it.
- `/grpadd <username>` adds a direct connection to the active group when the current user owns it.
- `/help` prints basic help.

Autocomplete behavior:

- Typing `/ping ` shows direct connections.
- Typing `/group ` shows groups.
- Typing `/grpadd ` shows direct connections.
- `Tab` applies the selected suggestion.
- Up/down changes the selected suggestion.

## E2EE Readiness

Encryption is intentionally not implemented yet. The code is structured so E2EE can be added without replacing the transport or TUI:

- Users can have multiple devices.
- Devices register public identity keys at signup/login.
- Message transport uses a payload envelope currently marked `plaintext.v1`.
- Local gateway owns encode/send/store boundaries.

Future E2EE work should replace plaintext payload encoding with encrypted payloads and introduce device key bundles, prekeys, verified devices, and group key management.
