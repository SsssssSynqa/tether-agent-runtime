# SPDX-License-Identifier: Apache-2.0
"""Standalone Starlette API and optional static host for Tether Console."""

from __future__ import annotations

from pathlib import Path

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

from .config import ConsoleSettings
from .readers import StoreCorrupt
from .service import ConsoleService


def _service(request: Request) -> ConsoleService:
    return request.app.state.console_service


def _ok(payload: dict) -> JSONResponse:
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


async def api_status(request: Request) -> JSONResponse:
    return _ok(_service(request).status())


async def api_cards(request: Request) -> JSONResponse:
    try:
        return _ok(_service(request).cards(request.query_params.get("layer", "all")))
    except ValueError as exc:
        return JSONResponse({"error": "invalid_request", "detail": str(exc)}, status_code=400)


async def api_card(request: Request) -> JSONResponse:
    item = _service(request).card(request.path_params["item_id"])
    if item is None:
        return JSONResponse({"error": "not_found"}, status_code=404)
    return _ok(item)


async def api_semantic(request: Request) -> JSONResponse:
    try:
        return _ok(_service(request).semantic(request.query_params.get("kind", "all")))
    except ValueError as exc:
        return JSONResponse({"error": "invalid_request", "detail": str(exc)}, status_code=400)


async def api_context(request: Request) -> JSONResponse:
    return _ok(_service(request).context())


async def api_sources(request: Request) -> JSONResponse:
    return _ok(_service(request).sources())


async def api_integrity(request: Request) -> JSONResponse:
    return _ok(_service(request).integrity())


async def api_index(_request: Request) -> JSONResponse:
    return _ok(
        {
            "name": "Tether Console API",
            "read_only": True,
            "routes": [
                "/api/status", "/api/cards", "/api/cards/{item_id}",
                "/api/semantic", "/api/context/current", "/api/sources",
                "/api/integrity",
            ],
        }
    )


async def store_corrupt(_request: Request, exc: StoreCorrupt) -> JSONResponse:
    return JSONResponse(
        {
            "error": "memory_store_corrupt",
            "journal": exc.journal,
            "line": exc.line,
            "detail": exc.reason,
        },
        status_code=503,
    )


def create_app(settings: ConsoleSettings | None = None) -> Starlette:
    resolved = settings or ConsoleSettings.from_env()
    routes = [
        Route("/api", api_index),
        Route("/api/status", api_status),
        Route("/api/cards", api_cards),
        Route("/api/cards/{item_id:path}", api_card),
        Route("/api/semantic", api_semantic),
        Route("/api/context/current", api_context),
        Route("/api/sources", api_sources),
        Route("/api/integrity", api_integrity),
    ]
    static_dir: Path | None = resolved.static_dir
    if static_dir and static_dir.is_dir():
        routes.append(Mount("/", app=StaticFiles(directory=static_dir, html=True), name="console"))
    app = Starlette(
        debug=False,
        routes=routes,
        exception_handlers={StoreCorrupt: store_corrupt},
    )
    app.state.console_service = ConsoleService(resolved)
    return app


app = create_app()
