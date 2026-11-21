---
name: pr-review-ci-fix
description: Automated PR review and CI auto-fix for GitHub and GitLab using the Composio CLI. Pulls diffs, fetches failing job logs, posts review comments, and loops fix commits until checks go green.
metadata:
  short-description: Automated PR review + CI auto-fix across GitHub/GitLab
---

# PR Review + CI Auto-Fix

Drive GitHub/GitLab PR reviews and CI triage from the shell using the [Composio CLI](https://docs.composio.dev/docs/cli). No tab-switching between browser, terminal, and chat.

## When to Use

- A PR needs a structured review (correctness, style, risks) with inline comments.
- CI is red and you want the agent to read the logs, patch the code, and recheck.
- You want a single command that cycles: **fetch diff → critique → fix → push → rerun**.

## Prereqs

```bash
curl -fsSL https://composio.dev/install | bash
composio login
composio link github        # or: composio link gitlab
```

Optional env for non-interactive runs: `COMPOSIO_API_KEY`.

## Core Toolkits

Discover slugs with search, then pin them for reuse:

```bash
composio search "list pull request files" --toolkits github
composio search "download workflow logs" --toolkits github
composio search "create pr comment" --toolkits gitlab
```

Common slugs you'll reuse:

- `GITHUB_GET_A_PULL_REQUEST`
- `GITHUB_LIST_PULL_REQUESTS_FILES`
- `GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST`
- `GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY`
- `GITHUB_DOWNLOAD_WORKFLOW_RUN_LOGS`
- `GITLAB_GET_SINGLE_MERGE_REQUEST`
- `GITLAB_LIST_MERGE_REQUEST_DISCUSSIONS`
- `GITLAB_CREATE_NEW_MERGE_REQUEST_NOTE`

Always confirm via `composio execute <SLUG> --get-schema` before first use.

## Review Workflow

1. **Pull the PR metadata + diff:**
   ```bash
   composio execute GITHUB_GET_A_PULL_REQUEST \
     -d '{"owner":"acme","repo":"app","pull_number":482}'
   composio execute GITHUB_LIST_PULL_REQUESTS_FILES \
     -d '{"owner":"acme","repo":"app","pull_number":482}'
   ```
2. **Summarize risk areas** (auth, migrations, public APIs, tests) into a review body.
3. **Post the review** with inline comments:
   ```bash
   composio execute GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST -d '{
     "owner":"acme","repo":"app","pull_number":482,
     "event":"COMMENT",
     "body":"Overall LGTM with 2 blocking notes.",
     "comments":[
       {"path":"src/auth.ts","line":42,"body":"Missing null check on session"},
       {"path":"src/auth.ts","line":88,"body":"Token TTL is hardcoded; move to config"}
     ]
   }'
   ```

## CI Auto-Fix Loop

1. **Find the red run:**
   ```bash
   composio execute GITHUB_LIST_WORKFLOW_RUNS_FOR_A_REPOSITORY \
     -d '{"owner":"acme","repo":"app","branch":"feat/billing","status":"failure"}'
   ```
2. **Pull logs:**
   ```bash
   composio execute GITHUB_DOWNLOAD_WORKFLOW_RUN_LOGS \
     -d '{"owner":"acme","repo":"app","run_id":123456}'
   ```
3. **Parse failure → patch locally** (the agent writes the fix into the working tree).
4. **Commit + push** via local `git`, then re-poll step 1 until `conclusion=success`.
5. **Post a PR comment** describing each fix commit so the human reviewer sees what changed.

## One-Shot Workflow File

Save as `scripts/review-and-fix.ts` and run with `composio run --file ./scripts/review-and-fix.ts -- --pr 482`:

```ts
const pr = process.argv.includes("--pr")
  ? Number(process.argv[process.argv.indexOf("--pr") + 1])
  : null;

const meta = await execute("GITHUB_GET_A_PULL_REQUEST", {
  owner: "acme",
  repo: "app",
  pull_number: pr,
});
const files = await execute("GITHUB_LIST_PULL_REQUESTS_FILES", {
  owner: "acme",
  repo: "app",
  pull_number: pr,
});

console.log(JSON.stringify({ meta, files }, null, 2));
```

## GitLab Variant

Swap slugs and param names:

```bash
composio execute GITLAB_GET_SINGLE_MERGE_REQUEST \
  -d '{"id":"acme/app","merge_request_iid":482}'
composio execute GITLAB_CREATE_NEW_MERGE_REQUEST_NOTE \
  -d '{"id":"acme/app","merge_request_iid":482,"body":"CI fix pushed as commit deadbeef"}'
```

## Troubleshooting

- **`Connection required for github`** → `composio link github`
- **Unknown input shape** → `composio execute <SLUG> --get-schema`
- **Log download huge** → stream via `composio proxy` against the raw API and `grep` locally
- **Rate limits** → serialize calls or lower poll frequency; avoid `--parallel` for the same repo

Full CLI reference: [docs.composio.dev/docs/cli](https://docs.composio.dev/docs/cli)
