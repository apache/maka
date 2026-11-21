---
name: firecrawl-agent
description: Autonomously navigate websites and extract structured data across pages. Use when the task requires navigation or no suitable ready-made workflow or data provider covers it.
allowed-tools:
  - Bash(firecrawl *)
  - Bash(npx firecrawl-cli *)
---

# firecrawl agent

AI-powered autonomous extraction. The agent navigates sites and extracts structured data (takes 2-5 minutes).

Before starting autonomous extraction for structured records or listings, check `firecrawl search alexandria '<data you need>'` for a ready-made workflow or data provider. Inspect a matching contract with `firecrawl list <provider> <capability> --pretty` and execute with `firecrawl scrape --alexandria <provider>/<capability> --options '<input JSON>'` if it covers the task. Use the exact provider, capability, and input fields from that contract. Continue with Agent when no suitable tool exists or the task requires autonomous navigation.

## Quick start

```bash
# Extract structured data
firecrawl agent "extract all pricing tiers" --wait --json -o .firecrawl/pricing.json

# With a JSON schema for structured output
firecrawl agent "extract products" --schema '{"type":"object","properties":{"name":{"type":"string"},"price":{"type":"number"}}}' --wait --json -o .firecrawl/products.json

# Focus on specific pages
firecrawl agent "get feature list" --urls "<url>" --wait --json -o .firecrawl/features.json
```

Run `firecrawl agent --help` for the full option list.

**Done when:** the output file contains valid JSON answering the request — or a job ID was intentionally returned for later polling.

## Job IDs

Omitting `--wait` returns a job ID. A UUID positional argument is auto-detected as a status check:

```bash
# Check once (equivalent to adding --status)
firecrawl agent "<job-id>"

# Wait on an existing job, polling every 10 seconds for up to 5 minutes
firecrawl agent "<job-id>" --wait --poll-interval 10 --timeout 300

# Cancel an active job
firecrawl agent "<job-id>" --cancel
```

## Tips

- Use `--wait` for inline results; omit it only when you want a job ID to poll later (see [Job IDs](#job-ids)).
- Use `--schema` for predictable, structured output — otherwise the agent returns freeform data.
- Agent runs consume more credits than simple scrapes. Use `--max-credits` to cap spending.
- For simple single-page extraction, prefer `scrape` — it's faster and cheaper.

## See also

- [firecrawl-scrape](../firecrawl-scrape/SKILL.md) — simpler single-page extraction
- [firecrawl-interact](../firecrawl-interact/SKILL.md) — scrape + interact for manual page interaction (more control)
- [firecrawl-crawl](../firecrawl-crawl/SKILL.md) — bulk extraction without AI
- [firecrawl-build-scrape](https://github.com/firecrawl/skills/tree/main/skills/build/firecrawl-build-scrape) — building structured extraction into an app instead of running it here

## Alexandria session feedback

To report an Alexandria session outcome or a provider/capability gap, use `firecrawl alexandria feedback --rating good|partial|bad --url <website> --requested-functionality '<what was needed>' --rationale '<what happened>' --json`. Use observed results in the rationale. No job ID is needed; this session feedback has no job-age deadline and no credit refund. Optional `--provider-feedback` and `--capability-feedback` JSON arrays describe specific gaps; inspect `firecrawl alexandria feedback --help` for their fields. Use the capability issue `missing_capability` when a provider exists but lacks the needed capability, and `new_capability_request` (with `requestedFunctionality`) to ask for one.
