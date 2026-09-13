"""Distiller sidecar: a thin REST adapter over notebooklm-py.

This service contains NO business logic. It does not decide what to render,
when to render it, or what to filter - it only translates REST calls into
notebooklm-py calls and upstream failures into the documented error contract.
"""

from __future__ import annotations

import logging
import os
import tempfile
import uuid
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, Request, Response
from fastapi.responses import JSONResponse

import errors
from config import Settings, load_settings
from errors import install_handlers, upstream
from logging_setup import configure_logging, request_id_var
from nlm_client import (
    NotebookLMLike,
    close_client,
    get_client,
    get_optional_client,
    open_client,
)
from schemas import AddSourcesRequest, AskRequest, AudioRequest, CreateNotebookRequest

REQUEST_ID_HEADER = "X-Request-Id"

# States that mean "the artifact is finished and downloadable". Compared by
# name so an upstream enum rename degrades to "pending" rather than crashing.
_READY_STATES = frozenset({"completed", "ready", "success", "succeeded", "done"})

logger = logging.getLogger("distiller.sidecar")
settings: Settings = load_settings()


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    configure_logging(os.environ.get("LOG_LEVEL", "INFO"))
    await open_client(settings)
    try:
        yield
    finally:
        await close_client()


app = FastAPI(title="Distiller NotebookLM sidecar", version="1.0.0", lifespan=lifespan)
install_handlers(app)


@app.middleware("http")
async def request_id_middleware(request: Request, call_next: Any) -> Response:
    """Echo the Node side's correlation id and bind it to every log record."""
    request_id = request.headers.get(REQUEST_ID_HEADER) or str(uuid.uuid4())
    token = request_id_var.set(request_id)
    try:
        response = await call_next(request)
    finally:
        request_id_var.reset(token)
    response.headers[REQUEST_ID_HEADER] = request_id
    return response


def _state_name(status: Any) -> str:
    """Normalise an enum / string / object status to a bare lowercase name."""
    value = getattr(status, "value", status)
    return str(value).strip().lower().rsplit(".", 1)[-1]


def _is_ready(status: Any) -> bool:
    return _state_name(status) in _READY_STATES


@app.get("/health")
async def health(client: NotebookLMLike | None = Depends(get_optional_client)) -> dict[str, Any]:
    """Docker healthcheck target. Never requires a working token."""
    return {"status": "ok", "notebooklm_available": client is not None}


@app.post("/notebooks", status_code=201)
async def create_notebook(
    body: CreateNotebookRequest,
    client: NotebookLMLike = Depends(get_client),
) -> dict[str, Any]:
    with upstream():
        notebook = await client.notebooks.create(body.title)
    return {"notebook_id": notebook.id}


@app.post("/notebooks/{notebook_id}/sources")
async def add_sources(
    notebook_id: str,
    body: AddSourcesRequest,
    client: NotebookLMLike = Depends(get_client),
) -> dict[str, Any]:
    source_ids: list[str] = []
    # WHY a loop: notebooklm-py exposes URL ingestion one source at a time.
    with upstream():
        for url in body.urls:
            source = await client.sources.add_url(notebook_id, url)
            source_ids.append(source.id)
    return {"added": len(source_ids), "source_ids": source_ids}


@app.post("/notebooks/{notebook_id}/ask")
async def ask(
    notebook_id: str,
    body: AskRequest,
    client: NotebookLMLike = Depends(get_client),
) -> dict[str, Any]:
    with upstream():
        result = await client.chat.ask(notebook_id, body.question)
    return {"answer": result.answer}


@app.post("/notebooks/{notebook_id}/audio")
async def start_audio(
    notebook_id: str,
    client: NotebookLMLike = Depends(get_client),
    body: AudioRequest | None = None,
) -> dict[str, Any]:
    instructions = body.instructions if body is not None else None
    with upstream():
        generation = await client.artifacts.generate_audio(
            notebook_id, instructions=instructions
        )
    status = "ready" if _is_ready(getattr(generation, "status", None)) else "pending"
    return {"status": status, "task_id": getattr(generation, "task_id", None)}


@app.get("/notebooks/{notebook_id}/audio")
async def get_audio(
    notebook_id: str,
    client: NotebookLMLike = Depends(get_client),
) -> Response:
    with upstream():
        artifacts = await client.artifacts.list_audio(notebook_id)

    ready = [artifact for artifact in artifacts if _is_ready(getattr(artifact, "status", None))]
    if not ready:
        return JSONResponse(status_code=202, content={"status": errors.PENDING})

    # WHY the last one: notebooklm-py returns audio overviews oldest-first, and
    # the caller polls for the generation it just started.
    artifact = ready[-1]

    # WHY a temp file: the library only offers a download-to-path API.
    with tempfile.TemporaryDirectory() as tmpdir:
        destination = os.path.join(tmpdir, "audio.mp3")
        with upstream():
            await client.artifacts.download_audio(
                notebook_id, destination, artifact_id=getattr(artifact, "id", None)
            )
        with open(destination, "rb") as handle:
            payload = handle.read()

    return Response(content=payload, media_type="audio/mpeg")


@app.delete("/notebooks/{notebook_id}")
async def delete_notebook(
    notebook_id: str,
    client: NotebookLMLike = Depends(get_client),
) -> dict[str, Any]:
    with upstream():
        await client.notebooks.delete(notebook_id)
    return {"deleted": True, "notebook_id": notebook_id}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=settings.port)
