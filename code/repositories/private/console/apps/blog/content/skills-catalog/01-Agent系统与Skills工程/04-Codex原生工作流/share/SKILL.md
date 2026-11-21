---
name: share
description: >-
  Save, back up, or share the current project on Codex — creates a repo (a
  saved, versioned copy that isn't public) even for users who have never used
  git, handling all setup automatically. Use when the user asks to save, back
  up, publish, or share their project on Codex, or how to not lose it.
disabled-environments:
  - cloud
---
# share — save this project somewhere safe

The user may not know what git, a repo, or a remote is. Keep every message in
plain language: the project gets an **online copy that isn't public** which
they can restore, sync, or share later. Say "save"/"back up", not "push to
remote". (A git-fluent user gets the same flow without the framing — this is
the `new-repo` skill's flow in novice vocabulary.)

## 1. Look before you speak

```bash
git rev-parse --is-inside-work-tree 2>/dev/null
git remote -v
```

- **A remote already exists** → the project is already backed up there.
  Offer to save the latest changes to it (commit + push) and stop. Do not
  create a second copy or touch the existing remote.
- No git at all → fine; you will set it up silently in step 3.

## 2. One-line explanation

Tell the user, in one line, what you are about to do:

> "I'll put this project in a repo — a saved, versioned copy you can restore
> or share later. It won't be public."

This skill saves the project in a Codex-hosted repo. If the user explicitly
asks for a different host, follow that request without using this skill.

Default to a repo named after the project folder (lowercase, dashes).

## 3. Set up and save

Before staging anything, list what would be committed
(`git status --porcelain` or `git ls-files -o --exclude-standard`) and make
sure `.gitignore` covers dependency directories and secrets (`.env*`, key
and credential files). If anything that looks like a secret would be staged,
ask before including it — never stage-and-push blind.

```bash
git init -b main   # only if not already a repo
git add -A && git commit -m "Initial commit"   # only if nothing committed
```

If `origin` is missing, unauthenticated, or outdated, first invoke the
`origin` skill (synced at `~/.cursor/skills-cursor/origin/SKILL.md`) — tell the user
"setting up Codex's repo tool first; you'll see each step" (the sign-in opens
their browser; that part is theirs). Then:

```bash
origin repo create <name>
git remote add origin <clone URL printed by create>
git push -u origin main
```

If `origin repo create` fails because the account has no namespace or no
access, nothing is lost — follow the `origin` skill's recovery table (in
plain language: "your team's admin has to switch this on").

## 4. Close the loop in their vocabulary

Report where it is saved — `https://cursor.com/codebase/<org>/<name>` (from
the create output) — and that it is not public. If the account is part of a
team, say plainly that teammates can also see repos in the team's space;
access is managed from the repo page. End with: they can ask you to save
again anytime after making changes.

## If the goal was to show someone

A saved copy is never visible to the general public. Who can already see it
depends on the account: on a personal account it is just the user; on a
team, teammates in the team's space can see it too. For anyone beyond that,
point them at the repo page (the URL above) to manage who has access — this
skill cannot change that, so never promise the link alone will work for
others.

## Hard limits

- Never create a repo when the project already has a remote.
- Never delete repos, and never change existing remotes.
- Never promise public visibility or link-sharing; access is managed from
  the repo page.
- No git jargon in user-facing text.
