# Operations and recovery

## Normal startup

1. Mount or unlock the private data root.
2. Verify filesystem ownership and available space.
3. Load credentials from an external secret source.
4. Start the single authoritative runtime; it must acquire `storage.root/.tether-instance.lock`, and a second instance using that root must fail.
5. Confirm that startup opens the authoritative session before any channel is attached. An existing anchor must resume successfully; on a genuinely empty root, explicitly authorized initial creation occurs here.
6. Attach channel adapters only after session open succeeds.
7. Start the read-only Console on loopback if needed.

Do not infer continuity from a running process, a green health endpoint, or a provider response. The stored session ID, resume result, and append-only history must agree.

## Optional macOS launchd supervision

[`examples/com.example.tether.plist`](../examples/com.example.tether.plist) is a
synthetic LaunchAgent skeleton for operators who choose macOS process
supervision. Copy it outside the repository, replace every placeholder with an
absolute local path, validate it with `plutil`, and verify a foreground startup
before loading it. Keep the runtime config, data root, and logs outside the
source checkout.

The plist intentionally contains no credential values. Inject provider and
Telegram secrets through an operator-controlled credential wrapper or another
local secret mechanism; do not paste tokens into the plist or commit a populated
copy. A process supervisor restarts the same storage root and session anchor—it
must never create a second per-channel runtime.

## Backup set

Back up at minimum:

- authoritative session state;
- append-only raw transcript and source assets;
- append-only human corrections;
- configuration schema without secrets;
- any keys required to decrypt the backup.

Derived indexes, vectors, cards, and manifests should be rebuildable, but backing them up can shorten recovery. Never restore derived memory without the raw evidence and corrections it claims to represent.

Use atomic snapshots or stop writes at a documented boundary. Verify backups by restoring to an isolated temporary location and checking references; file existence alone is not proof.

## Resume failure

If resume fails:

1. Stop persona-bearing inference while keeping diagnostics available.
2. Preserve the failing state and raw authority.
3. Check configuration, provider/session adapter compatibility, permissions, and corruption.
4. Restore the authoritative state from a verified backup when possible.
5. If continuity cannot be restored, require an explicit operator decision before creating a replacement and record the lineage break.

Never delete the session file merely to make the service green. If any raw transcript, summaries, cards, or causal-journal authority remains, the reference runtime refuses to create a replacement anchor. Restore the authoritative anchor; deleting evidence to bypass that check is not recovery and must not be reported as continuation.

## Delivery recovery

A committed response and its delivery acknowledgement are separate records. After a transport failure:

- retry delivery using the committed bytes and causal ID;
- do not call the model again for that event;
- downgrade a missing reply target only under the documented channel-specific rule;
- place unrecoverable events in a diagnosable dead-letter state;
- require human review before replaying stale historical messages.

## Compaction failure

Keep the last valid active context, retain the raw source, record the failure, and fall back or retry within a bounded policy. Do not install an empty or invalid summary to save space.

## Rebuilding memory

1. Snapshot the raw authority and corrections.
2. Validate JSONL and source-asset integrity.
3. Rebuild deterministic indexes.
4. Re-run probabilistic derivation with versioned prompts and models.
5. Validate attribution, entity IDs, quotations, and source coverage.
6. Switch the compiled view only after the replacement passes validation.

## Provider change

A provider change is an adapter operation, not an identity migration. Keep the authoritative session anchor and raw memory intact, test the new adapter with synthetic prompts, and preserve provider provenance on new outputs.

## Channel change

Adding a channel requires ingress authentication, recipient-aware egress, causal IDs, delivery state, and attachment to the existing runtime. A new channel must not receive its own persona history for convenience.
