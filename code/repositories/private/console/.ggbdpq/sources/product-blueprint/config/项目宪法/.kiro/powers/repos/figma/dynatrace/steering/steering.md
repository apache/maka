# Dynatrace Observability & Production Impact Assessment

## Dynatrace MCP Server Capabilities

| Category | Key Functions | Primary Use Cases |
|----------|--------------|-------------------|
| **Entity & Topology** | `find_entity_by_name`, `get_environment_info` | Locate services, hosts, processes; verify tenant connection |
| **Problem Management** | `list_problems`, `chat_with_davis_copilot` | Query active/closed problems; get Davis AI insights on issues |
| **Security** | `list_vulnerabilities` | Retrieve vulnerabilities by risk score; access Davis security assessments |
| **DQL Querying** | `execute_dql`, `generate_dql_from_natural_language`, `explain_dql`, `verify_dql` | Query GRAIL data; convert natural language to DQL; validate syntax |
| **Kubernetes** | `get_kubernetes_events` | Retrieve cluster events; query pod conditions and resource usage |
| **Notifications** | `send_email`, `send_slack_message`, `create_workflow_for_notification` | Send alerts; automate team notifications |
| **Resource Mgmt** | `reset_grail_budget` | Reset query budget limits after exhaustion |

---

## Finding Entities & Problems

### Service Discovery

```dql
// Find services by name pattern
fetch dt.entity.service
| filter matchesValue(entity.name, "*<SERVICE_NAME>*")
| fields id, entity.name, calls, called_by

// Find services in a namespace (via naming convention)
fetch dt.entity.service
| filter matchesValue(entity.name, "*<NAMESPACE>*")
| fields id, entity.name
```

**Note**: K8s metadata fields (`k8s.namespace.name`, `k8s.cluster.name`) are NOT available on `fetch dt.entity.service`. Use `entity.name` patterns or query logs/events for K8s metadata.

### Problem Discovery

```dql
// Find problems by namespace
list_problems(filter: "contains(k8s.namespace.name, \"<NAMESPACE>\")")

// Find problems affecting a specific service
list_problems(filter: "in(affected_entity_ids, \"<SERVICE_ID>\")")
```

---

## Metrics Reference

### Service-Level Metrics

| Metric | Key |
|--------|-----|
| Response Time | `dt.service.request.response_time` |
| Request Count | `dt.service.request.count` |
| Failure Count | `dt.service.request.failure_count` |

### Container-Level Metrics

| Metric | Key |
|--------|-----|
| CPU Usage | `dt.kubernetes.container.cpu_usage` |
| Memory Working Set | `dt.kubernetes.container.memory_working_set` |
| CPU Requests | `dt.kubernetes.container.requests_cpu` |
| Memory Requests | `dt.kubernetes.container.requests_memory` |
| CPU Limits | `dt.kubernetes.container.limits_cpu` |
| Memory Limits | `dt.kubernetes.container.limits_memory` |

### Runtime Metrics

| Runtime | Metrics |
|---------|---------|
| **JVM** | `dt.runtime.jvm.memory.heap.used`, `dt.runtime.jvm.memory.heap.max` |
| **Go** | `dt.runtime.go.scheduler.goroutine_count`, `dt.runtime.go.memory.heap` |

### Metric Discovery

```dql
// Find metrics for a service
fetch metric.series 
| filter dt.entity.service == "<SERVICE_ID>" 
| summarize cnt = count(), by:{metric.key} 
| sort cnt desc | limit 50

// Find container metrics in a namespace
fetch metric.series 
| filter k8s.namespace.name == "<NAMESPACE>" 
| filter matchesValue(metric.key, "*kubernetes.container*")
| summarize cnt = count(), by:{metric.key} 
| sort cnt desc
```

---

## DQL Query Fundamentals

### Pipeline Structure

```dql
fetch <record-type> | filter <condition> | summarize <aggregation> | sort <field> | limit <count>
```

**Execution Model:**
- `fetch` retrieves raw records from Grail storage
- `filter` reduces the result set (apply early for performance)
- `fields` selects specific columns (reduces data transfer)
- `summarize` aggregates records into groups (**ALWAYS requires aggregation function**)
- `sort` orders results (**MUST reference aggregation aliases, NOT functions**)
- `limit` restricts output size

