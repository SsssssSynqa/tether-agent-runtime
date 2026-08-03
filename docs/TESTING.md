# Testing and conformance

All repository tests are designed to run without a live provider, Telegram token, private history, or network request.

`make check` runs the dependency-free core checks. After installing Console development dependencies, `make check-all` adds both Console suites.

## Runtime suite

```bash
npm test
```

The suite uses temporary synthetic storage and covers:

- process-boundary first-session creation and cross-channel resume;
- fail-closed resume or lost-anchor recovery without a replacement attempt;
- single-writer storage-root locking;
- append-only raw messages, summaries, and cards, including bounded latest-version card recall;
- source-evidence validation and semantic idempotency;
- durable inbox transitions;
- provider URL, credential, and environment-header validation;
- Telegram normalization, edited-message causal identity, exact-update replay, API-base transport safety, and rate-limit behavior;
- an injected mock fetch implementation for the provider adapter.

## Export integrity

```bash
npm run verify:export
```

The clean public runtime is generated from an explicit file allowlist. The export lock records SHA-256 digests for exact-byte source exports. This check catches accidental drift between the exported core and its reviewed source snapshot.

## Selfsame Protocol probe

```bash
node scripts/probe-selfsame-protocol.cjs
```

The protocol probe is fully synthetic and imports only Node standard-library modules. It exercises accepted and rejected paths for one session, fail-closed resume, compaction conservation, exact replay, attribution, alias protection, rebuildable memory, append-only correction, provider independence, and capability views.

## Public snapshot guard

```bash
scripts/check-public-snapshot
node scripts/check-markdown-links.cjs
```

The guard detects common secret formats, private paths, production artifacts, live identifiers, and unsafe GitHub Actions permissions. It is a backstop, not a replacement for human review.

## Console backend

After installing the documented development requirements:

```bash
cd console/backend
python -m pytest tests/test_tether_console.py
```

## Console frontend

```bash
cd console/frontend
pnpm test
pnpm check
pnpm build
```

## Conformance claims

Passing a component test does not automatically grant a Selfsame Protocol level. Use the conformance statement in `SELFSAME_PROTOCOL.md`, publish the evidence path, and list exceptions. Level 4 requires synthetic recovery probes in addition to all normative Level 1–3 behavior.
