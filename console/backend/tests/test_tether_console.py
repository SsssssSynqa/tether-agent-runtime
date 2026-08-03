# SPDX-License-Identifier: Apache-2.0
"""Public Tether Console API contract with synthetic local-folder data."""

from __future__ import annotations

import json

import pytest
from starlette.testclient import TestClient

from tether_console import ConsoleSettings, create_app


def _jsonl(path, *records):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(record, ensure_ascii=False) + "\n" for record in records),
        encoding="utf-8",
    )


@pytest.fixture()
def memory_store(tmp_path):
    root = tmp_path / "memory"
    folds = root / "folds"
    cards = root / "cards"
    semantic = root / "semantic"
    folds.mkdir(parents=True)
    cards.mkdir()
    semantic.mkdir()

    (folds / "2026-01-02.md").write_text(
        "# Fold log\n\n## 08:09:10 · 折叠 4 轮\n\nA compacted sample.\n\n---\n",
        encoding="utf-8",
    )
    day_card = {
        "type": "memory-card",
        "id": "memory-card:day:2026-01-02:v1:sample",
        "cardType": "day",
        "version": 1,
        "period": {"key": "2026-01-02"},
        "sourceIds": ["source:sample-message"],
        "content": "The operator named the project Tether.",
        "createdAt": "2026-01-02T09:00:00Z",
    }
    week_card = {
        "type": "memory-card",
        "id": "memory-card:week:2025-12-29:v1:sample",
        "cardType": "week",
        "version": 1,
        "period": {"key": "2025-12-29"},
        "sourceIds": [day_card["id"]],
        "content": "The runtime preserved one session across two channels.",
        "createdAt": "2026-01-03T09:00:00Z",
    }
    _jsonl(cards / "cards.jsonl", day_card, week_card)
    _jsonl(
        cards / "coverage.jsonl",
        {"type": "coverage", "cardType": "day", "period": {"key": "2026-01-02"}, "status": "complete"},
    )
    _jsonl(
        cards / "compile-manifests.jsonl",
        {
            "type": "memory-context-manifest",
            "compiledAt": "2026-01-03T10:00:00Z",
            "blocks": [{"kind": "card", "id": day_card["id"]}],
            "memoryTokens": 40,
            "tokenBudget": 1000,
        },
    )

    (semantic / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "mode": "cards"}), encoding="utf-8"
    )
    (semantic / "entities.json").write_text(
        json.dumps({"entities": [{"entityId": "operator", "canonicalDisplayName": "Operator"}]}),
        encoding="utf-8",
    )
    claim = {
        "claimId": "claim:sample-001",
        "kind": "decision",
        "content": "The project is named Tether.",
        "speakerEntityId": "operator",
        "verificationStatus": "supported",
        "evidence": [{"messageId": "source:sample-message", "quote": "Call it Tether.", "textSha256": "a" * 64}],
        "createdAt": "2026-01-02T09:00:00Z",
    }
    event = {
        "eventId": "event:sample-001",
        "title": "Naming decision",
        "triggerClaimIds": [claim["claimId"]],
        "status": "accepted",
        "createdAt": "2026-01-02T09:01:00Z",
    }
    projection = {
        "projectionId": "projection:sample-001",
        "projectionType": "day",
        "period": {"key": "2026-01-02"},
        "title": "Verified day",
        "sentences": [{"text": "The project is named Tether.", "supportClaimIds": [claim["claimId"]], "supportEventIds": [event["eventId"]], "verificationStatus": "supported"}],
        "supportClaimIds": [claim["claimId"]],
        "supportEventIds": [event["eventId"]],
        "status": "accepted",
        "createdAt": "2026-01-02T09:02:00Z",
    }
    _jsonl(semantic / "claims.jsonl", claim)
    _jsonl(semantic / "events.jsonl", event)
    _jsonl(semantic / "projections.jsonl", projection)
    _jsonl(
        semantic / "packet-reviews.jsonl",
        {"packetId": "packet:sample-001", "status": "committed", "reviewAttempt": 1, "createdAt": "2026-01-02T09:03:00Z"},
    )
    _jsonl(
        semantic / "inbox.jsonl",
        {
            "packetId": "packet:sample-001",
            "status": "completed",
            "queueClass": "live",
            "attempts": 1,
            "updatedAt": "2026-01-02T09:04:00Z",
            "packet": {"rawMessages": [{"text": "must stay private"}]},
        },
        {
            "packetId": "packet:retry-001",
            "status": "retry",
            "queueClass": "historical",
            "attempts": 2,
            "nextRetryAt": "2026-01-04T09:00:00Z",
            "lastError": "provider details must stay private",
            "updatedAt": "2026-01-02T09:05:00Z",
        },
        {
            "packetId": "packet:pending-001",
            "status": "pending",
            "queueClass": "live",
            "attempts": 0,
            "updatedAt": "2026-01-02T09:06:00Z",
        },
        {
            "packetId": "packet:human-001",
            "status": "needs_human_review",
            "queueClass": "rebuild-priority",
            "attempts": 2,
            "reviewAttempts": 1,
            "updatedAt": "2026-01-02T09:07:00Z",
        },
    )
    (semantic / "embedding-state.json").write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "enabled": True,
                "totalDocuments": 3,
                "indexedDocuments": 2,
                "missingDocuments": 1,
                "storedVectors": 2,
                "updatedAt": "2026-01-02T09:08:00Z",
            }
        ),
        encoding="utf-8",
    )
    _jsonl(
        semantic / "embeddings.jsonl",
        {
            "schemaVersion": 1,
            "recordId": day_card["id"],
            "kind": "card:day",
            "title": "Day card · 2026-01-02",
            "contentSha256": "c" * 64,
            "vector": [0.125, 0.25, -0.5],
            "dimensions": 3,
            "providerId": "sample-embedding-provider",
            "model": "sample-embedding-model",
            "updatedAt": "2026-01-02T09:08:00Z",
        },
        {
            "schemaVersion": 1,
            "recordId": claim["claimId"],
            "kind": "claim",
            "title": "Naming claim",
            "contentSha256": "d" * 64,
            "vector": [-0.375, 0.625, 0.75],
            "dimensions": 3,
            "providerId": "sample-embedding-provider",
            "model": "sample-embedding-model",
            "updatedAt": "2026-01-02T09:09:00Z",
        },
    )
    _jsonl(
        semantic / "compile-manifests.jsonl",
        {
            "type": "semantic-memory-context-manifest",
            "schemaVersion": 2,
            "compiledAt": "2026-01-03T11:00:00Z",
            "mode": "cards",
            "blocks": [{"projectionId": projection["projectionId"], "text": "The project is named Tether.", "tokenEstimate": 9}],
            "selectedProjectionIds": [projection["projectionId"]],
            "usedTokens": 9,
            "tokenBudget": 1000,
        },
    )
    return root, folds, cards, semantic


