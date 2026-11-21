---
name: firecrawl-search
description: Find web sources with query-relevant page excerpts and optional full-page content, and discover workflows, data APIs, and indexes. Use for web research or finding structured records, listings, transcripts, and datasets. Supports semantic tool discovery, domain matching, and progressive catalogue browsing.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl-cli *)
---

# firecrawl search

Search naturally using the user’s actual question. Default search returns web results plus relevant Alexandria tools, with optional web content scraping.

For structured records, filterable listings, transcripts, or datasets, first check `firecrawl search alexandria '<data you need>'` for a suitable workflow or data provider. For a known website, use `firecrawl find-tools <url>`. Inspect a selected contract with `firecrawl list <provider> <capability> --pretty` before executing it through `scrape`; reuse a complete contract already returned by discovery. If no suitable tool exists, continue with web search or Agent. Use ordinary `search` for web research and URL `scrape` for a known page.

## Quick start

```bash
# Basic search
firecrawl search "your query" -o .firecrawl/result.json --json

# Search and scrape full page content from results
firecrawl search "your query" --scrape -o .firecrawl/scraped.json --json

# News from the past day
firecrawl search "your query" --sources news --tbs qdr:d -o .firecrawl/news.json --json
```

Use `firecrawl search --help` for search options, `firecrawl list --help` for contract browsing, and `firecrawl scrape --help` for execution options.

`--categories developer` searches an index of public repositories, GitHub issues, merged pull requests, repository READMEs, and curated documentation sites. `--categories research` is a website filter, not the paper index. Dedicated skills: [firecrawl-developer-index](../firecrawl-developer-index/SKILL.md) and [firecrawl-research-index](../firecrawl-research-index/SKILL.md).

**Done when:** relevant results have been inspected, per-call errors and empty results have been checked, the request has been answered with source links, and feedback is sent within the time window unless opted out.

## Go beyond page content with Alexandria

Alexandria is a catalogue of ready-made website workflows, API providers, and specialized indexes. Depending on the tool, it can return structured records, detailed listings, financial data, company information, research, or public records that a search snippet or single scraped page does not contain. Discover current coverage rather than assuming a provider or capability exists.

- **Semantic discovery** matches the meaning of the user's question to tool capabilities, even when no relevant provider website appears in the web results. Use `firecrawl search alexandria '<data you need>'` when you specifically need tools.
- **Domain matching** surfaces tools associated with websites in the web results. A matched tool may retrieve richer details, related records, or structured collections beyond the linked page. Domain matching signals relevance, not proof that the tool covers the requested fields or market.
- **Combined search** uses both paths alongside web results by default: `firecrawl search '<user question>'`. Use the web result when sufficient; inspect a matching tool when it offers a more direct route to the required data.

### Inspect before execution

Search defaults to `web,alexandria` with domain-tool matching on. Preserve the user's location, marketplace, and constraints in the query; do not turn normal research into an artificial tool-discovery query. Inspect `data.web` and `data.tools` from the same response.

Search returns compact tool matches by default: only `provider`, `capability`, and `description`. A match is not executed data. Select a candidate, then run `firecrawl list <provider> <capability> --pretty` with its provider and capability IDs to read the contract's inputs, coverage, and access requirements.

Use `--tool-detail summary --json` for discovery metadata and navigation; inspect the selected contract with `list` before execution. Use `--tool-detail full --json` to receive contracts directly in search results and reuse them without another inspection call. Prefer full when several related contracts will be needed immediately. Displayed pricing is informational, not an extra confirmation gate.

After inspecting the contract, execute with `firecrawl scrape <provider/capability> --options '<input JSON>'` (`--alexandria` remains supported). All provider execution goes through Scrape; `search --scrape` only fetches web result content, not provider tools.

Use `list` for category/provider browsing and selected contracts. For a known website, `find-tools <url>` discovers associated tools without executing them. Run `firecrawl find-tools --help` for advanced catalogue selectors; avoid broad expansion unless the task needs it.

If no returned tool covers the country/market/segment or required inputs, continue with ordinary web results. Do not exhaust the catalogue or pay for adjacent tools just to probe coverage. `--sources web` explicitly opts out of Alexandria; `--sources web --domain-tools` retains domain matches only.

For Alexandria feedback about a provider result or coverage gap, see [firecrawl-alexandria](../firecrawl-alexandria/SKILL.md).

## Progressive discovery and output handling

```bash
# Web + domain matching + semantic tools
firecrawl search '<user question>'

# Semantic tools only
firecrawl search alexandria '<user question>'

# Categories → providers → tools → contract
firecrawl list
firecrawl list <category-id> --category
firecrawl list <provider-id>
firecrawl list <provider-id> <capability-id> --pretty

# Execute a tool
firecrawl scrape <provider-id>/<capability-id> --options '<JSON matching the selected contract>'
```

