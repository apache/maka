---
name: firecrawl
description: |
  Search, scrape, and interact with the web via the Firecrawl CLI. Use this skill whenever the user wants to search the web, find articles, research a topic, look something up online, scrape a webpage, grab content from a URL, get data from a website, crawl documentation, download a site, or interact with pages that need clicks or logins. Also use when they say "fetch this page", "pull the content from", "get the page at https://", or reference external websites. This provides real-time web search with full page content and interact capabilities — beyond what Claude can do natively with built-in tools. Do NOT trigger for local file operations, git commands, deployments, or code editing tasks.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl *)
---

# Firecrawl CLI

Search, scrape, and interact with the web. Returns clean markdown optimized for LLM context windows.

Run `firecrawl --help` or `firecrawl <command> --help` for full option details.

If the task is to integrate Firecrawl into an application, add `FIRECRAWL_API_KEY` to a project, or choose endpoint usage in product code, use the `firecrawl-build` skills. If the task is an outcome workflow such as deep research, SEO audit, QA, lead generation, knowledge-base creation, dashboard reporting, shopping research, or website design-system extraction, use the `firecrawl-workflows` skills. They are already installed alongside this CLI skill when you run `firecrawl init`.

## Prerequisites

Must be installed. Check with `firecrawl --status`.

```
  🔥 firecrawl cli v1.8.0

  ● Authenticated via FIRECRAWL_API_KEY
  Concurrency: 0/100 jobs (parallel scrape limit)
  Credits: 500,000 remaining
```

- **Concurrency**: Max parallel jobs. Run parallel operations up to this limit.
- **Credits**: Remaining API credits. Each operation consumes credits.