@pytest.fixture()
def client(memory_store):
    root, folds, cards, semantic = memory_store
    settings = ConsoleSettings(root, folds, cards, semantic)
    return TestClient(create_app(settings))


def test_status_exposes_counts_and_aliases_without_host_paths(client, memory_store):
    response = client.get("/api/status")
    assert response.status_code == 200
    body = response.json()
    assert body["read_only"] is True
    assert body["counts"]["day_cards"] == 1
    assert body["counts"]["week_cards"] == 1
    assert body["counts"]["folds"] == 1
    assert body["counts"]["claims"] == 1
    assert body["counts"]["queue_total"] == 4
    assert body["counts"]["queue_actionable"] == 2
    assert body["counts"]["queue_human_review"] == 1
    assert body["counts"]["stored_vectors"] == 2
    assert body["embedding"] == {
        "enabled": True,
        "total_documents": 3,
        "indexed_documents": 2,
        "missing_documents": 1,
        "stored_vectors": 2,
        "updated_at": "2026-01-02T09:08:00Z",
    }
    assert body["integrity"] == {"healthy": True, "issue_count": 0}
    serialized = response.text
    assert str(memory_store[0]) not in serialized
    assert body["configured"]["memory_root"]["alias"] == "$TETHER_MEMORY_ROOT"


def test_cards_support_layers_detail_and_latest_compile_flag(client):
    days = client.get("/api/cards?layer=day").json()
    assert days["count"] == 1
    assert days["items"][0]["used_in_latest_compile"] is True
    detail = client.get("/api/cards/day:2026-01-02")
    assert detail.status_code == 200
    assert "named the project" in detail.json()["content"]
    assert client.get("/api/cards?layer=unknown").status_code == 400


