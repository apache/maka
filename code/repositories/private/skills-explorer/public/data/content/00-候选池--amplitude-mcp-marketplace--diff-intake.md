---
name: diff-intake
description: >
  Reads a PR or branch diff and produces a structured YAML change brief for
  downstream analytics instrumentation skills. Use this as the first step
  whenever a user shares a PR link, branch comparison, or raw diff and wants
  to understand what changed, what needs tracking, or how to instrument a
  feature. Trigger on phrases like "review this PR", "what changed in this
  branch", "help me instrument this diff", "check analytics coverage for this
  change", or any request to start the analytics review workflow.
---

# diff-intake

Follow this skill step by step.
You are step 1 of the analytics instrumentation workflow. Produce a compact
YAML change brief that downstream skills (discover-event-surfaces,
instrument-events) will consume. Keep the output machine-readable and
precise — no prose around the YAML block.

## Step 1: Gather changed files and categorize

Fetch the list of changed files from the source, then categorize each one.

### Fetching changes

- **PR URL**
  `gh pr view <number-or-url>`
  `gh pr view <pr-number> --json files --jq '.files[] | "\(.path)\t+\(.additions) -\(.deletions)\t"'`
- **Branch comparison**
  `git log <main|master>..<branch>`
  `git diff --stat <main|master>..<branch>`
- **Ambiguous mention** (PR number, branch name): infer the right form and fetch without asking unless auth fails.

### Categorize files

Assign each file to a category based on its path:

- **Core Logic**: application source (e.g. src/auth/login.py, database/models.ts)
- **Generated**: anything with `generated` in its path
- **Testing**: test files
- **Config / Dependencies**: package.json, docker-compose.yml, etc.
- **Documentation**: READMEs, docs/
- **Noise**: lock-files, .svg, auto-generated migrations

For each file, record: path, category, change type (Added / Modified / Deleted), and analytics likelihood (1–5).

## Step 2: Build the file summary map

Read every single **Core Logic** file and create the file summary map.
Only process and include **Core Logic** files.

### Fetching detailed diffs

- **PR**
  `gh pr view <number-or-url> --json baseRefOid,headRefOid`
  Using the response, get a detailed diff
  `git diff <baseRefOid>...<headRefOid> -- <file1> <file2> <file_n>`
- **Branch comparison**
  `git diff main..feature/foo  -- <file1> <file2> <file_n>`

### For each file, record

- `summary` — 2-line summary of what changed
- `stack` — frontend, backend, or shared

### Also derive user-facing changes and touched surfaces

While reading the diff and the changed files, also produce the higher-level
signals that downstream event discovery needs:

- `user_facing_changes` — a flat list of concrete behavior changes that matter
  to a user, PM, or analyst. Each item should describe what a user can now do,
  see, or experience differently. Omit purely internal refactors.
- `surfaces.components` — the UI components, routes, pages, handlers, or other
  interaction surfaces directly involved in those user-facing changes. Prefer
  likely instrumentation points over low-level helpers.

For each surface, record:

- `name` — component, route, page, hook, or surface name
- `file` — repo-relative path
- `change` — `added`, `modified`, or `deleted`

If the change is backend-only or has no clear interactive surface, omit
`surfaces.components` rather than inventing one.

## Step 3: Classify the overall change

Infer the change type and analytics scope:

| Type                                     | Analytics implication                             |
| ---------------------------------------- | ------------------------------------------------- |
| feat                                     | High — new surfaces likely need tracking          |
| fix                                      | Low–Medium — may affect existing event conditions |
| refactor                                 | Low — tracking paths may move, regression risk    |
| perf                                     | Low — usually no tracking impact                  |
| revert                                   | Medium — need to check what tracking was lost     |
| style / docs / test / build / ci / chore | None — skip analytics analysis                    |

`analytics_scope` = highest implication present:

- `none` — only no-impact types
- `low` — only perf/refactor
- `medium` — fix
- `high` — any feature or capability addition

If `analytics_scope` is `none`, emit the brief and note that downstream skills are not needed.

## Step 4: Emit the YAML brief

Output only the YAML block — no prose before or after. Follow the format exactly.
List each file individually in file_summary_map (no globs).

```yaml
change_brief:
  classification:
    primary: feat # dominant conventional commit type
    types: [feat, fix] # all types detected
    analytics_scope: high # none | low | medium | high
    stack: frontend # frontend | backend | fullstack
  summary: "One sentence describing the overall change"
  user_facing_changes:
    - "Users can now upload an avatar with drag-and-drop and preview it before saving."
  surfaces:
    components:
      - name: "AvatarUpload"
        file: "src/components/AvatarUpload.tsx"
        change: modified
  file_summary_map: # each entry includes a layer field
    - file: "src/components/AvatarUpload.tsx"
      summary: "New component for avatar upload with drag-and-drop and preview"
      layer: frontend # frontend | backend | shared
    - file: "src/api/upload.ts"
      summary: "Upload endpoint handler, validates file type and persists to S3"
      layer: backend
```
