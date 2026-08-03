# Operations and recovery

中文文档见 [OPERATIONS.zh-CN.md](OPERATIONS.zh-CN.md).

This runbook distinguishes commands that are safe against a live runtime from commands that intentionally require an offline boundary. Replace paths with local untracked values; never paste credentials into command history intended for publication.

## Process topology

Recommended topology:

```text
launchd / systemd / container restart policy
└── bin/tether-supervisor.cjs config.json
    └── bin/tether.cjs config.json
```

The host manager starts the supervisor at boot and may apply its own separately bounded restart policy. The Tether supervisor owns child readiness, heartbeat monitoring, restart backoff, jitter, and crash-loop budget. Do not configure the host manager to launch a second `tether.cjs` process or to reset a terminal crash loop forever.

The runtime owns `.tether-instance.lock`; the supervisor owns `.tether-supervisor.lock`. The child validates the parent PID/token recorded in the supervisor lock. Stale locks are reclaimed only when their recorded process is no longer alive; malformed locks fail closed.

Synthetic service definitions:

- [macOS launchd](../examples/com.example.tether.plist)
- [Linux systemd](../examples/tether.service)

## Live-safe inspection

These commands do not mutate durable state and may run while Tether is online:

```bash
node bin/tether-ops.cjs status ./config.json
node bin/tether-ops.cjs dead-letters ./config.json
node bin/tether-ops.cjs inspect <update-id> ./config.json
node bin/tether-tools.cjs approvals ./config.json
node bin/tether-tools.cjs operations ./config.json
```

`status` reports the storage schema, latest runtime-health decision, and Telegram durable-inbox counts. Treat timestamps and queue counts as snapshots, not permanent facts.

Tool approvals are durably synchronized and may also be resolved online:

```bash
node bin/tether-tools.cjs approve <approval-id> ./config.json
node bin/tether-tools.cjs deny <approval-id> ./config.json
```

## Offline boundary

The following operations must run only after both supervisor and child runtime are stopped:

- storage migration;
- backup from the live storage root;
- restore;
- any dead-letter/requeue state mutation;
- semantic rebuild queueing;
- vector backfill or offline memory status.

They acquire the supervisor lock first and the runtime lock second. If either process is still alive—or a supervisor is merely waiting to restart its child—the command refuses with `TETHER_INSTANCE_LOCKED`.

Stop the service through its owning service manager and confirm it remains stopped. Do not bypass this check by deleting lock files.

## Normal startup checklist

1. Mount/unlock the private storage and workspace volumes.
2. Confirm ownership, restrictive permissions, available space, and that workspace roots are physically disjoint from `storage.root`.
3. Inject provider and Telegram credentials from the external secret source.
4. Start `tether-supervisor`.
5. Run `tether-ops status` and confirm storage is `current`, runtime health is ready/continue, and the expected session has resumed.
6. Verify terminal or a synthetic authorized channel turn before relying on Telegram.
7. Start the read-only Console on loopback if desired.

A green process and a successful provider response do not prove continuity. The storage marker, session anchor, transcript proof, and resume result must agree.

## Storage migration

The current storage schema is v1. A truly empty root is initialized automatically. A non-empty root with no `storage-version.json` is treated as v0 and cannot start until explicitly adopted.

1. Stop supervisor and runtime.
2. Create a filesystem-level copy or snapshot outside `storage.root`. The built-in backup command intentionally refuses unversioned storage, so this pre-migration copy must use an operator-controlled offline copy mechanism.
3. Confirm the copy contains `session.json`, the complete `memory/` tree, Telegram inbox/offset, and any other authority present.
4. Run:

   ```bash
   node bin/tether-ops.cjs migrate ./config.json
   ```

5. Inspect the result and `storage-version.json`. The marker records `migratedFrom: 0`, the configured agent ID, and a SHA-256 fingerprint of the pre-migration tree.
6. Run `tether-ops status`, then restart the supervisor.

Migration v0→v1 adopts the existing layout; it does not rewrite conversation data. Unknown future schema versions, an agent mismatch, symlinks, or special files remain blocked.

## Verified backup

Stop both processes, then:

```bash
node bin/tether-ops.cjs backup /absolute/backup-parent ./config.json
```

The destination must be outside `storage.root` and may not resolve to an overlapping physical tree. The command creates a new directory named like:

```text
tether-backup-<timestamp>-<root-digest-prefix>/
├── backup-manifest.json
└── data/
```

It copies regular files only, excludes ephemeral locks/health/restore work, fsyncs copies, records every size and SHA-256, checks the storage version and agent binding, verifies the session anchor against the transcript proof, and atomically renames staging into the final path.

Verify any backup independently:

```bash
node bin/tether-ops.cjs verify-backup /absolute/path/to/tether-backup-...
```

Verification rejects extra/missing files, symlinks, special files, hash drift, root-digest drift, invalid session shape, agent mismatch, and transcript-proof mismatch.

A Tether backup is a readable directory, **not encrypted**. Encrypt and transport it according to the deployment threat model.

The built-in backup covers `storage.root` only. Back up these separately when they live elsewhere:

- every tool workspace root;
- `telegram.attachmentDirectory` if configured outside storage;
- secrets required to start providers/channels;
- operator logs, service definitions, and encryption keys.

Never restore derived memory without the raw evidence and correction journals it claims to represent.

## Restore drill and real restore

Always verify first. Use a temporary config whose `storage.root` points to a new empty directory and whose `agent.id` matches the backup:

```bash
node bin/tether-ops.cjs verify-backup /absolute/path/to/backup
node bin/tether-ops.cjs restore /absolute/path/to/backup ./restore-config.json
node bin/tether-ops.cjs status ./restore-config.json
```

