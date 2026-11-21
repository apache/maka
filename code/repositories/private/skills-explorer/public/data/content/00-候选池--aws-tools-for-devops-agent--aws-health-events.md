---
name: aws-health-events
description: ALWAYS use this skill in the beginning of any incident investigation, root cause
  analysis, or operational troubleshooting. This skill retrieves and analyzes
  AWS Health events (service issues, scheduled changes, and account notifications)
  to identify AWS-side events that may explain or correlate with observed
  operational issues. Activate this skill when investigating an issue and you
  observe service degradation, elevated error rates, latency spikes, connection
  failures, throttling, capacity issues, deployment-related failures, alarms, or
  any operational event or issue. This skill searches AWS Health events by
  service, time window, region, and status to surface active or recent service
  disruptions, scheduled maintenance, and account-specific notifications that
  inform the current investigation. Also activate when a user requests a health
  event summary or report for their account over a specified time period.
metadata:
  author: udid-aws
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Incident RCA"
  aws-devops-agent-skills.aws-services: "AWS Health"
  aws-devops-agent-skills.technical-domains: "Operations"
---

# AWS Health Event Review

Use this skill when investigating an incident and you need to check for AWS-side
service events that may be causing or contributing to the observed issue. Also
use this skill when a user requests a summary report of AWS Health events over a
configurable time period.

## When to Use This Skill

**Incident Investigation (automatic activation):**

- An active incident may be caused by an AWS service disruption or degradation.
- You observe service degradation, elevated error rates, latency spikes,
  connection failures, throttling, or capacity issues.
- You need to determine whether an AWS-side event is the root cause or a
  contributing factor to the current incident.
- You want to correlate observed symptoms with known AWS Health events.

**Chat Reporting (on-demand activation):**

- A user requests a health event summary or report for their account.
- A user wants to review the health posture of their AWS environment over a
  specific time period.
- A user asks about recent AWS service issues affecting their account or region.

## Prerequisites

- The account must have an **AWS Business Support+**, **Enterprise Support**, or
  **Unified Operations** support plan to access the AWS Health API.
- The agent must have permissions to call the following IAM actions:
  - `health:DescribeEvents`
  - `health:DescribeEventDetails`
  - `health:DescribeAffectedEntities`
  - `health:DescribeEventTypes`
- The AWS Health API is only available in the **us-east-1** region. All API
  calls must target the `us-east-1` endpoint regardless of where the affected
  resources are located.
- Health event data is available for up to 90 days. Events older than 90 days
  cannot be retrieved via the API.

---

## Step 1: Gather Incident Context

Before searching Health events, extract key details from the current incident:

1. **Affected AWS services** — identify the service(s) experiencing issues
   (e.g., EC2, RDS, Lambda, ELB, ECS).
2. **Timeframe** — determine when the incident started and its current duration.
   Use ISO 8601 timestamps.
3. **Affected resources** — collect specific resource identifiers (instance IDs,
   ARNs, endpoint names, cluster names).
4. **Region and availability zone** — identify the AWS region and, if known, the
   specific availability zone(s) affected.
5. **Symptoms** — note the observed symptoms (latency spikes, 5xx errors,
   connection timeouts, throttling, capacity errors).

Use these details as filter criteria in subsequent steps.

---

## Step 2: Search Health Events

Use the AWS Health API `DescribeEvents` operation to retrieve events matching
the incident context. All calls must target the **us-east-1** endpoint.

### API call pattern

```
aws health describe-events \
  --region us-east-1 \
  --filter '{
    "services": ["<SERVICE_CODE>"],
    "startTimes": [{"from": "<ISO-8601-start>"}],
    "regions": ["<affected-region>"],
    "eventStatusCodes": ["open", "closed"],
    "eventTypeCategories": ["issue", "scheduledChange", "accountNotification"]
  }' \
  --max-results 100
```

### Filtering strategies