### ⚠️ CRITICAL: Summarize and Sort Syntax

**These two errors cause most DQL failures:**

1. **Summarize ALWAYS needs an aggregation function:**
   ```dql
   // ❌ WRONG - missing aggregation function
   | summarize by:{k8s.deployment.name}
   
   // ✅ CORRECT - includes count()
   | summarize count(), by:{k8s.deployment.name}
   ```

2. **Sort MUST use an alias, NOT the aggregation function:**
   ```dql
   // ❌ WRONG - cannot sort by function directly
   | summarize count(), by:{namespace}
   | sort count() desc
   
   // ✅ CORRECT - define alias, then sort by alias
   | summarize cnt = count(), by:{namespace}
   | sort cnt desc
   ```

3. **bin() in summarize MUST use an alias for sorting:**
   ```dql
   // ❌ WRONG - timestamp no longer exists after summarize
   | summarize cnt = count(), by:{bin(timestamp, 5m)}
   | sort timestamp desc
   
   // ✅ CORRECT - alias the bin() expression
   | summarize cnt = count(), by:{timeframe = bin(timestamp, 5m)}
   | sort timeframe desc
   ```

**Always follow this pattern:**
```dql
| summarize <alias> = <function>(), by:{<field>}
| sort <alias> desc
```

### Other Syntax Rules

| Rule | Wrong ❌ | Correct ✅ |
|------|---------|-----------|
| String quotes | `'ERROR'` | `"ERROR"` |
| Multiple values | `id in ("A", "B")` | `id == "A" or id == "B"` |
| Special char fields | `filter field-name == "x"` | ``filter `field-name` == "x"`` |

**⚠️ IMPORTANT: No `in()` or set notation for multiple values**
DQL does NOT support `in ("val1", "val2")` or `in {"val1", "val2"}` syntax. Use `or` chains:
```dql
// ❌ WRONG - neither parentheses nor curly braces work
filter k8s.namespace.name in ("<NS1>", "<NS2>", "<NS3>")
filter k8s.namespace.name in {"<NS1>", "<NS2>", "<NS3>"}

// ✅ CORRECT - use or chains
filter k8s.namespace.name == "<NS1>"
  or k8s.namespace.name == "<NS2>"
  or k8s.namespace.name == "<NS3>"
```
This applies to both `| filter` pipes AND `timeseries filter:` clauses.

### Pattern Matching

```dql
// Wildcard patterns (PREFERRED)
filter matchesValue(k8s.deployment.name, "*<SERVICE>*")   // contains
filter matchesValue(k8s.deployment.name, "<PREFIX>-*")   // starts with
filter matchesValue(k8s.deployment.name, "*-<SUFFIX>")   // ends with

// Exact phrase search
filter matchesPhrase(content, "connection timeout")
```

### Entity Fields vs Metrics

```dql
// ✅ Entity metadata
fetch dt.entity.service
| filter matchesValue(entity.name, "*<SERVICE>*")
| fields id, entity.name, calls, called_by

// ❌ WRONG: Cannot access metrics as entity fields
fetch dt.entity.service
| fields id, dt.service.request.response_time  // This fails!

// ✅ Metrics via timeseries
timeseries avg(dt.service.request.response_time),
  from: now() - 1h,
  filter: dt.entity.service == "<SERVICE_ID>"
```

---

## Common Query Patterns

### Error Analysis

```dql
// Error hotspots by deployment
fetch logs 
| filter k8s.namespace.name == "<NAMESPACE>" 
  and loglevel == "ERROR" 
  and timestamp > now() - 1h
| summarize errorCount = count(), by:{k8s.deployment.name}
| sort errorCount desc | limit 20

// Error message patterns for a service
fetch logs 
| filter contains(k8s.deployment.name, "<SERVICE>") 
  and loglevel == "ERROR" 
  and timestamp > now() - 1h
| summarize cnt = count(), by:{content}
| sort cnt desc | limit 20

// When did errors start?
fetch logs 
| filter k8s.deployment.name == "<SERVICE>" 
  and loglevel == "ERROR" 
  and timestamp > now() - 6h
| summarize errorCount = count(), by:{timeframe = bin(timestamp, 5m)} 
| sort timeframe asc
```

### Service Performance

