<!-- SPDX-License-Identifier: Apache-2.0 -->

# Selfsame Protocol (SSP)

**Status:** Independent implementation protocol, version 1.0-draft<br>
**Reference implementation:** Tether<br>
**Protocol goal:** Preserve one agent's identity, causal history, and attributable memory across channels, providers, failures, and context limits.

## 1. Scope

The Selfsame Protocol specifies identity-continuity invariants for a persona-bearing agent runtime. It does not prescribe a model vendor, transport, database, embedding model, user interface, or deployment topology.

An implementation can use Telegram, a terminal, a web client, or another channel. It can change providers and memory engines. Those components are replaceable. The authoritative identity and history are not.

Tether is a reference implementation of SSP. SSP is deliberately independent of Tether: another runtime can conform without using Tether code, names, file formats, or services.

## 2. Normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHOULD**, **SHOULD NOT**, and **MAY** are to be interpreted as normative requirements.

## 3. Terms

- **Agent identity:** The persona-bearing continuity that users intend to reach, independent of a process, channel, or provider.
- **Authoritative session:** The single logical conversation history for one agent identity.
- **Raw authority:** The append-only record of accepted inputs, committed outputs, provenance, and corrections.
- **Derived memory:** Any summary, card, claim, event, vector, projection, index, cache, or compiled context produced from raw authority.
- **Causal event ID:** A stable identifier for one accepted ingress event and every effect caused by that event.
- **Exact replay:** Re-delivery of the already committed output for a causal event, without another inference.
- **Compaction:** Replacement of active model context with a smaller derived representation while retaining raw authority.
- **Capability view:** The tools, writes, approvals, and external actions available for one turn.
- **Human correction:** An authenticated, append-only instruction that changes the accepted interpretation of evidence without rewriting the evidence itself.

## 4. Core invariants

### 4.1 One complete session

1. A persona-bearing agent identity **MUST** have exactly one authoritative session across every attached channel.
2. A runtime **MUST NOT** create separate histories by channel, chat, sender, device, trust zone, provider, or capability profile.
3. All accepted turns **MUST** join the same causal history in a deterministic order.
4. Channel-local delivery metadata **MAY** be stored separately, but it **MUST NOT** become a second persona history.
5. An explicitly requested independent engineering task or stateless parser **MAY** use a separate session, but it **MUST NOT** impersonate, replace, or silently become the persona-bearing agent.

### 4.2 Resume is fail-closed

1. A runtime **MUST** persist enough identity to resume the authoritative session after process, transport, or host failure.
2. If the authoritative session cannot be resumed, persona-bearing inference **MUST NOT** continue in a newly created session.
3. Resume failure **MUST** produce a durable, diagnosable blocked state. It **SHOULD** tell an operator how to restore or explicitly replace the session.
4. Creation of a replacement authoritative session **MUST** require an explicit, attributable decision. The replacement **MUST** retain a link to the prior raw authority and **MUST NOT** be reported as an ordinary resume.
5. Provider availability, a healthy process, or the ability to generate text **MUST NOT** be treated as proof that the authoritative session was resumed.

### 4.3 Append-only raw authority

1. Accepted user inputs, committed agent outputs, causal IDs, channel provenance, and human corrections **MUST** be durably recorded in raw authority.
2. Raw authority **MUST** be append-only under ordinary operation. Repair operations **MUST NOT** silently edit, replace, or delete historical evidence.
3. A repair **MUST** preserve the original record and append an attributable superseding or invalidating record.
4. A runtime **SHOULD** commit the accepted input before inference and **MUST** commit the final output before acknowledging durable completion.
5. Large or binary source assets **MAY** be stored out of line. Their record **MUST** include a content identity and durable provenance.
6. Retention or legal deletion requirements **MAY** require removal, but such removal **MUST** be explicit, auditable, and never represented as normal compaction or correction.

### 4.4 Compaction conservation

1. Compaction **MUST NOT** delete or mutate raw authority.
2. A compacted representation **MUST** preserve causal order, speaker attribution, entity identity, unresolved uncertainty, and links back to its source range.
3. A compaction **MUST NOT** present an inference as a quotation or convert one speaker's statement into another speaker's statement.
4. Failed or invalid compaction **MUST** leave the last valid active context available. A runtime **MUST NOT** exchange silent loss for token savings.
5. Every compacted segment **SHOULD** record its source boundary, transformation version, and validation result.
6. The runtime **MUST** be able to inspect the raw source that a compacted statement claims to represent.

