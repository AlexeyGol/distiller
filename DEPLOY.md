# Deploying to Proxmox

Everything here has been run and verified, except the Proxmox host steps
themselves (no Proxmox host was available). The Docker side - build, from-scratch
deploy, automatic migrations, health checks - was exercised end to end.

---

## 1. VM or LXC?

**Use a VM.** That is Proxmox's own recommendation for Docker, and this guide
follows it.

An earlier draft of this document recommended an LXC to save roughly 600 MB of
guest kernel on a 16 GB box. That is common community practice and it does work,
but it is explicitly **not** what Proxmox recommends, and "saves 4% of RAM" is a
poor trade against "vendor-supported and behaves the way every troubleshooting
guide assumes".

### The three options, honestly

| Option | Status | Verdict here |
| --- | --- | --- |
| **Docker in a VM** | Proxmox's documented recommendation | **Use this** |
| Docker in an unprivileged LXC | Widely done, community-supported, **not** recommended by Proxmox | Works; you own the edge cases |
| Native OCI containers (PVE 9.1+) | **Technology preview** for application containers | Not a fit, see below |

**Why not native OCI**, even though it is the shiny 2026 answer. Proxmox VE 9.1
(November 2025) can create LXC containers directly from OCI images, which sounds
like exactly what we want. It is not, for two reasons. It is still a technology
preview for application containers, and more fundamentally it runs *images*, not
*compose stacks*. This deployment depends on things only an orchestrator
provides: `depends_on` with `service_completed_successfully` gating the migration
step, health-gated start ordering, a shared network, and named volumes. Running
five OCI containers by hand would mean reimplementing that ordering yourself,
and the migration gate is precisely the thing that makes a fresh deploy work
unattended. Revisit when the preview label comes off and compose semantics have
an answer.

**Why LXC is still defensible.** Plenty of people run Docker in unprivileged LXC
for years without incident, and the community helper scripts
([community-scripts/ProxmoxVE](https://github.com/community-scripts/ProxmoxVE),
the maintained successor to tteck's collection) ship a Docker LXC script. If you
already run that way and it works, there is no reason to migrate. Just know that
it is community practice rather than vendor guidance, so when something odd
happens with overlayfs or AppArmor you are on your own, and that `vzdump` of a
running Docker-in-LXC is crash-consistent rather than clean.

### Creating the VM

Debian 13 (Trixie) minimal, then:

- **2 vCPU, 4 GB RAM, 20 GB disk** for the system
- Enable the **QEMU guest agent** in VM Options, and `apt install qemu-guest-agent`
  inside. Without it Proxmox cannot quiesce or shut the VM down cleanly, and
  backups get rougher than they need to be.
- A **second disk** for `data/` (rendered mp3s), sized for your retention window.
  A 30-minute episode at 96 kbps is roughly 21 MB, so one topic daily at 30-day
  retention is under 1 GB. Separate so you can resize or snapshot it
  independently of the system disk.

Install Docker normally (`get.docker.com`), then continue at section 2.

RAM note: 4 GB is comfortable for the running stack. If you also build images on
this VM (section 5), give it 6 GB - the Next.js build wants about 2 GB on its
own.

### If you use an LXC anyway

Unprivileged, Debian 13 template, and set both features or Docker will not start:

```bash
pct set <CTID> -features nesting=1,keyctl=1
```

Same sizing. Everything from section 2 onward is identical.

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

**Per-instance secrets: literal, or a reference to the environment.**

A Telegram bot token belongs to a specific sink and a YouTube key to a specific
source, so a single environment variable per plugin type cannot express them -
two sinks may need two different tokens. Config therefore lives with the
instance, in the database, and you choose how the secret gets there:

| In the config field | Stored | Best for |
| --- | --- | --- |
| `AIzaSyD-realkey...` | the key itself | fastest setup, no restart |
| `${YOUTUBE_API_KEY}` | only the reference | **everything else** |

Prefer the reference. It keeps the database, its dumps, its config exports and
any screenshot of the sources table free of anything worth stealing, and it puts
the value where a Kubernetes Secret, a systemd credential or a Vault agent
already expects to put it. Per-instance flexibility is unaffected: two sinks can
reference `${TELEGRAM_BOT_TOKEN_A}` and `${TELEGRAM_BOT_TOKEN_B}`.

`${VAR:-fallback}` is supported. An unset variable with no fallback fails
loudly, naming both the variable and the field, rather than quietly polling with
an empty key and producing a 403 far from its cause.

A reference is not a secret, so it is neither masked in the UI nor redacted on
export - which means a config built on references exports in full and imports
onto another machine unchanged, with no `--with-secrets` variant needed at all.

Literal values are still masked on display (`AIza...XY`) and redacted on export.
`.env` remains the place for process-level configuration.

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
things: a Proxmox firewall rule plus the guest's IP for a LAN-only setup, or a
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

### Configuration export - the third thing worth backing up

A `pg_dump` is machine-to-machine and opaque. For the configuration itself -
topics, sources, sinks, keywords, schedules, settings - there is a readable,
diffable, portable JSON bundle:

```bash
# safe to commit or share: credential fields are redacted
docker compose exec -T app node_modules/.bin/tsx src/scripts/config-export.ts > config.json

# restorable backup: real keys included, written 0600
docker compose exec -T app node_modules/.bin/tsx src/scripts/config-export.ts --with-secrets --out config.backup.json
```

Restore, or seed a second install:

```bash
docker compose exec -T app node_modules/.bin/tsx src/scripts/config-import.ts config.backup.json
```

Two properties worth knowing:

- **Redacted by default.** Sharing a setup, committing it or pasting it into an
  issue is the common case and must not leak a bot token. `--with-secrets` is
  the deliberate one, and the file it writes is `0600`.
- **A redacted bundle still imports usefully.** Where a field reads
  `__REDACTED__`, any existing value is kept, so re-importing a shareable export
  onto a live install updates everything else and leaves the real keys alone.
  Anything with nothing to keep is reported as a warning naming the field.

Imports upsert by natural key - topic slug, source label - and never delete, so
a partial bundle cannot silently destroy what it does not mention. That also
means the bundle ports between installs: it contains no UUIDs.

Restore:

```bash
gunzip -c db-2026-09-13.sql.gz | docker compose exec -T db psql -U distiller distiller
```

`data/` can be discarded if you are willing to lose old audio; digests keep their
text summaries regardless, since those live in the database.

Proxmox's own VM backups cover the whole guest and are a reasonable
belt-and-braces layer. Keep the `pg_dump` anyway: with the QEMU guest agent
installed, `vzdump` can quiesce the filesystem, but it still captures Postgres
mid-transaction rather than taking a clean logical dump. The two answer different
questions - the snapshot restores a machine, the dump restores a database.

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

- **No Proxmox host was available**, so VM creation, guest-agent setup, the LXC
  feature flags and the resource sizing come from documentation rather than from
  a run. Everything from `docker compose up` onward was verified directly.
- **The OCI-native assessment is a reading of the release notes**, not an
  experiment. I did not try to run this stack as Proxmox application containers;
  the conclusion that it cannot express compose ordering follows from what the
  stack needs, not from a failed attempt.
- The reverse-proxy and TLS setup is left to you; nothing here has been tested
  behind one.
- NotebookLM has never been exercised with a real token, so the sidecar's
  behaviour on a live credential is untested. See the verification-debt table in
  [TODO.md](./TODO.md).
