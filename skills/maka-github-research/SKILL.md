---
name: maka-github-research
description: Research public GitHub repositories — issues, pull requests, discussions, comments, and timelines — with an anonymous-first, evidence-backed workflow. Use when Maka must inspect public GitHub work (including its own apache/maka tracker) without local CLI credentials, HTML scraping, or several custom parsers. It resolves canonical repository redirects, prefers unauthenticated REST, paginates deterministically, records rate-limit evidence, and escalates to authentication only when the endpoint provably requires it. Do not use it to weaken the Host sandbox, to embed credentials in the model context, or to promote a forge adapter into core; it is a research recipe layer, not a new authority.
---
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

# Maka GitHub Research

Inspect public GitHub repositories predictably and cheaply. This skill replaces the fragile improvised chain that a real Maka session had to build for ordinary public research (`gh search` → `401` → anonymous REST → repository redirect discovery → REST issue fetch → GraphQL auth failure → HTML scraping → link extraction → per-page fetch → extra metadata calls). The goal is one dependable route, not ten unrelated ones.

Tracks the "Structured public GitHub research" item of the harness friction umbrella (apache/maka#4267, item 4): *public repository research should not require local CLI credentials, HTML scraping, and several custom parsers.*

## Core principle: anonymous-first, escalate on evidence

1. **Assume no credentials.** Public repositories are fully researchable over unauthenticated REST. Start there so the workflow is reproducible on any machine and never blocks on a stale or scoped local token.
2. **Escalate only when an endpoint provably rejects anonymous access** (HTTP `401`/`403` from the endpoint itself, not a guess). Discussions search is the main case — see below.
3. **Do not scrape HTML** to recover data the REST API already returns as JSON (author, state, labels, comments, timeline, linked work). HTML scraping is the fallback of last resort, never the default.
4. **Record rate-limit evidence** (`X-RateLimit-Remaining` / `-Reset`) whenever you report results, so the user sees the real budget instead of a silent failure when it runs out.

## Workflow

1. **Resolve the canonical repository first.** Owners rename and redirect (the observed session hit `Maka-Agent/maka-agent` → `apache/maka`). Follow the redirect before any other call so every later request targets the real repository:

   ```bash
   curl -sSL -o /dev/null -w '%{url_effective}\n' \
     https://api.github.com/repos/Maka-Agent/maka-agent
   # -> https://api.github.com/repositories/1251460378  (id-canonical)
   curl -sSL https://api.github.com/repos/Maka-Agent/maka-agent \
     | grep '"full_name"'
   # -> "full_name": "apache/maka",
   ```

   Use the resolved `owner/repo` (or the numeric `repositories/{id}` form) for everything downstream.

2. **Pick the narrowest endpoint for the question.** Prefer a direct object read over search; prefer search over listing; prefer any REST route over scraping. See `references/rest-recipes.md` for copy-paste recipes covering: single issue/PR, comments, timeline (labels, cross-references, linked PRs), issue/PR search, per-file PR diff, and discussions.

3. **Paginate deterministically.** Use `per_page=100` and follow the `Link: rel="next"` header (or increment `page=` until an empty array). Never assume the first page is complete.

4. **Collect metadata from the API, not the page.** Canonical URL (`html_url`), author (`user.login`), `state`, `labels[].name`, `comments`, and linked work (timeline `cross-referenced` / `connected` events) are all JSON fields. Read `references/rest-recipes.md#metadata` for the exact `jq` selectors.

5. **Attach rate-limit evidence to the answer.** Report remaining budget and reset time; if a call fails, distinguish "rate-limited" from "not found" from "needs auth" using the response headers and status — do not report an empty result as "nothing found."

## Discussions: the one endpoint that needs auth

GitHub Discussions have **no anonymous REST list/search**; the data lives behind GraphQL, and unauthenticated GraphQL returns `403` (verified). Do **not** fall straight to HTML scraping. In order:

1. Try the REST search API scoped to the repo (`/search/issues` covers issues and PRs anonymously) for adjacent context.
2. For Discussions specifically, escalate to a token per `references/rate-limits-and-escalation.md` and use the documented GraphQL query — this is the sanctioned exception, gated on the `403` evidence.
3. Only if authentication is genuinely unavailable, fetch the discussion `html_url` with WebFetch for the body, and state explicitly in the result that metadata (labels, answer state, comment authors) could not be recovered anonymously.

## Escalation ladder

Anonymous REST → repo-scoped REST search → authenticated REST/GraphQL (only on `401`/`403` from the endpoint) → WebFetch of the canonical `html_url` (content only) → HTML scraping (last resort, flagged as lossy). Never skip a rung to reach for scraping. See `references/rate-limits-and-escalation.md` for exactly when and how to add a token without leaking it into the model context.

## Non-goals

- Not a new capability, permission, or network authority; it runs entirely on tools Maka already exposes (`ShellRun`/`curl`, `gh`, `WebFetch`).
- Does not embed or print credentials. Tokens come from the environment/`gh` keyring; never echo them.
- Does not promote a forge adapter into core. If a recurring need justifies that, open a focused issue — this skill is the unauthenticated-first precursor the umbrella asks for.

## References

- `references/rest-recipes.md` — tested anonymous-first recipes for every common object and query.
- `references/rate-limits-and-escalation.md` — rate-limit budgets, evidence headers, the discussions/GraphQL exception, and safe token escalation.
