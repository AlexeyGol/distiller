# Deploying to Proxmox

Everything here has been run and verified, except the Proxmox host steps
themselves (no Proxmox host was available). The Docker side - build, from-scratch
deploy, automatic migrations, health checks - was exercised end to end.

---

## 1. LXC container or VM?

Both work. The trade is isolation against RAM.

| | LXC (recommended on a 16 GB box) | VM |
| --- | --- | --- |
| RAM overhead | ~100 MB | ~700 MB for the guest kernel |
| Docker support | Works, needs two flags | Officially supported, no caveats |
| Disk | Shares the host page cache | Fixed allocation |
| Surprises | Occasional storage-driver quirks | Essentially none |

On a Latitude 5320 with **16 GB soldered and no way to add more**, the ~600 MB a
VM costs is worth avoiding. Use an **unprivileged LXC with nesting**. If you hit
storage-driver oddities and do not want to debug them, switch to a VM; nothing
else in this guide changes.

### Creating the LXC

Debian 12 template, then in the container's options enable:

- **Nesting** (`features: nesting=1`) - required, Docker will not start without it
- **keyctl** (`features: keyctl=1`) - required for Docker's own key storage

Via the host shell:

```bash
pct set <CTID> -features nesting=1,keyctl=1
```

Sizing: **2 cores, 4 GB RAM, 20 GB disk** is comfortable. The database is small;
what grows is `data/` (rendered mp3s). Put that on a separate mount point sized
for your retention window - a 30-minute episode at 96 kbps is roughly 21 MB, so
one topic daily at 30-day retention is under 1 GB.

Install Docker inside the container as normal (`get.docker.com`).

---

## 2. Getting the code there

```bash
git clone <your-repo> /opt/distiller
cd /opt/distiller
git checkout feat/mvp        # or a tag once you cut one
```

`/opt` rather than a home directory so the unit file and permissions are
predictable regardless of which user you are.

---

## 3. Secrets

There are two kinds and they are handled differently.

### Environment secrets: a root-owned `.env`

```bash
cp .env.example .env
chmod 600 .env
chown root:root .env
$EDITOR .env
```

`.env` is gitignored and read by `docker compose` at the point of `up`. At
minimum set `APP_PASSWORD`; compose **refuses to start** without it, which is
deliberate - this UI fronts a real Google credential and an unset password would
silently leave it open.

Also set `POSTGRES_PASSWORD` to something other than the default before the first
`up`. Postgres initialises its password on **first boot only**, so changing it
later means either an `ALTER USER` or wiping the volume.

