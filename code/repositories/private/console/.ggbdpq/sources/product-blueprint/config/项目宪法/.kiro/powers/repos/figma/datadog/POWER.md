---
name: "datadog"
displayName: "Datadog Observability"
description: "Query logs, metrics, traces, RUM events, incidents, and monitors from Datadog for production debugging and performance analysis"
keywords: ["datadog", "observability", "monitoring", "logs", "metrics", "apm", "traces", "rum", "incidents"]
author: "Datadog"
---

# Onboarding

Before proceeding, let the user know that the MCP server is currently in preview and they may need to request access by visiting https://docs.datadoghq.com/bits_ai/mcp_server/


# Overview

The Datadog Observability Power provides comprehensive access to your Datadog monitoring data across logs, metrics, APM traces, Real User Monitoring (RUM), incidents, and monitors. Query and analyze production systems for debugging, performance optimization, and incident response.

**Key capabilities:**
- **Log Search**: Query application and infrastructure logs with powerful filtering
- **Metrics**: Analyze time-series data for performance and resource utilization
- **APM/Traces**: Investigate distributed traces and service dependencies
- **RUM**: Analyze user experience, page performance, and frontend errors
- **Incidents**: Track and manage production incidents
- **Monitors**: Search alerting rules and monitor status
- **Documentation**: Look up Datadog setup, instrumentation, and best practices

**Authentication**: Requires Datadog API key and application key.

## Available Steering Files

This power has the following steering files:
- **steering** - Comprehensive query syntax guide with examples, workflows, and troubleshooting

## Available MCP Servers

### datadog
**Package:** `mcp-remote` + `https://mcp.datadoghq.com/api/unstable/mcp-server/mcp`
**Connection:** Remote MCP server via npx

**Tools:**

1. **search_datadog_logs** - Search application and infrastructure logs
   - Required: `query` (string) - Log search query
   - Optional: `from` (string) - Start time (default: "now-1h")
   - Optional: `to` (string) - End time (default: "now")
   - Optional: `head_limit` (number) - Max results (default: 100)
   - Optional: `max_tokens` (number) - Token limit for output
   - Optional: `group_by_message` (boolean) - Group similar logs
   - Optional: `extra_fields` (array) - Additional fields to include
   - Returns: Matching log entries with timestamps and attributes

2. **get_datadog_metric** - Query time-series metrics
   - Required: `query` (string) - Metric query
   - Required: `from` (string) - Start time
   - Required: `to` (string) - End time
   - Optional: `raw_data` (boolean) - Return raw datapoints vs binned
   - Optional: `use_cloud_cost` (boolean) - Query cloud cost data
   - Returns: Metric values over time with aggregations

3. **search_datadog_spans** - Search APM traces and spans
   - Required: `query` (string) - Span search query
   - Optional: `from` (string) - Start time (default: "now-1h")
   - Optional: `to` (string) - End time (default: "now")
   - Optional: `head_limit` (number) - Max results (default: 100)
   - Optional: `max_tokens` (number) - Token limit for output
   - Optional: `custom_attributes` (array) - Custom span attributes to include
   - Returns: Matching spans with trace IDs and timing

4. **get_datadog_trace** - Get full trace details by trace ID
   - Required: `trace_id` (string) - Trace ID to retrieve
   - Returns: Complete trace with all spans and relationships

5. **search_datadog_rum_events** - Search Real User Monitoring events
   - Required: `query` (string) - RUM event query
   - Optional: `from` (string) - Start time (default: "now-15m")
   - Optional: `to` (string) - End time (default: "now")
   - Optional: `head_limit` (number) - Max results (default: 100)
   - Optional: `max_tokens` (number) - Token limit for output
   - Optional: `detailed_output` (boolean) - Include full event details
   - Returns: RUM events (views, actions, errors, resources)

6. **search_datadog_incidents** - Search and list incidents
   - Optional: `query` (string) - Incident search query (default: "state:active")
   - Optional: `from` (string) - Start time
   - Optional: `to` (string) - End time
   - Returns: Incidents with severity, status, and affected services

