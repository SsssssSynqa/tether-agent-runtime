# Privacy Model

中文文档见 [PRIVACY.zh-CN.md](PRIVACY.zh-CN.md).

Tether is local-first: authoritative history and memory are stored in operator-controlled folders, and Tether Console reads those folders locally. Local-first is a deployment property, not a promise that configured providers and channels never receive data.

## Data flows

| Component | Data it may receive | Primary control |
|---|---|---|
| Channel adapter | Incoming and outgoing channel messages, delivery metadata | Channel configuration and access policy |
| Agent runtime | Authoritative session, causal IDs, active context, outputs | Local data directory and filesystem permissions |
| Model provider | The prompt, selected history, attachments, and tool results sent for inference | Provider adapter and provider account policy |
| Memory pipeline | Raw transcript plus derived cards, claims, events, corrections, and indexes | Local memory roots and retention policy |
| Workspace tools | Operator-declared local roots, filenames, UTF-8 contents, and write results | Root allowlist, per-channel capability policy, approval journal, and size limits |
| Tether Console | Read-only views of configured local memory folders | Loopback binding and local process access |
| Backups | Whatever selected runtime and memory data is included | Operator-controlled destination and encryption |

## What the repository does not contain

The public repository must not contain production conversations, account or chat identifiers, credentials, deployment addresses, private endpoints, user profiles, memory databases, runtime logs, media downloads, or backup archives. All examples and tests must be synthetic.

Run `scripts/check-public-snapshot` before publishing. The guard detects common accidental inclusions, but it cannot understand every private fact; human review remains required.

## External services

When an operator enables a provider or channel, data is handled under that external service's terms and retention policy. Tether cannot erase copies retained by an external service. Review those policies and minimize the context and attachments sent when appropriate, without manufacturing a second persona history.

Tether does not require hosted analytics or telemetry. A downstream distribution that adds telemetry should disclose it prominently and obtain any consent required by its users.

## Local storage

Raw authority is intentionally append-only because identity continuity depends on preserving evidence. This increases the importance of:

- explicit storage locations outside the source checkout;
- least-privilege filesystem permissions;
- encryption appropriate to the device and threat model;
- retention and backup policies;
- careful handling of derived vectors and summaries, which may still reveal source content;
- physical separation between every tool workspace and `storage.root` so model capabilities cannot reach continuity authority;
- authenticated, auditable legal deletion procedures when deletion is required.

Human corrections do not erase the original evidence. They append a superseding interpretation. Operators should communicate this behavior before collecting sensitive content.

Tool workspace data is not part of Tether's continuity backup because workspace
roots are required to be outside `storage.root`. A Telegram attachment directory
configured outside that root is also excluded. Inventory and protect those paths
separately.

## Backups and restore artifacts

The built-in backup format is a verified, content-addressed directory, not an
encrypted archive. It may contain the session anchor, raw conversation,
attachments, semantic records, tool journals, and delivery state in directly
readable form. Encrypt backup media, restrict destination permissions, and do
not upload a backup to a public issue or artifact store. Restore receipts and
partial work directories are operational metadata and should be treated as
sensitive until the drill is complete.

## Console exposure

The Console backend binds to `127.0.0.1` by default and is designed as a read-only browser over local memory. Do not expose it directly to a public network. If remote access is required, place it behind an authenticated, encrypted access layer and test authorization independently.

## Logs and diagnostics

Logs should contain event categories and opaque causal IDs, not message bodies, tokens, authorization headers, or full provider responses. Before sharing diagnostics, inspect every line and replace real identifiers and content with synthetic placeholders.

## Requests and incidents

Operators, not the upstream source repository, control their deployed data. Privacy incidents in Tether itself should be reported privately according to [SECURITY.md](SECURITY.md).
