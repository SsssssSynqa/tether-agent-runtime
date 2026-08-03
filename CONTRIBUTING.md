# Contributing to Tether

Thank you for helping make long-running agents more reliable without sacrificing identity or memory integrity.

## Before opening a change

1. Read [ARCHITECTURE.md](ARCHITECTURE.md) and [SELFSAME_PROTOCOL.md](SELFSAME_PROTOCOL.md).
2. Search existing issues and pull requests.
3. For a substantial behavioral or protocol change, open a design issue first. Describe the user-visible outcome, preserved invariants, unknowns, migration impact, and recovery behavior.
4. Never attach production conversations, credentials, identifiers, private logs, or real memory databases. Build a synthetic fixture.

## Development principles

- Preserve one complete authoritative session across persona-bearing channels.
- Fail closed on resume instead of silently creating a replacement session.
- Keep raw authority append-only; corrections append provenance.
- Make retries causally idempotent and replay committed output exactly.
- Treat summaries, vectors, cards, and indexes as derived and rebuildable.
- Keep attribution, entity, alias, and quotation integrity testable.
- Separate capability authorization from context continuity.
- Prefer small, independently verifiable changes over broad rewrites.
- Do not add dependencies without explaining why the standard library or an existing dependency is insufficient.

## Local checks

Run the dependency-free runtime, protocol, export, privacy, and documentation checks:

```bash
make check
```

After installing the Console backend and frontend development dependencies, run its offline suite too:

```bash
make console-check
```

The equivalent focused commands are documented in [docs/TESTING.md](docs/TESTING.md). Tests must not require a live provider, Telegram token, private history, or network access.

Every bug fix should include a synthetic regression that fails before the fix. Recovery changes should test both the accepted path and the dangerous counterexample.

## Protocol changes

`SELFSAME_PROTOCOL.md` is implementation-independent. A protocol pull request must:

- explain whether the change strengthens, clarifies, or incompatibly changes an invariant;
- update conformance levels and counterexamples when relevant;
- update the synthetic protocol probe;
- avoid making Tether internals mandatory for other implementations;
- preserve normative **MUST**, **SHOULD**, and **MAY** language consistently.

## Pull requests

- Keep generated files, runtime state, and unrelated formatting out of the diff.
- Explain the root cause and why the chosen boundary is correct.
- List tests run and their results.
- Call out security, privacy, migration, memory-rebuild, or session-continuity risks.
- Confirm that `scripts/check-public-snapshot` passes.
- Use clear commits such as `fix: preserve exact replay after lost acknowledgement`.

Unless explicitly stated otherwise, contributions submitted to this project are licensed under the [Apache License 2.0](LICENSE), without additional terms or conditions, in accordance with Section 5 of that license.

## Conduct and security

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Report vulnerabilities privately according to [SECURITY.md](SECURITY.md), not through a public issue.
