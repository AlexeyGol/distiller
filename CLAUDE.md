# CLAUDE.md

**Read [AGENTS.md](./AGENTS.md) first.** It is the canonical guidance for every
AI agent on this repo, kept tool-agnostic so Claude Code, Cursor and Codex all
follow the same rules. This file holds only the Claude Code specifics.

Also read [TODO.md](./TODO.md) before proposing work: it records what is planned,
what is built but unverified, and - importantly - what was already decided
against and why.

## The three things most likely to waste your time

1. **The project lives in WSL ext4, not on the Windows drive.** `/mnt/c` silently
   corrupts binaries during `npm install`. Use `/home/alex/distiller-mvp` for
   commands and `\\wsl.localhost\Ubuntu\home\alex\distiller-mvp` for file tools.
2. **Pipe scripts to `wsl.exe` on stdin.** An inline command string gets its
   quoting mangled and `$variables` silently become empty.
3. **Run git from inside WSL.** The worktree's gitdir is a POSIX path that
   Windows git cannot resolve.

Full detail, with the exact failure symptoms, is in AGENTS.md section 1.

## Running things

```bash
cat > /tmp/t.sh <<'SCRIPT'
cd /home/alex/distiller-mvp/app
npx vitest run
SCRIPT
wsl.exe -d Ubuntu bash < /tmp/t.sh 2>&1 | tr -d '\r'
```

The Bash tool here is Git Bash on Windows. It reaches `\\wsl.localhost\...`
paths and can invoke `wsl.exe`, but it is not the Linux shell. PowerShell eats
backslash paths passed through `wsl.exe`; prefer the Bash tool with a piped
script.

Long-running servers die when the piping shell exits, so **start a dev server
and curl it inside the same script** rather than across two calls.

## Subagents

Directory ownership is how parallel agents avoid collisions - AGENTS.md
section 8.

**Brief every subagent with the environment explicitly**: the WSL path, the UNC
path, and the piped-script pattern. A subagent inherits none of this context and
will default to the Windows path, which fails silently rather than loudly.

**Write any shared contract once, and give both sides the same words.** Two
agents were told to build opposite ends of one HTTP call; one was told the
response field was `notebook_id`, the other `id`. Both wrote correct code, both
test suites passed, and the mismatch only appeared the first time real traffic
crossed between them. If two agents meet at an interface, specify that interface
in one place and paste it verbatim into both briefs - then add a contract test.

**Subagent reports are claims, not results.** They are usually accurate and
occasionally confidently wrong. Re-run the full suite yourself after a subagent
lands; one reported "tsc clean" while a type error existed in a file it did not
own, and another's green suite hid the contract mismatch above.

## Verification

Never report a task complete without real, pasted command output. If something
could not be verified here, say which thing and why. This is a standing
instruction, not a per-task one.

For anything touching an external service, "the tests pass" is not verification.
Five separate bugs this repo has already hit were invisible to green test suites
- see AGENTS.md section 5.

## Committing

Check what you are staging. `git add -A` has twice swept large directories into
commits here (`app/.next`, `app/nlm-env`). `git status --porcelain | wc -l`
before committing costs nothing.

Do not add co-author or attribution trailers to commits in this repo.