```dql
// Response time trends
timeseries avg(dt.service.request.response_time), 
  percentile(dt.service.request.response_time, 95),
  from: now() - 6h, interval: 5m,
  filter: dt.entity.service == "<SERVICE_ID>"

// Slow traces
fetch spans 
| filter dt.entity.service == "<SERVICE_ID>" 
  and timestamp > now() - 1h 
  and duration > 1000000000
| summarize avgDuration = avg(duration), 
    p95 = percentile(duration, 95), 
    cnt = count(), 
    by:{span.name} 
| sort p95 desc
```

### Resource Usage

```dql
// Container CPU/Memory trends
timeseries avg(dt.kubernetes.container.cpu_usage),
  avg(dt.kubernetes.container.memory_working_set),
  from: now() - 2h, interval: 1m,
  filter: matchesValue(k8s.deployment.name, "*<SERVICE>*"),
  by: {k8s.pod.name}

// Referencing timeseries results in subsequent pipes
// Use backticks around the original expression name
timeseries avg(dt.kubernetes.container.cpu_usage),
  avg(dt.kubernetes.container.requests_cpu),
  from: now() - 1h, interval: 1h,
  by: {k8s.deployment.name}
| fields k8s.deployment.name,
    cpuUsage = `avg(dt.kubernetes.container.cpu_usage)`,
    cpuRequest = `avg(dt.kubernetes.container.requests_cpu)`
| fieldsAdd utilizationPct = (cpuUsage / cpuRequest) * 100
| sort utilizationPct desc

// OOMKilled events
fetch events 
| filter event.type == "RESOURCE_CONTENTION_EVENT" 
  or contains(event.name, "OOMKilled")
  and timestamp > now() - 2h 
| fields timestamp, event.name, k8s.deployment.name, k8s.pod.name
```

### Health Check Query

```dql
// Service health snapshot
fetch logs
| filter k8s.namespace.name == "<NAMESPACE>"
  and timestamp > now() - 15m
| summarize logCount = count(), 
    errorCount = countIf(loglevel == "ERROR"),
    warnCount = countIf(loglevel == "WARN"),
    by:{k8s.deployment.name}
| fields k8s.deployment.name, logCount, errorCount, warnCount,
    errorRate = errorCount / logCount * 100
| sort errorRate desc
```

---

## Time Ranges & Query Cost

| Time Range | Cost | Use Case |
|------------|------|----------|
| `now() - 1h` | Low | Active troubleshooting |
| `now() - 6h` | Low-Med | Recent investigation |
| `now() - 24h` | Medium | Daily analysis |
| `now() - 7d` | Med-High | Weekly trends (use aggregation) |
| `now() - 30d` | High | Historical (specific filters required) |

**Performance Tips:**
1. Always filter by time first
2. Filter by indexed fields (entity IDs, k8s labels) before text search
3. Use `fields` to select only needed columns
4. Use aliases for aggregations: `summarize cnt = count() | sort cnt desc`
5. Limit results aggressively during development

---

## Production Readiness Analysis

**CRITICAL REQUIREMENT**: When creating or reviewing design documents for features that involve service-to-service communication or performance-sensitive changes, perform a Dynatrace production readiness analysis.

### When to Perform Analysis

- Adding new service-to-service calls (synchronous or asynchronous)
- Modifying existing service call patterns
- Adding timeouts, circuit breakers, or retry logic
- Changes that may impact service latency or throughput
- Features that depend on external service performance

### Step 1: Identify Affected Services

From the code/design, identify:
- Which services will be called
- Which services will make new calls
- Expected call frequency and patterns
- Timeout and retry parameters

### Step 2: Gather Current Performance Metrics

**Latency Distribution** (Last 24-48 hours):
```dql
timeseries avg(dt.service.request.response_time),
  percentile(dt.service.request.response_time, 50),
  percentile(dt.service.request.response_time, 90),
  percentile(dt.service.request.response_time, 95),
  percentile(dt.service.request.response_time, 99),
  from: now() - 24h, interval: 1h,
  filter: dt.entity.service == "<SERVICE_ID>"
```

**Request Volume and Error Rate**:
```dql
timeseries sum(dt.service.request.count),
  sum(dt.service.request.failure_count),
  from: now() - 24h, interval: 1h,
  filter: dt.entity.service == "<SERVICE_ID>"
```

