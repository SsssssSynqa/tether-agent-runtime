# Getting started

中文文档见 [GETTING_STARTED.zh-CN.md](GETTING_STARTED.zh-CN.md).

This guide starts the complete reference runtime: one session shared by terminal and optional Telegram, automatic layered-memory maintenance, local tools, process supervision, and the read-only Console.

## 1. Prerequisites and offline verification

- Node.js 20 or newer;
- Python 3.11 or newer for Tether Console;
- pnpm 9 or newer for the Console frontend.

The runtime itself has no npm runtime dependencies. Before adding credentials, run:

```bash
make check
```

This uses only synthetic temporary data. If Console dependencies are already installed, run the larger gate:

```bash
make check-all
```

## 2. Choose three separate locations

Use separate directories for:

1. the source checkout;
2. `storage.root`, which holds continuity authority;
3. every tool workspace root.

For example:

```text
/opt/tether-agent-runtime/       source
/srv/tether/state/               storage.root
/srv/tether/workspace/           tools.workspaceRoots[0].path
```

A workspace root must not contain `storage.root`, and `storage.root` must not contain a workspace root. Tether resolves physical paths at startup and refuses either overlap. This prevents model tools from reaching the session anchor, transcript, Telegram inbox, or tool journal. All three paths should be outside publicly synced folders; the two data paths need separate backup policies.

## 3. Prepare local configuration

```bash
cp config.example.json config.json
cp persona-policy.example.md persona-policy.private.md
cp examples/config.private.example.json config.private.json
```

These local operational files are ignored by the repository defaults. Confirm with `git status` before adding any private value.

Edit `config.json`:

- set stable `agent.id` and `owner.entityId` values;
- point `persona.policyFile` to `./persona-policy.private.md`;
- set `storage.root` and `tools.workspaceRoots` to the separate paths chosen above;
- set the provider `baseUrl`, `model`, and optional fold/card/semantic/embedding model IDs;
- review memory time policy before allowing day-card settlement;
- leave Telegram disabled until the foreground runtime succeeds.

Relative paths resolve from the directory containing `config.json`.

## 4. Inject credentials

Tether does not load `.env` itself. Export credentials from a shell, credential manager, container secret, or host service wrapper:

```bash
export PRIMARY_API_KEY='set-this-locally'
```

`apiKeyEnv` names the environment variable; it never contains the secret. Provider-specific secret headers use `headerEnv`. Inline API keys, credential-bearing ordinary headers, credentials in URLs, and cleartext remote HTTP endpoints are rejected.

An unauthenticated loopback development provider can declare:

```json
{
  "authentication": "none",
  "baseUrl": "http://127.0.0.1:11434/v1/chat/completions"
}
```

## 5. Prove a foreground startup

Run the child runtime directly once during setup:

```bash
node bin/tether.cjs ./config.json
```

Startup must:

- create `storage-version.json` on a genuinely empty root;
- create or resume `session.json` before attaching a channel;
- publish `runtime-health.json` with `ready` state;
- accept terminal lines and print provider responses;
- refuse a second process pointed at the same root.

`runtime.allowInitialSessionCreate: true` authorizes only the first anchor on an empty authority root. If `session.json` is missing while transcript, card, semantic, causal, tool, or Telegram authority remains, startup fails closed. Restore the anchor; do not delete evidence to force a green start.