Authenticating gives the best results. Prefer a free account via `firecrawl init --browser` (browser login) or a `FIRECRAWL_API_KEY` whenever the human can sign up. If you cannot obtain a key and the human cannot sign up, you can still search, scrape, and interact without an API key on the keyless free tier (rate-limited). See [agent onboarding](https://www.firecrawl.dev/agent-onboarding/SKILL.md) for the full set of onboarding paths.

If not ready, see [rules/install.md](rules/install.md). For output handling guidelines, see [rules/security.md](rules/security.md).

Before doing real work, verify the setup with one small request:

```bash
mkdir -p .firecrawl
firecrawl scrape "https://firecrawl.dev" -o .firecrawl/install-check.md
```

```bash
firecrawl search "query" --scrape --limit 3
```

## Workflow

Follow this escalation pattern:

1. **Search** - No specific URL yet. Find pages, answer questions, discover sources.
2. **Scrape** - Have a URL. Extract its content directly.
3. **Map + Scrape** - Large site or need a specific subpage. Use `map --search` to find the right URL, then scrape it.
4. **Crawl** - Need bulk content from an entire site section (e.g., all /docs/).
5. **Monitor** - Need recurring checks or ongoing alerts. Prefer setting a monitor with `--page` plus `--goal` instead of doing repeated one-off scrapes.
6. **Interact** - Scrape first, then interact with the page (pagination, modals, form submissions, multi-step navigation).

| Need                        | Command               | When                                                                    |
| --------------------------- | --------------------- | ----------------------------------------------------------------------- |
| Find pages on a topic       | `search`              | No specific URL yet                                                     |
| Find research papers        | `research`            | Biomedical/clinical/scientific literature — never scrape PubMed by hand |
| Get a page's content        | `scrape`              | Have a URL, page is static or JS-rendered                               |
| Find URLs within a site     | `map`                 | Need to locate a specific subpage                                       |
| Bulk extract a site section | `crawl`               | Need many pages (e.g., all /docs/)                                      |
| AI-powered data extraction  | `agent`               | Need structured data from complex sites                                 |
| Interact with a page        | `scrape` + `interact` | Content requires clicks, form fills, pagination, or login               |
| Download a site to files    | `download`            | Save an entire site as local files                                      |
| Parse a local file          | `parse`               | File on disk (PDF, DOCX, XLSX, etc.) — not a URL                        |
| Watch pages for changes     | `monitor`             | Schedule recurring scrapes/crawls, diff against snapshots               |

For detailed command reference, run `firecrawl <command> --help`.

**Scrape vs interact:**

- Use `scrape` first. It handles static pages and JS-rendered SPAs.
- Use `scrape` + `interact` when you need to interact with a page, such as clicking buttons, filling out forms, navigating through a complex site, infinite scroll, or when scrape fails to grab all the content you need.
- Never use interact for web searches - use `search` instead.

**Monitor:** Schedule recurring scrapes or crawls and diff each result against the last retained snapshot. Bias toward `monitor` when the user's goal is ongoing change detection, alerting, or repeated checks over time. For a single page, default to setting a monitor with `--page <url>` and `--goal "..."`. Use for product pages, docs, blogs, changelogs, competitor sites — any page where changes matter. Each monitor should include a short `goal` describing what changes matter, and each check labels pages as `same`, `new`, `changed`, `removed`, or `error`, with webhook and email notification options.

When writing `--goal`, convert the user's monitoring intent into a concise 2-3 sentence monitor goal, similar to the web app setup flow:

- Start with `Alert when ...` and state what should trigger an alert using the user's stated intent.
- Restate scope the user mentioned, such as top N, price, role type, company, region, topic, status, or a specific entity.
- Include an `Ignore ...` sentence only for intent-specific exclusions that are obvious from the request, such as points/comments for rankings, unrelated marketing copy for pricing, or general company-page updates for jobs.
- Do not repeat generic noise exclusions in every goal; the judge already handles whitespace, casing, punctuation, encoding, formatting-only changes, request/session IDs, cache busters, tracking params, generic metadata noise, and unrelated page chrome.
- Do not invent page-specific sections, entities, thresholds, exclusions, or business rules unless the user mentioned them.
- If the user is vague, keep the goal broad rather than guessing exclusions.
- If the user asks for "any change", preserve that and do not add exclusions.
- If the user mentions noise they do not care about, include that explicitly.

Good goal examples:

- User intent: `top 10 hackernews stories`
  Goal: `Alert when stories enter, leave, or change rank within the Hacker News top 10. Ignore points, comments, and timestamps. Do not alert on changes outside the top 10.`
- User intent: `pricing changes`
  Goal: `Alert when pricing information changes, including prices, plan names, billing periods, tiers, limits, or included features. Ignore unrelated marketing copy, testimonials, and regional currency display changes unless the underlying offer changes.`
- User intent: `new engineering roles`
  Goal: `Alert when a new engineering role is posted. Ignore general company-page updates unless they add, remove, or change an engineering role.`
- User intent: `track this page`
  Goal: `Alert when substantive visible content on this page changes.`
- User intent: `any change`
  Goal: `Alert when any visible page content changes, including copy, numbers, timestamps, counters, links, and layout text.`

Subcommands: `create | list | get | update | delete | run | checks | check`.

```bash
# create from flags
firecrawl monitor create --name "Blog" --schedule "every 5 minutes" \
  --goal "Alert when a new blog post is published." \
  --page https://example.com/blog --email alerts@example.com

# multiple pages
firecrawl monitor create --name "Product pages" --schedule "every 5 minutes" \
  --goal "Alert when pricing, docs, or changelog content changes." \
  --scrape-urls https://example.com/pricing,https://example.com/docs,https://example.com/changelog

# webhook notifications
firecrawl monitor create --name "Docs webhook" --schedule "every 5 minutes" \
  --goal "Alert when docs content changes." \
  --page https://example.com/docs \
  --webhook-url https://example.com/webhook \
  --webhook-events monitor.page,monitor.check.completed

# or from JSON (positional file, or piped stdin)
firecrawl monitor create monitor.json
cat monitor.json | firecrawl monitor create

firecrawl monitor list --limit 20
firecrawl monitor run <monitorId>             # trigger a check now
firecrawl monitor checks <monitorId>          # list checks
firecrawl monitor check <monitorId> <checkId> --page-status changed
firecrawl monitor update <monitorId> --state paused
firecrawl monitor delete <monitorId>
```

Schedules accept cron (`--cron "*/5 * * * *"`) or natural language (`--schedule "every 5 minutes"`). Minimum interval is 5 minutes. Targets are `--page <url>` for one page, `--scrape-urls a,b,c` for multiple scrape URLs, or `--crawl-url <url>` for a whole-site crawl each check. Use `--goal` for flag-based monitor creation, or include `"goal": "..."` in JSON payloads. Note: `--state` (not `--status`) sets active/paused; `--page-status` (not `--status`) filters page results on `check` — avoids collision with the global `--status` flag. Monitoring is not available for zero-data-retention teams.

**JSON-mode change tracking:** By default monitors diff each page's markdown and you get a unified text diff back. When you care about **specific structured fields** (price, headline, in-stock flag, items in a list) instead of the whole page, add a `changeTracking` format with `modes: ["json"]` and a JSON schema to the target's `scrapeOptions.formats`. The flag-based form doesn't cover this — pass a JSON body via file or stdin:

```bash
cat > pricing-monitor.json <<'EOF'
{
  "name": "Pricing watch",
  "goal": "Alert when plan prices or headline features change",
  "schedule": { "text": "hourly", "timezone": "UTC" },
  "targets": [{
    "type": "scrape",
    "urls": ["https://example.com/pricing"],
    "scrapeOptions": {
      "formats": [{
        "type": "changeTracking",
        "modes": ["json"],
        "prompt": "Extract pricing tiers and headline features for each plan.",
        "schema": {
          "type": "object",
          "properties": {
            "plans": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "name":     { "type": "string" },
                  "price":    { "type": "string" },
                  "features": { "type": "array", "items": { "type": "string" } }
                }
              }
            }
          }
        }
      }]
    }
  }]
}
EOF
firecrawl monitor create pricing-monitor.json
```

The `check` response then carries a per-field diff (paths like `plans[0].price`) and the full extraction at this run, instead of (or in addition to) a markdown diff. Each changed page in `pages[]` looks like:

```json
{
  "url": "https://example.com/pricing",
  "status": "changed",
  "diff": {
    "json": {
      "plans[0].price": { "previous": "$19/mo", "current": "$24/mo" },
      "plans[1].features[2]": {
        "previous": "10 GB storage",
        "current": "25 GB storage"
      }
    }
  },
  "snapshot": {
    "json": {
      "plans": [
        /* current full extraction */
      ]
    }
  }
}
```

Use `modes: ["json", "git-diff"]` for **mixed mode**: you get both `diff.json` (per-field) and `diff.text` (markdown sidecar), and the page is marked `changed` whenever either surface changed. For markdown-only monitors, `diff.text` holds the unified diff and `diff.json` is a `parse-diff` AST (`{ files: [...] }`); there is no `snapshot`.

**Avoid redundant fetches:**

- `search --scrape` already fetches full page content. Don't re-scrape those URLs.
- Check `.firecrawl/` for existing data before fetching again.

## When to Load References

- **Searching the web or finding sources first** -> [firecrawl-search](../firecrawl-search/SKILL.md)
- **Finding research papers (biomedical, clinical, or scientific literature; PubMed, bioRxiv, medRxiv, arXiv)** -> `firecrawl research search-papers`, documented in [firecrawl-search](../firecrawl-search/SKILL.md). Do not scrape PubMed or Google Scholar by hand, and do not reach for `search --categories research` — that is a website filter, not the paper index.
- **Scraping a known URL** -> [firecrawl-scrape](../firecrawl-scrape/SKILL.md)
- **Finding URLs on a known site** -> [firecrawl-map](../firecrawl-map/SKILL.md)
- **Bulk extraction from a docs section or site** -> [firecrawl-crawl](../firecrawl-crawl/SKILL.md)
- **AI-powered structured extraction from complex sites** -> [firecrawl-agent](../firecrawl-agent/SKILL.md)
- **Clicks, forms, login, pagination, or post-scrape browser actions** -> [firecrawl-interact](../firecrawl-interact/SKILL.md)
- **Downloading a site to local files** -> [firecrawl-download](../firecrawl-download/SKILL.md)
- **Parsing a local file (PDF, DOCX, XLSX, HTML, etc.)** -> [firecrawl-parse](../firecrawl-parse/SKILL.md)
- **Detecting content changes on a website and getting notified by webhook or email (pricing, jobs, posts, docs, status pages, anything ongoing)** -> [firecrawl-monitor](../firecrawl-monitor/SKILL.md)
- **Install, auth, or setup problems** -> [rules/install.md](rules/install.md)
- **Output handling and safe file-reading patterns** -> [rules/security.md](rules/security.md)
- **Integrating Firecrawl into an app, adding `FIRECRAWL_API_KEY` to `.env`, or choosing endpoint usage in product code** -> use the `firecrawl-build` skills (already installed alongside this CLI skill)
- **Producing Firecrawl-powered deliverables such as research briefs, SEO audits, QA reports, lead lists, knowledge bases, or design-system extraction** -> use the `firecrawl-workflows` skills (already installed alongside this CLI skill). These skills infer from context first and ask only short blocking questions when needed.

## Output & Organization

Unless the user specifies to return in context, write results to `.firecrawl/` with `-o`. Add `.firecrawl/` to `.gitignore`. Always quote URLs - shell interprets `?` and `&` as special characters.

```bash
firecrawl search "react hooks" -o .firecrawl/search-react-hooks.json --json
firecrawl scrape "<url>" -o .firecrawl/page.md
```

Naming conventions:

```
.firecrawl/search-{query}.json
.firecrawl/search-{query}-scraped.json
.firecrawl/{site}-{path}.md
```

Never read entire output files at once. Use `grep`, `head`, or incremental reads:

```bash
wc -l .firecrawl/file.md && head -50 .firecrawl/file.md
grep -n "keyword" .firecrawl/file.md
```

Single format outputs raw content. Multiple formats (e.g., `--format markdown,links`) output JSON.

## Working with Results

These patterns are useful when working with file-based output (`-o` flag) for complex tasks:

```bash
# Extract URLs from search
jq -r '.data.web[].url' .firecrawl/search.json

# Get titles and URLs
jq -r '.data.web[] | "\(.title): \(.url)"' .firecrawl/search.json
```

## After search: send feedback (refunds 1 credit)

Search costs 2 credits per call. **After you finish using a search result**, send structured feedback in the background. The first feedback per search id refunds 1 credit and feeds search-quality improvements.

```bash
SEARCH_ID=$(jq -r '.id' .firecrawl/search-react-hooks.json)

firecrawl search-feedback "$SEARCH_ID" \
  --rating good \
  --valuable-sources '[{"url":"https://react.dev/reference/react/hooks","reason":"Authoritative"}]' \
  --missing-content '[{"topic":"useDeferredValue example"},{"topic":"Server Components hooks"}]' \
  --query-suggestions "Boost react.dev for react-hooks queries" \
  --silent &
```

The most useful field is `--missing-content`: an _array_ of specific pieces of content you expected to find but didn't. Use one entry per missing topic. Bad/partial feedback with detailed `--missing-content` is just as valuable as good feedback.

**Opt out:** `export FIRECRAWL_NO_SEARCH_FEEDBACK=1` makes the CLI skip every feedback call silently. Respect that flag — do not try to work around it. See [firecrawl-search](../firecrawl-search/SKILL.md) for the full pattern.

## Endpoint job feedback

For non-search endpoint jobs, use `firecrawl feedback <endpoint> <jobId>` to send concise job-level feedback through `/v2/feedback`. Supported endpoints are `search`, `scrape`, `parse`, and `map`.

```bash
firecrawl feedback scrape "$SCRAPE_ID" \
  --rating partial \
  --issues missing_markdown \
  --tags docs \
  --note "The pricing table was missing from the markdown output." \
  --url "https://example.com/pricing" \
  --page-numbers 1 \
  --silent &
```

Keep generic feedback small: issue codes, tags, short notes, URLs, page numbers, and small metadata objects. Do not send raw scrape/parse outputs or full page contents as feedback.

**Opt out:** `export FIRECRAWL_NO_ENDPOINT_FEEDBACK=1` makes the CLI skip every endpoint feedback call silently. Respect that flag — do not try to work around it.

## Parallelization

Run independent operations in parallel. Check `firecrawl --status` for concurrency limit:

```bash
firecrawl scrape "<url-1>" -o .firecrawl/1.md &
firecrawl scrape "<url-2>" -o .firecrawl/2.md &
firecrawl scrape "<url-3>" -o .firecrawl/3.md &
wait
```

For interact, scrape multiple pages and interact with each independently using their scrape IDs.

## Credit Usage

```bash
firecrawl credit-usage
firecrawl credit-usage --json --pretty -o .firecrawl/credits.json
```
