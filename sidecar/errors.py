"""Translation of upstream notebooklm-py failures into the REST error contract.

The Node side branches on these exact shapes, so every route funnels its
upstream call through :func:`upstream` and every failure is rendered by the
single :class:`SidecarError` handler.
"""

from __future__ import annotations

import contextlib
import datetime as dt
import logging
from typing import Any, Final, Iterator

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

QUOTA_EXHAUSTED: Final = "quota_exhausted"
AUTH_FAILED: Final = "auth_failed"
NOT_FOUND: Final = "not_found"
UPSTREAM_UNAVAILABLE: Final = "upstream_unavailable"
INTERNAL_ERROR: Final = "internal_error"
PENDING: Final = "pending"


class SidecarError(Exception):
    """A failure already mapped onto the documented HTTP contract."""

    def __init__(
        self,
        status_code: int,
        error: str,
        detail: str,
        retry_after: str | None = None,
    ) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.error = error
        self.detail = detail
        self.retry_after = retry_after


# WHY match on class NAME across the MRO instead of importing the classes:
# notebooklm-py is an unofficial, optional dependency that breaks without
# warning. Importing its exception types at module load would make this
# adapter - and its tests - unusable whenever the library is missing or has
# reshuffled its exception module.
_EXCEPTION_NAMES: Final[dict[str, tuple[int, str]]] = {
    # Audio not finished yet is a normal state, not a failure.
    "ArtifactNotReadyError": (202, PENDING),
    "ArtifactInProgressTimeoutError": (202, PENDING),
    "ArtifactPendingTimeoutError": (202, PENDING),
    # Quota / rate limiting.
    "RateLimitError": (429, QUOTA_EXHAUSTED),
    "NotebookLimitError": (429, QUOTA_EXHAUSTED),
    # Authentication.
    "AuthError": (401, AUTH_FAILED),
    "AuthExtractionError": (401, AUTH_FAILED),
    # Missing resources.
    "NotFoundError": (404, NOT_FOUND),
    "NotebookNotFoundError": (404, NOT_FOUND),
    "SourceNotFoundError": (404, NOT_FOUND),
    "ArtifactNotFoundError": (404, NOT_FOUND),
    "CollectionNotFoundError": (404, NOT_FOUND),
    "MindMapNotFoundError": (404, NOT_FOUND),
    "NoteNotFoundError": (404, NOT_FOUND),
    "LabelNotFoundError": (404, NOT_FOUND),
    # Upstream unreachable, 5xx, or timed out.
    "NetworkError": (502, UPSTREAM_UNAVAILABLE),
    "ServerError": (502, UPSTREAM_UNAVAILABLE),
    "RPCTimeoutError": (502, UPSTREAM_UNAVAILABLE),
    "RPCError": (502, UPSTREAM_UNAVAILABLE),
    "WaitTimeoutError": (502, UPSTREAM_UNAVAILABLE),
    "NotebookLMError": (502, UPSTREAM_UNAVAILABLE),
    # httpx / stdlib transport failures that can surface untranslated.
    "ConnectError": (502, UPSTREAM_UNAVAILABLE),
    "ConnectTimeout": (502, UPSTREAM_UNAVAILABLE),
    "ReadTimeout": (502, UPSTREAM_UNAVAILABLE),
    "WriteTimeout": (502, UPSTREAM_UNAVAILABLE),
    "PoolTimeout": (502, UPSTREAM_UNAVAILABLE),
    "TimeoutException": (502, UPSTREAM_UNAVAILABLE),
    "TransportError": (502, UPSTREAM_UNAVAILABLE),
    "HTTPError": (502, UPSTREAM_UNAVAILABLE),
    "ConnectionError": (502, UPSTREAM_UNAVAILABLE),
    "TimeoutError": (502, UPSTREAM_UNAVAILABLE),
}


def _retry_after_iso(exc: BaseException) -> str | None:
    """Normalise the library's `retry_after` (seconds) to an ISO-8601 instant."""
    raw: Any = getattr(exc, "retry_after", None)
    if raw is None:
        return None
    if isinstance(raw, dt.datetime):
        return raw.isoformat()
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        return (dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=float(raw))).isoformat()
    text = str(raw).strip()
    return text or None


def classify(exc: BaseException) -> SidecarError:
    """Map any upstream exception onto the documented contract."""
    if isinstance(exc, SidecarError):
        return exc
    for klass in type(exc).__mro__:
        hit = _EXCEPTION_NAMES.get(klass.__name__)
        if hit is not None:
            status_code, error = hit
            return SidecarError(status_code, error, str(exc), _retry_after_iso(exc))
    return SidecarError(500, INTERNAL_ERROR, str(exc))


@contextlib.contextmanager
def upstream() -> Iterator[None]:
    """Wrap a notebooklm-py call so its failure leaves as a SidecarError."""
    try:
        yield
    except SidecarError:
        raise
    except BaseException as exc:  # noqa: BLE001 - deliberate catch-all boundary
        mapped = classify(exc)
        logger.warning(
            "upstream call failed",
            extra={
                "extra_fields": {
                    "error": mapped.error,
                    "status_code": mapped.status_code,
                    "exception": type(exc).__name__,
                }
            },
        )
        raise mapped from exc


def render(error: SidecarError) -> JSONResponse:
    # WHY 202 is special-cased: "audio not ready" is a normal poll result and
    # must not carry an `error` key the caller would treat as a failure.
    if error.status_code == 202:
        return JSONResponse(status_code=202, content={"status": PENDING})
    body: dict[str, Any] = {"error": error.error, "detail": error.detail}
    if error.error == QUOTA_EXHAUSTED:
        body["retry_after"] = error.retry_after
    return JSONResponse(status_code=error.status_code, content=body)


def install_handlers(app: FastAPI) -> None:
    @app.exception_handler(SidecarError)
    async def _handle(_: Request, exc: SidecarError) -> JSONResponse:
        return render(exc)
