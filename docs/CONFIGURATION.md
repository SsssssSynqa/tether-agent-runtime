# Configuration

Tether uses a public JSON configuration plus an optional ignored overlay. Secrets are resolved from environment variables at load time.

## Merge order

1. The path passed to `bin/tether.cjs` (default `./config.json`).
2. `config.private.json` next to that file, when present.
3. The file named by `TETHER_PRIVATE_CONFIG`, which replaces the default overlay path.
4. Provider keys resolved from each provider's `apiKeyEnv`.

Objects merge recursively. Arrays replace the base array, so a private `providers` array must include every provider that should remain active.

Relative `storage.root` and `persona.policyFile` values resolve from the directory containing the public config file.

## Agent and entity registry

```json
{
  "agent": { "id": "example-agent", "displayName": "Example Agent" },
  "owner": { "entityId": "example-owner", "displayName": "Example Owner" },
  "entities": [
    { "entityId": "example-owner", "canonicalDisplayName": "Example Owner", "type": "person" },
    { "entityId": "example-agent", "canonicalDisplayName": "Example Agent", "type": "ai" }
  ]
}
```

Use stable opaque entity IDs. Display names and aliases are presentation metadata, not identity keys. Do not recycle an ID for another person or agent.

## Persona policy

`persona.policyFile` points to an untracked Markdown policy. `persona.inlinePolicy` is available for synthetic or embedded configurations. The loader exposes the resulting text as the system prompt.

Keep private histories and personal facts out of a public persona-policy example. The policy should define behavioral rules; remembered facts belong in traceable memory.

## Address policy

`addressPolicy` declares the canonical owner display name, disallowed owner aliases, and entity names that mechanical normalization must preserve. Quoted text and naming events remain protected even when an alias mapping changes.

## Storage

```json
{
  "storage": { "root": "../private-tether-data" }
}
```

The reference CLI writes:

- `session.json` — authoritative session anchor;
- `memory/transcript.jsonl` — append-only raw messages;
- `memory/summaries.jsonl` — derived summaries with source message IDs;
- `memory/cards/cards.jsonl` — derived cards with source message IDs.

The broader memory and Console layers can use separate fold, card, and semantic roots. Keep all data roots outside the repository, restrict permissions, and back them up as sensitive data.

## Runtime

- `runtime.allowInitialSessionCreate`: explicit approval for process-boundary initial creation only. The CLI opens the session before attaching channels and creates an anchor only when no raw transcript, summaries, cards, or causal-journal authority exists. A missing anchor with any such authority, or a failed stored resume, remains fail-closed.
- `runtime.rawTailMessages`: maximum number of recent raw records compiled into model context. The default is `40`; `0` omits this layer from compiled context without deleting source records.
- `runtime.summaryLimit`: maximum number of the latest derived summaries compiled into model context. The default is `20`; `0` omits this layer.
- `runtime.cardLimit`: maximum number of derived day/week cards compiled into model context after selecting only the latest version of each logical `(cardType, period.key)` card. The default is `20`; `0` omits this layer. Selected cards are injected as system context.

All three context limits are non-negative integer counts. They bound inference input only; they do not truncate or rewrite the append-only files. The CLI also holds `storage.root/.tether-instance.lock` for its lifetime so two runtimes cannot concurrently own the same storage root.

## Providers

The initial adapter accepts an ordered `providers` array. Supported fields are:

- `id`: stable provider-chain identifier;
- `label`: operator-facing description;
- `adapter`: currently `openai-compatible`;
- `baseUrl`: complete chat-completions endpoint. Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback hosts: `localhost`, `127.0.0.0/8`, and `::1`;
- `apiKeyEnv`: environment variable containing the key used for built-in bearer authentication;
- `authentication`: set to `none` to disable built-in bearer authentication, either for an unauthenticated endpoint or when authentication is supplied entirely through `headerEnv`;
- `model`: provider model identifier;
- `headers`: optional non-secret additional headers;
- `headerEnv`: optional mapping from a custom secret header name to the environment variable that contains its value;
- `timeoutMs`: optional per-provider timeout.

Provider URLs must not contain URL userinfo (`username:password@host`) or common credential query parameters such as `api_key`, `key`, `token`, `access_token`, `auth`, `authorization`, `secret`, `password`, `signature`, or `sig`. This rule applies even when a URL would otherwise use HTTPS.

Inline `provider.apiKey` is rejected. Credential-like names such as `Authorization`, `X-API-Key`, `*-Token`, `*Secret*`, `*Password*`, and `*Credential*` are also rejected in ordinary `headers`; values beginning with `Bearer` or `Basic` are rejected there as well. Keep ordinary, non-secret metadata in `headers` and resolve every secret from the environment. For a provider-specific authentication header, use:

```json
{
  "headers": {
    "X-Client-Version": "tether-example"
  },
  "headerEnv": {
    "X-Provider-Token": "PROVIDER_TOKEN"
  }
}
```

`headerEnv` maps HTTP header names to environment-variable names; it never contains the credential value itself. Startup fails when a referenced environment variable is missing, and the same header name cannot appear in both `headers` and `headerEnv`. Use `apiKeyEnv` for built-in bearer authentication. For a provider authenticated only by custom headers, set `authentication: "none"` to disable the built-in bearer requirement and declare those secret headers in `headerEnv`. The adapter tries providers in order and returns the first non-empty completion. A provider switch does not change `agent.id`, session state, or memory authority.

The public example uses the reserved `.invalid` domain so it can never accidentally reach a real service.

## Telegram

The configuration schema reserves:

- `telegram.enabled` to attach live long polling in the shared CLI process;
- `telegram.tokenEnv` for the environment-variable name;
- `telegram.allowedGroups` for explicit group configuration;
- `telegram.noReplyGroupIds` and `telegram.rateLimitedGroupIds` for delivery behavior.
- `telegram.rateLimitStateDir` for persistent group-send timing state.

`owner.telegramUserIds` defines the only senders accepted in private Telegram. Group chat IDs are the keys of `telegram.allowedGroups`; no group is accepted implicitly. Inline `telegram.token` is forbidden.

When enabled, the CLI starts live `getUpdates` polling and attaches Telegram to the same runtime and session state as terminal. It writes `telegram-offset.txt` beneath `storage.root` after each update has been processed or safely ignored. Keep the offset with the session and raw memory during backup and recovery. The adapter rejects output longer than Telegram's 4096-character atomic limit rather than splitting one committed response into ambiguous deliveries.

## Tether Console environment

- `TETHER_MEMORY_ROOT`: common memory root;
- `TETHER_FOLD_DIR`: optional fold/summary root override;
- `TETHER_CARD_DIR`: optional card root override;
- `TETHER_SEMANTIC_DIR`: optional semantic-memory root override;
- `TETHER_CONSOLE_STATIC_DIR`: built frontend directory;
- `TETHER_CONSOLE_HOST`: listener host, default `127.0.0.1`;
- `TETHER_CONSOLE_PORT`: listener port, default `8431`.

The frontend development server uses `127.0.0.1:5187` and proxies `/api` to the backend at `127.0.0.1:8431`.
