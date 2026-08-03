# Tether Console

A local, read-only view of the memory that keeps one agent attached to itself.

Tether Console is the generic extraction of the production Memory Hub views used for layered local memory. It deliberately preserves the original separation between readable cards, semantic evidence, and compile manifests rather than flattening everything into a single “memory” list.

## What it shows

- fold logs plus day and week cards;
- semantic claims, events, projections, and packet reviews as separate records;
- durable semantic extraction queue health without exposing raw packet text or provider errors;
- embedding coverage and sanitized vector metadata without returning numeric vectors;
- the latest recorded compile manifest—the context the runtime actually loaded;
- source references and exact evidence-quote availability;
- dangling claim/event references and supported claims without quotes;
- folder readiness without returning absolute host paths.

The public API is read-only. It does not accept filesystem paths in requests, expose local paths in responses, edit journals, infer missing cards, or silently skip corrupt JSONL. A malformed journal returns `503 memory_store_corrupt` with only the journal basename and line number.

## Quick start with synthetic data

From this `console/` directory:

```bash
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

Open <http://127.0.0.1:8431>. The bundled `sample-data/` is wholly synthetic and is safe for screenshots, tests, and demonstrations.

For frontend development, keep the backend on `8431`, then run:

```bash
cd frontend
pnpm dev
```

Vite listens on <http://127.0.0.1:5187> and proxies `/api` to the local backend.

## Point it at an existing local memory folder

Use one conventional root:

```text
memory/
├── folds/
│   └── YYYY-MM-DD.md
├── cards/
│   ├── cards.jsonl
│   ├── coverage.jsonl
│   ├── compile-manifests.jsonl
│   ├── day-cards/YYYY/YYYY-MM-DD.md
│   └── week-cards/YYYY/YYYY-MM-DD--YYYY-MM-DD.md
└── semantic/
    ├── manifest.json
    ├── entities.json
    ├── claims.jsonl
    ├── events.jsonl
    ├── projections.jsonl
    ├── packets.jsonl
    ├── inbox.jsonl
    ├── packet-reviews.jsonl
    ├── patches.jsonl
    ├── embedding-state.json
    ├── embeddings.jsonl
    └── compile-manifests.jsonl
```

Then set:

```bash
TETHER_MEMORY_ROOT=/path/to/memory
```

Existing deployments may instead inject each directory independently:

```bash
TETHER_FOLD_DIR=/path/to/folds
TETHER_CARD_DIR=/path/to/cards
TETHER_SEMANTIC_DIR=/path/to/semantic
```

For compatibility with the original local folder layout, the card reader also recognizes `日卡/` and `周卡/` directories. These names are data-layout compatibility only; no persona, owner, principal, database, or deployment state is embedded in the package.

## API

| Route | Purpose |
|---|---|
| `GET /api/status` | Readiness, counts, and integrity summary |
| `GET /api/cards?layer=all|day|week|fold` | Human-readable layered memory |
| `GET /api/cards/{item_id}` | One card/fold record |
| `GET /api/semantic?kind=all|claims|events|projections|reviews|queue|vectors` | Verifiable semantic journals, sanitized extraction queue state, and vector metadata |
| `GET /api/context/current` | Latest recorded compile manifest |
| `GET /api/sources` | Source-to-memory references |
| `GET /api/integrity` | Referential and evidence checks |

All responses use `Cache-Control: no-store`.

## Verification

Backend:

```bash
PYTHONPATH=backend python -m pytest backend/tests/test_tether_console.py
```

Frontend:

```bash
cd frontend
pnpm test
pnpm check
pnpm build
```

The source copy inside Memory Hub and the exported public `console/` are produced by the versioned `tether-console/export-manifest.json` allowlist. From the Hub source root, release maintainers run:

```bash
python tether-console/export_console.py export --target /path/to/public/console
python tether-console/export_console.py check --target /path/to/public/console
cd tether-console && python -m unittest test_export_console.py
```

The standard-library exporter performs exact-byte copies only, writes deterministic `console/export-lock.json` SHA-256 records, and fails if a previously managed path becomes stale. It performs no search/replace and never exports repository history.

## Deliberate boundaries

- This console inspects local memory, embedding coverage, and the semantic extraction queue; it is not the provider adapter, Telegram adapter, terminal adapter, or Telegram delivery queue.
- Human correction writes and authenticated multi-principal Memory Hub workflows stay outside this public read-only surface.
- Integrity checks validate the journal references available in the local folder. They cannot prove that an upstream chat export itself is complete.
- JSONL is parsed strictly on every request in this first public version. Very large installations should retain Tether's bounded active manifests and archive rotation.

Licensed under the [Apache License 2.0](../LICENSE).
