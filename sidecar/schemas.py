"""Request bodies. Field constraints give the documented 422 for free."""

from __future__ import annotations

from pydantic import BaseModel, Field


class CreateNotebookRequest(BaseModel):
    title: str = Field(min_length=1)


class AddSourcesRequest(BaseModel):
    urls: list[str] = Field(min_length=1)


class AskRequest(BaseModel):
    question: str = Field(min_length=1)


class AudioRequest(BaseModel):
    # Optional body: the caller may POST `{}` to accept NotebookLM's defaults.
    instructions: str | None = None
