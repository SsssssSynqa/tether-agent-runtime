# Testing and conformance

All default repository tests use synthetic temporary data. They require no live model, Telegram account, credential, private history, or network request.

## Fast release gates

```bash
make check
```

This runs:

1. runtime offline suites;
2. the Selfsame Protocol synthetic probe;
3. exact-byte export verification;
4. public-snapshot disclosure/security guard;
5. local Markdown link validation.

After installing Console development dependencies:

```bash
make check-all
```

This adds Console backend tests plus frontend tests, static checks, and a production build.

## Runtime suites

```bash
npm test
```

`test/offline.cjs` and `test/layered-runtime.cjs` cover accepted and rejected paths for:

- first-session creation only on an empty authority root;
- same-session terminal/Telegram attachment and fail-closed resume;
- storage schema initialization, migration requirements, newer-version/agent mismatch rejection;
- single runtime lock, supervisor lock, and offline dual-lock exclusion;
- append-only transcript proof, token-driven folds, emergency loss-preserving fallback, and summary archives;
- day/week card settlement, source coverage, latest logical versions, attribution, aliases, protected quotations, and naming events;
- semantic extraction/verification/high-risk review, queue idempotency, modes, projections, and bounded manifests;
- optional embeddings, incremental maintenance, bulk backfill, query recall, compaction, and card fallback;
- provider URL/credential/header validation, purpose models, images, failover, and empty/ambiguous results;
- bounded tool calls, path confinement, symlink/hidden/credential rejection, storage/workspace isolation, approvals, replay, and ambiguous effects;
- Telegram owner/group authorization, mention/all modes, batching, envelope repair, reactions, attachments, deterministic chunking, and missing-reply fallback;
- durable inbox transitions, capacity deferral, exact committed-output replay, operator pauses, dead letters, and manual requeue guards;
- runtime health, stale-heartbeat decisions, supervised restart/backoff/jitter/budget, and graceful stop;
- backup hash tree, semantic/session proof checks, resumable atomic restore, tamper/overlap/symlink/special-file rejection;
- exact-byte source export and stale-managed-file detection.

Every test owns a temporary directory. Provider and Telegram HTTP calls use injected fakes.

## Selfsame Protocol probe

```bash
node scripts/probe-selfsame-protocol.cjs
```

The dependency-free probe exercises the protocol's cumulative identity, durability, memory, and recovery invariants. It includes counterexamples: failed resume, invalid compaction, duplicate ingress, missing evidence, alias conflict, index deletion, and capability differences.

Passing the probe does not waive normative requirements. A conformance statement must identify the implementation revision, claimed level, evidence command, excluded optional features, and known exceptions as described in [SELFSAME_PROTOCOL.md](../SELFSAME_PROTOCOL.md).

## Export integrity

```bash
npm run verify:export
```

The public runtime and Console are generated from explicit allowlists. Export locks store SHA-256 and size for every managed file. Verification detects local drift, unreviewed additions, changed bytes, and stale managed paths rather than relying on a manual copy.

## Disclosure and repository guard

```bash
scripts/check-public-snapshot
node scripts/check-markdown-links.cjs
```

The guard checks common secret formats, private paths, production artifacts, live identifiers, unsafe workflow permissions, and tracked runtime data. It is a backstop; human review is still required because no pattern list understands every private fact.

## Console backend

```bash
PYTHONPATH=console/backend python3 -m pytest \
  console/backend/tests/test_tether_console.py
```

The suite covers loopback/default configuration, strict JSONL parsing, corrupt-store errors, path redaction, read-only API behavior, cards/folds, semantic queue sanitization, vector metadata without raw numeric vectors, source references, integrity, and current-context manifests.

## Console frontend

```bash
cd console/frontend
pnpm test
pnpm check
pnpm build
```

Tests exercise route rendering and API-state behavior; `check` runs project static validation, and `build` proves the production bundle.

## Service and documentation checks

On macOS:

```bash
plutil -lint examples/com.example.tether.plist
```

On a systemd host:

```bash
systemd-analyze verify examples/tether.service
```

The example files contain placeholders and are not loaded by tests. Validate the copied, locally edited definition again before installing it.

## What default CI does not do

Default CI deliberately does not:

- contact a real provider or Telegram;
- load production memory or credentials;
- start a live long-poll consumer;
- migrate, back up, restore, or replay a deployed data root;
- prove a host's permissions, encryption, secret manager, service manager, or external-provider retention policy.

Those checks belong to an operator-controlled staging environment and the recovery drills in [OPERATIONS.md](OPERATIONS.md).

## Pull-request release checklist

Before declaring a release-ready branch:

1. run `make check-all` from a clean worktree;
2. run syntax checks over every JS/CJS file;
3. validate service examples on their target operating systems;
4. start Console against bundled synthetic data and inspect the first real browser view;
5. scan tracked files and git diff for credentials, private paths, logs, databases, downloads, and backup archives;
6. verify README capability claims against executable code and commands;
7. confirm GitHub CI and CodeQL checks pass;
8. keep the release PR draft until all required checks and documentation links are green.