Existing unversioned roots fail with `TETHER_STORAGE_MIGRATION_REQUIRED`. Stop all Tether processes, make an external verified copy, and follow [Storage migration](OPERATIONS.md#storage-migration).

Stop the foreground process cleanly with Ctrl-C before starting the supervisor.

## 6. Run the Tether supervisor

Recommended long-running command:

```bash
node bin/tether-supervisor.cjs ./config.json
```

The supervisor owns `.tether-supervisor.lock`, starts `bin/tether.cjs`, monitors readiness and heartbeat freshness, and restarts the same storage/session after failure with backoff, jitter, and a bounded crash-loop budget.

For host boot management, point launchd or systemd at the supervisor—not at `bin/tether.cjs`. Synthetic examples are provided in [`examples/`](../examples/README.md). Keep secrets in the host's secret mechanism rather than committing them into service files.

Check state from another shell:

```bash
node bin/tether-ops.cjs status ./config.json
```

## 7. Enable Telegram on the same session

Set the owner IDs and Telegram block in `config.json`:

```json
{
  "owner": {
    "entityId": "example-owner",
    "displayName": "Example Owner",
    "telegramUserIds": ["OWNER_TELEGRAM_ID"]
  },
  "telegram": {
    "enabled": true,
    "tokenEnv": "TELEGRAM_BOT_TOKEN",
    "allowedGroups": {
      "GROUP_CHAT_ID": {
        "enabled": true,
        "mode": "mention",
        "mentionPatterns": ["Example Agent"],
        "ownerAlways": true,
        "ignoreBotMessages": true
      }
    }
  }
}
```

Then inject the token and restart the supervisor through the host mechanism:

```bash
export TELEGRAM_BOT_TOKEN='set-this-locally'
node bin/tether-supervisor.cjs ./config.json
```

Private ingress is owner-only. A group is accepted only when its chat ID is an enabled key in `allowedGroups`. `mode: "mention"` requires a configured mention unless `ownerAlways` applies; `mode: "all"` observes every accepted message while the reply policy can still choose silence.

Telegram and terminal remain attached to the same `TetherRuntime`, `SelfsameSession`, transcript, cards, and semantic store. Do not create a Telegram-specific state root.

The adapter also provides:

- durable updates and persisted `telegram-offset.txt`;
- exact crash replay and dead-letter state;
- group batching and validated multi-reply envelopes;
- deterministic long-message splitting;
- one-time no-reply fallback when a referenced Telegram message disappeared;
- image downloads and bounded text previews for ordinary files;
- explicit attachment size limits and a private attachment directory.

Treat the offset, inbox, attachments, session anchor, and memory as one continuity backup set.

## 8. Review tool capabilities

The example enables local file tools. Before use, review:

- each stable workspace root ID and physical path;
- read/write byte limits and directory-entry limit;
- per-channel `allow`, `approval`, and `deny` policies.

The default example allows terminal reads/writes, allows Telegram private reads but requires approval for writes, and denies group tools. The model has no shell, network, delete, rename, or arbitrary binary-write tool.

List pending approvals while the runtime remains online:

```bash
node bin/tether-tools.cjs approvals ./config.json
node bin/tether-tools.cjs approve <approval-id> ./config.json
# or
node bin/tether-tools.cjs deny <approval-id> ./config.json
```

An ordinary approval pause is retried by the durable Telegram dispatcher. An ambiguous external effect becomes `operator-paused`; after inspecting the operation journal and filesystem, explicitly resume the affected update with `tether-ops resume`.

## 9. Confirm automatic memory maintenance

Memory maintenance starts with the runtime; no cron job is required. It performs automatic active-context folding, semantic extraction/verification, day/week card settlement, and optional vector maintenance.

All `tether-memory` commands are offline operations and acquire both supervisor and runtime locks. Stop both processes first:

```bash
node bin/tether-memory.cjs status ./config.json
node bin/tether-memory.cjs rebuild-semantic ./config.json
node bin/tether-memory.cjs backfill-vectors ./config.json
```

`rebuild-semantic` idempotently queues historical transcript turns. `backfill-vectors` is useful after enabling embeddings or changing the vector index. Restart the supervisor only after the command exits successfully.

## 10. Start Tether Console

Use the bundled synthetic data first:

```bash
cd console
python -m venv .venv
. .venv/bin/activate
pip install -r backend/requirements.txt
cd frontend
pnpm install
pnpm test
pnpm check
pnpm build
cd ..
cp .env.example .env
set -a; . ./.env; set +a
PYTHONPATH=backend python -m tether_console
```

Open <http://127.0.0.1:8431>. To inspect the real runtime, set `TETHER_MEMORY_ROOT` to `<storage.root>/memory` in an untracked environment file or shell. The Console is read-only and loopback-first; it is not an administrative write API.

## 11. Create the first verified backup

Stop the supervisor and runtime, then run:

```bash
node bin/tether-ops.cjs backup /path/outside/storage ./config.json
node bin/tether-ops.cjs verify-backup /path/to/tether-backup-...
```

The command prints the exact created backup path and root SHA-256. Backup directories are not encrypted. Restore drills should use a new empty target and a temporary config; never overwrite a live data root. See [Operations and recovery](OPERATIONS.md) for exact dead-letter, migration, backup, and restore commands.