### 4.5 Attribution, entity, and alias integrity

1. Every remembered statement or event **MUST** preserve its actual speaker or source role.
2. A model-generated line **MUST NOT** be stored as a user's quotation unless raw authority contains that quotation from the user.
3. Entities **MUST NOT** be merged solely because their names, aliases, roles, or descriptions are similar.
4. Alias normalization **MUST** be scoped and versioned. It **MUST NOT** rewrite protected quotations, naming events, source titles, or identifiers.
5. When attribution or entity identity is ambiguous, the system **MUST** retain the ambiguity or reject the derived claim. It **MUST NOT** invent certainty for presentation quality.
6. A later alias or entity correction **MUST** be expressed as an append-only correction with provenance.

### 4.6 Causal idempotency and exact replay

1. Each accepted ingress event **MUST** receive a stable causal event ID before persona-bearing inference.
2. All retries, deliveries, memory writes, and acknowledgements caused by an event **MUST** carry that causal ID or an unambiguous child ID.
3. The runtime **MUST** commit at most one authoritative inference result for one causal event ID.
4. If a committed event is retried, the runtime **MUST** perform exact replay. It **MUST NOT** call the model again and present a different answer as the same event.
5. Delivery acknowledgement and inference commitment **MUST** be distinguishable. A lost transport acknowledgement **MUST NOT** cause a second inference.
6. Duplicate ingress **MUST** be safe. The observable authoritative history after one delivery and after repeated delivery of the same event **MUST** be equivalent.
7. If exact replay cannot be performed, the event **MUST** enter a diagnosable blocked or dead-letter state rather than being silently regenerated.

### 4.7 Derived memory is rebuildable

1. Derived memory **MUST NOT** be the sole authority for a remembered fact.
2. Every derived item **MUST** retain sufficient lineage to identify its raw sources and applicable human corrections.
3. Deleting indexes, vectors, cards, manifests, projections, and caches **MUST NOT** destroy the evidence required to reconstruct them.
4. Deterministic indexes **SHOULD** be exactly rebuildable from raw authority.
5. Probabilistic derivations **SHOULD** record model, prompt, schema, and transformation versions. A rebuild MAY differ in wording, but it **MUST** remain attributable to the same evidence and corrections.
6. A derived item that fails validation **MUST NOT** replace a previously valid item or raw authority.

### 4.8 Human correction is append-only

1. A human correction **MUST** identify its target, authorizing principal, timestamp, reason or intent, and supersession relationship.
2. A correction **MUST NOT** overwrite the source record it corrects.
3. Corrected views **MUST** apply the latest authorized correction while keeping earlier interpretations inspectable.
4. A correction **MUST NOT** claim that the corrected interpretation was the original evidence.
5. Automated processes **MUST NOT** grant a correction human authority from a self-asserted payload field alone.

### 4.9 Channel and provider independence

1. A channel adapter **MUST** attach to the authoritative session; it **MUST NOT** own a persona session.
2. Switching, adding, disconnecting, or reconnecting a channel **MUST NOT** reset identity or history.
3. Switching model or API providers **MUST NOT** create a new identity or erase the authoritative session.
4. Provider-specific conversation IDs **MAY** be used as transport state, but they **MUST NOT** be the only identity anchor.
5. Channel-specific formatting and privacy rules **MAY** change output presentation. They **MUST NOT** create a separate underlying memory.

### 4.10 Capability is not context isolation

1. A runtime **MAY** restrict tools, writes, network access, approvals, or administrative operations per turn and per channel.
2. Such capability restrictions **MUST NOT** be implemented by forking, cropping, or replacing the authoritative persona history.
3. Privacy enforcement **SHOULD** happen at authorization, tool, and egress boundaries while the authoritative identity remains continuous.
4. A reduced disclosure view **MAY** protect recipients, but it **MUST NOT** become an independent memory that later impersonates the agent.
5. A system **MUST NOT** claim SSP continuity if its safety model depends on separate persona sessions for different trust zones.

## 5. Required transaction order

A conforming durable transport SHOULD follow this logical order:

1. authenticate and authorize ingress;
2. assign or recover the stable causal event ID;
3. durably append the accepted input;
4. deduplicate against committed and in-progress causal events;
5. verify that the authoritative session is resumed;
6. perform at most one inference;
7. validate and durably append the committed output;
8. derive memory with source lineage;
9. deliver the committed output;
10. durably record delivery acknowledgement.

Steps MAY be combined transactionally, but reordering **MUST NOT** violate the invariants in Section 4.

## 6. Conformance levels

An implementation **MUST** state the highest level it claims and publish evidence for every requirement at that level.

### SSP Level 1 — Identity Continuity

The implementation satisfies Sections 4.1, 4.2, 4.9, and 4.10. It preserves one authoritative session across attached channels and providers and fails closed when that session cannot be resumed.

### SSP Level 2 — Durable Continuity

The implementation satisfies Level 1 plus Sections 4.3, 4.4, and 4.6. It retains append-only raw authority, conserves evidence through compaction, and makes retries causally idempotent with exact replay.

### SSP Level 3 — Verifiable Memory

The implementation satisfies Level 2 plus Sections 4.5, 4.7, and 4.8. Its derived memory is attributable, rebuildable, entity-safe, and correctable without rewriting history.

### SSP Level 4 — Recovery-Proven

The implementation satisfies Level 3 and publishes automated, synthetic recovery probes covering at least:

- restart and successful resume without session replacement;
- resume failure that creates no replacement session;
- duplicate ingress with one inference and byte-equivalent replay;
- compaction failure with no raw or active-context loss;
- channel and provider switching with unchanged identity;
- attribution, alias, and entity counterexamples;
- deletion and rebuild of derived memory;
- append-only human correction precedence;
- distinct capability views over one authoritative context.

A production-data-only demonstration is insufficient for Level 4. The probes **MUST** run without private histories, credentials, or live providers.

## 7. Required conformance statement

A public claim SHOULD use this form:

> `<implementation> conforms to Selfsame Protocol Level <n>, protocol version <version>. Evidence: <test or report location>. Known exceptions: <none or explicit list>.`

A runtime **MUST NOT** claim a level if it silently exempts a required invariant. Partial implementations MAY say they are "SSP-inspired" and list the implemented sections.

## 8. Non-conforming counterexamples

The following designs are explicitly non-conforming:

1. **Per-channel personas:** Telegram and terminal each maintain their own history, even if summaries are periodically synchronized.
2. **Helpful amnesia:** Resume fails, so the runtime silently creates a fresh session and keeps answering.
3. **Destructive summarization:** Old turns are deleted after a summary is generated, leaving the summary as the only evidence.
4. **Retry regeneration:** A response was committed but delivery failed, so the model is called again for the same incoming message.
5. **Quotation laundering:** A model paraphrase or invented dialogue is later stored as a verbatim user quotation.
6. **Alias rewriting history:** A global replacement changes words inside a protected quotation or naming event.
7. **Entity collapse:** Two people or agents with similar aliases are merged without source evidence.
8. **Vector-only memory:** The vector database is the only surviving record of a memory and cannot identify the original source.
9. **Correction by overwrite:** A user correction edits the old record in place, making the original evidence and change history unavailable.
10. **Provider identity:** The runtime treats a provider conversation ID as the agent's sole identity and becomes a new persona when providers change.
11. **Context segregation as safety:** Public and private channels use separate persona histories and are advertised as one continuous agent.
12. **Capability fork:** A read-only channel receives a separate memory rather than the same context with fewer authorized actions.

## 9. Security and privacy boundary

SSP continuity does not authorize disclosure. A conforming implementation **MUST** still authenticate users, authorize actions, limit tools, protect secrets, and filter output for its recipient context. These controls operate around one authoritative identity; they do not require manufacturing multiple identities.

Raw authority can contain sensitive material. Implementations **SHOULD** use least-privilege filesystem permissions, encryption appropriate to their threat model, redacted diagnostics, explicit retention controls, and tested backups. Conformance to SSP is not a claim of complete security or privacy.

## 10. Versioning

Protocol revisions **MUST** document compatibility changes. An implementation **SHOULD** record the SSP version used by every conformance report. A future revision MUST NOT weaken an invariant while presenting itself as backward-compatible with the same conformance level.