| Strategy             | How to Apply                                                                                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| By service           | Use the `services` filter with the AWS Health service code (e.g., `EC2`, `RDS`, `ELASTICLOADBALANCING`), because service-specific events are most likely to correlate with the incident. |
| By time range        | Use `startTimes` with a `from` value set to 7 days before the incident start, because events that started before the incident may still be active and causing impact.                    |
| By region            | Use the `regions` filter to scope events to the affected region, because regional events are more likely to impact the specific resources under investigation.                           |
| By availability zone | Use the `availabilityZones` filter when the incident is isolated to a specific AZ, because AZ-scoped events have the highest correlation with AZ-specific failures.                      |
| By status            | Include both `open` and `closed` statuses, because recently closed events may have caused residual impact that is still being observed.                                                  |
| By event scope       | Include both `ACCOUNT_SPECIFIC` and `PUBLIC` events, because public service events affect all accounts in the region while account-specific events target your resources directly.       |

### Pagination handling

- Follow the `nextToken` from each response to retrieve subsequent pages.
- Continue paginating until `nextToken` is null or a maximum of **500 events**
  have been collected.
- Set `maxResults` to 100 per page for efficient retrieval.

---

## Step 3: Filter Relevant Events

Before retrieving full event details, filter the events returned in Step 2 to
identify only those relevant to the current investigation. This avoids
unnecessary `DescribeEventDetails` calls for events that are clearly unrelated.

### Relevance filtering criteria

Evaluate each event from the `DescribeEvents` response using these fields
(available without calling `DescribeEventDetails`):

| Field                         | Relevance Signal                                                                                                              |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `service`                     | Must match one of the affected services from the incident context, or a related service from the Service Dependency Map       |
| `eventTypeCategory`           | Prioritize `issue` events for active incidents; include `scheduledChange` if the incident coincides with a maintenance window |
| `eventTypeCode`               | Match against known operational event patterns (e.g., `AWS_EC2_OPERATIONAL_ISSUE`, `AWS_RDS_MAINTENANCE`)                     |
| `statusCode`                  | Prioritize `open` events; include `closed` only if the event ended within 2 hours of the incident start                       |
| `startTime` / `endTime`       | The event's active period must overlap with the incident timeframe                                                            |
| `region` / `availabilityZone` | Must match the incident's affected region or AZ                                                                               |

### Filtering rules

1. **Keep** events where the `service` matches an affected service or a related
   service from the Service Dependency Map.
2. **Keep** events where the active period (startTime to endTime, or to present
   if open) overlaps with the incident timeframe.
3. **Keep** events where the `region` or `availabilityZone` matches the
   incident's affected region/AZ.
4. **Discard** `accountNotification` events unless the incident context
   specifically suggests an account-level issue (e.g., abuse notification,
   certificate expiry).
5. **Discard** `closed` events that ended more than 2 hours before the incident
   started (unlikely to be contributing).

### Result

After filtering, proceed to Step 4 only with the relevant subset of events.
If all events are filtered out, report that no relevant Health events were found
and suggest alternative investigation paths (see Step 7).

---

## Step 4: Get Event Details

For each **relevant** event identified in Step 3, retrieve full descriptions
and timelines using `DescribeEventDetails`.

### API call pattern

```
aws health describe-event-details \
  --region us-east-1 \
  --event-arns '["<arn-1>", "<arn-2>", ..., "<arn-10>"]'
```

### Batching rules

- The API accepts a **maximum of 10 event ARNs per request**.
- If more than 10 relevant events need details, issue multiple batched calls of
  up to 10 ARNs each until all relevant events are detailed.

### Extract from each event detail

- **Event description** — the `latestDescription` text explaining the event.
- **Timeline** — start time, end time (null if ongoing), last updated time.
- **Status** — current status (open, closed, upcoming).
- **Service and region** — confirm the affected service and region.
- **Event type** — the category (issue, scheduledChange, accountNotification)
  and specific type code.

### Handling failedSet

- The response contains a `successfulSet` and a `failedSet`.
- If any event ARNs appear in `failedSet`, report the failed ARN and error
  message to the operator.
- Continue processing all events from `successfulSet` without blocking on
  failures.

---

## Step 5: Identify Affected Entities

