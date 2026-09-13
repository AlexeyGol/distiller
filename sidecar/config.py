"""Environment-driven configuration for the sidecar."""

from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    """Runtime configuration. Frozen so a request cannot mutate it."""

    auth_dir: str
    profile: str
    port: int
    timeout: float


def load_settings() -> Settings:
    return Settings(
        auth_dir=os.environ.get("NLM_AUTH_DIR", "/auth"),
        profile=os.environ.get("NLM_PROFILE", "default"),
        port=int(os.environ.get("PORT", "8000")),
        timeout=float(os.environ.get("NLM_TIMEOUT", "60")),
    )
