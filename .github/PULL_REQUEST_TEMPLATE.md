## Outcome

Describe the user-visible result and the root cause addressed.

## Selfsame invariants

- [ ] One authoritative persona session remains shared across channels.
- [ ] Resume failure cannot silently create a replacement session.
- [ ] Raw authority remains append-only and compaction is non-destructive.
- [ ] Duplicate ingress cannot cause duplicate inference; committed output replays exactly.
- [ ] Attribution, entity, alias, and quotation integrity remain fail-closed.
- [ ] Derived memory remains traceable and rebuildable.
- [ ] Human correction remains append-only and authenticated.
- [ ] Capability changes do not fork identity context.
- [ ] Not applicable items are explained below.

## Verification

List exact offline commands and results. Include a synthetic regression for bug fixes and rejected counterexamples for recovery changes.

## Privacy and release check

- [ ] `scripts/check-public-snapshot` passes.
- [ ] The diff contains no credential, private history, real identifier, local path, endpoint, log, database, runtime state, or generated secret.
- [ ] New dependencies are necessary and explained.
- [ ] Documentation, examples, migrations, and recovery steps are updated where needed.

## Risks and exceptions

Describe security, privacy, migration, compatibility, or protocol-conformance risks and any checklist item marked not applicable.
