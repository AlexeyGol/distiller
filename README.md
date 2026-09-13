# Distiller

Self-hosted digest builder. Polls RSS feeds and YouTube channels/searches,
filters items by keyword into **topics**, and renders each topic into a text
summary and an audio podcast via NotebookLM (Gemini Notebook).

One topic is one podcast feed.

```
Source plugin -> normalize -> dedup -> keyword filter -> DRAFT digest
                                              |
                               curation gate (auto | manual)
                                              v
                          Renderer plugin -> artifacts -> Sink plugins
```

## What makes it extensible

Three plugin seams, each self-describing via a Zod schema so the UI renders
config forms without knowing any concrete plugin. Adding a plugin type means
adding one file and listing it in its directory index - no UI changes.

| Seam | Built in | Directory |
| --- | --- | --- |
| Source | `rss`, `reddit`, `hackernews`, `youtube-channel`, `youtube-search` | `app/src/core/sources/` |
| Renderer | `llm-text`, `notebooklm-text`, `notebooklm` | `app/src/renderers/` |
| Sink | `telegram` | `app/src/sinks/` |

The `rss` source covers far more than its name suggests. TLDR
(`tldr.tech/api/rss/{tech,ai,devops}`), Lobsters, Mastodon hashtags, GitHub
releases, Google News queries and arXiv are all plain feeds - paste the URL, no
plugin required. See [TODO.md](./TODO.md) for the verified list.

Renderers are ordered cheapest-first. `notebooklm-text` exists because an audio
overview costs one of 20 per day and takes minutes, while asking NotebookLM a
question costs one of roughly 500 and returns in seconds - so a source-grounded
summary no longer requires generating a podcast you did not want.

Plugins toggle at two levels: the **type** (hides from the catalog, pauses all
instances, keeps config) and the **instance** (pause one feed or destination).

## Quick start

```bash
cp .env.example .env        # set APP_PASSWORD at minimum
docker compose up -d
```

Then open http://localhost:3000.

That is the whole thing. A `migrate` service runs the schema migrations once and
exits, and `app` and `worker` wait for it to succeed, so a fresh host needs no
manual step. Verified from a wiped volume.

Optionally seed a topic with real working feeds:

```bash
docker compose run --rm migrate node_modules/.bin/tsx src/db/seed.ts
```

Deploying to a home server, including Proxmox and secret handling, is in
[DEPLOY.md](./DEPLOY.md).

## NotebookLM credentials

The `notebooklm` renderer drives a real consumer Google account through an
unofficial client, so it needs a token generated once on a machine with a
browser:

```bash
python3 -m venv nlm-env && source nlm-env/bin/activate

# BOTH extras are required, and the error message if you miss one is easy to
# misread. [headless] mints the durable master token; [browser] is what
# captures the one-time oauth_token, and it pulls Playwright - whose browser
# binaries are a SEPARATE download that pip does not do for you.
pip install "notebooklm-py[headless,browser]"
playwright install chromium

notebooklm login --master-token --account you@gmail.com
```

If you already hold an `oauth_token`, or cannot run a browser on that machine,
skip `[browser]` and Playwright entirely:

```bash
pip install "notebooklm-py[headless]"
notebooklm login --master-token --account you@gmail.com --oauth-token <TOKEN>
```

On macOS 15 or wherever the bundled Chromium crashes, add `--browser chrome` to
use system Google Chrome instead.

Copy the resulting profile directory to `./nlm_auth/profiles/default/`. It must
contain **both** `storage_state.json` and `master_token.json` - the client loads
the former and the brief's original assumption that the master token alone was
enough turned out to be wrong.

`nlm_auth/` is gitignored and mounted read-only. Never bake it into an image.

### Why this asks for your Google password, and what to do about it

NotebookLM has no public API for consumer accounts, so there is no OAuth app to
consent to and no scoped token to grant. The only way to get a session is to
authenticate the way a person does. Playwright drives an ordinary Chromium and
the password goes to `accounts.google.com` over TLS, not to the tool.

Two things are still worth weighing before you type it:

- **The browser is automated**, so the driving process is technically capable of
  reading the login page. `notebooklm-py` does not, and it is open source and
  auditable - but this is extended trust, not zero trust.