7. **get_datadog_incident** - Get detailed incident information
   - Required: `incident_id` (string) - Incident ID
   - Returns: Full incident details with timeline and updates

8. **search_datadog_monitors** - Search alerting monitors
   - Optional: `query` (string) - Monitor search query
   - Returns: Monitors with status and configuration

9. **search_datadog_services** - List APM services
   - Optional: `detailed_output` (boolean) - Include service details
   - Returns: Services with metadata and dependencies

10. **search_datadog_dashboards** - Search dashboards
    - Optional: `query` (string) - Dashboard search query
    - Optional: `max_queries_per_dashboard` (number) - Extract widget queries
    - Returns: Dashboards with metadata and widget queries

11. **search_datadog_docs** - Search Datadog documentation
    - Required: `query` (string) - Documentation search query
    - Returns: Relevant documentation pages and guides

## Tool Usage Examples

### Searching Logs

**Find error logs:**
```javascript
usePower("datadog", "datadog", "search_datadog_logs", {
  "query": "service:api env:prod status:error",
  "from": "now-1h",
  "to": "now"
})
// Returns: Error logs from API service in last hour
```

**Search with custom attributes:**
```javascript
usePower("datadog", "datadog", "search_datadog_logs", {
  "query": "service:checkout @http.status_code:[400 TO 599]",
  "from": "now-1h",
  "to": "now",
  "extra_fields": ["@user.id", "@order.id", "@http.*"]
})
// Returns: HTTP errors with user and order context
```

### Querying Metrics

**Service response time:**
```javascript
usePower("datadog", "datadog", "get_datadog_metric", {
  "query": "avg:trace.servlet.request.duration{service:api,env:prod} by {resource_name}",
  "from": "now-4h",
  "to": "now"
})
// Returns: Average response time per endpoint
```

**CPU usage by host:**
```javascript
usePower("datadog", "datadog", "get_datadog_metric", {
  "query": "avg:system.cpu.user{env:prod} by {host}",
  "from": "now-1h",
  "to": "now"
})
// Returns: CPU usage for each production host
```

**Cloud costs:**
```javascript
usePower("datadog", "datadog", "get_datadog_metric", {
  "query": "sum:all.cost{*} by {providername}.rollup(sum, daily)",
  "from": "now-30d",
  "to": "now",
  "use_cloud_cost": true
})
// Returns: Daily costs by cloud provider
```

### Searching Traces

**Find slow requests:**
```javascript
usePower("datadog", "datadog", "search_datadog_spans", {
  "query": "service:api @duration:>100000000",  // >100ms in nanoseconds
  "from": "now-1h",
  "to": "now"
})
// Returns: Slow API requests with trace IDs
```

**Get full trace details:**
```javascript
usePower("datadog", "datadog", "get_datadog_trace", {
  "trace_id": "7d5d747be160e280504c099d984bcfe0"
})
// Returns: Complete trace with all spans and timing
```

### RUM Analysis

**Find slow page loads:**
```javascript
usePower("datadog", "datadog", "search_datadog_rum_events", {
  "query": "@type:view @view.loading_time:>3000",
  "from": "now-1h",
  "to": "now",
  "detailed_output": true
})
// Returns: Pages taking >3 seconds to load
```

**Frontend errors:**
```javascript
usePower("datadog", "datadog", "search_datadog_rum_events", {
  "query": "@type:error @application.name:\"My App\" @device.type:mobile",
  "from": "now-1h",
  "to": "now"
})
// Returns: Mobile frontend errors
```

### Incident Management

**List active incidents:**
```javascript
usePower("datadog", "datadog", "search_datadog_incidents", {
  "query": "state:(active OR stable)"
})
// Returns: Current incidents being worked on
```

**Get incident details:**
```javascript
usePower("datadog", "datadog", "get_datadog_incident", {
  "incident_id": "12345"
})
// Returns: Full incident timeline and updates
```

