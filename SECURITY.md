# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability, leaked credential, private transcript, authorization bypass, or privacy exposure.

Use the repository's **Security** tab to submit a private GitHub Security Advisory. Include:

- the affected component and revision;
- a minimal synthetic reproduction;
- expected and observed behavior;
- impact and preconditions;
- any suggested remediation;
- whether real credentials or personal data may have been exposed.

Do not include a real conversation, token, user identifier, channel export, memory database, or production log. Replace them with synthetic values. Maintainers will acknowledge the report through the advisory and coordinate remediation and disclosure there.

## Supported versions

Until the first stable release, security fixes target the latest revision on the default branch. After versioned releases begin, this section will identify supported release lines.

## Security boundaries

Tether coordinates components with different trust boundaries:

- channel adapters authenticate ingress and shape recipient-visible output;
- the runtime owns the authoritative session and causal journal;
- provider adapters send selected context to a configured model service;
- memory folders contain sensitive raw and derived records;
- Tether Console reads local memory and binds to loopback by default;
- per-turn capabilities authorize tools and writes without forking identity context.

The Selfsame Protocol protects continuity; it is not an authentication or encryption protocol. Operators must configure access controls appropriate to their deployment.

## Deployment checklist

- Store secrets outside the repository and outside committed configuration.
- Require HTTPS for remote provider endpoints. Permit HTTP only for `localhost`, `127.0.0.0/8`, or `::1`, and never embed credentials in provider URL userinfo or query parameters.
- Apply the same HTTPS-or-loopback boundary to a custom Telegram API base; reject URL credentials, query parameters, and fragments.
- Keep authentication out of ordinary provider `headers`; use `apiKeyEnv` or `headerEnv` so credential values come from the process environment.
- Keep runtime data outside the source checkout with least-privilege filesystem permissions.
- Bind Console and administrative endpoints to loopback unless a separately authenticated reverse proxy is deliberately configured.
- Treat raw transcripts, corrections, cards, vectors, logs, and backups as sensitive data.
- Verify provider and channel retention policies before sending real content.
- Rotate a secret immediately if it appears in a terminal transcript, log, issue, or commit.
- Review capability policies independently from context continuity.
- Run `scripts/check-public-snapshot` before publishing a branch or release archive.
- Back up raw authority and test restoration without creating a replacement persona session.

## Out of scope for public testing

Do not test against accounts, bots, endpoints, or deployments you do not own or have permission to assess. Do not submit denial-of-service traffic, social engineering, credential stuffing, or real private data.
