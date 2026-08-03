# Configuration

中文文档见 [CONFIGURATION.zh-CN.md](CONFIGURATION.zh-CN.md).

[`config.example.json`](../config.example.json) is the canonical reference. Tether reads a public JSON configuration, merges one ignored machine-local overlay, resolves paths relative to the public file, and resolves secrets from environment variables.

## Merge and path rules

Load order:

1. the path passed to a CLI (default `./config.json`);
2. `config.private.json` beside that file, when present;
3. when `TETHER_PRIVATE_CONFIG` is set, that path replaces the default overlay;
4. provider and Telegram credentials resolve from the named environment variables.

Objects merge recursively. Arrays replace the base array, so an overlay `providers` or `entities` array must repeat every entry that should stay active.

The loader resolves these paths from the directory containing the public config:

- `storage.root`;
- `persona.policyFile`;
- `tools.workspaceRoots[*].path`;
- `telegram.rateLimitStateDir`;
- `telegram.attachmentDirectory`.

## Identity, entities, and persona

```json
{
  "agent": { "id": "example-agent", "displayName": "Example Agent" },
  "owner": {
    "entityId": "example-owner",
    "displayName": "Example Owner",
    "telegramUserIds": ["OWNER_TELEGRAM_ID"]
  },
  "persona": { "policyFile": "./persona-policy.private.md" },
  "entities": [
    { "entityId": "example-owner", "canonicalDisplayName": "Example Owner", "type": "person" },
    { "entityId": "example-agent", "canonicalDisplayName": "Example Agent", "type": "ai" }
  ]
}
```

Use stable opaque IDs and never recycle one for another person or agent. Display names, aliases, Telegram IDs, and bot names are resolver metadata—not identity keys. `session.json` and the storage marker are bound to `agent.id`.

`persona.policyFile` should be untracked. `persona.inlinePolicy` exists for synthetic or embedded configurations. Behavioral policy belongs here; remembered facts belong in traceable memory.

`addressPolicy` declares:

- `canonicalOwnerName`;
- `disallowedOwnerNames` for ordinary card prose;
- optional `semanticDisallowedOwnerNames`;
- `preservedEntityNames`.

Normalization preserves source-verifiable quotations and explicit naming events; it does not perform blind split/join replacement.

## Continuity storage

```json
{
  "storage": { "root": "/srv/tether/state" },
  "runtime": {
    "allowInitialSessionCreate": true,
    "maintenanceIntervalMs": 30000,
    "maintenanceActiveDelayMs": 250,
    "maintenanceErrorBaseDelayMs": 30000,
    "maintenanceErrorMaxDelayMs": 3600000
  }
}
```

`storage.root` contains the session anchor, storage-version marker, runtime health, Telegram offset/inbox/attachments, causal and tool journals, and the full `memory/` tree. Put it outside the source checkout with least-privilege permissions.

`allowInitialSessionCreate` authorizes only the first anchor on an empty authority root. It is not permission to replace a missing or failed session. Existing unversioned data requires `tether-ops migrate` while both runtime and supervisor are stopped.

The maintenance timings control the in-process memory worker:

- `maintenanceIntervalMs`: idle poll interval;
- `maintenanceActiveDelayMs`: delay while useful work continues; zero is allowed;
- `maintenanceErrorBaseDelayMs` / `maintenanceErrorMaxDelayMs`: exponential error backoff bounds.

The standard layered CLI uses the watermarks under `memory` below. The `TetherRuntime` library still accepts `rawTailMessages`, `summaryLimit`, and `cardLimit` when embedded with the legacy `AppendOnlyMemory`, but those legacy bounds are not the standard layered-memory controls.

## Layered memory

```json
{
  "memory": {
    "activeSoftTokenWatermark": 36000,
    "activeTargetTokenWatermark": 24000,
    "roundHardLimit": 120,
    "minimumRawTailRounds": 8,
    "summaryHistoryLimit": 64,
    "contextTokenBudget": 180000,
    "recentWeekCount": 4,
    "time": {
      "timezoneOffsetMinutes": 0,
      "cutoffHour": 6,
      "forceHour": 12,
      "quietMinutes": 45,
      "displayLabel": "configured local time"
    },
    "cards": { "enabled": true, "policy": "lossless" },
    "semantic": {
      "mode": "cards",
      "manifestMaxRecords": 50,
      "manifestMaxBytes": 8388608,
      "embeddings": { "enabled": false }
    }
  }
}
```

