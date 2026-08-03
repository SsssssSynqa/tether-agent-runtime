# SPDX-License-Identifier: Apache-2.0
"""Service boundary for the public Tether local-folder console."""

from __future__ import annotations

from .config import ConsoleSettings
from .readers import (
    current_context,
    integrity,
    list_cards,
    list_folds,
    semantic_public,
    semantic_state,
)


class ConsoleService:
    def __init__(self, settings: ConsoleSettings):
        self.settings = settings

    def status(self) -> dict:
        cards = list_cards(self.settings.card_dir)
        folds = list_folds(self.settings.fold_dir)
        semantic = semantic_public(semantic_state(self.settings.semantic_dir))
        health = integrity(self.settings.card_dir, self.settings.semantic_dir)
        return {
            "name": "Tether Console",
            "read_only": True,
            "storage": "local-folders",
            "configured": {
                key: {"alias": alias, "exists": path.exists()}
                for (key, alias), path in zip(
                    self.settings.aliases().items(),
                    (
                        self.settings.memory_root,
                        self.settings.fold_dir,
                        self.settings.card_dir,
                        self.settings.semantic_dir,
                    ),
                    strict=True,
                )
            },
            "counts": {
                "folds": len(folds),
                "day_cards": sum(item["layer"] == "day" for item in cards),
                "week_cards": sum(item["layer"] == "week" for item in cards),
                **semantic["counts"],
            },
            "integrity": {
                "healthy": health["healthy"],
                "issue_count": health["issue_count"],
            },
        }

    def cards(self, layer: str = "all") -> dict:
        if layer not in {"all", "day", "week", "fold"}:
            raise ValueError("layer must be all, day, week, or fold")
        cards = list_cards(self.settings.card_dir)
        items = [*cards, *list_folds(self.settings.fold_dir)]
        if layer != "all":
            items = [item for item in items if item["layer"] == layer]
        return {"layer": layer, "count": len(items), "items": items}

    def card(self, item_id: str) -> dict | None:
        return next(
            (item for item in self.cards()["items"] if item.get("id") == item_id),
            None,
        )

    def semantic(self, kind: str = "all") -> dict:
        if kind not in {"all", "claims", "events", "projections", "reviews", "queue"}:
            raise ValueError("kind must be all, claims, events, projections, reviews, or queue")
        payload = semantic_public(semantic_state(self.settings.semantic_dir))
        if kind == "all":
            return payload
        return {
            "mode": payload["mode"],
            "schema_version": payload["schema_version"],
            "kind": kind,
            "count": len(payload[kind]),
            "items": payload[kind],
        }

    def context(self) -> dict:
        return current_context(self.settings.card_dir, self.settings.semantic_dir)

    def integrity(self) -> dict:
        return integrity(self.settings.card_dir, self.settings.semantic_dir)

    def sources(self) -> dict:
        cards = list_cards(self.settings.card_dir)
        state = semantic_state(self.settings.semantic_dir)
        sources: dict[str, dict] = {}
        for card in cards:
            for source_id in card["source_ids"]:
                item = sources.setdefault(source_id, {"id": source_id, "kind": "card-source", "references": []})
                item["references"].append(card["id"])
        for claim in state["claims"].values():
            for evidence in claim.get("evidence") or []:
                if not isinstance(evidence, dict):
                    continue
                source_id = str(evidence.get("messageId") or evidence.get("sourceId") or "")
                if not source_id:
                    continue
                item = sources.setdefault(source_id, {"id": source_id, "kind": "evidence", "references": []})
                item["kind"] = "evidence"
                item["references"].append(str(claim.get("claimId")))
                item["quote_present"] = bool(str(evidence.get("quote") or "").strip())
                item["text_sha256_present"] = bool(evidence.get("textSha256"))
        items = sorted(sources.values(), key=lambda item: item["id"])
        return {"count": len(items), "items": items}
