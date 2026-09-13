"""Construction and injection of the notebooklm-py client.

The client is held in module state and handed out through a FastAPI
dependency so tests can substitute a fake without touching the network or
needing a real master token.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional, Protocol, runtime_checkable

from fastapi import Depends

from config import Settings
from errors import UPSTREAM_UNAVAILABLE, SidecarError

logger = logging.getLogger(__name__)


@runtime_checkable
class NotebookLMLike(Protocol):
    """The slice of notebooklm-py this adapter actually uses."""

    notebooks: Any
    sources: Any
    chat: Any
    artifacts: Any


_client: Optional[NotebookLMLike] = None
_context: Any = None
_unavailable_reason: str = "client not initialised"


async def open_client(settings: Settings) -> None:
    """Build and enter the upstream client, recording failure instead of raising.

    WHY failures are swallowed: /health is what the Docker healthcheck hits and
    it must answer even when the master token is missing or expired.
    """
    global _client, _context, _unavailable_reason

    # notebooklm-py resolves its auth tree from these two variables, which puts
    # the master token at <auth_dir>/profiles/<profile>/master_token.json.
    os.environ["NOTEBOOKLM_HOME"] = settings.auth_dir
    os.environ["NOTEBOOKLM_PROFILE"] = settings.profile

    try:
        # WHY a deferred import: the library is unofficial and optional, so an
        # install problem must degrade /health rather than kill the process.
        from notebooklm import NotebookLMClient
    except Exception as exc:  # noqa: BLE001
        _unavailable_reason = f"notebooklm-py import failed: {exc}"
        logger.error("notebooklm-py unavailable", extra={"extra_fields": {"reason": _unavailable_reason}})
        return

    try:
        context = NotebookLMClient.from_storage(profile=settings.profile, timeout=settings.timeout)
        _client = await context.__aenter__()
        _context = context
        _unavailable_reason = ""
        logger.info("notebooklm client ready", extra={"extra_fields": {"profile": settings.profile}})
    except Exception as exc:  # noqa: BLE001
        _unavailable_reason = f"{type(exc).__name__}: {exc}"
        logger.error("notebooklm client construction failed", extra={"extra_fields": {"reason": _unavailable_reason}})


async def close_client() -> None:
    global _client, _context, _unavailable_reason
    if _context is not None:
        try:
            await _context.__aexit__(None, None, None)
        except Exception as exc:  # noqa: BLE001
            logger.warning("client shutdown failed", extra={"extra_fields": {"reason": str(exc)}})
    _client = None
    _context = None
    _unavailable_reason = "client closed"


def get_optional_client() -> Optional[NotebookLMLike]:
    """The single injection seam. Tests override exactly this dependency."""
    return _client


def unavailable_reason() -> str:
    return _unavailable_reason


def get_client(
    client: Optional[NotebookLMLike] = Depends(get_optional_client),
) -> NotebookLMLike:
    """Require a usable client, or fail with the documented 502 shape."""
    if client is None:
        raise SidecarError(502, UPSTREAM_UNAVAILABLE, unavailable_reason() or "notebooklm client unavailable")
    return client