### Monitor Search

**Find alerting monitors:**
```javascript
usePower("datadog", "datadog", "search_datadog_monitors", {
  "query": "status:alert muted:false env:prod"
})
// Returns: Active unmuted alerts in production
```

## Combining Tools (Workflows)

### Workflow 1: Production Error Investigation

```javascript
// Step 1: Find recent errors in logs
const errorLogs = usePower("datadog", "datadog", "search_datadog_logs", {
  "query": "service:checkout env:prod status:error",
  "from": "now-1h",
  "to": "now",
  "extra_fields": ["@error.message", "@user.id"]
})

// Step 2: Find related error traces
const errorSpans = usePower("datadog", "datadog", "search_datadog_spans", {
  "query": "service:checkout status:error",
  "from": "now-1h",
  "to": "now"
})

// Step 3: Get full trace for first error
const fullTrace = usePower("datadog", "datadog", "get_datadog_trace", {
  "trace_id": errorSpans[0].trace_id
})

// Step 4: Check if there's an active incident
const incidents = usePower("datadog", "datadog", "search_datadog_incidents", {
  "query": "state:active"
})

// Step 5: Check related monitors
const monitors = usePower("datadog", "datadog", "search_datadog_monitors", {
  "query": "tag:\"service:checkout\" status:alert"
})
```

### Workflow 2: Performance Degradation Analysis

```javascript
// Step 1: Identify slow requests
const slowSpans = usePower("datadog", "datadog", "search_datadog_spans", {
  "query": "service:api @duration:>100000000",  // >100ms
  "from": "now-1h",
  "to": "now"
})

// Step 2: Check response time metrics
const latencyMetrics = usePower("datadog", "datadog", "get_datadog_metric", {
  "query": "avg:trace.servlet.request.duration{service:api} by {resource_name}",
  "from": "now-4h",
  "to": "now"
})

// Step 3: Check infrastructure metrics
const cpuMetrics = usePower("datadog", "datadog", "get_datadog_metric", {
  "query": "avg:system.cpu.user{service:api} by {host}",
  "from": "now-4h",
  "to": "now"
})

// Step 4: Check for deployment correlation
const deploymentLogs = usePower("datadog", "datadog", "search_datadog_logs", {
  "query": "service:api @deployment.version:*",
  "from": "now-4h",
  "to": "now"
})

// Step 5: Get full trace of slowest request
const slowestTrace = usePower("datadog", "datadog", "get_datadog_trace", {
  "trace_id": slowSpans[0].trace_id
})
```

### Workflow 3: User Experience Investigation

```javascript
// Step 1: Find slow page loads
const slowPages = usePower("datadog", "datadog", "search_datadog_rum_events", {
  "query": "@type:view @view.loading_time:>3000",
  "from": "now-1h",
  "to": "now",
  "detailed_output": true
})

// Step 2: Check for frontend errors
const frontendErrors = usePower("datadog", "datadog", "search_datadog_rum_events", {
  "query": "@type:error",
  "from": "now-1h",
  "to": "now"
})

// Step 3: Check backend API performance
const apiLatency = usePower("datadog", "datadog", "get_datadog_metric", {
  "query": "avg:trace.servlet.request.duration{service:api,env:prod}",
  "from": "now-1h",
  "to": "now"
})

// Step 4: Check resource loading issues
const resourceErrors = usePower("datadog", "datadog", "search_datadog_rum_events", {
  "query": "@type:resource @resource.status_code:[400 TO 599]",
  "from": "now-1h",
  "to": "now"
})
```

### Workflow 4: Service Dependency Analysis

