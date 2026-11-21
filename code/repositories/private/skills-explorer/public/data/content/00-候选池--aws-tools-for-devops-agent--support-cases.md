---
name: support-cases
description: ALWAYS use this skill in the beginning of any incident investigation, root cause
  analysis, or operational troubleshooting. This skill retrieves and analyzes
  AWS Support cases (open and resolved) to find historical incidents with
  similar symptoms, error patterns, or affected services. Activate this skill
  when investigating an issue and you observe service degradation, elevated
  error rates, latency spikes, connection failures, throttling, capacity issues,
  deployment-related failures, alarms, or any operational event or issue. This
  skill searches past support cases by service, time window, severity, and error
  keywords to surface prior root causes, proven remediations, and recurring
  patterns that inform the current investigation.
metadata:
  author: udid-aws
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Incident RCA"
  aws-devops-agent-skills.aws-services: "AWS Support"
  aws-devops-agent-skills.technical-domains: "Operations"
---

# Support Case Review

Use this skill when investigating an incident and you need to review AWS Support
cases — either the current case associated with the incident or historical cases
that may contain relevant context, similar symptoms, or proven remediation steps.

## When to Use This Skill

- An active incident shares symptoms with previously resolved issues.
- You need to check if a similar support case was filed in the past 24 months.
- You want to correlate the current incident with known AWS service events.
- You need to retrieve communications and resolution details from a prior case.
- You want to identify recurring patterns across multiple support cases.

## Prerequisites

- The AWS account must have a Business Support+, Enterprise Support, or
  Unified Operations plan (required for the AWS Support API).
- The agent must have permissions to call `support:DescribeCases` and
  `support:DescribeCommunications` in the target account.
- Support case data is available for 24 months after creation. Cases older than
  24 months cannot be retrieved via the API.

---

## Step 1: Identify the Current Incident Context

Before searching support cases, gather key details from the current incident:

1. **Affected AWS services** (e.g., EC2, RDS, Lambda, ELB).
2. **Error messages or error codes** observed in logs or alarms.
3. **Timeframe** of the incident (start time, duration).
4. **Affected resources** (instance IDs, ARNs, endpoint names).
5. **Symptoms** (latency spikes, 5xx errors, connection timeouts, throttling).

Use these details as search criteria when filtering support cases.

---

## Step 2: Search for Related Support Cases

Use the AWS Support API to retrieve cases that may be relevant.

### Retrieve all recent cases (open and resolved)

```
aws support describe-cases \
  --include-resolved-cases \
  --include-communications \
  --after-time "<ISO-8601-start>" \
  --before-time "<ISO-8601-end>" \
  --language "en"
```

### Filter by specific case IDs (if known)

```
aws support describe-cases \
  --case-id-list "case-123456789010-muen-2024" \
  --include-communications
```

### Key filtering strategies

| Strategy            | How to Apply                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| By time window      | Use `--after-time` and `--before-time` to scope cases to the relevant period (e.g., past 30 days, or around a previous incident date), because recent cases are more likely to reflect current infrastructure state. |
| By service          | Review the `serviceCode` field in returned cases to match the affected service (e.g., `amazon-elastic-compute-cloud`, `amazon-rds`), because the same service often exhibits recurring failure patterns.             |
| By severity         | Check the `severityCode` field — focus on `urgent` and `critical` cases for major incidents, because higher-severity cases tend to have more detailed root cause analysis from AWS Support.                          |
| By status           | Use `--include-resolved-cases` to include closed cases, because resolved cases contain the root cause and remediation steps that are most valuable for correlating with the current incident.                        |
| By subject keywords | Scan the `subject` field of returned cases for keywords matching the current incident symptoms, because similar symptoms often share underlying causes.                                                              |

---

## Step 3: Review Case Communications

The `describe-cases` response with `includeCommunications: true` returns the
most recent communications for each case in the `recentCommunications` field
(up to 5 messages). Since root cause analysis and resolution steps are
typically in the final messages of a resolved case, this is usually sufficient.

If the `recentCommunications` field includes a `nextToken`, the case has
additional older messages. Only paginate using `describe-communications` if the
recent messages do not contain a clear root cause or resolution — for example,
if the last messages are follow-up questions rather than a final answer.

```
aws support describe-communications \
  --case-id "case-123456789010-muen-2024" \
  --max-results 10 \
  --next-token "<nextToken-from-recentCommunications>"
```

When reviewing communications, look for:

1. **Root cause statements** — AWS Support engineers often summarize the root
   cause in their final response.
2. **Remediation steps** — Specific actions taken to resolve the issue (e.g.,
   "increased max_connections", "applied security group rule", "scaled up
   instance type").
3. **Configuration recommendations** — Best practices or tuning suggestions
   provided by AWS.
4. **Escalation notes** — If the case was escalated, check for deeper technical
   analysis from specialized teams.

---

## Step 4: Correlate Findings with Current Incident

After reviewing relevant cases, correlate the findings:

### Pattern matching checklist

- [ ] Do past cases share the same affected service and resource type?
- [ ] Are the error messages or codes identical or similar?
- [ ] Did past incidents occur at a similar time of day or day of week (indicating load patterns)?
- [ ] Was the root cause a configuration issue that may still be present?
- [ ] Was the resolution a temporary workaround that has since expired or been reverted?
- [ ] Did AWS identify a service-side issue that may be recurring?

### Relevance scoring

Rate each historical case on relevance to the current incident:

| Score  | Criteria                                                            |
| ------ | ------------------------------------------------------------------- |
| High   | Same service, same error, same resource type, similar timeframe     |
| Medium | Same service, different error but related symptoms                  |
| Low    | Different service but similar architectural pattern or failure mode |

---

## Step 5: Summarize Findings

Provide a structured summary including:

1. **Number of related cases found** — How many past cases matched the search
   criteria.
2. **Most relevant case(s)** — Case ID, subject, status, and creation date of
   the top matches.
3. **Historical root causes** — What caused similar issues in the past.
4. **Past resolutions** — What remediation steps were applied and whether they
   were permanent fixes or temporary workarounds.
5. **Recommendations** — Based on historical patterns, suggest investigation
   paths or remediation steps for the current incident.
6. **Recurring pattern alert** — If the same issue has occurred multiple times,
   flag it as a recurring problem requiring a permanent fix or architectural
   change.

---

## Decision Tree: Case Search Strategy

```
Is there a known case ID associated with the current incident?
├── YES → Retrieve that specific case and its communications (Step 2, filter by case ID)
└── NO → Continue below

Is the affected AWS service known?
├── YES → Search cases in the past 90 days for that service, then expand to 12 months if needed
└── NO → Search all cases in the past 30 days and filter by error keywords

Were relevant historical cases found?
├── YES → Review communications (Step 3), correlate findings (Step 4), summarize (Step 5)
└── NO → Broaden search criteria:
         - Expand time window
         - Search by related services (e.g., if ELB is affected, also check EC2 and Target Group cases)
         - Search by error code or symptom keywords in case subjects
```

---

## Tips for Effective Case Review

- **Start narrow, then broaden**: Begin with specific filters (service + time
  window) and expand only if no relevant cases are found.
- **Check resolved cases**: The most valuable information often comes from
  resolved cases where root cause and fix are documented.
- **Note case severity patterns**: If past cases for the same issue were filed
  at `critical` severity, the current incident may warrant similar urgency.
- **Cross-reference with deployments**: If a past case was caused by a
  deployment, check if a similar deployment occurred before the current incident.
