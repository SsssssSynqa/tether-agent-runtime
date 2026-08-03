# Adapter contracts

中文文档见 [ADAPTERS.zh-CN.md](ADAPTERS.zh-CN.md).

Tether adapters are replaceable boundaries around one authoritative runtime. Connecting another API or channel must not create another persona session, transcript, or derived-memory root.

## Provider adapter

The runtime requires an asynchronous `respond` method:

```js
const provider = {
  async respond({ messages, purpose, sourceParts, causalId, toolContext }) {
    return {
      text: 'synthetic response',
      providerId: 'example-provider',
      model: 'example-model',
      purpose,
      finishReason: 'stop'
    };
  }
};
```

The standard runtime passes the complete compiled message list. `purpose` distinguishes ordinary dialogue, folds, cards, semantic extraction/repair/audit, semantic verification, and high-risk verification. `sourceParts` carries normalized attachments; `causalId` and `toolContext` let an adapter journal tool-loop intent without inventing another conversation identity.

An embedding-capable adapter also exposes:

```js
const result = await provider.embed({
  texts: ['verified memory text'],
  purpose: 'memory-embedding'
});
// { vectors: [[...]], providerId, model }
```

A provider adapter should normalize provider-specific request/response, tool-call, streaming, usage, timeout, and error formats. It must preserve provider/model/purpose provenance and must not use a provider conversation ID as the sole identity anchor.

### Included OpenAI-compatible adapter

`runtime/providers/openai-compatible.cjs` supports:

- an ordered provider failover chain;
- purpose-specific model and output-token selection;
- Chat Completions message content;
- optional image data URLs with bounded part counts;
- a sequential, bounded tool-call loop;
- Embeddings requests;
- environment-only bearer or custom-header credentials;
- HTTPS remote endpoints and loopback-only HTTP.

Provider failover selects another API endpoint around the same session and compiled context. An empty or rejected response may try the next configured provider. If a tool-enabled request may have reached a provider but no durable response proves its outcome, the adapter emits a manual-only ambiguity instead of automatically re-inferring.

## Channel adapter

Minimum shape:

```js
const channel = {
  id: 'example-channel',
  onMessage(handler) {
    // Retain the one handler and call it with normalized ingress.
  },
  async send(message) {
    // Deliver the already committed response.
  }
};
```

Normalized ingress should contain:

```js
{
  messageId: 'stable-channel-event-id',
  text: 'message text',
  metadata: {
    source: 'example-channel',
    trustZone: 'private',
    senderId: 'opaque-sender-id',
    senderEntityId: 'optional-canonical-entity',
    senderDisplayName: 'Display Name',
    chatId: 'opaque-conversation-address',
    owner: true,
    isGroup: false,
    receivedAt: '2030-01-01T00:00:00.000Z'
  },
  sourceParts: []
}
```

`messageId` must be stable across retries. The runtime derives causal identity from channel + message ID before inference. Metadata supports authorization, attribution, delivery, and recipient-aware prompt/output policy; it never selects a different persona history.

Useful optional channel methods include `initialize`, `start`, `stop`, and `historyAssistantText`. A live channel should not begin polling until the runtime has opened the session. Local cursor, reply target, rate-limit, formatting, and attachment-download state belong to the adapter; persona identity does not.

## Durable channel boundary

A production channel needs more than the minimum interface:

1. authenticate ingress;
2. durably accept a stable source event before inference;
3. preserve ordering and duplicate identity;
4. distinguish committed output from delivery acknowledgement;
5. replay exact committed bytes after transport uncertainty;
6. expose retry, pause, and dead-letter state;
7. keep recipient-aware output controls outside the shared context.

If the transport does not provide a stable event ID, the adapter must define and document a deterministic equivalent. It must not use a new random ID on every retry.

## Telegram implementation

The included Telegram boundary provides:

- owner-only private ingress and explicitly allowlisted groups;
- `mention` and `all` group modes;
- durable `getUpdates` polling with an atomic offset;
- exact update replay and edited-message causal identity;
- durable group batching and validated multi-reply JSON envelopes;
- missing-reply-target fallback without regenerating output;
- deterministic long-response chunking;
- per-group no-reply/rate-limit behavior and reaction allowlists;
- bounded image/file download, sanitized source metadata, and private attachment storage.

`telegram:update:<update_id>` is the stable normalized identity. The normalized metadata retains `telegramMessageId` for reply delivery and records `updateKind` as either `message` or `edited_message`. A Telegram edit has a new `update_id`, so it is a distinct append-only event even when `telegramMessageId` is unchanged.

A custom Telegram API base must use HTTPS except on loopback, and may not contain credentials, query parameters, or fragments.

## Tool adapter boundary

The included tool runtime exposes definitions to the provider only when the current channel policy permits them. A replacement tool implementation must preserve:

- stable operation IDs and a contract hash;
- root/capability authorization before execution;
- durable intent before any side effect;
- exact approval scope;
- atomic or otherwise provable postconditions;
- fail-closed handling of ambiguous effects;
- no access to continuity storage through a workspace root.

Never solve a capability difference by passing a cropped or separate persona history.

## Adding another provider API

1. Implement `respond` and optional `embed` with the normalized shapes above.
2. Map each purpose to an explicit model/configuration.
3. Categorize safe failover versus ambiguous inference.
4. Preserve output provenance and tool-call IDs.
5. Add config validation and environment-only credential handling.
6. Add synthetic tests proving provider failure does not change agent/session IDs or duplicate tool effects.

## Adding another channel

1. Authenticate the sender/address.
2. Define a stable source-event ID and durable cursor.
3. Normalize messages/attachments with attribution metadata.
4. Attach to the existing `TetherRuntime` after session open.
5. Journal committed output separately from delivery acknowledgement.
6. Add exact replay, backoff, pause/dead-letter inventory, and recipient-aware output.
7. Test the channel beside terminal/Telegram against the same transcript and session proof.

## Conformance tests

Every new adapter should add synthetic accepted and rejected paths for:

- unchanged agent/session/transcript proof across adapter failure and fallback;
- duplicate ingress with one inference;
- exact replay after lost delivery acknowledgement;
- safe missing reply targets;
- attachment size/type/path boundaries;
- secret-free diagnostics;
- no live network calls in default tests;
- tool capability differences over an identical context digest;
- ambiguous inference or external effects stopping for operator review.
