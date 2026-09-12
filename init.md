# Distiller: Implementation Plan & Initialization Guide

## Architecture Overview
Distiller is a self-hosted web application that monitors RSS feeds and YouTube channels, filters them by keywords, and automatically generates summaries and audio podcasts using Google's NotebookLM.

It uses a 3-tier architecture deployed via Docker Compose:
1. **Next.js Frontend/Worker (`/app`)**: Manages the UI, PostgreSQL database (via Drizzle ORM), and background jobs (via pg-boss) for fetching RSS feeds.
2. **Python FastAPI Sidecar (`/sidecar`)**: Provides a stable REST API wrapper around `notebooklm-py` for interacting with NotebookLM.
3. **PostgreSQL**: Stores feeds, items, digests, and background job queues.

## Directory Structure
We use a polyglot monorepo structure. This is the industry standard for projects combining Node.js and Python, as it cleanly separates dependencies, linting rules, and Docker build contexts.

```text
/home/alexey/Documents/distiller/
├── app/                  # Next.js 15, React, Tailwind, Drizzle ORM
│   ├── package.json      # Uses pnpm
│   ├── src/
│   └── Dockerfile
├── sidecar/              # Python FastAPI, notebooklm-py
│   ├── requirements.txt
│   ├── main.py
│   └── Dockerfile
├── docker-compose.yml    # Orchestrates app, sidecar, and db
└── init.md               # This file
```

## NotebookLM Master Token Instructions
To run the NotebookLM sidecar without a browser and ensure the session auto-renews, you need a Master Token.

**Do this on your local machine (not the server) once:**
1. Create a temporary Python virtual environment:
   ```bash
   python3 -m venv nlm-env
   source nlm-env/bin/activate
   ```
2. Install the library with Android transport support:
   ```bash
   pip install "notebooklm-py[android]"
   ```
3. Login and generate the Master Token:
   ```bash
   notebooklm login --master-token --account your-google-email@gmail.com
   ```
   *Follow the on-screen prompts to authenticate.*
4. The token is saved to `~/.notebooklm/profiles/default/master_token.json`. 
5. Copy this file into the Distiller project directory later when we configure the Docker volumes (e.g., to `/home/alexey/Documents/distiller/nlm_auth/profiles/default/master_token.json`).

## Proposed Implementation Steps

### Phase 1: Initialization & Database
1. Initialize Next.js project in `/app` using `pnpm`.
2. Setup Drizzle ORM and PostgreSQL schema (Feeds, Keywords, Items, Digests).
3. Setup `pg-boss` for background job processing.

### Phase 2: Python Sidecar
1. Create `/sidecar` directory.
2. Write a FastAPI wrapper exposing endpoints for:
   - `POST /notebooks` (Create notebook)
   - `POST /notebooks/{id}/sources` (Add URL)
   - `POST /notebooks/{id}/ask` (Generate summary)
   - `POST /notebooks/{id}/audio` (Start podcast generation)
   - `GET /notebooks/{id}/audio` (Download MP3)

### Phase 3: Next.js Backend Logic
1. Implement RSS and YouTube feed parsing logic (using `rss-parser`).
2. Implement keyword filtering.
3. Write pg-boss job handlers to orchestrate the API calls to the Python sidecar.

### Phase 4: Frontend UI (English)
1. Dashboard with stats.
2. Feed & Keyword management pages.
3. Digests page displaying generated text summaries.
4. Persistent Global Audio Player for listening to the podcasts.

### Phase 5: Dockerization
1. Write `Dockerfile` for the Next.js app.
2. Write `Dockerfile` for the Python sidecar.
3. Write `docker-compose.yml` to tie everything together.
