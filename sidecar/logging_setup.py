"""Structured JSON logging with a per-request correlation id."""

from __future__ import annotations

import contextvars
import datetime as dt
import json
import logging
import sys
from typing import Any

# WHY a ContextVar: the correlation id has to reach log records emitted deep
# inside route handlers without being threaded through every function call.
request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="-")


class JsonFormatter(logging.Formatter):
    """Emit one JSON object per line so the Node side can parse the stream."""

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": dt.datetime.now(dt.timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": request_id_var.get(),
        }
        extra = getattr(record, "extra_fields", None)
        if isinstance(extra, dict):
            payload.update(extra)
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    # WHY replace rather than append: uvicorn installs its own plain-text
    # handlers, which would double every line in a non-JSON shape.
    root.handlers[:] = [handler]
    root.setLevel(level)
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        noisy = logging.getLogger(name)
        noisy.handlers[:] = []
        noisy.propagate = True
