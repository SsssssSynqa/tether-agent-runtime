# Getting started

中文文档见 [GETTING_STARTED.zh-CN.md](GETTING_STARTED.zh-CN.md).

This guide starts the public reference runtime with terminal and, when enabled, live Telegram long polling. Both channels attach to the same `TetherRuntime` and `SelfsameSession`; never run one persona runtime per channel.

## 1. Install prerequisites

- Node.js 20 or newer
- Python 3.11 or newer if using Tether Console
- pnpm 9 or newer if developing the Console frontend

The runtime has no npm runtime dependencies. Start by running the offline checks:

```bash
npm test
npm run verify:export
node scripts/probe-selfsame-protocol.cjs
scripts/check-public-snapshot
```

## 2. Prepare untracked configuration

```bash
cp config.example.json config.json
cp persona-policy.example.md persona-policy.private.md
cp examples/config.private.example.json config.private.json
```

`config.json`, `config.private.json`, and `persona-policy.private.md` are local operational files. Verify they remain untracked before adding credentials or private persona material.

Edit the provider URL and model. Keep the key in the environment variable named by `apiKeyEnv`:

```bash
export PRIMARY_API_KEY='set-this-locally'
```

The code does not automatically parse `.env`; use your shell, credential manager, container secret, or process manager. Provider credentials are environment-only: `provider.apiKey` is rejected, and each authenticated provider must declare `apiKeyEnv`. Provider-specific secret headers use `headerEnv`, which maps a header name to an environment-variable name. Do not put credentials in `baseUrl` or ordinary `headers`; remote provider URLs must use HTTPS, with HTTP reserved for loopback development endpoints.

Set `storage.root` to a private directory outside the source checkout. Tether creates `session.json` and the `memory/` subtree there with restrictive file modes where the operating system supports them.

## 3. Review first-session creation

`runtime.allowInitialSessionCreate: true` is explicit approval to create the initial authoritative session only when the data root contains no existing authority. After `session.json` exists, failure to resume that session is fail-closed; the runtime will not call the creation callback to manufacture a replacement.

Back up the data root before changing agent identity or session adapters. Deleting `session.json` is not a normal reset and must not be presented as continuation.

At startup, the reference CLI acquires a single-instance lock for `storage.root` and calls `session.open` exactly once before attaching terminal or Telegram. When no anchor exists, `allowInitialSessionCreate: true` permits startup to create it only if the raw transcript, summaries, cards, and causal journal are all empty. Telegram can therefore be enabled from the beginning and may provide the first input after this process-boundary bootstrap.

If `session.json` is missing while any raw, derived, or causal authority remains, startup fails closed. Restore the authoritative anchor from backup; do not delete the remaining data or create a replacement and call it continuation. A second runtime pointed at the same `storage.root` also fails while the first instance holds `.tether-instance.lock`.

## 4. Start the shared runtime

```bash
node bin/tether.cjs ./config.json
```

or:

```bash
npm start
```

Each line entered on standard input becomes a terminal-channel message. Provider responses are printed to standard output. The public CLI is intentionally small; production process management and live credentials are operator-owned.

## 5. Enable Telegram on the same session

Set the owner identity and Telegram section in `config.json`:

```json
{
  "owner": {
    "entityId": "example-owner",
    "displayName": "Example Owner",
    "telegramUserIds": ["replace-with-owner-id"]
  },
  "telegram": {
    "enabled": true,
    "tokenEnv": "TELEGRAM_BOT_TOKEN",
    "allowedGroups": {},
    "noReplyGroupIds": [],
    "rateLimitedGroupIds": [],
    "rateLimitStateDir": "../private-tether-data/telegram-rate-limit"
  }
}
```

Inject the token in the named environment variable:

```bash
export TELEGRAM_BOT_TOKEN='set-this-locally'
node bin/tether.cjs ./config.json
```

Private Telegram ingress is owner-only. Group ingress is accepted only for chat IDs present as keys in `telegram.allowedGroups`; an empty object allows no groups. The channel persists the next Telegram update offset at `telegram-offset.txt` under `storage.root`, after each accepted update finishes. Treat that file as continuity state and do not reset it casually.

Terminal and Telegram are attached inside the same CLI process. Do not start a second runtime or use a second state file for Telegram. Keep a process supervisor outside Tether if automatic restart is required.

The exported adapter helpers live in:

- `runtime/channels/terminal.cjs`
- `runtime/channels/telegram.cjs`
- `runtime/providers/openai-compatible.cjs`

The offline suite demonstrates two channels reopening the same session without permitting a replacement.

## 6. Start Tether Console

Install the Console backend's development requirements according to `console/backend/README.md`, then:

```bash
cd console/backend
PYTHONPATH=. python -m tether_console
```

The default listener is `http://127.0.0.1:8431`. Point `TETHER_MEMORY_ROOT` at the runtime memory root, or configure the individual fold, card, and semantic roots described in [CONFIGURATION.md](CONFIGURATION.md).

The Console is read-only. Keep it on loopback unless a separate authenticated access layer is deliberately configured.