Restore requirements:

- supervisor and runtime for the target root must be stopped;
- backup and target must not contain one another, including through symlinks;
- target must be empty, or contain a matching resumable restore receipt and only already verified backup files;
- any conflicting existing file is an error, never overwritten speculatively.

Files are copied through fsynced temporary files. `session.json` is copied last so an interrupted restore cannot look like a complete persona root. `.tether-restore-receipt.json` records `prepared` then `completed`; rerunning the same completed restore is idempotent, while a receipt for a different backup is rejected.

After a real restore:

1. compare the reported root digest with the intended backup;
2. start the supervisor;
3. check readiness and the resumed session proof;
4. inspect queue/dead-letter state before accepting new traffic;
5. perform one authorized test turn, then verify it appended to the restored transcript.

Do not delete `session.json` to make a failed restore start. If continuity cannot be proven, preserve the state and record an explicit lineage break before any new persona is created.

## Telegram dead letters and paused updates

Inventory and inspect live:

```bash
node bin/tether-ops.cjs dead-letters ./config.json
node bin/tether-ops.cjs inspect <update-id> ./config.json
```

Then stop supervisor/runtime before mutating state.

```bash
# Ordinary terminal dead letter
node bin/tether-ops.cjs requeue <update-id> ./config.json

# Operator-paused ambiguous inference/tool/delivery after manual resolution
node bin/tether-ops.cjs resume <update-id> ./config.json

# Explicit retry of a failed state
node bin/tether-ops.cjs requeue-failed <update-id> ./config.json

# Acknowledge that redelivering an already-done update is intentional
node bin/tether-ops.cjs requeue-done <update-id> --confirm-redeliver ./config.json

# Close an orphan only after proving the original source cannot be recovered
node bin/tether-ops.cjs archive-orphan <update-id> --confirm-unrecoverable ./config.json
```

Requeue records intent; after the command exits, restart the supervisor and let the ordinary durable/causal path perform replay. Never call the provider manually to recreate a lost response when committed bytes already exist.

Before replaying stale messages, review recipient, age, causal state, committed output, and whether the user still expects a response. `requeue-done` and `archive-orphan` require explicit flags because their consequences are not safely inferable.

## Tool approvals and ambiguity

A private Telegram write configured as `approval` produces a durable approval ID and a timed pause. Approving or denying it updates the journal; the normal dispatcher retry observes that decision.

If Tether cannot prove whether a file mutation completed—for example, the observed post-write digest is neither the expected before nor after digest—it raises `TETHER_TOOL_EFFECT_AMBIGUOUS` and operator-pauses the Telegram update. Inspect:

```bash
node bin/tether-tools.cjs operations ./config.json
node bin/tether-ops.cjs inspect <update-id> ./config.json
```

Resolve the real filesystem state first. Only then use `tether-ops resume`. Do not approve or replay a changed contract/root mapping as if it were the original operation.

## Memory maintenance and rebuild

Normal maintenance is automatic. Use offline commands for inventory or bulk repair:

```bash
node bin/tether-memory.cjs status ./config.json
node bin/tether-memory.cjs rebuild-semantic ./config.json
node bin/tether-memory.cjs backfill-vectors ./config.json
```

`status` reports semantic mode/queue/counts, vector coverage, and transcript proof. `rebuild-semantic` streams the transcript and idempotently queues turns without loading the whole file. `backfill-vectors` indexes all currently eligible verified documents and compacts stale vectors.

Recommended sequence after a memory-policy/model change:

1. stop processes;
2. create and verify a backup;
3. run semantic rebuild if source records need re-derivation;
4. restart and let the automatic semantic queue drain;
5. stop again and run vector backfill after semantic records stabilize;
6. run memory status and inspect the Console;
7. restart the supervisor.

Do not declare semantic success from file counts alone. Inspect attribution, quotation evidence, entity resolution, review queue, and source coverage.

## Failure playbooks

### Session resume failure

1. Keep persona inference stopped.
2. Preserve the failing root and diagnostics.
3. Check storage version, agent ID, anchor shape, transcript proof, permissions, and provider/session adapter compatibility.
4. Restore the complete root from a verified backup when possible.
5. If recovery is impossible, require an explicit operator decision and record the lineage break. Never call a fresh session “the same one.”

### Folding/card/semantic failure

Leave the raw source and last valid compiled view in place. Inspect bounded retry state and provider-purpose configuration. Invalid candidates are not installed. Card failures retain the lower source layer; vector failures retain cards; semantic failures retain raw/card context.

### Provider change

Treat it as an adapter change, not an identity migration. Keep `agent.id`, `storage.root`, session anchor, and transcript intact. Test the new endpoint with synthetic data, preserve provider provenance on new outputs, then restart the same supervisor.

### Channel change

A new adapter needs authenticated ingress, stable causal IDs, durable delivery state, recipient-aware output, and attachment to the existing runtime. It must not create a channel-specific persona history.

### Supervisor crash-loop exhaustion

The supervisor stops after the configured restart budget. Inspect the latest health record and redacted process logs, fix the root cause, then restart through the host manager. Raising the budget without diagnosing the failure merely hides a loop.

## Periodic drills

At a documented cadence:

- verify the latest backup and restore it into an isolated empty directory;
- confirm the restored session proof and agent binding;
- inspect dead letters, operator pauses, tool approvals, and semantic review queue;
- check vector coverage and manifest sizes;
- verify storage/workspace free space and permissions;
- run offline repository tests against the deployed revision;
- confirm Console remains loopback-only;
- rotate credentials according to provider/channel policy.

Recovery is proven by a successful isolated restore and resume, not by the existence of backup files.