```javascript
// Step 1: List all services
const services = usePower("datadog", "datadog", "search_datadog_services", {
  "detailed_output": true
})

// Step 2: Find traces for a service
const serviceSpans = usePower("datadog", "datadog", "search_datadog_spans", {
  "query": "service:frontend",
  "from": "now-1h",
  "to": "now"
})

// Step 3: Get full trace to see downstream calls
const dependencyTrace = usePower("datadog", "datadog", "get_datadog_trace", {
  "trace_id": serviceSpans[0].trace_id
})

// Step 4: Check latency between services
const serviceLatency = usePower("datadog", "datadog", "get_datadog_metric", {
  "query": "avg:trace.servlet.request.duration{env:prod} by {service}",
  "from": "now-4h",
  "to": "now"
})
```

## Query Syntax Guide

### Log Search Syntax

**Tags** (no @ prefix):
- `service:api` - Service name
- `env:prod` - Environment
- `status:error` - Log status level
- `host:web-1` - Hostname

**Attributes** (@ prefix required):
- `@http.status_code:500` - HTTP status
- `@user.id:abc123` - User identifier
- `@duration:>1000` - Duration in milliseconds
- `@error.message:"timeout"` - Error message

**Boolean operators:**
- AND (default): `service:api status:error`
- OR: `env:(prod OR staging)`
- Exclusion: `-status:info`

**Wildcards:**
- `service:web*` - Matches web-api, web-worker
- `@url:/api/*` - Matches any /api/ path

### Metric Query Syntax

**Structure:**
```
<AGGREGATOR>:<METRIC_NAME>{<SCOPE>} by {<GROUPING>}
```

**Aggregators:**
- `avg` - Average across series
- `sum` - Sum all series
- `min` / `max` - Min/max values
- `p95` / `p99` - Percentiles

**Examples:**
```
avg:system.cpu.user{env:prod} by {host}
sum:trace.requests.count{service:api}.rollup(sum, 300)
p95:trace.servlet.request.duration{env:prod}
```

### APM/Trace Query Syntax

**Reserved fields** (NO @ prefix):
- `service` - Service name
- `resource_name` - Endpoint/operation
- `operation_name` - Span operation
- `status` - ok or error
- `trace_id` - Specific trace

**Span attributes** (@ prefix required):
- `@http.status_code` - HTTP status
- `@http.method` - HTTP method
- `@duration` - Duration in **nanoseconds**
- `@error.message` - Error message

**Duration conversions:**
- 1ms = 1,000,000 nanoseconds
- 100ms = 100,000,000 nanoseconds
- 1s = 1,000,000,000 nanoseconds

**Examples:**
```
service:api status:error
service:api @duration:>100000000
operation_name:db.query @duration:>1000000000
```

### RUM Query Syntax

**Event types:**
- `@type:view` - Page views
- `@type:action` - User interactions
- `@type:error` - Frontend errors
- `@type:resource` - Resource loading
- `@type:vital` - Core Web Vitals

**Common attributes:**
- `@application.name` - RUM app name
- `@view.url_path` - Page URL
- `@view.loading_time` - Load duration (ms)
- `@device.type` - Device type
- `@browser.name` - Browser name
- `@user.id` - User identifier

**Examples:**
```
@type:view @view.loading_time:>3000
@type:error @browser.name:Safari
@type:resource @resource.status_code:[400 TO 599]
```

### Incident Query Syntax

**Fields:**
- `state` - active, stable, resolved
- `severity` - SEV-1, SEV-2, SEV-3, SEV-4, SEV-5
- `customer_impacted` - true or false

**Important:** Group multiple values of same field:
```
severity:(SEV-1 OR SEV-2)  ✅
severity:SEV-1 OR severity:SEV-2  ❌
```

**Examples:**
```
state:active
severity:(SEV-1 OR SEV-2) AND state:active
customer_impacted:true AND state:active
```

### Monitor Query Syntax

**Fields:**
- `status` - alert, warn, ok
- `muted` - true or false
- `tag` - Monitor tags
- `env` - Environment
- `priority` - p1, p2, etc.

**Examples:**
```
status:alert muted:false
priority:(p1 OR p2)
tag:"service:api" status:alert
```

## Best Practices

### ✅ Do:

