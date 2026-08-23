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

# Search Service Threat Model

> Archived on 2026-07-13. This document records the PR-SEARCH-0/1.5 contract boundary, not the current search product implementation. Source and focused tests own the active contract.

PR-SEARCH-0 is a contract-only package. It must not add a real provider, browser engine, renderer network call, cache writer, or runtime search execution path.

PR-SEARCH-1.5 (this revision) adds the `SearchResultTarget` closed discriminated union (currently only `{ kind: 'thread'; sessionId: string; turnId?: string }`) so source-kind-specific navigation hints stay typed. Adding a new variant (memory / activity / etc.) is an explicit contract change. Thread navigation deliberately does NOT use `maka://session/<id>` — `packages/ui/src/maka-uri.ts:24` defers that scheme until a real session navigation contract exists. Renderers consume `SearchResult.target` for navigation; `SearchResult.url` stays reserved for `web` / `web_fetch` external results.

## Source Separation

Search is not one source. Maka must keep these sources typed and visibly separate:

- `thread`: local session/thread text search.
- `memory`: local or provider-backed semantic memory search.
- `activity`: future OCR/activity search, gated by Screen Recording and retention settings.
- `tool`: tool discovery, bounded by existing tool permission mode.
- `web`: external web search through an explicit provider.
- `web_fetch`: URL fetch/extraction, treated as active untrusted content.

Local private sources (`thread`, `memory`, `activity`) must not be silently mixed with external `web` results. UI and tool outputs should show source kind.

## Assets

- search query text;
- result titles, URLs, snippets, summaries, and markdown;
- cookies and browser session state;
- provider credentials and base URLs;
- chat history, memories, and future OCR/activity text;
- cache entries and embeddings;
- citation indexes injected into LLM context.

## Boundaries

1. Renderer to main: renderer can request search only through typed IPC.
2. Main to provider/site: query/result data may leave the machine.
3. Browser page to app: HTML/JS/CSS is untrusted active content.
4. Result to renderer: no raw HTML rendering.
5. Local private stores to LLM: memory/activity results may be prompt-injected only with explicit source semantics.
6. Cache/persistence: results and embeddings can become long-lived local data.

## Required Gates Before Web Search

- `normalizeSearchQuery`, `normalizeSearchLimit`, `normalizeSearchDomainList`, and `normalizeSearchUrl` before provider calls.
- URL scheme allowlist: only `http:` and `https:`.
- Redirect/private-network policy before URL fetch.
- Domain allow/block suffix matching; blocked wins.
- Result and total-output byte caps.
- AbortSignal and wall-clock timeout.
- No query/snippet/markdown bodies in telemetry.
- Cache policy with TTL, refresh bypass, and no authenticated page caching by default.
- Browser mode must use isolated partitions by default; no defaultSession cookie reuse.
- CAPTCHA/challenge returns `needs_human_browser`, not indefinite hidden-browser waiting.

## What Not To Copy From reference implementation

- Hidden Google scraping as the default Search Service.
- `defaultSession` browser/cookie reuse.
- Cookie sync from debug windows into search/fetch sessions.
- Cookie import/export without typed payload, user action, and audit log.
- Raw HTML rendering in the app.
- One untyped result list that mixes local thread/memory/activity and external web.

## Minimum Test Matrix

- query trim, empty reject, type reject, length cap;
- limit default/clamp/reject;
- domain canonicalization, dedupe, suffix matching;
- URL scheme allowlist and tracking parameter stripping;
- freshness rewrite for latest/today/now/今天/最新 queries;
- no rewrite for historical/archive/since/过去 queries;
- citation indexes monotonic once execution exists;
- timeout/abort returns structured error once execution exists;
- renderer has no direct network primitive for search once IPC exists;
- telemetry omits snippets and markdown bodies once execution exists.
