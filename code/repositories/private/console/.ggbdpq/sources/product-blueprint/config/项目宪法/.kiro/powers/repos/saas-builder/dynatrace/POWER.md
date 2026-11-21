---
name: "dynatrace"
displayName: "Dynatrace Observability"
description: "Query logs, metrics, traces, problems, and Kubernetes events from Dynatrace using DQL for production debugging and performance analysis"
keywords: ["dynatrace", "observability", "monitoring", "dql", "logs", "metrics", "kubernetes", "davis", "grail"]
author: "Dynatrace"
---

# Dynatrace Observability Power

## Overview

The Dynatrace Observability Power provides comprehensive access to your Dynatrace monitoring data through DQL (Dynatrace Query Language). Query logs, metrics, distributed traces, problems, Kubernetes events, and leverage Davis AI for intelligent insights.

**Key capabilities:**
- **DQL Querying**: Execute powerful queries against GRAIL data lake
- **Natural Language to DQL**: Convert questions to DQL queries automatically
- **Problem Management**: Track and analyze active/closed problems with Davis AI
- **Entity & Topology**: Find services, hosts, processes, and their relationships
- **Kubernetes Monitoring**: Query cluster events, pod conditions, resource usage
- **Security**: List vulnerabilities and access Davis security assessments
- **Notifications**: Send alerts via email, Slack, or automated workflows
- **RUM**: Analyze user sessions, Core Web Vitals, frontend errors

**Authentication**: Requires Dynatrace environment URL and bearer token.

## Available Steering Files

This power has the following steering files:
- **steering** - Complete DQL guide with query patterns, workflows, and troubleshooting

## Available MCP Servers

### dynatrace
**Package:** `@dynatrace-oss/dynatrace-mcp-server`
**Connection:** URL-based MCP server

**Tools:**

1. **execute_dql** - Execute DQL query against Dynatrace
   - Required: `query` (string) - DQL query to execute
   - Returns: Query results with records

2. **generate_dql_from_natural_language** - Convert natural language to DQL
   - Required: `question` (string) - Natural language question
   - Returns: Generated DQL query

3. **explain_dql** - Get explanation of DQL query
   - Required: `query` (string) - DQL query to explain
   - Returns: Human-readable explanation

4. **verify_dql** - Validate DQL syntax
   - Required: `query` (string) - DQL query to validate
   - Returns: Validation result with errors if any

5. **find_entity_by_name** - Find entities by name
   - Required: `name` (string) - Entity name to search
   - Optional: `type` (string) - Entity type filter
   - Returns: Matching entities with IDs

6. **get_environment_info** - Get Dynatrace environment information
   - No parameters required
   - Returns: Environment details and connection status

7. **list_problems** - List problems (incidents)
   - Optional: `filter` (string) - DQL filter expression
   - Optional: `from` (string) - Start time
   - Optional: `to` (string) - End time
   - Returns: Problems with affected entities

8. **chat_with_davis_copilot** - Get Davis AI insights
   - Required: `message` (string) - Question for Davis
   - Returns: AI-generated insights and recommendations

9. **list_vulnerabilities** - List security vulnerabilities
   - Optional: `risk_score_min` (number) - Minimum risk score
   - Returns: Vulnerabilities with risk assessments

10. **get_kubernetes_events** - Get Kubernetes cluster events
    - Optional: `namespace` (string) - Kubernetes namespace
    - Optional: `cluster` (string) - Cluster name
    - Returns: K8s events with timestamps

11. **send_email** - Send email notification
    - Required: `to` (string) - Recipient email
    - Required: `subject` (string) - Email subject
    - Required: `body` (string) - Email body

12. **send_slack_message** - Send Slack notification
    - Required: `channel` (string) - Slack channel
    - Required: `message` (string) - Message text

13. **reset_grail_budget** - Reset GRAIL query budget
    - No parameters required
    - Returns: Budget reset confirmation

## Tool Usage Examples

### Executing DQL Queries

**Find error logs:**
```javascript
usePower("dynatrace", "dynatrace", "execute_dql", {
  "query": `fetch logs
    | filter loglevel == "ERROR" and timestamp > now() - 1h
    | fields timestamp, content, k8s.deployment.name
    | limit 100`
})
// Returns: Error logs from last hour
```

**Service performance metrics:**
```javascript
usePower("dynatrace", "dynatrace", "execute_dql", {
  "query": `timeseries avg(dt.service.request.response_time),
    from: now() - 6h,
    filter: dt.entity.service == "SERVICE-ABC123"`
})
// Returns: Response time timeseries
```

### Natural Language to DQL

