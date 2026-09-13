"""API contract tests.

Every test injects a fake notebooklm client through the single
`get_optional_client` dependency, so nothing here touches the network or needs
a master token. The TestClient is deliberately NOT used as a context manager:
that skips the lifespan, which is what would otherwise try to build a real
client.
"""

from __future__ import annotations

from types import SimpleNamespace

from dataclasses import dataclass, field
from typing import Any, Callable, Iterator

import pytest
from fastapi.testclient import TestClient

import main
from nlm_client import get_optional_client


# --------------------------------------------------------------------------
# Fakes. These mimic only the shapes the adapter actually reads.
# --------------------------------------------------------------------------
@dataclass
class FakeNotebook:
    id: str


@dataclass
class FakeSource:
    id: str


@dataclass
class FakeAskResult:
    answer: str


@dataclass
class FakeGeneration:
    task_id: str
    status: str


@dataclass
class FakeArtifact:
    id: str
    status: str


# WHY these names matter: errors.classify() matches upstream failures by class
# name across the MRO, so a stand-in must be named exactly like the real class.
class RateLimitError(Exception):
    def __init__(self, message: str, retry_after: int | None = None) -> None:
        super().__init__(message)
        self.retry_after = retry_after


class AuthError(Exception):
    pass


class NotebookNotFoundError(Exception):
    pass


class RPCTimeoutError(Exception):
    pass


class ArtifactNotReadyError(Exception):
    pass


@dataclass
class FakeNotebooks:
    created: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    create_error: Exception | None = None
    delete_error: Exception | None = None

    async def create(self, title: str) -> FakeNotebook:
        if self.create_error:
            raise self.create_error
        self.created.append(title)
        return FakeNotebook(id="nb-123")

    async def delete(self, notebook_id: str) -> None:
        if self.delete_error:
            raise self.delete_error
        self.deleted.append(notebook_id)


@dataclass
class FakeSources:
    added: list[tuple[str, str]] = field(default_factory=list)
    error: Exception | None = None

    async def add_url(self, notebook_id: str, url: str) -> FakeSource:
        if self.error:
            raise self.error
        self.added.append((notebook_id, url))
        return FakeSource(id="src-%d" % (len(self.added),))


@dataclass
class FakeChat:
    answer: str = "Because the feed said so."
    error: Exception | None = None

    async def ask(self, notebook_id: str, question: str) -> FakeAskResult:
        if self.error:
            raise self.error
        return FakeAskResult(answer=self.answer)


@dataclass
class FakeArtifacts:
    audio_artifacts: list[FakeArtifact] = field(default_factory=list)
    audio_bytes: bytes = b"ID3fake-mp3-bytes"
    generate_error: Exception | None = None
    list_error: Exception | None = None
    generate_status: str = "pending"

    async def generate_audio(
        self, notebook_id: str, instructions: str | None = None
    ) -> FakeGeneration:
        if self.generate_error:
            raise self.generate_error
        return FakeGeneration(task_id="task-1", status=self.generate_status)

    async def list_audio(self, notebook_id: str) -> list[FakeArtifact]:
        if self.list_error:
            raise self.list_error
        return list(self.audio_artifacts)

    async def download_audio(
        self, notebook_id: str, output_path: str, artifact_id: str | None = None
    ) -> str:
        with open(output_path, "wb") as handle:
            handle.write(self.audio_bytes)
        return output_path


@dataclass
class FakeClient:
    notebooks: FakeNotebooks = field(default_factory=FakeNotebooks)
    sources: FakeSources = field(default_factory=FakeSources)
    chat: FakeChat = field(default_factory=FakeChat)
    artifacts: FakeArtifacts = field(default_factory=FakeArtifacts)


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------
@pytest.fixture
def fake() -> FakeClient:
    return FakeClient()


@pytest.fixture
def inject() -> Iterator[Callable[[Any], TestClient]]:
    """Return a factory that overrides the client dependency with any object."""

    def _inject(client_obj: Any) -> TestClient:
        main.app.dependency_overrides[get_optional_client] = lambda: client_obj
        return TestClient(main.app)

    yield _inject
    main.app.dependency_overrides.clear()


@pytest.fixture
def client(fake: FakeClient, inject: Callable[[Any], TestClient]) -> TestClient:
    return inject(fake)


