# Tether

Tether is a local-first agent runtime that preserves one continuous identity across channels, provider changes, crashes, and context limits.

> **One agent. One session. Every channel. Memory that stays.**<br>
> **一个 Agent，一条连续会话，跨越所有通道，记忆始终留存。**

In the Tether architecture, Telegram and terminal are two doors into the same agent—not separate bots, histories, or approximations of one another. The public core keeps the authoritative session and append-only source history attached to that identity and provides the durable, semantic, and adapter primitives needed to extend the runtime without violating that boundary.

Tether was extracted from a production agent runtime. This repository is a clean, synthetic, provider-neutral distribution: it contains no production conversation history, credentials, identifiers, or deployment details.

## Why Tether exists

Most agent bridges optimize message delivery. Tether treats delivery as the outermost layer of a harder problem: after a channel switch, model-provider failure, process restart, or context compaction, how do you prove that the returning agent is still attached to the same history?

Tether therefore fails closed instead of manufacturing continuity:

- a failed session resume does not silently create a fresh persona;
- a failed compaction keeps the last valid context and the original transcript;
- a delivery retry replays the committed answer instead of asking the model again;
- a derived memory cannot become a quotation without source evidence;
- a human correction is appended with provenance rather than rewriting history.

These rules are specified independently in the [Selfsame Protocol](SELFSAME_PROTOCOL.md). Tether is one reference implementation; SSP can be implemented by other runtimes.

## Public snapshot status

This first clean snapshot is a **minimal runnable core**, not a claim that every production subsystem has already been generalized. It includes the Selfsame session guard, append-only transcript/summary/card repository, semantic store and validators, durable spool primitives, terminal channel, live Telegram long-poll channel with a persisted update offset, OpenAI-compatible provider adapter, synthetic tests, and the read-only Memory Console. Telegram and terminal attach to the same runtime and session in one process.

Automated context folding, daily/weekly extraction scheduling, model-driven semantic extraction, and production process supervision are not in this snapshot. Those components still require generalization of deployment and policy assumptions. Until generalized versions land, operators must supply that orchestration around the documented core invariants. The repository does not describe absent automation as shipped behavior.

## What is included

### One agent, one session

- The terminal adapter and every operator-wired channel adapter attach to one authoritative runtime session; the public Telegram utilities are intended for that shared boundary.
- The CLI acquires one storage-root lock and opens or explicitly creates the session anchor exactly once before attaching channels; Telegram may be the first input after startup.
- Channel, chat, device, sender, provider, and capability profile do not fork the persona history.
- Resume is fail-closed: inability to resume, or a missing anchor beside any raw, derived, or causal authority, becomes an explicit blocked state, never an invisible reset.
- Per-channel tool and output permissions remain possible without context isolation.

### Durable channel-delivery primitives

- durable ingress and outbound state primitives for acknowledgement, retry, and dead-letter orchestration;
- stable causal event IDs and idempotent duplicate handling;
- exact replay of a previously committed response after delivery failure;
- per-conversation ordering and bounded recovery behavior;
- provider capacity and transient-failure handling without consuming a message twice.

### Local, layered memory primitives

- append-only raw transcript as the source authority;
- non-destructive context compaction with source boundaries;
- card schemas plus semantic claims, events, projections, evidence, and review state;
- attribution, entity, alias, and protected-quotation integrity rules;
- append-only human corrections;
- derived indexes, vectors, manifests, and cards that can be rebuilt from source evidence;
- bounded model context with independent raw, summary, and card limits; card recall selects only the latest version of each logical day/week card and injects selected cards as system context without deleting superseded records.

### Tether Console

The local Console provides a read-only view of memory folders and their integrity state. It exposes source coverage, cards, semantic records, corrections, queues, and the context manifest without turning the UI database into a second source of truth. The server binds to loopback by default.

### Provider and channel adapter boundaries

The runtime is provider-neutral. OpenAI-compatible APIs are the initial adapter shape; additional providers can implement the same boundary. Remote provider URLs require HTTPS, while HTTP is restricted to loopback; URL-embedded credentials and credential-bearing ordinary headers are rejected, with `apiKeyEnv` and `headerEnv` providing environment-only secret injection.

The CLI always attaches terminal and, when `telegram.enabled` is true, attaches the live Telegram long-poll channel to that same runtime. Owner IDs, group allowlists, rate-limit state, and the Telegram token environment variable remain explicit configuration. Telegram update IDs form the causal message identity, so a message edit is a new event while replaying the same update remains idempotent.

## Repository layout

```text
runtime/                  Agent runtime, memory layers, and channel/provider adapters
console/backend/          Read-only local-folder Console API
console/frontend/         Tether Console web interface
examples/                 Synthetic configuration examples
scripts/                  Offline conformance and public-snapshot checks
docs/                     Architecture, configuration, privacy, and operations
SELFSAME_PROTOCOL.md       Provider- and implementation-independent invariants
```

## Requirements

- Node.js 20 or newer for the runtime and synthetic conformance probe
- Python 3.11 or newer for the Console backend
- pnpm 9 or newer for the Console frontend

No live model, Telegram account, token, or network access is required to run the repository's conformance and unit tests.

## Quick start

1. Optionally copy the synthetic environment template as a local reference and keep the real file untracked. Tether does not auto-load `.env`; inject values through your shell or process manager.

   ```bash
   cp examples/.env.example .env
   ```

2. Review [configuration and adapter setup](docs/CONFIGURATION.md). Put runtime data in a directory outside the repository.

3. Run the dependency-free core checks before adding any credential:

   ```bash
   make check
   ```

   After installing the Console development dependencies, `make check-all` also tests and builds the Console.

4. Start the runtime and attach the terminal adapter using the commands documented in [Getting started](docs/GETTING_STARTED.md).

5. Optionally start the local Console:

   ```bash
   cd console/backend
   PYTHONPATH=. python -m tether_console
   ```

   The default listener is `http://127.0.0.1:8431`. The Console remains read-only; it does not edit authoritative memory files.

## Selfsame Protocol conformance

The protocol defines four cumulative levels:

1. **Identity Continuity**
2. **Durable Continuity**
3. **Verifiable Memory**
4. **Recovery-Proven**

Run the fully synthetic protocol probe with:

```bash
node scripts/probe-selfsame-protocol.cjs
```

The probe uses no private data, production state, credentials, provider calls, or network access. See [SELFSAME_PROTOCOL.md](SELFSAME_PROTOCOL.md) before making a conformance claim; passing one probe does not waive any normative requirement.

## Privacy model

Local-first does not mean data never leaves the machine. A configured channel receives messages, and a configured model provider receives the context sent for inference. Tether itself does not require hosted telemetry, but operators remain responsible for provider retention policies, channel privacy, filesystem permissions, backups, and recipient-aware output controls.

Read [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) before connecting real accounts or histories. Never commit `.env`, raw transcripts, memory folders, database files, channel exports, logs, or identifiers.

## Project policy

- **License:** [Apache License 2.0](LICENSE), except for noted third-party material. Distributions must preserve applicable attribution in [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Three modified bridge helpers include MIT-licensed material, and `CODE_OF_CONDUCT.md` is separately licensed under `CC-BY-SA-4.0`.
- **Contributions:** [CONTRIBUTING.md](CONTRIBUTING.md)
- **Security reports:** [SECURITY.md](SECURITY.md)
- **Code of Conduct:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)
- **Name and marks:** [TRADEMARKS.md](TRADEMARKS.md)

Apache-2.0 includes an explicit patent grant, but it does not grant permission to imply endorsement by, or official affiliation with, the Tether project.
