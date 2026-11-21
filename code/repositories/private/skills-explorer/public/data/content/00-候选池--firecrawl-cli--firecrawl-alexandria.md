---
name: firecrawl-alexandria
description: Find a direct path to structured data through ready-made workflows, data APIs, and indexes. Follow the search skill to discover and inspect tools, then the scrape skill to execute them.
---

# A direct path to structured data

Alexandria brings ready-made website workflows, API providers, and specialized indexes into Firecrawl search and scrape. Semantic discovery finds capabilities by the data you need; domain matching connects web results to tools that may retrieve richer structured data beyond the page. Discover a tool that fits the task and get structured results directly, reducing the browsing, parsing, and repeated requests needed to assemble the data yourself.

- [Search](../firecrawl-search/SKILL.md) to find web results and relevant tools, then inspect only the contracts needed for the task.
- [Scrape](../firecrawl-scrape/SKILL.md) to execute a selected tool or read a URL. For large retained results, use its remote Bash guidance to select the data you need.

Use ordinary web results when they answer the question; use a provider tool when its coverage and inputs fit.

## Alexandria feedback

Alexandria coverage grows from what agents report. If you choose to report how the catalogue served a task, send at most one `firecrawl alexandria feedback` per website you needed data from after finishing the task. It is free: no job ID, no time window, no credit refund.

Feedback can describe any of these outcomes:

- A tool answered the need, fully or partly.
- A tool ran but returned wrong or incomplete data, or failed.
- No provider covers the website, or a provider exists but lacks the capability you needed, and you fell back to web search, scrape, or Agent.

**Opt out:** if `FIRECRAWL_NO_ENDPOINT_FEEDBACK=1` (or `FIRECRAWL_DISABLE_ENDPOINT_FEEDBACK=1`) is set, the CLI silently skips the call and never sends anything. Respect that; do not try to work around it. (Team admins can also disable this server-side; the API returns `feedbackErrorCode: "TEAM_OPTED_OUT"` and the CLI exits 0 silently.)

**Rules to know before you call this:**

- **`--url` is the website the user needed data from**, not the provider and not a Firecrawl page. `--requested-functionality` is what they needed from it, in one sentence. These two fields are the most important: they aggregate across teams and tell us which sites and workflows to add next.
- **`--rationale` explains the rating** from observed results: which provider or capability served or failed the need, and how. Two or three sentences, no raw results pasted in.
- **`--provider-feedback`** is a JSON array of `{name, issue, why}` for providers that were missing, thin, or unavailable. Issues: `missing_provider` (no provider covers the site), `insufficient_coverage` (exists, but data was thin, stale, or partial for this market or segment), `provider_unavailable` (could not be called), `other`.
- **`--capability-feedback`** is a JSON array of `{name, provider, issue, why, requestedFunctionality?}` for capabilities that were missing, wrong, or failed. Issues: `new_capability_request` (ask the provider to add one; `requestedFunctionality` required), `missing_capability` (provider exists but lacks it), `insufficient_functionality` (exists but cannot take the input or filter you needed), `incorrect_result`, `execution_error`, `other`. Use `name` and `provider` exactly as discovery returned them; for a capability that does not exist yet, name what it should be.
- **Rate honestly:** `good` when a tool answered the need, `partial` when it answered some of it or with gaps, `bad` when nothing available answered it or what ran was wrong or failed.
- **`--silent &`** is the right pattern: exit code 0 even on failure, so a rejected call never crashes your pipeline.

```bash
# Example: send at most once per website after the task is done. Replace the
# placeholders with what actually happened; drop --provider-feedback or
# --capability-feedback when there is nothing to report at that level.
firecrawl alexandria feedback \
  --rating "<good|partial|bad>" \
  --url "https://sam.gov" \
  --requested-functionality "Active contracts by agency with their attachments" \
  --rationale "sam-gov/contracts returned the contract list, but no capability exposes attachment links, so those were scraped from the web instead." \
  --capability-feedback '[{"name":"attachments","provider":"sam-gov","issue":"new_capability_request","why":"Attachments were the point of the task","requestedFunctionality":"Given a contract ID, return attachment URLs and document text"}]' \
  --silent &
```

If you report a site with no provider coverage, use `--provider-feedback '[{"name":"<site or provider>","issue":"missing_provider","why":"<what was needed>"}]'` and rate `bad`; that is the signal we use to onboard new providers.

`--silent` suppresses output and `&` runs it in the background so feedback never blocks you. Run `firecrawl alexandria feedback --help` for every option.
