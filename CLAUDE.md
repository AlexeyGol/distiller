# CLAUDE.md

**Read [AGENTS.md](./AGENTS.md) first.** It is the canonical guidance for all AI
agents on this repo, and it is kept tool-agnostic so Claude Code, Cursor and Codex
all follow the same rules. This file holds only the Claude Code specifics that do
not belong in a shared file.

## The three things most likely to waste your time

1. **The project lives in WSL ext4, not on the Windows drive.** `/mnt/c` silently
   corrupts binaries during `npm install`. Use `/home/alex/distiller-mvp` for
   commands and `\\wsl.localhost\Ubuntu\home\alex\distiller-mvp` for file tools.
2. **Pipe scripts to `wsl.exe` on stdin.** Passing a command string inline gets its
   quoting mangled and `$variables` silently become empty.
3. **Run git from inside WSL.** The worktree's gitdir is a POSIX path that Windows
   git cannot resolve.

Full detail, including the exact failure symptoms, is in AGENTS.md section 1.

## Running things

```bash
cat > /tmp/t.sh <<'SCRIPT'
cd /home/alex/distiller-mvp/app
npx vitest run
SCRIPT
wsl.exe -d Ubuntu bash < /tmp/t.sh 2>&1 | tr -d '\r'
```

The Bash tool here is Git Bash on Windows. It can reach `\\wsl.localhost\...` paths
and can invoke `wsl.exe`, but it is not the Linux shell. PowerShell mangles
backslash paths passed through `wsl.exe`; prefer the Bash tool with a piped script.

## Subagents

Directory ownership is how parallel agents avoid collisions - see AGENTS.md
section 6. When briefing a subagent, give it the WSL path, the UNC path, and the
piped-script command pattern explicitly. A subagent does not inherit this context
and will default to the Windows path, which silently fails.

## Verification

Never report a task complete without real, pasted command output. If a thing could
not be verified here, say which thing and why. This is a standing instruction, not
a per-task one.