- **`master_token.json` is broader than the password session.** It is a
  gpsoauth-style long-lived Google master token whose purpose is minting service
  tokens. That is what buys unattended renewal, and it is also why it is a more
  valuable credential than a NotebookLM cookie.

**The mitigation that matters: use a dedicated Google account, not your primary.**
Then the blast radius of that token is an account that does nothing else. Give
it NotebookLM Pro if you want the 20 audio overviews a day.

If you would rather not type a password into an automated browser at all, the
CLI offers three ways round it:

```bash
# 1. Reuse the Chrome you already use and are already signed into
pip install "notebooklm-py[cookies]"
notebooklm login --browser-cookies chrome --account you@gmail.com

# 2. Attach to a Chrome you launched yourself
notebooklm login --master-token --account you@gmail.com --cdp-url http://localhost:9222

# 3. Supply the token yourself, no browser involved
notebooklm login --master-token --account you@gmail.com --oauth-token <TOKEN>
```

Option 1 skips Playwright entirely but yields cookies that expire, so you
re-authenticate periodically. `--master-token` is what buys unattended renewal -
the convenience and the credential's power are the same thing.

The account tier sets the ceiling: NotebookLM **Pro** allows 20 audio overviews
per day. The `notebooklm` renderer declares `dailyBudget: 20` as a local safety
valve, but the upstream's own quota error is always treated as authoritative.

## Running without NotebookLM

`llm-text` is the fallback renderer and has no exotic dependencies. It supports
`gemini`, `anthropic` and `ollama` through one config field, so a topic can
produce text digests even when the unofficial client breaks. Gemini's AI Studio
free tier is ample at this volume.

## Tests

```bash
cd app     && npx vitest run       # 459 tests
cd app     && npx tsc --noEmit
cd sidecar && python3 -m pytest -q # 27 tests
```

**No Docker, no Postgres and no network required.** Database tests run real
Postgres in-process via pglite, so unique indexes, cascades and `ON CONFLICT`
are genuinely exercised rather than mocked. Plugin tests inject their transport
and stub `fetch`.

## Development environment

This project must be developed inside **WSL2 on the Linux filesystem**, not on
`/mnt/c`. The 9p mount silently truncates binaries during `npm install`, which
surfaces as bogus syntax errors in package install scripts rather than as an I/O
error. See [AGENTS.md](./AGENTS.md) for the full detail and the exact symptoms.

AI coding agents should read [AGENTS.md](./AGENTS.md) before running anything.

Known gaps, planned work and decisions already settled are in
[TODO.md](./TODO.md). Deploying to a home server is covered in
[DEPLOY.md](./DEPLOY.md).

## Design decisions worth knowing

- **Dedup is a database constraint**, not a SELECT-then-INSERT, which would
  still race two workers.
- **A digest is a state machine** (DRAFT -> APPROVED -> RENDERING -> READY). The
  approval gate exists because rendering is the quota-limited step; curating
  first stops junk from consuming it.
- **`render_log` is an event log**, not a date-keyed counter, because the
  upstream quota window is not ours to define and has been reported as both a
  rolling 24h window and a multi-hour compute budget.
- **Disk is the artifact store; Telegram is a sink.** Telegram bots upload up to
  50 MB but `getFile` only serves downloads up to 20 MB.
- **The Python sidecar is an adapter**, existing only because `notebooklm-py` is
  Python. Keeping it free of business logic is what would make it deletable if
  the official Gemini Notebook Enterprise API ever became reachable, since that
  API is plain REST.
- **The worker is a separate process** from Next.js, which is not a job host.

## Layout

```
app/       Next.js 15 + plugins + pipeline + worker  (TypeScript, ESM)
  src/core/      plugin contracts, registry, keyword filter, source plugins
  src/db/        Drizzle schema, migrations, pglite test harness
  src/pipeline/  ingest, digest lifecycle
  src/renderers/ llm-text, notebooklm
  src/sinks/     telegram
  src/worker/    pg-boss wiring + job bodies
sidecar/   FastAPI adapter over notebooklm-py  (Python)
data/      rendered artifacts (gitignored)
nlm_auth/  NotebookLM credentials (gitignored)
```