def test_semantic_keeps_claim_event_projection_and_review_separate(client):
    body = client.get("/api/semantic").json()
    assert body["counts"]["claims"] == 1
    assert body["counts"]["events"] == 1
    assert body["counts"]["projections"] == 1
    assert body["counts"]["reviews"] == 1
    assert body["claims"][0]["evidence"][0]["quote"] == "Call it Tether."
    events = client.get("/api/semantic?kind=events").json()
    assert events["kind"] == "events"
    assert events["items"][0]["title"] == "Naming decision"
    queue = client.get("/api/semantic?kind=queue").json()
    assert queue["count"] == 4
    retry = next(item for item in queue["items"] if item["status"] == "retry")
    assert retry == {
        "packetId": "packet:retry-001",
        "status": "retry",
        "queueClass": "historical",
        "attempts": 2,
        "reviewAttempts": 0,
        "nextRetryAt": "2026-01-04T09:00:00Z",
        "updatedAt": "2026-01-02T09:05:00Z",
    }
    semantic_response = client.get("/api/semantic")
    assert "lastError" not in semantic_response.text
    assert "must stay private" not in semantic_response.text
    vectors = client.get("/api/semantic?kind=vectors").json()
    assert vectors["count"] == 2
    assert vectors["items"][0] == {
        "recordId": "claim:sample-001",
        "kind": "claim",
        "title": "Naming claim",
        "dimensions": 3,
        "providerId": "sample-embedding-provider",
        "model": "sample-embedding-model",
        "updatedAt": "2026-01-02T09:09:00Z",
    }
    assert '"vector":' not in semantic_response.text
    assert "c" * 64 not in semantic_response.text


def test_current_context_sources_and_integrity_are_inspectable(client):
    context = client.get("/api/context/current").json()
    assert context["source"] == "semantic"
    assert context["content_snapshot"] is True
    assert context["blocks"][0]["projectionId"] == "projection:sample-001"
    sources = client.get("/api/sources").json()
    assert sources["count"] == 2
    evidence = next(item for item in sources["items"] if item["kind"] == "evidence")
    assert evidence["quote_present"] is True
    assert client.get("/api/integrity").json()["healthy"] is True


def test_dangling_semantic_reference_is_reported_not_silently_ignored(client, memory_store):
    semantic = memory_store[3]
    projection = json.loads((semantic / "projections.jsonl").read_text().splitlines()[0])
    projection["projectionId"] = "projection:sample-broken"
    projection["supportClaimIds"] = ["claim:missing"]
    _jsonl(semantic / "projections.jsonl", projection)
    body = client.get("/api/integrity").json()
    assert body["healthy"] is False
    assert body["issues"]["missing_claim_references"] == ["claim:missing"]


def test_corrupt_jsonl_fails_closed_with_journal_and_line(client, memory_store):
    cards = memory_store[2]
    (cards / "cards.jsonl").write_text('{"type":"memory-card"}\n{bad\n', encoding="utf-8")
    response = client.get("/api/cards")
    assert response.status_code == 503
    assert response.json() == {
        "error": "memory_store_corrupt",
        "journal": "cards.jsonl",
        "line": 2,
        "detail": "invalid JSONL record",
    }


def test_human_patch_is_applied_before_semantic_records_are_displayed(client, memory_store):
    semantic = memory_store[3]
    _jsonl(
        semantic / "patches.jsonl",
        {
            "patchId": "patch:sample-001",
            "targetType": "claim",
            "targetId": "claim:sample-001",
            "operation": "invalidate",
            "createdAt": "2026-01-02T10:00:00Z",
        },
    )
    body = client.get("/api/semantic").json()
    assert body["claims"][0]["verificationStatus"] == "invalidated"
    assert body["events"][0]["status"] == "stale"
    assert body["projections"][0]["status"] == "stale"
    assert body["counts"]["patches"] == 1


