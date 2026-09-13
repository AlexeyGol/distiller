# TODO

Ideas, open questions and known gaps. Ordered roughly by value, not by effort.

Each entry says **why** it matters, because a bare task list loses the reasoning
within a week. The "Decided against" section exists so settled questions stay
settled.

---

## Next up

### 1. Cross-source deduplication

**Problem.** Dedup today is `unique(source_id, external_id)`: it stops the same
item arriving twice from the *same* source, and does nothing across sources.
TLDR, Hacker News, Reddit and a personal blog all link to the same underlying
articles, so one story can appear four times in a digest - and NotebookLM will
narrate it four times.

Not yet visible in real data (0 duplicates today) only because the seeded
sources barely overlap. Adding TLDR or a second aggregator starts it
immediately.

**Design.** Deduplicate at **digest-build time, not at ingest.**

Keep every copy in `items`; collapse them in `buildDraft`. Ingest-time dedup
would throw away information: four sources covering one story is *signal* that
the story matters. Collapsing late lets a digest say "covered by TLDR, HN and
r/LocalLLaMA" and rank it higher, which beats silently dropping three rows.

- add `items.canonical_url` + index
- normalise: lowercase host, strip `www.`, strip `utm_*` / `ref` / `fbclid`,
  strip fragment, strip trailing slash
- `buildDraft` groups candidates by `canonical_url`, keeps the copy with the
  richest body, records the others as corroborating sources
- surface "seen in N sources" in the curation UI

**Open question.** Some aggregators link to themselves rather than the source
(a Reddit post whose `url` is the comments page). Canonicalising those needs
the outbound link from the post body, which is a second, messier step. Ship URL
normalisation first and see how much it actually leaves on the table.

### 2. Podcast RSS sink

The point of the project is listening. Right now audio is reachable only
through the web player or a Telegram upload, which is not how anyone actually
consumes podcasts.

A `podcast-rss` sink exposing a per-topic RSS feed with `<enclosure>` tags
would let any podcast app subscribe. This is probably the single biggest
usability win left, and it needs no new external dependency: the artifacts and
the metadata already exist.

Needs: a stable public URL per topic, correct iTunes namespace tags, and a
decision about auth (a podcast app cannot log in, so it needs an unguessable
feed token rather than the session cookie).

### 3. Reschedule on topic change

`scheduleEverything()` is re-callable by design but nothing calls it after the
initial boot, so editing a topic's cron in the UI has no effect until the
worker restarts. Either call it from the topic-save action, or have the worker
poll for schedule changes.

---

## Verification debt

Built but **not proven end to end**. Each is a known unknown, not a suspicion.

| Thing | State |
| --- | --- |
| `app/Dockerfile`, `worker` container | Written, **never built or run**. Only `db` has been exercised under compose. |
| NotebookLM renderer against a real token | Never run. Sidecar unit tests use a fake client; the real `ask` / `audio` round trip is untested. |
| Telegram sink | Never sent a real message. Contract verified against docs, not against Telegram. |
| `llm-text` against a real provider | Never called Gemini/Anthropic/Ollama for real. |
| Audio player with a real mp3 | No mp3 has ever been produced, so range requests and seeking are untested with real bytes. |

The pattern to fix them is the same one that caught two bugs already: exercise
it against the real thing, not the fixture.

---

## Sources

### Need no code
The `rss` plugin already handles these. Paste the URL:

| Source | URL | Verified |
| --- | --- | --- |
| TLDR newsletter | `tldr.tech/api/rss/{tech,ai,devops}` | 200 |
| Lobsters by tag | `lobste.rs/t/<tag>.rss` | 200 |
| Mastodon by hashtag | `<instance>/tags/<tag>.rss` | 200 |
| GitHub releases | `github.com/<owner>/<repo>/releases.atom` | 200 |
| Google News query | `news.google.com/rss/search?q=<q>` | 200 after redirect |
| Changelog | `changelog.com/news/feed` | 200 |
| arXiv | `export.arxiv.org/api/query?...` | needs **https**, http 301s |

### Candidates worth a plugin
Only where there is logic beyond fetching a feed.

- **Bluesky** - public search API, no key. Firehose-adjacent volume, so it
  needs query + filtering rather than a raw feed.
- **arXiv** - Atom, but the query syntax (`cat:cs.AI AND abs:...`) is arcane
  enough that a guided form would earn its keep.
- **Newsletter via IMAP** - the general answer to "this newsletter has no RSS".
  Real value, real complexity: credentials, folder selection, HTML parsing.

### Item scoring
`hackernews` already stores points and comment counts in `raw`, and Reddit
stores score, but nothing reads them. A per-topic "minimum score" filter would
cut noise more cheaply than better summarisation.

---

## Smaller gaps

- **Keyword editing** - add/remove only. A keyword is a term plus a mode, so
  remove-then-add is the same number of clicks. Left alone deliberately.
- **Digest deletion** - no way to remove a bad digest from the UI.
- **Bulk curation** - no "select all" / "select none" on the curation screen.
  Painful once a draft has 30+ items.
- **Source import/export** - moving a setup between machines means retyping
  every source. An OPML import would cover the RSS ones for free.
- **Sidecar orphan cleanup** - a retry after a mid-render crash can leave an
  orphaned NotebookLM notebook. The readable title makes it findable; nothing
  cleans it up automatically, and the 500-notebook cap is real.

---

## Decided against

Recorded so these do not get re-litigated. Reopen only with a new reason.

**Runtime-installable plugins.** Would need sandboxing, a versioned ABI and
capability grants. For a single-tenant self-hosted app the plugin author is the
operator, so isolation buys nothing and costs a great deal. The registry stays
static and in-repo.

**In-app playback as a plugin.** It is the app reading its own stored artifact.
No config, no alternative implementation, so it is not a plugin.

**Telegram as blob storage.** Bots upload up to 50 MB but `getFile` only serves
downloads up to 20 MB, so longer podcasts break silently on read-back. Disk is
the store; Telegram is a delivery sink.

**Mirroring NotebookLM's quota accounting.** Reported limits disagree (rolling
24h vs a multi-hour compute budget) and Google changes them. The local budget
is a configurable safety valve; the upstream's own error is authoritative.

**Ingest-time deduplication.** See item 1: it discards the corroboration signal.

**Consumer subscriptions as API access.** Claude Pro/Max and Gemini Advanced do
not grant programmatic access, and Claude Code's subscription auth covers
interactive development, not a backend service. At this volume a real API key
costs a few dollars a month, so this is not worth engineering around.

---

## Open question: keep the `reddit` plugin?

A subreddit `.rss` URL works in the generic `rss` plugin, so the dedicated
plugin is mostly ergonomics. The one thing it genuinely buys is **retry
classification**: the generic plugin raises a non-retryable `FeedHttpError` on
Reddit's 403, so a throttled subreddit sits broken until someone notices, while
the dedicated plugin raises `TransientError` and self-heals on the next poll.

Given Reddit returns 403 and 429 interchangeably for throttling, that
difference is not academic. Keeping it for now; worth revisiting if the
maintenance cost shows up.