**Convert question to query:**
```javascript
usePower("dynatrace", "dynatrace", "generate_dql_from_natural_language", {
  "question": "Show me error logs from the payment service in the last hour"
})
// Returns: Generated DQL query
```

### Finding Entities

**Find service by name:**
```javascript
usePower("dynatrace", "dynatrace", "find_entity_by_name", {
  "name": "checkout",
  "type": "SERVICE"
})
// Returns: Matching services with IDs
```

### Problem Management

**List active problems:**
```javascript
usePower("dynatrace", "dynatrace", "list_problems", {
  "filter": "contains(k8s.namespace.name, \"production\")"
})
// Returns: Active problems in production namespace
```

**Get Davis AI insights:**
```javascript
usePower("dynatrace", "dynatrace", "chat_with_davis_copilot", {
  "message": "Why is the checkout service slow?"
})
// Returns: AI-generated analysis and recommendations
```

### Kubernetes Monitoring

**Get cluster events:**
```javascript
usePower("dynatrace", "dynatrace", "get_kubernetes_events", {
  "namespace": "production",
  "cluster": "prod-cluster-1"
})
// Returns: Recent K8s events
```

## Combining Tools (Workflows)

### Workflow 1: Service Degradation Investigation

```javascript
// Step 1: Find the service entity
const service = usePower("dynatrace", "dynatrace", "find_entity_by_name", {
  "name": "checkout",
  "type": "SERVICE"
})

// Step 2: Check for active problems
const problems = usePower("dynatrace", "dynatrace", "list_problems", {
  "filter": `in(affected_entity_ids, "${service[0].id}")`
})

// Step 3: Query response time metrics
const metrics = usePower("dynatrace", "dynatrace", "execute_dql", {
  "query": `timeseries avg(dt.service.request.response_time),
    percentile(dt.service.request.response_time, 95),
    from: now() - 6h,
    filter: dt.entity.service == "${service[0].id}"`
})

// Step 4: Get error logs
const logs = usePower("dynatrace", "dynatrace", "execute_dql", {
  "query": `fetch logs
    | filter dt.entity.service == "${service[0].id}"
      and loglevel == "ERROR"
      and timestamp > now() - 1h
    | summarize cnt = count(), by:{content}
    | sort cnt desc | limit 20`
})

// Step 5: Ask Davis for insights
const insights = usePower("dynatrace", "dynatrace", "chat_with_davis_copilot", {
  "message": `The checkout service has ${problems.length} problems and high error rates. What's causing this?`
})
```

### Workflow 2: High Error Rate Analysis

```javascript
// Step 1: Identify deployments with errors
const errorsByDeployment = usePower("dynatrace", "dynatrace", "execute_dql", {
  "query": `fetch logs
    | filter k8s.namespace.name == "production"
      and loglevel == "ERROR"
      and timestamp > now() - 1h
    | summarize errorCount = count(), by:{k8s.deployment.name}
    | sort errorCount desc | limit 10`
})

// Step 2: Get error patterns for top deployment
const errorPatterns = usePower("dynatrace", "dynatrace", "execute_dql", {
  "query": `fetch logs
    | filter k8s.deployment.name == "payment-service"
      and loglevel == "ERROR"
      and timestamp > now() - 1h
    | summarize cnt = count(), by:{content}
    | sort cnt desc | limit 20`
})

// Step 3: Check K8s events for correlation
const k8sEvents = usePower("dynatrace", "dynatrace", "get_kubernetes_events", {
  "namespace": "production"
})

// Step 4: Generate DQL for deeper analysis
const dqlQuery = usePower("dynatrace", "dynatrace", "generate_dql_from_natural_language", {
  "question": "Show me when errors started in payment-service over the last 6 hours"
})

// Step 5: Execute the generated query
const timeline = usePower("dynatrace", "dynatrace", "execute_dql", {
  "query": dqlQuery
})
```

## DQL Query Syntax Guide

### Basic Structure

```dql
fetch <record-type>
| filter <condition>
| fields <columns>
| summarize <aggregation>
| sort <field>
| limit <count>
```

### Core Commands

- **fetch**: Retrieve data (`logs`, `events`, `spans`, `dt.entity.service`)
- **filter**: Apply conditions (use early for performance)
- **fields**: Select specific columns
- **summarize**: Aggregate data (ALWAYS requires aggregation function)
- **sort**: Order results
- **limit**: Restrict output size
- **timeseries**: Query metrics over time

### Critical Syntax Rules

1. **Strings use double quotes**: `"ERROR"` ✅ | `'ERROR'` ❌
2. **Summarize needs aggregation**: `summarize count(), by:{x}` ✅
3. **Multiple values use OR**: `id == "A" or id == "B"` ✅
4. **Use aliases for sorting**: `summarize cnt = count() | sort cnt desc` ✅
5. **Always filter by time**: `timestamp > now() - 1h`

### Common Patterns

**Error analysis:**
```dql
fetch logs
| filter loglevel == "ERROR" and timestamp > now() - 1h
| summarize cnt = count(), by:{k8s.deployment.name}
| sort cnt desc | limit 20
```

**Service metrics:**
```dql
timeseries avg(dt.service.request.response_time),
  from: now() - 6h,
  filter: dt.entity.service == "SERVICE-123"
