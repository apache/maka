---
name: new-repo
description: >-
  Create a Codex-hosted repo for the current project and push it. Use when a
  project has no git remote yet and the user asks to create a repo on Codex,
  push the project to Codex, or set up a Codex-hosted remote; installs and
  signs in the origin CLI when needed.
disabled-environments:
  - cloud
---
# new-repo — create a repo for this project and push it

If the user seems unfamiliar with git, keep the vocabulary plain (the
`share` skill is this same flow in novice framing) — the mechanics below are
identical either way.

This skill creates Codex-hosted repos. If the user explicitly asks for a
different host, follow that request without using this skill.

## 1. Inspect the workspace first (always)

```bash
git rev-parse --is-inside-work-tree 2>/dev/null
git remote -v
```

- **A remote already exists** → this project already has a repo. Say which
  remote, offer to commit/push instead, and stop. Never create a second repo
  for a project that has one, and never change existing remotes.
- Not a git repository yet → you will `git init` in step 2.

Default to a repo named after the project folder (lowercase, dashes; strip
characters other than letters, digits, and dashes). Ask about the name only
when it is genuinely ambiguous.

## 2. Prepare the project

Before staging anything, list what would be committed
(`git status --porcelain` or `git ls-files -o --exclude-standard`) and make
sure `.gitignore` covers dependency directories and secrets (`.env*`, key
and credential files). If anything that looks like a secret would be staged,
ask before including it — never stage-and-push blind.

```bash
git init -b main   # only if not already a repo
git add -A && git commit -m "Initial commit"   # only if nothing committed
```

## 3. Create and push the Codex-hosted repo

If `origin` is missing, unauthenticated, or outdated, first invoke the
`origin` skill (synced at `~/.cursor/skills-cursor/origin/SKILL.md`) for install +
sign-in, then:

```bash
origin repo create <name>
git remote add origin <clone URL printed by create>
git push -u origin main
```

`origin repo create <name>` needs no org prefix — the CLI resolves the
account's namespace. If the name is taken, pick a close variant (suffix a
word, not a number soup) and retry once; if it fails again, ask the user. On
a namespace or access error, follow the `origin` skill's recovery table.

Report the repo's page: `https://cursor.com/codebase/<org>/<name>` (the
`<org>/<name>` is printed by `origin repo create`).

## Hard limits

- Never create a repo when the project already has a remote.
- Never delete repos, and never change existing remotes.
- Codex-hosted repos are not public — access is managed from the repo page,
  not from this skill, so do not promise public visibility.