**Resource Utilization**:
```dql
timeseries avg(dt.kubernetes.container.cpu_usage),
  avg(dt.kubernetes.container.memory_working_set),
  from: now() - 24h, interval: 1h,
  filter: contains(k8s.deployment.name, "<SERVICE_NAME>")
```

**Service Dependencies**:
```dql
fetch dt.entity.service
| filter id == "<SERVICE_ID>"
| fields entity.name, calls, called_by
```

### Step 3: Analyze Compatibility with Design

| Design Parameter | Production Reality | Risk Level |
|------------------|-------------------|------------|
| Expected latency | Actual P50/P95/P99 | HIGH if mismatch |
| Timeout setting | Service P95/P99 | HIGH if timeout < P95 |
| Expected load | Current request rate | MEDIUM if >30% increase |
| Circuit breaker threshold | Current error rate | MEDIUM if too sensitive |
| Resource capacity | Current CPU/Memory | MEDIUM if near limits |

### Step 4: Calculate Impact

**Timeout Rate Estimation**:
- If timeout < P95: ~5% timeout rate
- If timeout < P90: ~10% timeout rate
- If timeout < P50: ~50% timeout rate (CRITICAL)

**Load Impact**:
- New calls per hour = (calling service requests/hour)
- Load increase % = (new calls / current calls) × 100
- If >30% increase: HIGH RISK

**Latency Impact**:
- New latency = baseline + (dependency avg latency)
- If new latency > target SLO: HIGH RISK

### Step 5: Risk Assessment

**LOW RISK** ✅:
- Timeout > P99 of dependency
- Load increase <10%
- Fail-open pattern implemented
- Circuit breaker configured appropriately
- Target SLOs achievable

**MEDIUM RISK** ⚠️:
- Timeout between P95 and P99
- Load increase 10-30%
- Resilience patterns in place
- May require monitoring and tuning

**HIGH RISK** ❌:
- Timeout < P95 of dependency
- Load increase >30%
- No resilience patterns
- Target SLOs not achievable
- Time-based performance variations

### Step 6: Required Actions

**For HIGH RISK changes**:
1. **DO NOT PROCEED** with current design
2. **OPTIMIZE** the dependency service first
3. **ADJUST** design parameters (timeout, SLOs, etc.)
4. **IMPLEMENT** alternative approach (caching, async, etc.)
5. **RE-ANALYZE** after changes

**For MEDIUM RISK changes**:
1. **ADJUST** design parameters if needed
2. **ADD** additional monitoring and alerting
3. **PLAN** gradual rollout (1% → 10% → 50% → 100%)
4. **PREPARE** rollback procedures

**For LOW RISK changes**:
1. **PROCEED** with design as planned
2. **IMPLEMENT** standard monitoring
3. **DOCUMENT** baseline metrics for comparison

### Example Analysis Output

```markdown
## Production Readiness Assessment

**Feature**: <FEATURE_NAME>
**Risk Level**: ❌ HIGH RISK

### Current Metrics
- <DEPENDENCY_SERVICE> P95: 1300ms
- Design Timeout: 500ms
- Expected Timeout Rate: 40%

### Findings
- Timeout setting incompatible with production performance
- Circuit breaker will open continuously
- Feature will only work 4% of the time

### Recommendations
1. Optimize <DEPENDENCY_SERVICE> (reduce P95 to <400ms)
2. OR increase timeout to 1500ms (accept higher latency)
3. OR implement caching layer (bypass dependency)

### Decision
DO NOT PROCEED until <DEPENDENCY_SERVICE> P95 is optimized.
```

---

## IDE Workflow Integration

### Code Change → Service Impact

When reviewing code changes that add or modify service calls:

1. **Identify the service being called** from the code (URL, client name, gRPC service)
2. **Find the Dynatrace entity**: `find_entity_by_name("<SERVICE_NAME>")`
3. **Gather performance data** using the production readiness queries above
4. **Compare against design parameters** (timeouts, expected latency)
5. **Report risk level** with actionable recommendations

### Post-Deployment Monitoring

After deploying a change, monitor these indicators:

```dql
// Compare error rate before/after deployment
timeseries sum(dt.service.request.failure_count) / sum(dt.service.request.count) * 100,
  from: now() - 4h, interval: 5m,
  filter: dt.entity.service == "<SERVICE_ID>"

// Watch for latency regression
timeseries percentile(dt.service.request.response_time, 95),
  from: now() - 4h, interval: 5m,
  filter: dt.entity.service == "<SERVICE_ID>"
```