For events with `eventScopeCode` of **ACCOUNT_SPECIFIC**, retrieve the list of
affected resources using `DescribeAffectedEntities`.

> **Important**: Only call DescribeAffectedEntities for ACCOUNT_SPECIFIC events.
> PUBLIC events do not return entity data.

### API call pattern

```
aws health describe-affected-entities \
  --region us-east-1 \
  --filter '{"eventArns": ["<event-arn>"]}'
  --max-results 100
```

### Entity matching

When the incident context includes specific resource identifiers:

1. Retrieve all affected entities for the event (paginate up to **500 entities**
   per event using `nextToken`).
2. Perform exact string matching of each entity's `entityValue` against the
   incident context resource identifiers.
3. Present matched entities in a separate section before non-matched entities.
4. Include entity status (`IMPAIRED`, `UNIMPAIRED`, `UNKNOWN`, `PENDING`) and
   last updated time for each entity.

### Error handling

- If `DescribeAffectedEntities` returns an error for a specific event ARN,
  report the event ARN that failed and continue processing remaining events.

---

## Step 6: Correlate with Incident

Score each Health event for relevance to the current incident using the
following criteria:

### Relevance scoring

| Classification | Criteria                                                                                                                   | Label                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **High**       | Matching service + overlapping timeframe + matching affected resource (or matching region/AZ if no resource IDs available) | Likely contributing factor (if event is open) |
| **Medium**     | Matching service + overlapping timeframe (no resource match)                                                               | Likely contributing factor (if event is open) |
| **Low**        | Matching service only (no timeframe overlap)                                                                               | Background context                            |

### Scoring rules

- **Service match**: The event's service code matches one of the affected
  services from the incident context.
- **Timeframe overlap**: The event's active period (start time through end time,
  or through present if still open) intersects with the incident's timeframe
  (start time through end time, or through present if ongoing).
- **Region/AZ match**: The event's region or availability zone matches the
  incident's affected region or AZ.
- **Resource match**: At least one affected entity's `entityValue` matches a
  resource identifier from the incident context.

### Contributing factor labeling

- Any **open** event classified as High or Medium relevance SHALL be labeled as
  a "likely contributing factor" in addition to its relevance classification.
- Closed events with High relevance should be noted as potential recent causes
  if the incident started shortly after the event closed.

### When resource identifiers are unavailable

If the incident context does not include specific resource identifiers, score
relevance using only service, timeframe, and region/AZ factors:

- **High**: Matching service + overlapping timeframe + matching region or AZ
- **Medium**: Matching service + overlapping timeframe
- **Low**: Matching service only

---

## Step 7: Present Structured Output

Present findings in a clear, structured format organized for quick
comprehension and action.

### Output structure

1. **Summary** — total events found, broken down by category and status.
2. **Correlated events** — grouped by event type category in this order:
   - Issues (service disruptions) — present first
   - Scheduled changes (maintenance) — present second
   - Account notifications — present last
3. **Within each group** — sort by:
   - Relevance classification (High → Medium → Low)
   - Then by start time descending (most recent first)
4. **Per event** — include:
   - Event type category and service
   - Region and availability zone (if applicable)
   - Status (open/closed/upcoming)
   - Start time and end time (ISO 8601)
   - Description (summarized to 256 characters max)
   - Relevance classification and matching criteria
   - Contributing factor label (if applicable)
5. **Actionable next steps** — for each correlated event, include at least one
   recommendation such as:
   - Check specific affected resources
   - Review related service limits or quotas
   - Verify recent configuration changes
   - Monitor the AWS Health Dashboard for updates
   - Contact AWS Support if the event is ongoing

### When no events are found

If no relevant Health events are identified:

- Explicitly state that no matching AWS Health events were found.
- Confirm the search parameters used (service, time range, region).
- Recommend checking other potential causes:
  - Recent deployments or configuration changes
  - Resource limits or quota exhaustion
  - Network connectivity issues
  - Application-level errors

---

## Decision Tree: Event Search Strategy