### Active context

- `activeSoftTokenWatermark`: start token-driven folding above this estimate;
- `activeTargetTokenWatermark`: fold toward this estimate; it may not exceed the soft watermark;
- `roundHardLimit`: round-count safety ceiling;
- `minimumRawTailRounds`: minimum recent raw rounds retained in active history;
- `summaryHistoryLimit`: number of independent summaries retained in active `history.json`; older summaries move to an append-only archive;
- `foldSummaryMaxChars`: optional maximum fold candidate length (default `1500`);
- `contextTokenBudget`: shared compiler budget for cards/semantic memory;
- `recentWeekCount`: how many completed weeks are considered for weekly cards and projections.

Older compatibility fields `historyTokenBudget`, `roundsBudget`, and `hardTokenCap` remain accepted by `ConversationHistory`; new deployments should use the active watermarks and hard round limit.

### Operational-day policy

- `timezoneOffsetMinutes`: fixed offset from UTC, from `-840` to `840`;
- `cutoffHour`: local hour at which the memory day changes;
- `quietMinutes`: inactivity required for natural settlement;
- `forceHour`: latest settlement boundary, measured on the operational timeline and not earlier than `cutoffHour`;
- `displayLabel`: human-readable time label included in generation context.

A fixed offset is deliberate and deterministic. Operators in daylight-saving regions must update it when their local offset changes if local wall-clock alignment matters.

### Cards

`cards.enabled: false` disables automatic card generation but does not delete existing cards. `cards.policy` is one of:

- `pending`: record coverage as pending without asking a model to generate cards;
- `relational`: preserve relational meaning, boundaries, changes, and repair while omitting unnecessary intimate mechanics;
- `lossless`: retain enough concrete facts to reconstruct causality and preferences without content-based downgrading.

### Semantic modes

- `off`: disabled;
- `shadow`: derive and expose records without injecting them;
- `cards`: inject verified semantic cards/projections;
- `full`: additionally permit verified semantic folding.

`manifestMaxRecords` and `manifestMaxBytes` bound compile-manifest journals. Semantic queue records, claims, events, projections, packet reviews, and patches remain separate append-only/provenance-aware records.

### Embeddings

`memory.semantic.embeddings.enabled: true` requires at least one provider with both `embeddingsUrl` and `embeddingModel`.

- `batchSize` (default `32`);
- `topK` (default `6`);
- `minScore` (default `0.25`, range `-1..1`);
- `maxEmbeddingChars` (default `12000` per document);
- `maxRetrievedChars` (default `2000` total recall text);
- `maxBytes` (default `67108864` journal cap).

Vector failures fall back to ordinary layered cards. After enabling or changing embeddings, run the offline `tether-memory backfill-vectors` command.

## Providers

`providers` is an ordered failover chain. The bundled adapter currently requires `adapter: "openai-compatible"` and a complete Chat Completions URL.

Common fields:

| Field | Meaning |
|---|---|
| `id`, `label` | Stable machine ID and operator-facing label |
| `baseUrl`, `model` | Chat Completions endpoint and default model |
| `apiKeyEnv` | Environment variable used for built-in bearer auth |
| `authentication: "none"` | Disable built-in bearer auth for an unauthenticated endpoint or custom-header auth |
| `headers` | Non-secret static headers only |
| `headerEnv` | Map secret header names to environment-variable names |
| `timeoutMs` | Per-provider request timeout |
| `foldModel`, `memoryModel` | Optional fold and day/week-card models |
| `semanticExtractorModel` | Optional extraction/repair/audit model |
| `semanticVerifierModel` | Optional verification model |
| `semanticHighRiskModel` | Optional high-risk verification model |
| `maxTokens` and purpose-specific `*MaxTokens` | Optional output limits |
| `imageInput` | `data-url`, `metadata-only`, or `reject` |
| `maxImageParts` | Maximum images added to one provider request |
| `embeddingsUrl`, `embeddingModel` | Both required together for embeddings |
| `embeddingDimensions`, `embeddingTimeoutMs` | Optional embedding request controls |

Purpose-specific model fallback is deterministic: semantic high-risk → verifier → default; semantic extractor → memory → fold → default; memory cards → fold → default; fold → default.

