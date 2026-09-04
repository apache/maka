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

# Rate limits, evidence, and safe escalation

## Anonymous budget (measure, don't assume)

Unauthenticated REST is limited **per source IP**. Read the real budget instead of guessing:

```bash
curl -sSD - -o /dev/null https://api.github.com/rate_limit \
  | grep -i '^x-ratelimit-'
# X-RateLimit-Limit: 60
# X-RateLimit-Remaining: 33
# X-RateLimit-Reset: 1725446400   # unix seconds
```

Observed anonymous ceilings (subject to change — always confirm from headers):

| Endpoint family        | Anonymous limit        | Notes                                            |
|------------------------|------------------------|--------------------------------------------------|
| Core REST (`/repos/…`) | ~60 requests / hour    | Shared across all core calls from the IP.        |
| Search (`/search/…`)   | ~10 requests / minute  | Separate bucket from core.                        |
| GraphQL (`/graphql`)   | **auth required**      | Anonymous returns `403`.                          |

Every REST response carries these headers — attach `Remaining`/`Reset` to any result you report so the user sees the budget, and back off (or escalate) *before* hitting zero rather than after.

## Classify failures — never report an empty result as "nothing found"

| Symptom                                           | Meaning                              | Action                                                        |
|---------------------------------------------------|--------------------------------------|---------------------------------------------------------------|
| `403` + `X-RateLimit-Remaining: 0`                | Rate-limited, not forbidden          | Wait until `Reset`, or authenticate to raise the ceiling.     |
| `403` on `/graphql` (Discussions)                 | Endpoint needs auth                  | Escalate to a token; do not scrape first.                     |
| `401`                                             | A token was sent and is bad/expired  | Fall back to **anonymous** (drop the token), then re-auth.    |
| `404` on a known-public repo                      | Renamed/moved                        | Re-resolve the canonical repo (redirect step).                |
| `301`/`302`                                        | Repo redirect                        | Follow with `-L`; use the resolved `full_name`.               |
| `200` + empty `items`                             | Genuinely no matches                 | Report as empty *with* the query used, so it can be widened.  |

The observed session's `gh search` `401` was this table's row 3: a local token was present but rejected. The fix is to drop to anonymous REST immediately, which is why this skill starts there.

## Escalation ladder (in order; stop at the first that answers)

1. **Anonymous REST** — direct object read, then repo-scoped search.
2. **Authenticated REST/GraphQL** — only when the endpoint itself returns `401`/`403` (Discussions, or you exhausted the anonymous budget). Raises limits to ~5,000 core req/hour and unlocks GraphQL.
3. **WebFetch of the canonical `html_url`** — for prose/rendering the API does not expose; content only, metadata flagged as unavailable.
4. **HTML scraping** — last resort, explicitly labelled lossy in the result.

## Adding a token without leaking it

- Prefer the existing `gh` keyring: `gh api <path>` and `gh api graphql` use it automatically. Confirm with `gh auth status` (do **not** print the token).
- If using raw `curl`, read the token from the environment, never a literal:

  ```bash
  curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" "$API/…"
  ```

- Never echo, log, or paste a token into the transcript, a commit, or a tool argument that is rendered back. Redact it if a command would surface it.
- A read-only public-repo research task needs no scopes beyond default read; do not request write scopes for research.

## When to stop using this skill and open an issue instead

If a workflow repeatedly needs authenticated GraphQL (heavy Discussions research) or structured cross-repo aggregation, that is the signal to open a focused issue for a first-class forge research surface — the umbrella (apache/maka#4267) explicitly wants this unauthenticated-first skill *before* any adapter is promoted into core. Capture the concrete recurring need in that issue rather than growing this skill into a de-facto adapter.
