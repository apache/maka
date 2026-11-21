---
name: datadog-logs
description: Query and filter Datadog logs from the shell using the Composio CLI. Run scoped log searches, pivot across services/environments, and export structured JSON for downstream agents instead of click-driving the Datadog UI.
metadata:
  short-description: Datadog log filtering via the Composio CLI
---

# Datadog Logs

Query Datadog logs through the [Composio CLI](https://docs.composio.dev/docs/cli) so the agent can filter, pivot, and summarize without you pasting screenshots.

## When to Use

- Investigating a spike, error surge, or latency regression and you want structured JSON back.
- Correlating a deploy with log volume changes across services/environments.
- Building a scheduled "what broke overnight" digest.

## Prereqs

```bash
curl -fsSL https://composio.dev/install | bash
composio login
composio link datadog       # prompts for site + API/APP keys
```

## Discover Tools

```bash
composio search "search logs" --toolkits datadog
composio search "aggregate logs" --toolkits datadog
composio tools list datadog
```

Commonly used slugs (confirm with `--get-schema`):

- `DATADOG_SEARCH_LOGS`
- `DATADOG_AGGREGATE_LOGS`
- `DATADOG_LIST_ACTIVE_METRICS`
- `DATADOG_GET_EVENT`

## Filter Recipes

### Errors from one service in the last 15 minutes

```bash
composio execute DATADOG_SEARCH_LOGS -d '{
  "filter": {
    "query": "service:checkout status:error env:prod",
    "from": "now-15m",
    "to": "now"
  },
  "page": { "limit": 100 },
  "sort": "-timestamp"
}'
```

### Aggregate error count by endpoint

```bash
composio execute DATADOG_AGGREGATE_LOGS -d '{
  "filter": { "query": "service:checkout status:error", "from": "now-1h", "to": "now" },
  "group_by": [{ "facet": "@http.url_path", "limit": 20 }],
  "compute": [{ "aggregation": "count" }]
}'
```

### Trace a single request across services

```bash
composio execute DATADOG_SEARCH_LOGS -d '{
  "filter": { "query": "@trace_id:7f3a2b1c env:prod", "from": "now-1h", "to": "now" },
  "sort": "timestamp"
}'
```

### Save a reusable query

```bash
composio search "save log view" --toolkits datadog
composio execute DATADOG_CREATE_SAVED_VIEW -d '{
  "name": "checkout-errors-prod",
  "query": "service:checkout status:error env:prod"
}'
```

## Pipe into Local Analysis

Datadog output is JSON on stdout — pipe to `jq` for quick summaries:

```bash
composio execute DATADOG_SEARCH_LOGS -d '{
  "filter": {"query":"service:api status:error","from":"now-30m","to":"now"},
  "page":{"limit":500}
}' | jq -r '.data[].attributes.message' | sort | uniq -c | sort -rn | head
```

## Multi-Step Workflow

Save as `scripts/dd-incident.ts`, then `composio run --file scripts/dd-incident.ts -- --service checkout`:

```ts
const svc = process.argv[process.argv.indexOf("--service") + 1];

const errors = await execute("DATADOG_SEARCH_LOGS", {
  filter: { query: `service:${svc} status:error`, from: "now-1h", to: "now" },
  page: { limit: 200 },
  sort: "-timestamp",
});

const topPaths = await execute("DATADOG_AGGREGATE_LOGS", {
  filter: { query: `service:${svc} status:error`, from: "now-1h", to: "now" },
  group_by: [{ facet: "@http.url_path", limit: 10 }],
  compute: [{ aggregation: "count" }],
});

console.log(JSON.stringify({ svc, sample: errors.data?.slice(0, 5), topPaths }, null, 2));
```

## Schedule a Daily Digest

Use cron (or `composio dev listen` for triggers) to run the workflow and forward results to Slack:

```bash
composio run --file scripts/dd-incident.ts -- --service checkout \
  | tee /tmp/digest.json

composio execute SLACK_SEND_MESSAGE -d "$(jq -n \
  --slurpfile d /tmp/digest.json \
  '{channel:"oncall", text: ($d[0] | tojson)}')"
```

## Troubleshooting

- **Empty results** → confirm `env:` and `service:` tags; Datadog indexes are region-scoped — set the right site during `composio link datadog`.
- **`403 Forbidden`** → the APP key lacks `logs_read`; regenerate with scope and re-link.
- **Slow queries** → narrow `from/to`, add a `facet` filter, or use `DATADOG_AGGREGATE_LOGS` instead of pulling raw events.
- **Unknown facet** → `composio search "list log facets" --toolkits datadog`.

Full CLI reference: [docs.composio.dev/docs/cli](https://docs.composio.dev/docs/cli)
