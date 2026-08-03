# Adapter contracts

Tether adapters are replaceable boundaries around one authoritative runtime. Adding an API or channel must not create a second persona session.

## Provider adapter

The runtime expects a provider object with an asynchronous `respond` method:

```js
const provider = {
  async respond({ sessionId, channelId, messages, sourceMessage }) {
    return {
      text: "synthetic response",
      providerId: "example-provider"
    };
  }
};
```

The adapter should normalize provider-specific request, response, streaming, usage, timeout, and error formats. It must not treat a provider conversation ID as the sole agent identity. A provider failure may select another adapter but must not create a replacement authoritative session.

The included `openai-compatible` adapter accepts an ordered provider chain and a complete chat-completions URL. Remote URLs require HTTPS; HTTP is limited to loopback development endpoints. URL-embedded credentials and credential-bearing ordinary headers are rejected. Use `apiKeyEnv` for bearer authentication or `headerEnv` for provider-specific secret headers, as documented in [CONFIGURATION.md](CONFIGURATION.md). Tests inject a mock `fetch` implementation; no live request is needed.

## Channel adapter

The runtime expects:

```js
const channel = {
  id: "example-channel",
  onMessage(handler) {
    // Save handler and call it with normalized ingress.
  },
  async send(message) {
    // Deliver the already committed response.
  }
};
```

Normalized ingress needs a stable `messageId`, text, and metadata sufficient for authorization and delivery. Live adapters should assign a stable causal event ID before inference and persist delivery state. Session creation is not a channel decision: the reference CLI opens or creates the authoritative anchor once at the process boundary before any adapter is attached.

Every channel instance for one agent attaches to the same `TetherRuntime`, `SelfsameSession`, and memory authority. Channel-local cursors, reply targets, rate limits, and formatting remain adapter state; they never become persona identity.

## Capability policy

A channel can be read-only, require approvals, or expose fewer tools than another channel. Implement the difference in authorization and tool execution. Do not pass a separate history merely because a channel has fewer capabilities.

## Telegram boundary

The public Telegram utility provides:

- live `getUpdates` long polling;
- an atomically persisted update offset;
- update normalization;
- owner/group metadata mapping hooks;
- missing-reply-target delivery fallback;
- group rate-limit and batching primitives in the exported library.

`createTelegramApi` uses the official HTTPS endpoint by default. A custom
`apiBase` must also use HTTPS, except for an explicit loopback development
endpoint; URL credentials, query parameters, and fragments are rejected so the
bot token cannot be redirected through an ambiguous or cleartext remote URL.

When `telegram.enabled` is true, `bin/tether.cjs` opens the shared session first, then attaches the Telegram long-poll channel and terminal to the same runtime. The Telegram token is read only from `telegram.tokenEnv`; private ingress is owner-only, and group ingress is allowlisted. The update offset is stored under the shared private data root. External process supervision remains operator-owned.

Telegram uses `telegram:update:<update_id>` as the normalized `messageId` and causal identity. The original `chatId` and `telegramMessageId` remain in metadata for authorization and reply delivery, while `updateKind` records either `message` or `edited_message`. Telegram assigns a new `update_id` to an edit even though it retains the original `message_id`, so an edit becomes a distinct append-only causal event. Replaying the same `update_id` resolves to the same event and remains idempotent.

## Conformance test expectations

Every new adapter should add synthetic tests for:

- unchanged agent and session IDs before and after adapter failure;
- duplicate ingress with one inference;
- exact replay after lost delivery acknowledgement;
- safe behavior when reply targets disappear;
- redacted diagnostics;
- no network calls in default unit tests;
- capability differences over an identical context digest.