def test_latest_human_card_override_is_displayed_without_mutating_source_journal(client, memory_store):
    cards = memory_store[2]
    original = (cards / "cards.jsonl").read_bytes()
    _jsonl(
        cards / "human-overrides.jsonl",
        {
            "type": "memory-card-override",
            "cardType": "day",
            "periodKey": "2026-01-02",
            "content": "A human-corrected day card.",
            "createdAt": "2026-01-04T10:00:00Z",
        },
    )
    item = client.get("/api/cards/day:2026-01-02").json()
    assert item["content"] == "A human-corrected day card."
    assert item["human_override"] is True
    assert (cards / "cards.jsonl").read_bytes() == original


def test_runtime_memory_card_schema_is_readable_from_memory_root_env(
    tmp_path, monkeypatch
):
    """Runtime and Console share the same local cards/cards.jsonl contract."""
    from tether_console.readers import list_cards, list_folds
    from tether_console.service import ConsoleService

    memory_root = tmp_path / "runtime-memory"
    fold_dir = memory_root / "folds"
    card_dir = memory_root / "cards"
    semantic_dir = memory_root / "semantic"
    fold_dir.mkdir(parents=True)
    card_dir.mkdir()
    semantic_dir.mkdir()
    runtime_card = {
        "type": "memory-card",
        "id": "memory-card:day:2026-02-03:v1:runtime-sample",
        "cardType": "day",
        "version": 1,
        "period": {"key": "2026-02-03"},
        "sourceIds": ["source:runtime-sample-001"],
        "content": "The runtime preserved one session across two local adapters.",
    }
    runtime_week_card = {
        "type": "memory-card",
        "id": "memory-card:week:2026-02-02:v1:runtime-sample",
        "cardType": "week",
        "version": 1,
        "period": {"key": "2026-02-02"},
        "sourceIds": [runtime_card["id"]],
        "content": "Journal week fallback.",
    }
    _jsonl(card_dir / "cards.jsonl", runtime_card, runtime_week_card)
    day_markdown = card_dir / "day-cards" / "2026" / "2026-02-03.md"
    day_markdown.parent.mkdir(parents=True)
    day_markdown.write_text(
        "# Day card\n\nThe canonical day-cards markdown wins.", encoding="utf-8"
    )
    week_markdown = card_dir / "week-cards" / "2026" / "2026-02-02--2026-02-08.md"
    week_markdown.parent.mkdir(parents=True)
    week_markdown.write_text(
        "# Week card\n\nThe canonical week-cards markdown wins.", encoding="utf-8"
    )
    (fold_dir / "2026-02-03.md").write_text(
        "# Fold log\n\n## 08:09:10（configured local time） · 折叠 4 轮\n\nGeneric timezone fold.\n\n---\n",
        encoding="utf-8",
    )
    original = (card_dir / "cards.jsonl").read_bytes()
    (semantic_dir / "manifest.json").write_text(
        json.dumps({"schemaVersion": 1, "mode": "cards"}), encoding="utf-8"
    )

    monkeypatch.setenv("TETHER_MEMORY_ROOT", str(memory_root))
    for name in ("TETHER_FOLD_DIR", "TETHER_CARD_DIR", "TETHER_SEMANTIC_DIR"):
        monkeypatch.delenv(name, raising=False)
    settings = ConsoleSettings.from_env()
    assert settings.card_dir == card_dir.resolve()

    records = list_cards(settings.card_dir)
    assert len(records) == 2
    day_record = next(item for item in records if item["layer"] == "day")
    week_record = next(item for item in records if item["layer"] == "week")
    assert day_record["card_id"] == runtime_card["id"]
    assert day_record["content"] == "The canonical day-cards markdown wins."
    assert day_record["source_ids"] == runtime_card["sourceIds"]
    assert week_record["content"] == "The canonical week-cards markdown wins."
    assert list_folds(settings.fold_dir)[0]["content"] == "Generic timezone fold."

    service_records = ConsoleService(settings).cards("day")
    assert service_records["count"] == 1
    assert service_records["items"][0]["period_key"] == "2026-02-03"

    with TestClient(create_app(settings)) as env_client:
        response = env_client.get("/api/cards?layer=day")
        assert response.status_code == 200
        assert response.json()["items"][0]["id"] == "day:2026-02-03"
        assert response.json()["items"][0]["content"] == "The canonical day-cards markdown wins."

    assert (card_dir / "cards.jsonl").read_bytes() == original
    assert not (card_dir / "human-overrides.jsonl").exists()
