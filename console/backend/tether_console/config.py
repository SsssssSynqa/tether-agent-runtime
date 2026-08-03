# SPDX-License-Identifier: Apache-2.0
"""Environment-backed paths for the standalone Tether Console."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


def _path(value: str | None, fallback: Path) -> Path:
    return Path(value).expanduser().resolve() if value else fallback.resolve()


@dataclass(frozen=True)
class ConsoleSettings:
    """Resolved local folders. Paths are never serialized by the API."""

    memory_root: Path
    fold_dir: Path
    card_dir: Path
    semantic_dir: Path
    static_dir: Path | None = None

    @classmethod
    def from_env(
        cls,
        env: Mapping[str, str] | None = None,
        *,
        cwd: Path | None = None,
    ) -> "ConsoleSettings":
        values = os.environ if env is None else env
        base = Path.cwd() if cwd is None else cwd
        root = _path(values.get("TETHER_MEMORY_ROOT"), base / "sample-data")
        static_value = values.get("TETHER_CONSOLE_STATIC_DIR")
        static_dir = _path(static_value, base / "frontend" / "dist") if static_value else None
        return cls(
            memory_root=root,
            fold_dir=_path(values.get("TETHER_FOLD_DIR"), root / "folds"),
            card_dir=_path(values.get("TETHER_CARD_DIR"), root / "cards"),
            semantic_dir=_path(values.get("TETHER_SEMANTIC_DIR"), root / "semantic"),
            static_dir=static_dir,
        )

    def aliases(self) -> dict[str, str]:
        """Stable public labels rather than host filesystem paths."""
        return {
            "memory_root": "$TETHER_MEMORY_ROOT",
            "folds": "$TETHER_FOLD_DIR",
            "cards": "$TETHER_CARD_DIR",
            "semantic": "$TETHER_SEMANTIC_DIR",
        }
