<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Anonymous-first REST recipes

Every recipe below works **without authentication** against public repositories unless explicitly marked. All were exercised against `apache/maka`. Set a base once:

```bash
API=https://api.github.com
H='-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28"'
```

Prefer `gh api <path>` when a token is already present (it paginates and sets headers for you); the raw `curl` form is the credential-free fallback that always works.

## 0. Resolve the canonical repository (always first)

```bash
# Redirect resolution — renamed/moved repos answer with 301 to the id-canonical URL.
curl -sSL https://api.github.com/repos/Maka-Agent/maka-agent | jq -r .full_name
# -> apache/maka
```

Reuse the resolved `OWNER/REPO` below.

## 1. A single issue or pull request

A PR *is* an issue for metadata; use `/issues/{n}` for state/labels/author/comment-count, `/pulls/{n}` for diff/merge details.

```bash
OWNER=apache REPO=maka N=4267
curl -sS "$API/repos/$OWNER/$REPO/issues/$N" \
  | jq '{number, title, state, author: .user.login, labels: [.labels[].name], comments, html_url}'
```

## 2. Comments on an issue/PR (paginated)

```bash
curl -sS "$API/repos/$OWNER/$REPO/issues/$N/comments?per_page=100" \
  | jq -r '.[] | "\(.user.login) @ \(.created_at):\n\(.body)\n---"'
```

If the response fills 100 items, follow the `Link` header:

```bash
curl -sSD /tmp/h.txt "$API/repos/$OWNER/$REPO/issues/$N/comments?per_page=100&page=1" -o /tmp/c.json
grep -i '^link:' /tmp/h.txt   # look for rel="next"
```

## 3. Timeline — labels, linked PRs, cross-references {#metadata}

The timeline endpoint is how you recover "linked work" without scraping. It needs the preview `Accept` on older servers but works on github.com anonymously:

```bash
curl -sS -H "Accept: application/vnd.github+json" \
  "$API/repos/$OWNER/$REPO/issues/$N/timeline?per_page=100" \
  | jq -r '.[] | select(.event | test("cross-referenced|connected|labeled|closed")) | .event'
```

Useful selectors:

- `cross-referenced` → `.source.issue.html_url` (issue/PR that mentions this one)
- `connected` / `disconnected` → linked PR lifecycle
- `labeled` / `unlabeled` → `.label.name`
- `closed` → `.commit_id` (closing commit, if any)

## 4. Search issues and PRs (anonymous, repo-scoped)

The Search API returns `200` anonymously; scope with `repo:` to keep the query cheap and specific.

```bash
Q='repo:apache/maka+harness+in:title+state:open'
curl -sS "$API/search/issues?q=$Q&per_page=20" \
  | jq -r '.items[] | "#\(.number) [\(.state)] \(.title)  \(.html_url)"'
```

Qualifiers worth knowing: `is:issue` / `is:pr`, `state:open|closed`, `label:"enhancement"`, `author:<login>`, `in:title,body`, `created:>2026-01-01`, `sort=updated`.

## 5. Pull request specifics

```bash
PR=4380
# Files + patch per file (no scraping of the "Files changed" tab)
curl -sS "$API/repos/$OWNER/$REPO/pulls/$PR/files?per_page=100" \
  | jq -r '.[] | "\(.status)\t+\(.additions)-\(.deletions)\t\(.filename)"'
# Review state and mergeability
curl -sS "$API/repos/$OWNER/$REPO/pulls/$PR" \
  | jq '{state, merged, mergeable, draft, base: .base.ref, head: .head.ref}'
```

Full unified diff without cloning:

```bash
curl -sS -H "Accept: application/vnd.github.v3.diff" \
  "$API/repos/$OWNER/$REPO/pulls/$PR" -o pr-$PR.diff
```

## 6. Repository facts (default branch, topics, redirect target)

```bash
curl -sS "$API/repos/$OWNER/$REPO" \
  | jq '{full_name, default_branch, description, open_issues_count, topics}'
```

## 7. Discussions (needs a token — see rate-limits reference)

There is **no anonymous Discussions list/search**. With a token:

```bash
gh api graphql -f query='
  query($owner:String!,$name:String!){
    repository(owner:$owner,name:$name){
      discussions(first:20, orderBy:{field:UPDATED_AT, direction:DESC}){
        nodes{ number title url category{name} answerChosenAt
               comments{totalCount} author{login} }
      }
    }
  }' -F owner=$OWNER -F name=$REPO
```

Anonymous GraphQL returns `403`; do not retry it unauthenticated, and do not scrape — escalate per the rate-limits reference.

## Notes

- Every JSON field above is canonical API data; reach for WebFetch/HTML only when the API cannot answer (Discussions without a token, or prose rendering).
- `jq` and `curl` are assumed present; if `jq` is unavailable, `gh api --jq` uses the built-in filter, and `python3 -m json.tool` is a portable pretty-printer.