Remote URLs must use HTTPS. Plain HTTP is accepted only for `localhost`, `127.0.0.0/8`, and `::1`. URL userinfo and credential query parameters are rejected. Inline `apiKey`, credential-named ordinary headers, and values beginning with `Bearer` or `Basic` are rejected. Missing referenced environment variables fail startup.

The adapter tries providers in order and accepts the first valid non-empty completion. Provider failover does not change the session or identity. Ambiguous tool-call inference is operator-paused rather than automatically repeated.

## Local tools

```json
{
  "tools": {
    "enabled": true,
    "maxIterations": 5,
    "maxReadBytes": 524288,
    "maxWriteBytes": 1048576,
    "maxDirectoryEntries": 200,
    "workspaceRoots": [
      { "id": "workspace", "path": "/srv/tether/workspace" }
    ],
    "policies": {
      "terminal": { "read": "allow", "write": "allow" },
      "telegramPrivate": { "read": "allow", "write": "approval" },
      "telegramGroup": { "read": "deny", "write": "deny" },
      "default": { "read": "deny", "write": "deny" }
    }
  }
}
```

Root IDs must match `[a-z][a-z0-9_-]{0,63}` and be unique. A root path and `storage.root` must be physically disjoint in both directions. Symbolic links, traversal, hidden components, credential-like names, and root escape are refused.

Policies choose `allow`, `approval`, or `deny` independently for read and write in each recognized scope. Missing scope/capability falls back through `default` to deny. `maxIterations` bounds one provider tool loop.

## Telegram

Core fields:

- `enabled`, `tokenEnv`;
- `allowedGroups` keyed by chat ID;
- `pollTimeoutSeconds`, `pollRetryDelayMs`;
- durable retry: `retryIntervalMs`, `maxAttempts`, `retryBaseMs`, `retryMaxMs`, `durableInboxMaxBytes`;
- attachments: `attachmentDirectory`, `maxImageBytes`, `maxFileBytes`, `maxFilePreviewChars`, `maxQuotedChars`;
- group replies: `groupMaxReplies`, `groupAllowedReactions`, `groupRepairAttempts`, `groupMaxPendingMessages`, `groupBatchTiming`;
- delivery controls: `noReplyGroupIds`, `rateLimitedGroupIds`, `rateLimitStateDir`.

`owner.telegramUserIds` is the private-chat allowlist. Inline `telegram.token` is forbidden.

Each group entry supports:

- `enabled`;
- `mode`: `mention` or `all`;
- `mentionPatterns`: required non-empty strings for mention matching;
- `ownerAlways`;
- `ignoreBotMessages`.

Long output is deterministically split into Telegram-safe chunks. Only the first chunk preserves the reply target. Update offsets, durable inbox state, group batches, attachment metadata, committed responses, and delivery acknowledgements are stored beneath the continuity root.

## Process supervision

```json
{
  "supervision": {
    "heartbeatIntervalMs": 5000,
    "monitorIntervalMs": 5000,
    "heartbeatStaleMs": 30000,
    "readyTimeoutMs": 60000,
    "restartBaseMs": 1000,
    "restartMaxMs": 60000,
    "restartWindowMs": 300000,
    "maxRestartsPerWindow": 8,
    "shutdownGraceMs": 15000
  }
}
```

All fields are positive integers. `heartbeatStaleMs` must be at least heartbeat + monitor intervals, `readyTimeoutMs` must exceed the heartbeat interval, and `restartMaxMs` may not be smaller than `restartBaseMs`.

These settings govern the child runtime supervisor. A host service manager may supervise `tether-supervisor`, but must not independently start another child runtime against the same root.

## Tether Console environment

- `TETHER_MEMORY_ROOT`: conventional common memory root;
- `TETHER_FOLD_DIR`, `TETHER_CARD_DIR`, `TETHER_SEMANTIC_DIR`: optional per-layer overrides;
- `TETHER_CONSOLE_STATIC_DIR`: built frontend directory;
- `TETHER_CONSOLE_HOST`: default `127.0.0.1`;
- `TETHER_CONSOLE_PORT`: default `8431`.

The frontend development server uses `127.0.0.1:5187` and proxies `/api` to `127.0.0.1:8431`. Keep the Console on loopback unless an independently authenticated and encrypted access layer is configured.