**Rollback Indicators**:
- P95 latency increased >50% from baseline
- Error rate increased >2x from baseline
- Circuit breakers opening
- Downstream services showing degradation

---

## Troubleshooting Guide

### ⚠️ Most Common Syntax Errors

**#1 - Missing aggregation function in summarize:**
```dql
// ❌ WRONG
| summarize by:{k8s.deployment.name}

// ✅ CORRECT  
| summarize cnt = count(), by:{k8s.deployment.name}
```

**#2 - Sorting by function instead of alias:**
```dql
// ❌ WRONG
| summarize count(), by:{namespace}
| sort count() desc

// ✅ CORRECT
| summarize cnt = count(), by:{namespace}
| sort cnt desc
```

### Other Syntax Errors

| Error | Wrong ❌ | Correct ✅ |
|-------|---------|-----------|
| String quotes | `'ERROR'` | `"ERROR"` |
| Set literal syntax | `loglevel in {"ERROR", "WARN"}` | `loglevel == "ERROR" or loglevel == "WARN"` |
| Missing time filter | `filter loglevel == "ERROR"` | `filter timestamp > now() - 1h and loglevel == "ERROR"` |

### Zero Results Checklist

1. **Widen time range**: `now() - 1h` → `now() - 6h`
2. **Verify field names**: `fetch logs | limit 5`
3. **Check case-sensitivity**: `loglevel == "ERROR"` vs `"Error"`
4. **Review filter logic**: AND requires all conditions true
5. **Validate entity IDs**: Format is `SERVICE-ABC123`, not friendly names

### Query Limits Exceeded

- "Result size exceeded" → Add `| limit 1000` or aggregate
- "Query timeout" → Narrow time range, add specific filters
- "Too many groups" → Filter before aggregating on high-cardinality fields

---

## Agentic Behavior Guidelines

These guidelines govern how the AI assistant should interact when using Dynatrace tools.

### Query Execution

- **Execute queries for data retrieval** - When user asks for data, metrics, or logs, execute the query
- **Don't ask permission** - Execute relevant queries directly
- **Show results first** - Present query results before analysis

### Reviewing User-Provided Queries

When asked to review, fix, or optimize a query:

1. **Analyze the query first** - Identify ALL issues WITHOUT executing the broken query
2. **Explain what's wrong in detail** - This is the primary deliverable. List each issue:
   - Syntax errors (quotes, missing functions, etc.)
   - Performance issues (filter order, missing time range, etc.)
   - Inefficiencies (unnecessary fields, high cardinality, etc.)
3. **Provide the corrected query** - Show the fixed version with comments
4. **Optionally execute** - Verify the corrected version works

**The explanation is more important than execution** - Users asking "what's wrong with this query" want education, not just a working query.

**Never execute a query you know is broken** - Fix it first.

### Advisory Questions

When user asks "how should I...", "what's the best approach...", or "how do I...":
1. **ALWAYS explain the methodology BEFORE executing any queries** - The user is asking for education, not just results
2. **Structure your approach** - Break down complex investigations into numbered steps
3. **Include example queries** - Show correct syntax patterns for each step
4. **Execution is optional** - Only execute after explaining the approach

**Example for "How do I trace an issue through the stack?":**
First explain the distributed tracing methodology:
- Step 1: Check frontend/RUM for user-facing errors
- Step 2: Extract trace IDs from failed requests
- Step 3: Query spans for those trace IDs
- Step 4: Identify all services in the trace path
- Step 5: Find the slowest or failing span
Then optionally demonstrate with queries.

### Zero Results Handling

When a query returns 0 records:
1. Report the result and show the query executed
2. Suggest possible causes (time range, filters, field names)
3. **Ask before running exploratory queries** - Don't assume data doesn't exist

### Building on User Context

- **Accept user premises** - If user states facts about their environment, build on them
- **Don't re-discover** - Avoid running queries to verify what the user already told you
- **Provide next steps** - Focus on advancing the investigation

### Response Quality

- **Acknowledge problems first** - When fixing errors, explain the issue before the solution
- **Complete your analysis** - Synthesize findings and provide actionable conclusions
- **Be direct** - Avoid celebratory language when troubleshooting