```
Is this a chat-based health report request?
├── YES → Search the user-specified time period (default 30 days, max 90 days)
│         Organize results by category, service, and status
│         Present as a summary report
└── NO → Continue with incident investigation flow below

Is the affected AWS service known?
├── YES → Search events for that service within the past 7 days
│   ├── Events found → Proceed to Step 3 (Filter Relevant Events)
│   └── No events found → Broaden to related services (see Service Dependency Map)
│       ├── Events found → Proceed to Step 3
│       └── No events found → Expand time window to 14 days and retry
│           ├── Events found → Proceed to Step 3
│           └── No events found → Report no events found, suggest other investigation paths
└── NO → Search all services filtered by region and availability zone (past 7 days)
    ├── Events found → Proceed to Step 3
    └── No events found → Expand time window to 14 days
        ├── Events found → Proceed to Step 3
        └── No events found → Report no events found, suggest other investigation paths

Does the incident involve a specific availability zone?
├── YES → Include the AZ filter in all searches above
└── NO → Filter by region only
```

---

## Service Dependency Map

When the initial service-specific search returns no results, broaden the search
to related services that share infrastructure dependencies:

| Primary Service | Related Services to Check               |
| --------------- | --------------------------------------- |
| ELB / ALB / NLB | EC2, VPC, Route 53                      |
| RDS             | EC2, EBS                                |
| ECS / EKS       | EC2, VPC, ELB                           |
| Lambda          | VPC, CloudWatch                         |
| CloudFront      | S3, Route 53                            |
| API Gateway     | Lambda, VPC                             |
| ElastiCache     | EC2, VPC                                |
| DynamoDB        | VPC (if VPC endpoints used)             |
| S3              | CloudFront, VPC (if VPC endpoints used) |
| Kinesis         | EC2, VPC                                |

Search up to 3 related services when broadening. Use the Health API service
codes from the references document (e.g., `ELASTICLOADBALANCING` for ELB,
`ROUTE53` for Route 53).

---

## Error Handling

| Error Condition                        | Agent Behavior                                                                                                                                                                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Missing `health:Describe*` permissions | Report the missing permissions and specify the required IAM actions: `health:DescribeEvents`, `health:DescribeEventDetails`, `health:DescribeAffectedEntities`, `health:DescribeEventTypes`. Provide the IAM policy snippet needed. |
| Throttling (HTTP 429)                  | Retry with exponential backoff: wait 1s → 2s → 4s (max 3 retries). If still throttled after 3 retries, report that the Health API is currently rate-limited and recommend trying again shortly.                                     |
| Service error (HTTP 5xx)               | Report the error code and recommend the operator check the AWS Health Dashboard directly as a fallback.                                                                                                                             |
| Timeout (30 seconds)                   | Cancel the request and report a timeout error. Suggest the operator check the Health Dashboard directly or retry with narrower filters.                                                                                             |
| Zero events found                      | Report that no events matched the specified filters. Confirm the search parameters used. Suggest broadening the search or checking other investigation paths.                                                                       |
| Invalid time range (start > end)       | Report the invalid time range error. Ask the operator to provide corrected timestamps.                                                                                                                                              |
| DescribeEventDetails failedSet         | Report the failed event ARNs and error messages. Continue processing events from the successfulSet.                                                                                                                                 |
| DescribeAffectedEntities error         | Report the event ARN for which entity retrieval failed. Continue processing remaining events.                                                                                                                                       |
| Unknown service name (chat report)     | Inform the user the service was not recognized. List services that have events in the requested time period.                                                                                                                        |

---

## Tips for Effective Health Event Review

- **Always check us-east-1**: The Health API endpoint is only in us-east-1,
  regardless of where your resources are located.
- **Start narrow, then broaden**: Begin with the specific affected service and
  a 7-day window. Only expand if no results are found.
- **Check both open and closed events**: A recently closed event may still be
  causing residual impact.
- **Correlate with support cases**: If a Health event references a service
  disruption, check if related support cases exist using the support-cases skill.
- **Account-specific vs public events**: Account-specific events directly affect
  your resources. Public events are service-wide but may still impact you.
- **Look at scheduled changes**: Upcoming or recent maintenance windows can
  explain transient issues that resolve on their own.