# --------------------------------------------------------------------------
# /health
# --------------------------------------------------------------------------
def test_health_with_usable_client(client: TestClient) -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "notebooklm_available": True}


def test_health_without_usable_client(inject: Callable[[Any], TestClient]) -> None:
    response = inject(None).get("/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok", "notebooklm_available": False}


# --------------------------------------------------------------------------
# Happy paths
# --------------------------------------------------------------------------
def test_create_notebook(client: TestClient, fake: FakeClient) -> None:
    response = client.post("/notebooks", json={"title": "Weekly digest"})
    assert response.status_code == 201
    assert response.json() == {"notebook_id": "nb-123"}
    assert fake.notebooks.created == ["Weekly digest"]


def test_add_sources(client: TestClient, fake: FakeClient) -> None:
    urls = ["https://example.com/a", "https://example.com/b"]
    response = client.post("/notebooks/nb-123/sources", json={"urls": urls})
    assert response.status_code == 200
    assert response.json() == {
        "added": 2,
        "source_ids": ["src-1", "src-2"],
        "failed": [],
    }
    assert fake.sources.added == [("nb-123", urls[0]), ("nb-123", urls[1])]


def test_ask(client: TestClient) -> None:
    response = client.post("/notebooks/nb-123/ask", json={"question": "What changed?"})
    assert response.status_code == 200
    assert response.json() == {"answer": "Because the feed said so."}


def test_delete_notebook(client: TestClient, fake: FakeClient) -> None:
    response = client.delete("/notebooks/nb-123")
    assert response.status_code == 200
    assert response.json()["deleted"] is True
    assert fake.notebooks.deleted == ["nb-123"]


# --------------------------------------------------------------------------
# Audio lifecycle
# --------------------------------------------------------------------------
def test_start_audio_returns_pending(client: TestClient) -> None:
    response = client.post(
        "/notebooks/nb-123/audio", json={"instructions": "Keep it short"}
    )
    assert response.status_code == 200
    assert response.json()["status"] == "pending"


def test_start_audio_accepts_empty_body(client: TestClient) -> None:
    response = client.post("/notebooks/nb-123/audio")
    assert response.status_code == 200
    assert response.json()["status"] == "pending"


def test_start_audio_reports_ready_when_already_complete(
    client: TestClient, fake: FakeClient
) -> None:
    fake.artifacts.generate_status = "completed"
    response = client.post("/notebooks/nb-123/audio", json={})
    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_audio_poll_then_download(client: TestClient, fake: FakeClient) -> None:
    # First poll: generation still running.
    fake.artifacts.audio_artifacts = [FakeArtifact(id="art-1", status="in_progress")]
    first = client.get("/notebooks/nb-123/audio")
    assert first.status_code == 202
    assert first.json() == {"status": "pending"}

    # Second poll: artifact completed, mp3 bytes stream back.
    fake.artifacts.audio_artifacts = [FakeArtifact(id="art-1", status="completed")]
    second = client.get("/notebooks/nb-123/audio")
    assert second.status_code == 200
    assert second.headers["content-type"] == "audio/mpeg"
    assert second.content == b"ID3fake-mp3-bytes"


def test_audio_not_ready_exception_maps_to_202(
    client: TestClient, fake: FakeClient
) -> None:
    fake.artifacts.list_error = ArtifactNotReadyError("still cooking")
    response = client.get("/notebooks/nb-123/audio")
    assert response.status_code == 202
    assert response.json() == {"status": "pending"}


# --------------------------------------------------------------------------
# Error contract
# --------------------------------------------------------------------------
def test_quota_exhausted_maps_to_429(client: TestClient, fake: FakeClient) -> None:
    fake.artifacts.generate_error = RateLimitError(
        "20 audio overviews/day", retry_after=3600
    )
    response = client.post("/notebooks/nb-123/audio", json={"instructions": None})
    assert response.status_code == 429
    body = response.json()
    assert body["error"] == "quota_exhausted"
    assert body["detail"] == "20 audio overviews/day"
    # retry_after is normalised from seconds to an ISO-8601 instant.
    assert body["retry_after"] is not None and "T" in body["retry_after"]


def test_quota_without_retry_after_is_null(
    client: TestClient, fake: FakeClient
) -> None:
    fake.artifacts.generate_error = RateLimitError("quota gone")
    response = client.post("/notebooks/nb-123/audio", json={})
    assert response.status_code == 429
    assert response.json()["retry_after"] is None