Default search combines web results, domain matches and semantic tools; `search alexandria` returns semantic tool matches only. Read the selected contract instead of expanding the entire catalogue. Tool discovery is not execution.

Keep large search responses in `--json -o` output and select the relevant results. If a subsequent provider execution or URL scrape exceeds the agent's output limit, use its retained ID with the [remote Bash recovery instructions](../firecrawl-scrape/references/large-results.md). Search request IDs are not supported Bash inputs. Do not blindly rerun a successful provider because the client could not display its result.

## Tips

- **`--highlights` on by default:** results are query-relevant excerpts from the page. Use `--no-highlights` for the original snippets.
- **`--scrape` fetches full content** — reuse that content instead of re-scraping result URLs. This saves credits and avoids redundant fetches.
- For large results, use `-o` and bounded local reads when a filesystem is available. Do not dump the full response into context.
- Use `jq` to extract URLs or titles: `jq -r '.data.web[].url' .firecrawl/search.json`
- Naming convention: `.firecrawl/search-{query}.json` or `.firecrawl/search-{query}-scraped.json`

## Send feedback after every search (refunds 1 credit)

Search costs 2 credits. After you've actually used the results (or decided they were useless), send structured feedback with `firecrawl search-feedback <id>`. The first feedback per search refunds 1 credit and helps us improve search quality. **Do this once per search**, in the background, after you finish processing the results — it does not block your main task.

**Opt out:** if `FIRECRAWL_NO_SEARCH_FEEDBACK=1` (or `FIRECRAWL_DISABLE_SEARCH_FEEDBACK=1`) is set, the CLI silently skips the call and never sends anything. Respect that — do not try to work around it. (Team admins can also disable this server-side; the API will return `feedbackErrorCode: "TEAM_OPTED_OUT"` and the CLI will exit 0 silently.)

**Rules to know before you call this:**

- **Time window:** must be sent within ~2 minutes of the search. Late feedback is rejected.
- **`--missing-content` is the most important field.** It's a list of _specific pieces_ of content you expected but did not find. One topic per entry, each in its own string. These aggregate across teams and tell us what to index next.
- **Substantive content required** (zero-effort feedback is rejected with HTTP 400):
  - `good` → must include at least one `--valuable-sources` entry.
  - `partial` → must include `--valuable-sources` or `--missing-content`.
  - `bad` → must include `--missing-content` or `--query-suggestions`.
- **Daily refund cap (per team, per UTC day, default 100 credits).** Once your team has been refunded 100 credits today, further submissions still record feedback but no longer refund credits. The response includes `creditsRefundedToday` / `dailyRefundCap` / `dailyCapReached`. **When `dailyCapReached: true`, stop calling `search-feedback` for the rest of the UTC day** — it won't refund anything and you're wasting bandwidth.
- **Idempotent:** re-submitting for the same search id returns success but no extra refund.
- **`--silent &`** is the right pattern — exit code 0 even on failure, so a rejected/expired call never crashes your pipeline.

Verify the search returned results before reading its `id`. Zero-result searches write no output file, so the file may be missing — or left over from an earlier search. The guard below skips feedback when the file is missing or has zero results; call `search-feedback` only inside it:

```bash
# Send once per search. Rate honestly and replace the placeholder with the
# rating that matches what actually happened. The two fields shown
# satisfy the substantive-content rule for every rating.
if SEARCH_ID=$(jq -er 'select(any(.data[]; length > 0)) | .id' .firecrawl/search-react-hooks.json); then
  firecrawl search-feedback "$SEARCH_ID" \
    --rating "<good|partial|bad>" \
    --valuable-sources '[{"url":"https://react.dev/reference/react/hooks","reason":"Most authoritative"}]' \
    --missing-content '[{"topic":"useDeferredValue","description":"No example of useDeferredValue with Suspense"}]' \
    --silent &
fi
```

**`--missing-content` accepts:**

- JSON array of `{topic, description?}` objects (richest, preferred)
- `"topic: description"` strings (shorthand)
- Plain `"topic1, topic2, topic3"` (when you only have topic names)
- Repeated `--missing-content` flags

`--silent` suppresses output and `&` runs it in the background so feedback never blocks you.

## See also

- [firecrawl-scrape](../firecrawl-scrape/SKILL.md) — scrape a specific URL
- [firecrawl-map](../firecrawl-map/SKILL.md) — discover URLs within a site
- [firecrawl-crawl](../firecrawl-crawl/SKILL.md) — bulk extract from a site
- [firecrawl-developer-index](../firecrawl-developer-index/SKILL.md) — issues, merged PRs, READMEs, and docs
- [firecrawl-research-index](../firecrawl-research-index/SKILL.md) — published papers, not `search --categories research`
- [firecrawl-build-search](https://github.com/firecrawl/skills/tree/main/skills/build/firecrawl-build-search) — building search into an app instead of running it here
