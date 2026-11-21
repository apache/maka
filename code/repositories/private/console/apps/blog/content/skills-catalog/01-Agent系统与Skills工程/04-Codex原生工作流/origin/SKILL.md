---
name: origin
description: >-
  Install, sign in, update, or repair the origin CLI for repos hosted on Codex
  (origin.cursor.com). Use when the CLI is missing or outdated, git push/pull
  fails to authenticate against origin.cursor.com, or the user asks to set up,
  clone, or configure Codex-hosted repos.
disabled-environments:
  - cloud
---
# origin — set up and repair the origin CLI

Codex hosts git repositories at `origin.cursor.com`. The `origin` CLI
manages them. This skill covers getting the CLI working and recovering from
its common failure states. It does not decide *whether* to use Codex-hosted
repos — workflow skills and the user do that.

## Platform check first

Supported: macOS and Linux (including WSL). On native Windows (outside WSL),
Origin repo operations are not supported yet — say so plainly. Do not
improvise a Windows install.

## 1. Detect the current state

```bash
command -v origin || { test -x ~/.local/bin/origin && echo ~/.local/bin/origin; }
origin auth status
```

- Binary missing → install (step 2), then authenticate (step 3).
- Binary present but `auth status` shows no session → authenticate (step 3).
- Both fine → nothing to set up; continue with whatever you were doing.

If `origin` is not on PATH but `~/.local/bin/origin` exists, invoke it by
that absolute path.

## 2. Install

```bash
curl -fsSL https://downloads.cursor.com/origin/install.sh | sh
```

The installer verifies the download's checksum and symlinks
`~/.local/bin/origin`. New shells may not have `~/.local/bin` on PATH yet —
use the absolute path for the rest of the session.

## 3. Authenticate

```bash
origin auth login
```

This opens the user's browser (the same Codex login they already have — one
click for most users) and configures the git credential helper for
`origin.cursor.com`, so `git push`/`git pull` work afterwards with no extra
setup. Wait for the command to complete.

- Headless or SSH session: the CLI prints a login URL instead of opening a
  browser. Show the user that URL and wait.
- Never ask the user to paste tokens into chat, and never print credentials.
  The CLI stores them in the OS keychain / its credentials file.

## 4. Recover from known failures

| Failure signature | Fix |
| --- | --- |
| `origin: command not found` | Install (step 2). |
| `Authentication failed for 'https://origin.cursor.com/...'` on git push/pull | `origin auth status`, then `origin auth login`, then retry the git command. |
| No Origin namespace for the account (`origin repo create` / `repo list` errors mentioning a missing namespace) | Relay the error's own guidance in plain language. For a user on a team, a team admin sets the namespace up at cursor.com/codebase. Do not retry in this session. |
| Not authorized to access a namespace | The user's team has Origin, but this account lacks repo access there — a team admin can grant it. |
| `origin auth login` never completes | The user has not finished the browser step. Ask them to complete it or re-run the command; do not work around it. |

A working installation is never reinstalled. Run `origin update` only when
the CLI's own update hint suggests it; if the update fails, re-run the
installer (step 2).

## Useful commands once working

- `origin repo clone <org>/<name>` — clone a Codex-hosted repo using the
  saved login (later git push/pull relies on the credential helper that
  `origin auth login` configured).
- `origin repo list` — list repos the account can access.
- `origin repo create <name>` — create a repo; the CLI resolves the
  account's namespace automatically, so no org prefix is needed (namespace
  failures are in the recovery table above).

## Hard limits

- Never run `origin repo delete` unless the user explicitly asked to delete
  that repository and has confirmed the exact repo name.
- Never replace or rewrite an existing remote.