def test_auth_error_maps_to_401(client: TestClient, fake: FakeClient) -> None:
    fake.notebooks.create_error = AuthError("master token expired")
    response = client.post("/notebooks", json={"title": "x"})
    assert response.status_code == 401
    assert response.json() == {"error": "auth_failed", "detail": "master token expired"}


def test_unknown_notebook_maps_to_404(client: TestClient, fake: FakeClient) -> None:
    fake.chat.error = NotebookNotFoundError("no such notebook")
    response = client.post("/notebooks/missing/ask", json={"question": "hi"})
    assert response.status_code == 404
    assert response.json() == {"error": "not_found", "detail": "no such notebook"}


def test_add_sources_tolerates_one_bad_url(client, fake):
    """One unfetchable link must not destroy the whole digest.

    Real feeds carry URLs NotebookLM cannot ingest - paywalled, fetcher-blocked,
    404 by render time. Failing the batch threw away every good source for one
    bad one, and with thirty items at least one bad link is near certain.
    """
    good, bad = "https://ok.example/a", "https://bad.example/b"

    async def add_url(_notebook_id, url):
        if url == bad:
            raise RuntimeError("Failed to add source: inaccessible")
        return SimpleNamespace(id="src-good")

    fake.sources.add_url = add_url

    response = client.post(
        "/notebooks/nb1/sources", json={"urls": [good, bad]}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["added"] == 1
    assert body["source_ids"] == ["src-good"]
    assert len(body["failed"]) == 1
    assert body["failed"][0]["url"] == bad


def test_add_sources_fails_only_when_nothing_lands(client, fake):
    """A notebook with no sources would summarise nothing, so that IS an error."""

    async def add_url(_notebook_id, _url):
        raise RuntimeError("Failed to add source: inaccessible")

    fake.sources.add_url = add_url

    response = client.post("/notebooks/nb1/sources", json={"urls": ["https://x/1"]})

    assert response.status_code == 502
    assert response.json()["error"] == "upstream_unavailable"


def test_upstream_timeout_maps_to_502(client: TestClient, fake: FakeClient) -> None:
    fake.sources.error = RPCTimeoutError("read timed out")
    response = client.post(
        "/notebooks/nb-123/sources", json={"urls": ["https://example.com"]}
    )
    assert response.status_code == 502
    assert response.json()["error"] == "upstream_unavailable"


def test_connection_error_maps_to_502(client: TestClient, fake: FakeClient) -> None:
    fake.notebooks.create_error = ConnectionError("connection refused")
    response = client.post("/notebooks", json={"title": "x"})
    assert response.status_code == 502
    assert response.json()["error"] == "upstream_unavailable"


def test_missing_client_maps_to_502(inject: Callable[[Any], TestClient]) -> None:
    response = inject(None).post("/notebooks", json={"title": "x"})
    assert response.status_code == 502
    assert response.json()["error"] == "upstream_unavailable"


# --------------------------------------------------------------------------
# Correlation id
# --------------------------------------------------------------------------
def test_request_id_is_echoed(client: TestClient) -> None:
    response = client.get("/health", headers={"X-Request-Id": "corr-42"})
    assert response.headers["X-Request-Id"] == "corr-42"


def test_request_id_generated_when_absent(client: TestClient) -> None:
    response = client.get("/health")
    assert response.headers.get("X-Request-Id")


def test_request_id_echoed_on_error_response(
    client: TestClient, fake: FakeClient
) -> None:
    fake.notebooks.create_error = AuthError("nope")
    response = client.post(
        "/notebooks", json={"title": "x"}, headers={"X-Request-Id": "corr-err"}
    )
    assert response.status_code == 401
    assert response.headers["X-Request-Id"] == "corr-err"


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    "path,payload",
    [
        ("/notebooks", {}),
        ("/notebooks", {"title": ""}),
        ("/notebooks/nb-123/sources", {}),
        ("/notebooks/nb-123/sources", {"urls": []}),
        ("/notebooks/nb-123/ask", {}),
        ("/notebooks/nb-123/ask", {"question": ""}),
    ],
)
def test_validation_errors(
    client: TestClient, path: str, payload: dict[str, Any]
) -> None:
    response = client.post(path, json=payload)
    assert response.status_code == 422
