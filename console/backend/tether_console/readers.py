# SPDX-License-Identifier: Apache-2.0
"""Readers adapted from Memory Hub's layered card and semantic views.

The public console keeps their key invariants: latest-by-id append-only journals,
strict JSONL parsing, evidence links kept separate from semantic verification,
and no host path disclosure.
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_FOLD_HEADER_RE = re.compile(
    r"^##\s+(\d{2}):(\d{2}):(\d{2})(?:（[^）\n]+）)?\s*·\s*折叠\s+(\d+)\s*轮\s*$",
    re.MULTILINE,
)


class StoreCorrupt(RuntimeError):
    """A journal cannot be trusted; callers must fail closed."""

    def __init__(self, journal: str, line: int | None, reason: str):
        location = f"{journal}:{line}" if line else journal
        super().__init__(f"{location}: {reason}")
        self.journal = journal
        self.line = line
        self.reason = reason


def sha256_json(value: Any) -> str:
    raw = json.dumps(
        value, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def strict_json(path: Path, default: Any) -> Any:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return default
    try:
        return json.loads(raw)
    except (TypeError, ValueError) as exc:
        raise StoreCorrupt(path.name, None, "invalid JSON") from exc


def strict_jsonl(path: Path) -> list[dict[str, Any]]:
    try:
        raw = path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    records: list[dict[str, Any]] = []
    for line_number, line in enumerate(raw.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            value = json.loads(line)
        except (TypeError, ValueError) as exc:
            raise StoreCorrupt(path.name, line_number, "invalid JSONL record") from exc
        if not isinstance(value, dict):
            raise StoreCorrupt(path.name, line_number, "record is not an object")
        records.append(value)
    return records


def latest_by(records: Iterable[dict[str, Any]], id_field: str) -> dict[str, dict]:
    result: dict[str, dict] = {}
    for record in records:
        record_id = record.get(id_field)
        if isinstance(record_id, str) and record_id:
            result[record_id] = dict(record)
    return result


def record_time(record: dict[str, Any]) -> str | None:
    for key in ("committedAt", "updatedAt", "createdAt", "compiledAt", "at"):
        value = record.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def excerpt(value: object, length: int = 180) -> str:
    compact = re.sub(r"\s+", " ", str(value or "")).strip()
    return compact if len(compact) <= length else f"{compact[:length]}…"


def latest_typed_record(path: Path, wanted_type: str) -> dict | None:
    records = strict_jsonl(path)
    return next(
        (record for record in reversed(records) if record.get("type") == wanted_type),
        None,
    )


def card_markdown_path(card_dir: Path, layer: str, period_key: str) -> Path | None:
    if layer not in {"day", "week"} or not _DATE_RE.fullmatch(period_key):
        return None
    if layer == "day":
        names = [
            card_dir / "day-cards" / period_key[:4] / f"{period_key}.md",
            card_dir / "day" / period_key[:4] / f"{period_key}.md",
            card_dir / "日卡" / period_key[:4] / f"{period_key}.md",
        ]
    else:
        names = list((card_dir / "week-cards" / period_key[:4]).glob(f"{period_key}*.md"))
        names += list((card_dir / "week" / period_key[:4]).glob(f"{period_key}*.md"))
        names += list((card_dir / "周卡" / period_key[:4]).glob(f"{period_key}*.md"))
    return next((path for path in names if path.is_file()), None)


def strip_card_heading(raw: str) -> str:
    normalized = raw.replace("\r\n", "\n").replace("\r", "\n")
    lines = normalized.splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def list_cards(card_dir: Path) -> list[dict[str, Any]]:
    latest: dict[str, dict[str, Any]] = {}
    for record in strict_jsonl(card_dir / "cards.jsonl"):
        if record.get("type") != "memory-card":
            continue
        layer = record.get("cardType")
        period = record.get("period") if isinstance(record.get("period"), dict) else {}
        period_key = period.get("key")
        if layer not in {"day", "week"} or not isinstance(period_key, str):
            continue
        logical_id = f"{layer}:{period_key}"
        current = latest.get(logical_id)
        if current is None or int(record.get("version") or 0) >= int(current.get("version") or 0):
            latest[logical_id] = record
    overrides: dict[str, dict[str, Any]] = {}
    for record in strict_jsonl(card_dir / "human-overrides.jsonl"):
        layer = record.get("cardType")
        period_key = record.get("periodKey")
        if layer in {"day", "week"} and isinstance(period_key, str) and str(record.get("content") or "").strip():
            overrides[f"{layer}:{period_key}"] = record
    coverage = {}
    for record in strict_jsonl(card_dir / "coverage.jsonl"):
        layer = record.get("cardType")
        period = record.get("period") if isinstance(record.get("period"), dict) else {}
        period_key = period.get("key")
        if layer in {"day", "week"} and isinstance(period_key, str):
            coverage[f"{layer}:{period_key}"] = record
    compile_record = latest_typed_record(
        card_dir / "compile-manifests.jsonl", "memory-context-manifest"
    )
    compile_ids = {
        str(block.get("id"))
        for block in (compile_record or {}).get("blocks", [])
        if isinstance(block, dict) and block.get("id")
    }
    cards = []
    for logical_id, record in latest.items():
        layer, period_key = logical_id.split(":", 1)
        path = card_markdown_path(card_dir, layer, period_key)
        override = overrides.get(logical_id)
        content = (
            str(override.get("content") or "").strip()
            if override
            else strip_card_heading(path.read_text(encoding="utf-8"))
            if path
            else str(record.get("content") or "").strip()
        )
        status = coverage.get(logical_id, {}).get("status") or "complete"
        cards.append(
            {
                "id": logical_id,
                "card_id": record.get("id"),
                "layer": layer,
                "period_key": period_key,
                "title": record.get("title") or f"{layer.title()} card · {period_key}",
                "content": content,
                "excerpt": excerpt(content),
                "version": int(record.get("version") or 1),
                "source_ids": [str(value) for value in record.get("sourceIds", [])],
                "source_count": len(record.get("sourceIds") or []),
                "status": status,
                "used_in_latest_compile": str(record.get("id")) in compile_ids,
                "updated_at": record_time(override or record),
                "human_override": bool(override),
                "revision": sha256_json({"record": record, "content": content, "override": override}),
            }
        )
    return sorted(cards, key=lambda item: (item["period_key"], item["layer"]), reverse=True)


def list_folds(fold_dir: Path) -> list[dict[str, Any]]:
    folds: list[dict[str, Any]] = []
    if not fold_dir.exists():
        return folds
    for path in sorted(fold_dir.glob("*.md"), reverse=True):
        if not _DATE_RE.fullmatch(path.stem):
            continue
        raw = path.read_text(encoding="utf-8")
        matches = list(_FOLD_HEADER_RE.finditer(raw))
        for index, match in enumerate(matches):
            end = matches[index + 1].start() if index + 1 < len(matches) else len(raw)
            content = re.sub(r"\n---\s*$", "", raw[match.end():end], flags=re.DOTALL).strip()
            time_key = ":".join(match.groups()[:3])
            folds.append(
                {
                    "id": f"fold:{path.stem}:{time_key}:{index}",
                    "layer": "fold",
                    "period_key": path.stem,
                    "time": time_key,
                    "folded_rounds": int(match.group(4)),
                    "content": content,
                    "excerpt": excerpt(content),
                }
            )
    return folds


def _parse_timestamp(value: object) -> float:
    if not isinstance(value, str) or not value:
        return 0.0
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return 0.0
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _apply_patches(state: dict[str, Any]) -> None:
    buckets = {"claim": ("claims", "claimId"), "event": ("events", "eventId"), "projection": ("projections", "projectionId"), "entity": ("entities", "entityId")}

    def apply(patch: dict[str, Any], *, period_scoped: bool = False) -> None:
        target_type = patch.get("targetType")
        target_id = patch.get("targetId")
        operation = patch.get("operation")
        if target_type not in buckets or not isinstance(target_id, str):
            return
        bucket_name, id_field = buckets[target_type]
        if target_type == "projection" and patch.get("scope") == "period":
            selector = patch.get("selector") if isinstance(patch.get("selector"), dict) else {}
            before = patch.get("before") if isinstance(patch.get("before"), dict) else {}
            period = before.get("period") if isinstance(before.get("period"), dict) else {}
            projection_type = selector.get("projectionType") or before.get("projectionType")
            period_key = selector.get("periodKey") or period.get("key")
            effective_from = selector.get("effectiveFromCreatedAt") or before.get("createdAt") or before.get("committedAt")
            threshold = _parse_timestamp(effective_from)
            for projection_id, projection in list(state["projections"].items()):
                projection_period = projection.get("period") if isinstance(projection.get("period"), dict) else {}
                created = projection.get("createdAt") or projection.get("committedAt")
                if projection.get("projectionType") == projection_type and projection_period.get("key") == period_key and (projection_id == target_id or (effective_from and _parse_timestamp(created) >= threshold)):
                    apply({**patch, "targetId": projection_id, "scope": "single"}, period_scoped=True)
            return
        target = state[bucket_name].get(target_id)
        if target is None:
            return
        after = patch.get("after") if isinstance(patch.get("after"), dict) else {}
        if operation in {"correct", "clarify"}:
            resolved = {**target, **after}
            if resolved.get(id_field) != target.get(id_field):
                return
            resolved["humanAuthored"] = True
            if target_type == "claim":
                resolved["verificationStatus"] = "supported"
            elif target_type == "event":
                resolved["status"] = "accepted"
            elif target_type == "projection" and (str(after.get("humanContent") or "").strip() or after.get("sentences")):
                resolved.update({"status": "accepted", "stale": False})
                if period_scoped:
                    resolved["humanAuthoredPeriod"] = True
            state[bucket_name][target_id] = resolved
            return
        if operation == "invalidate":
            resolved = {**target, "humanAuthored": True}
            if target_type == "claim":
                resolved["verificationStatus"] = "invalidated"
            elif target_type == "event":
                resolved["status"] = "invalidated"
            elif target_type == "projection":
                resolved.update({"status": "invalidated", "stale": True})
            else:
                resolved["invalidated"] = True
            state[bucket_name][target_id] = resolved
            return
        if operation == "split" and target_type in {"claim", "event"}:
            replacements = after.get("replacements")
            if not isinstance(replacements, list) or len(replacements) < 2:
                return
            apply({**patch, "operation": "invalidate"})
            for replacement in replacements:
                if not isinstance(replacement, dict) or not replacement.get(id_field):
                    continue
                record = {**replacement, "humanAuthored": True}
                record["verificationStatus" if target_type == "claim" else "status"] = "supported" if target_type == "claim" else "accepted"
                state[bucket_name][str(record[id_field])] = record
            return
        if operation == "merge" and target_type in {"claim", "event"}:
            source_ids, merged = after.get("sourceIds"), after.get("merged")
            if not isinstance(source_ids, list) or len(source_ids) < 2 or not isinstance(merged, dict) or not merged.get(id_field):
                return
            for source_id in source_ids:
                apply({"targetType": target_type, "targetId": str(source_id), "operation": "invalidate"})
            record = {**merged, "humanAuthored": True}
            record["verificationStatus" if target_type == "claim" else "status"] = "supported" if target_type == "claim" else "accepted"
            state[bucket_name][str(record[id_field])] = record

    for patch in state["patches"]:
        apply(patch)

    invalid_claims = {record_id for record_id, record in state["claims"].items() if record.get("verificationStatus") != "supported"}
    claim_fields = ("initialStateClaimIds", "triggerClaimIds", "interpretationClaimIds", "emotionOrStanceClaimIds", "actionClaimIds", "consequenceClaimIds", "laterActionClaimIds", "repairClaimIds", "unresolvedClaimIds")
    for event_id, event in list(state["events"].items()):
        references = {str(value) for field in claim_fields for value in (event.get(field) or [])}
        if references & invalid_claims:
            state["events"][event_id] = {**event, "status": "stale", "stale": True, "staleReason": "supporting_claim_changed"}
    invalid_events = {record_id for record_id, record in state["events"].items() if record.get("status") != "accepted"}
    for projection_id, projection in list(state["projections"].items()):
        if projection.get("humanContent") or projection.get("humanAuthoredPeriod"):
            continue
        claim_refs = set(map(str, projection.get("supportClaimIds") or []))
        event_refs = set(map(str, projection.get("supportEventIds") or []))
        for sentence in projection.get("sentences") or []:
            if isinstance(sentence, dict):
                claim_refs.update(map(str, sentence.get("supportClaimIds") or []))
                event_refs.update(map(str, sentence.get("supportEventIds") or []))
        if claim_refs & invalid_claims or event_refs & invalid_events:
            state["projections"][projection_id] = {**projection, "status": "stale", "stale": True, "autoEffective": False, "staleReason": "supporting_semantic_record_changed"}


def semantic_state(semantic_dir: Path) -> dict[str, Any]:
    manifest = strict_json(semantic_dir / "manifest.json", {})
    if not isinstance(manifest, dict):
        raise StoreCorrupt("manifest.json", None, "root is not an object")
    entities_raw = strict_json(semantic_dir / "entities.json", {"entities": []})
    entities = entities_raw.get("entities", []) if isinstance(entities_raw, dict) else entities_raw
    state = {
        "manifest": manifest,
        "claims": latest_by(strict_jsonl(semantic_dir / "claims.jsonl"), "claimId"),
        "events": latest_by(strict_jsonl(semantic_dir / "events.jsonl"), "eventId"),
        "projections": latest_by(strict_jsonl(semantic_dir / "projections.jsonl"), "projectionId"),
        "reviews": latest_by(strict_jsonl(semantic_dir / "packet-reviews.jsonl"), "packetId"),
        "packets": latest_by(strict_jsonl(semantic_dir / "packets.jsonl"), "packetId"),
        "queue": latest_by(strict_jsonl(semantic_dir / "inbox.jsonl"), "packetId"),
        "patches": strict_jsonl(semantic_dir / "patches.jsonl"),
        "entities": {
            str(item.get("entityId")): item
            for item in (entities if isinstance(entities, list) else [])
            if isinstance(item, dict) and item.get("entityId")
        },
    }
    _apply_patches(state)
    return state


def semantic_public(state: dict[str, Any]) -> dict[str, Any]:
    claims = sorted(state["claims"].values(), key=lambda item: record_time(item) or "", reverse=True)
    events = sorted(state["events"].values(), key=lambda item: record_time(item) or item.get("occurredFrom") or "", reverse=True)
    projections = sorted(state["projections"].values(), key=lambda item: record_time(item) or "", reverse=True)
    reviews = sorted(state["reviews"].values(), key=lambda item: record_time(item) or "", reverse=True)
    queue = sorted(
        (
            {
                "packetId": item.get("packetId"),
                "status": item.get("status") or "unknown",
                "queueClass": item.get("queueClass") or "live",
                "attempts": int(item.get("attempts") or 0),
                "reviewAttempts": int(item.get("reviewAttempts") or 0),
                "nextRetryAt": item.get("nextRetryAt"),
                "updatedAt": item.get("updatedAt"),
            }
            for item in state["queue"].values()
        ),
        key=lambda item: record_time(item) or "",
        reverse=True,
    )
    queue_counts = {
        status: sum(item["status"] == status for item in queue)
        for status in (
            "pending",
            "retry",
            "partial_review_pending",
            "needs_human_review",
            "completed",
        )
    }
    return {
        "mode": state["manifest"].get("mode") or "off",
        "schema_version": state["manifest"].get("schemaVersion"),
        "counts": {
            "claims": len(claims),
            "events": len(events),
            "projections": len(projections),
            "reviews": len(reviews),
            "patches": len(state["patches"]),
            "supported_claims": sum(item.get("verificationStatus") == "supported" for item in claims),
            "accepted_events": sum(item.get("status") == "accepted" for item in events),
            "accepted_projections": sum(item.get("status") == "accepted" and not item.get("stale") for item in projections),
            "queue_total": len(queue),
            "queue_pending": queue_counts["pending"],
            "queue_retry": queue_counts["retry"],
            "queue_partial_review": queue_counts["partial_review_pending"],
            "queue_human_review": queue_counts["needs_human_review"],
            "queue_completed": queue_counts["completed"],
            "queue_actionable": (
                queue_counts["pending"]
                + queue_counts["retry"]
                + queue_counts["partial_review_pending"]
            ),
        },
        "claims": claims,
        "events": events,
        "projections": projections,
        "reviews": reviews,
        "queue": queue,
    }


def current_context(card_dir: Path, semantic_dir: Path) -> dict[str, Any]:
    card_manifest = latest_typed_record(
        card_dir / "compile-manifests.jsonl", "memory-context-manifest"
    )
    semantic_manifest = latest_typed_record(
        semantic_dir / "compile-manifests.jsonl", "semantic-memory-context-manifest"
    )
    selected = semantic_manifest or card_manifest
    return {
        "source": "semantic" if semantic_manifest else "cards" if card_manifest else None,
        "compiled_at": (selected or {}).get("compiledAt"),
        "mode": (selected or {}).get("mode"),
        "context_layout": (selected or {}).get("contextLayout"),
        "blocks": (selected or {}).get("blocks", []),
        "selected_projection_ids": (selected or {}).get("selectedProjectionIds", []),
        "selected_archive_block_ids": (selected or {}).get("selectedArchiveBlockIds", []),
        "memory_tokens": (selected or {}).get("usedTokens", (selected or {}).get("memoryTokens")),
        "token_budget": (selected or {}).get("tokenBudget"),
        "over_budget": bool((selected or {}).get("overBudget")),
        "content_snapshot": bool((selected or {}).get("blocks")),
    }


def integrity(card_dir: Path, semantic_dir: Path) -> dict[str, Any]:
    cards = list_cards(card_dir)
    state = semantic_state(semantic_dir)
    claim_ids = set(state["claims"])
    event_ids = set(state["events"])
    missing_claim_refs: set[str] = set()
    missing_event_refs: set[str] = set()
    evidence_missing_quote: list[str] = []
    for claim_id, claim in state["claims"].items():
        evidence = claim.get("evidence") if isinstance(claim.get("evidence"), list) else []
        if claim.get("verificationStatus") == "supported" and not any(
            isinstance(item, dict) and str(item.get("quote") or "").strip() for item in evidence
        ):
            evidence_missing_quote.append(claim_id)
    event_claim_fields = (
        "initialStateClaimIds", "triggerClaimIds", "interpretationClaimIds",
        "emotionOrStanceClaimIds", "actionClaimIds", "consequenceClaimIds",
        "laterActionClaimIds", "repairClaimIds", "unresolvedClaimIds",
    )
    for event in state["events"].values():
        for field in event_claim_fields:
            missing_claim_refs.update(str(value) for value in (event.get(field) or []) if str(value) not in claim_ids)
    for projection in state["projections"].values():
        refs_claims = list(projection.get("supportClaimIds") or [])
        refs_events = list(projection.get("supportEventIds") or [])
        for sentence in projection.get("sentences") or []:
            if isinstance(sentence, dict):
                refs_claims += list(sentence.get("supportClaimIds") or [])
                refs_events += list(sentence.get("supportEventIds") or [])
        missing_claim_refs.update(str(value) for value in refs_claims if str(value) not in claim_ids)
        missing_event_refs.update(str(value) for value in refs_events if str(value) not in event_ids)
    missing_card_sources = sorted(
        {
            source_id
            for card in cards
            for source_id in card["source_ids"]
            if not source_id
        }
    )
    issues = {
        "missing_claim_references": sorted(missing_claim_refs),
        "missing_event_references": sorted(missing_event_refs),
        "supported_claims_without_quote": sorted(evidence_missing_quote),
        "empty_card_source_ids": missing_card_sources,
    }
    issue_count = sum(len(values) for values in issues.values())
    return {
        "healthy": issue_count == 0,
        "issue_count": issue_count,
        "checked": {
            "cards": len(cards),
            "claims": len(state["claims"]),
            "events": len(state["events"]),
            "projections": len(state["projections"]),
        },
        "issues": issues,
        "checked_at": datetime.now(timezone.utc).isoformat(),
    }