```

**Container resources:**
```dql
timeseries avg(dt.kubernetes.container.cpu_usage),
  avg(dt.kubernetes.container.memory_working_set),
  filter: k8s.namespace.name == "prod",
  by: {k8s.deployment.name}
```

## Best Practices

### ✅ Do:

- **Start with narrow time ranges** (1h) and expand if needed
- **Filter by time first**: `timestamp > now() - 1h`
- **Use indexed fields early**: entity IDs, k8s labels, timestamps
- **Limit aggressively**: `| limit 100` to control costs
- **Use aliases for aggregations**: Enables sorting and clarity
- **Leverage Davis AI**: Ask questions before writing complex queries
- **Use natural language tool**: Convert questions to DQL automatically
- **Validate queries**: Use `verify_dql` before executing

### ❌ Don't:

- **Use single quotes** for strings (must be double quotes)
- **Forget aggregation functions** in summarize
- **Query without time filters** (expensive and slow)
- **Use high-cardinality grouping** without filtering first
- **Ignore query costs** - start small, expand gradually
- **Skip entity lookup** - use `find_entity_by_name` first
- **Hardcode entity IDs** - look them up dynamically

## Troubleshooting

### Error: "Syntax error in DQL query"
**Cause:** Invalid DQL syntax
**Solution:**
1. Use `verify_dql` to validate syntax
2. Check string quotes (must be double quotes)
3. Ensure summarize has aggregation function
4. Use OR for multiple values, not IN with literals

### Error: "Query timeout"
**Cause:** Query too expensive or time range too large
**Solution:**
1. Narrow time range: `now() - 1h` instead of `now() - 7d`
2. Add specific filters before aggregating
3. Reduce aggregation cardinality
4. Use `| limit 100`

### Error: "Entity not found"
**Cause:** Invalid entity ID or name
**Solution:**
1. Use `find_entity_by_name` to get correct ID
2. Verify entity type (SERVICE, HOST, etc.)
3. Check entity exists in your environment

### Error: "No results found"
**Cause:** Filters too restrictive or wrong field names
**Solution:**
1. Widen time range
2. Check field names with `fetch logs | limit 5`
3. Verify case-sensitivity
4. Use `matchesValue()` for wildcards

## Configuration

**Authentication Required**: Dynatrace environment URL and bearer token

**Setup Steps:**

1. **Get Dynatrace Credentials:**
   - Log in to your Dynatrace environment
   - Navigate to Access Tokens
   - Create token with permissions: `Read entities`, `Read logs`, `Read metrics`, `Read problems`

2. **Configure in mcp.json:**
   ```json
   {
     "mcpServers": {
       "dynatrace": {
         "url": "YOUR_DT_URL",
         "headers": {
           "Authorization": "Bearer YOUR_BEARER_TOKEN"
         }
       }
     }
   }
   ```

3. **Or use environment variables:**
   ```json
   {
     "mcpServers": {
       "dynatrace": {
         "command": "npx",
         "args": ["-y", "@dynatrace-oss/dynatrace-mcp-server@latest"],
         "env": {
           "DT_ENVIRONMENT": "https://your-tenant.apps.dynatrace.com",
           "DT_API_TOKEN": "your-token-here"
         }
       }
     }
   }
   ```

## Tips

1. **Start with natural language** - Use `generate_dql_from_natural_language` to learn DQL
2. **Ask Davis first** - Get AI insights before diving into queries
3. **Find entities by name** - Don't hardcode entity IDs
4. **Use steering file** - Comprehensive DQL patterns and workflows
5. **Validate before executing** - Use `verify_dql` to catch syntax errors
6. **Limit query scope** - Start with 1h, expand if needed
7. **Leverage K8s metadata** - Filter by namespace, deployment, pod
8. **Check problems first** - Active problems often point to root cause
9. **Combine with Davis** - Use AI to interpret query results
10. **Monitor query costs** - Use `reset_grail_budget` if needed

---

**Package:** `@dynatrace-oss/dynatrace-mcp-server`  
**Source:** Official Dynatrace  
**License:** Apache 2.0  
**Connection:** URL-based MCP server with bearer token authentication