- **Start with narrow time ranges** (15m-1h) and expand if needed
- **Use unified service tags** (service, env, version) together
- **Filter by service first** to scope queries
- **Use @ prefix correctly** (attributes yes, reserved fields no)
- **Remember duration units** (nanoseconds for spans, milliseconds for logs/RUM)
- **Group similar logs** with `group_by_message: true`
- **Set appropriate max_tokens** (5000 for overview, 50000 for details)
- **Use extra_fields/custom_attributes** for custom data
- **Leverage documentation search** for setup and instrumentation questions
- **Check incidents first** when investigating issues

### ❌ Don't:

- **Use very long time ranges** without reason (expensive and slow)
- **Forget @ prefix** for log/span attributes
- **Use @ prefix** for reserved trace fields (service, status, etc.)
- **Forget duration conversions** (5ms = 5,000,000 nanoseconds)
- **Use wildcards inside quotes** (they become literal)
- **Skip escaping special characters** (: = / \ etc.)
- **Use excessive free-text searches** (use structured tags instead)
- **Ignore unified service tagging** (always include service, env, version)
- **Query without time filters** (expensive and slow)

## Troubleshooting

### Error: "No results found"
**Cause:** Filters too restrictive or wrong field names
**Solution:**
1. Widen time range
2. Check field names (use @ for attributes)
3. Verify case-sensitivity
4. Use wildcards for partial matches

### Error: "Query timeout"
**Cause:** Query too expensive or time range too large
**Solution:**
1. Narrow time range (start with now-1h)
2. Add specific filters (service, env)
3. Reduce aggregation cardinality
4. Use head_limit to restrict results

### Error: "Invalid query syntax"
**Cause:** Malformed query string
**Solution:**
1. Check @ prefix usage
2. Escape special characters (: = / \)
3. Use double quotes for strings with spaces
4. Group OR conditions: `field:(value1 OR value2)`

### Error: "Trace not found"
**Cause:** Invalid trace ID or trace expired
**Solution:**
1. Verify trace_id format (hex string)
2. Check if trace is within retention period
3. Ensure trace exists in correct environment

## Configuration

**Authentication Required**: Datadog API key and application key

**Setup Steps:**

1. **Get Datadog Credentials:**
   - Log in to Datadog
   - Navigate to Organization Settings → API Keys
   - Create or copy API key
   - Navigate to Organization Settings → Application Keys
   - Create or copy application key

2. **Configure in mcp.json:**
   ```json
   {
     "mcpServers": {
       "datadog": {
         "command": "npx",
         "args": [
           "mcp-remote",
           "https://mcp.datadoghq.com/api/unstable/mcp-server/mcp"
         ],
         "env": {
           "DD_API_KEY": "your-api-key-here",
           "DD_APP_KEY": "your-app-key-here",
           "DD_SITE": "datadoghq.com"
         }
       }
     }
   }
   ```

3. **Set DD_SITE** based on your region:
   - US1: `datadoghq.com` (default)
   - US3: `us3.datadoghq.com`
   - US5: `us5.datadoghq.com`
   - EU: `datadoghq.eu`
   - AP1: `ap1.datadoghq.com`

## Tips

1. **Start narrow** - Use 15m-1h time ranges, expand if needed
2. **Use steering file** - Comprehensive syntax guide with examples
3. **Check incidents first** - Active incidents often point to root cause
4. **Leverage unified tags** - Always use service, env, version together
5. **Search docs** - Use `search_datadog_docs` for setup questions
6. **Group logs** - Use `group_by_message` to reduce duplicate entries
7. **Get full traces** - Use trace_id from spans to get complete picture
8. **Monitor your monitors** - Check alert status during investigations
9. **Analyze dependencies** - Use full traces to understand service relationships
10. **Remember units** - Nanoseconds for spans, milliseconds for logs/RUM

---

**Package:** `mcp-remote` + Datadog MCP Server  
**Source:** Official Datadog  
**License:** Apache 2.0  
**Connection:** Remote MCP server with API/App key authentication