Fill in only the keys for the plugins you actually configure:
`GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

**Per-instance secrets live in the database, not in `.env`.** A Telegram bot
token belongs to a specific sink and a YouTube key to a specific source, so they
are entered in the UI and stored as JSONB. The UI masks them on display (field
names matching key/token/secret/password render as `AIza...XY`). `.env` is only
for process-level configuration.

### File secrets: the NotebookLM credential

```bash
mkdir -p nlm_auth/profiles/default
# copy storage_state.json AND master_token.json in from the machine where you
# ran `notebooklm login` - BOTH files are required, the client loads the former
chmod 700 nlm_auth
chmod 600 nlm_auth/profiles/default/*
```

Mounted **read-only** into the sidecar. `nlm_auth/` is gitignored and nothing
secret is ever baked into an image layer - the images contain only source.

### Rotating a secret

```bash
$EDITOR .env
docker compose up -d        # recreates only the containers whose env changed
```

No rebuild needed; environment is injected at run time, not build time.

---

## 4. First deploy

```bash
docker compose up -d
```

That is the whole thing. Verified from a completely wiped state:

```
db        healthy
migrate   exited 0    {"event":"migrations-applied"}
app       healthy     -> :3000
worker    healthy
sidecar   healthy
```

The `migrate` service runs migrations and exits; `app` and `worker` wait for it
to **succeed** before starting. So a fresh host comes up with a schema without
you running anything by hand. Drizzle records what it has applied, so it is a
no-op on every subsequent boot.

Seed a starting topic and some real feeds if you want something to look at:

```bash
docker compose run --rm migrate node_modules/.bin/tsx src/db/seed.ts
```

### Reaching it

The app binds `:3000` inside the container. Expose it however you already do
things: a Proxmox firewall rule plus the LXC's IP for a LAN-only setup, or a
reverse proxy (Caddy/nginx/Traefik) if you want TLS. **Do not put this on the
public internet** behind only `APP_PASSWORD` - it is a single shared password
with no rate limiting.

---

## 5. Updating

```bash
cd /opt/distiller
git pull
docker compose build
docker compose up -d
```

Migrations run automatically as part of `up`. Containers whose image did not
change are left running.

### Build on the server, or elsewhere?

**Build on the server** while it stays comfortable. It is one command and there
is no registry to run.

The Next.js build needs roughly 2 GB of RAM and a few minutes on four Tiger Lake
cores, and it competes with the running services. If that starts to hurt, build
elsewhere and pull images instead:

```bash
# on your workstation
docker build -t ghcr.io/<you>/distiller-app:2026-09-13 ./app
docker push ghcr.io/<you>/distiller-app:2026-09-13
```

then replace the `build:` keys with `image:` in an override file. Worth doing
when build time becomes annoying, not before.

### Pinning a version

Tag before deploying so rollback is a checkout rather than an archaeology
session:

```bash
git tag -a v0.1.0 -m "first deploy" && git push --tags
```

### Rolling back

```bash
git checkout v0.1.0
docker compose build && docker compose up -d
```

**Code rolls back; the database does not.** Drizzle generates forward-only
migrations, so reverting to a tag whose schema is older than the live database
will fail at whatever the new code no longer expects. In practice: take the
backup below before any deploy that includes a migration, and treat a schema
rollback as restore-from-dump rather than as a git operation.

---

## 6. Backups

Two things matter, and they are not in the same place.

```bash
# database - the configuration, digests and history
docker compose exec -T db pg_dump -U distiller distiller | gzip > db-$(date +%F).sql.gz

# artifacts - the rendered mp3s
tar czf data-$(date +%F).tar.gz data/
```

Also back up `.env` and `nlm_auth/` somewhere appropriate for credentials. They
are the only pieces that cannot be regenerated from git.

Restore:

```bash
gunzip -c db-2026-09-13.sql.gz | docker compose exec -T db psql -U distiller distiller
```

`data/` can be discarded if you are willing to lose old audio; digests keep their
text summaries regardless, since those live in the database.

Proxmox's own LXC snapshots cover the whole container and are a reasonable
belt-and-braces layer, but a snapshot of a running Postgres is a crash-consistent
copy, not a clean dump. Keep the `pg_dump`.

---

## 7. Operating notes

**Logs.** All three services log structured JSON to stdout:

```bash
docker compose logs -f worker
docker compose logs --since 1h app
```

**Health.** Every service has a real health check. The worker's is not an HTTP
probe - it verifies it can reach Postgres, because that is both its queue and
its data. The stock HTTP check inherited from the app image would have sat
unhealthy forever and, under `restart: unless-stopped`, killed a perfectly
healthy worker in a loop.

**Nothing showed up this morning?** The Runs panel on the dashboard shows each
source's last poll time and last error. That is the first place to look, before
the logs.

**Scheduling.** The worker polls sources on `POLL_SCHEDULE` (default every 30
minutes) and builds digests on each topic's own cron. Note the known gap in
[TODO.md](./TODO.md): editing a topic's schedule in the UI does not take effect
until the worker restarts.

**Resource ceiling.** Add limits if you want the stack to stay predictable
alongside whatever else the box does:

```yaml
    deploy:
      resources:
        limits:
          memory: 1g
```

---

## 8. What is not verified

- **No Proxmox host was available**, so the LXC creation, the nesting flags and
  the resource sizing come from documentation and general practice rather than
  from a run. Everything from `docker compose up` onward was verified.
- The reverse-proxy and TLS setup is left to you; nothing here has been tested
  behind one.
- NotebookLM has never been exercised with a real token, so the sidecar's
  behaviour on a live credential is untested. See the verification-debt table in
  [TODO.md](./TODO.md).
