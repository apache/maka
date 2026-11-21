---
name: arc-region-switch
description: "Answers questions about Amazon Application Recovery Controller (ARC) Region switch including architecture, plans, execution blocks, workflows, triggers, active/active vs active/passive, cross-account support, recovery time, dashboards, and customer positioning. Applicable when users ask about ARC Region switch adoption, design, or troubleshooting."
version: 1
---

# ARC Region switch Expert

## Overview

Makes the agent an expert on **Amazon Application Recovery Controller (ARC) Region switch** — the feature for orchestrating cross-Region workload failover and switchover. Supports technical questions, customer positioning, and SA engagement preparation.

Region switch orchestrates recovery for applications already deployed multi-Region. It does not create multi-Region architecture or handle data replication — it orchestrates failover of existing replicas and resources.

## Guardrail — where this skill's own files live (MCP vs local install)

Before reading a reference file, determine how this skill was loaded:

- **Loaded via the AWS MCP `retrieve_skill` tool:** the skill's reference files are not on the local filesystem. Fetch each one through `retrieve_skill` with the `file` parameter (e.g. `file="references/positioning.md"` or `file="references/doc-links.md"`) — do NOT `file_read` these paths locally or search the filesystem for them.
- **Installed locally** (e.g. `.kiro/skills/arc-region-switch/` or `~/.claude/skills/arc-region-switch/`): read reference files from the local skill directory using the relative paths shown here.

This applies only to the skill's own reference files; always read and write user or session data in the working directory, never through `retrieve_skill`.

## When Not to Use

- **In-Region failover** — Region switch is for cross-Region recovery only. Use AZ-level mechanisms (ALB, Auto Scaling) for in-Region resilience.
- **Data replication design** — Region switch orchestrates failover of existing replicas; it does not set up or manage replication. Use Aurora Global Database, DynamoDB Global Tables, S3 Cross-Region Replication, etc.
- **AZ-level resiliency** — For Availability Zone failures within a single Region, use multi-AZ architecture patterns instead.

## Terminology Constraints

- ALWAYS use "Region switch" (lowercase 's') for the product name
- Use "Routing Controls" only when referring to the Routing Controls execution block or the legacy cluster-based approach — do not use it as a synonym for Region switch
- Do NOT conflate **triggers** (CloudWatch alarms that start execution) with **application health alarms** (measure actual recovery time)
- Region switch orchestrates failover — it does NOT replicate data

## Critical Warnings

- **Irreversible in-progress steps**: Plan executions can be paused or cancelled, but any step that is already started cannot be reversed without another plan execution.
- **Monitor during events**: Customers should still monitor their application health during an event, even if they configure plan triggers to automatically start a plan execution.
- **Regional endpoint matters**: When deactivating a Region, call `start-plan-execution` from the healthy Region, not the Region being deactivated. When activating a Region, call from the Region being activated. See [StartPlanExecution API](https://docs.aws.amazon.com/arc-region-switch/latest/api/API_StartPlanExecution.html).

## Workflow

1. Classify the question: technical architecture, customer positioning, how-to, troubleshooting, or comparison
2. Answer from embedded knowledge in this skill
3. If the knowledge base is insufficient, search official AWS documentation (`docs.aws.amazon.com`)
4. Format the response for the audience (engineer, SA, customer)

Always validate:

- Correct terminology (Region switch, not routing controls for plan-based features)
- Include doc links where helpful (see Documentation Links section)
- Use positioning language from the Positioning section

## Architecture

### Components

| Component                       | Description                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Plan**                        | Top-level resource scoped to a multi-Region application. Contains workflows.                                                        |
| **Child Plan**                  | A self-contained plan nested within a parent plan (one level deep).                                                                 |
| **Workflow**                    | Ordered sequence of steps within a plan. Defines activation/deactivation logic.                                                     |
| **Step**                        | Container for one or more execution blocks, run in parallel or sequence.                                                            |
| **Execution Block**             | Performs a specific recovery action (e.g., scale up, reroute traffic, failover DB).                                                 |
| **Trigger**                     | CloudWatch alarm-based automation that initiates plan execution.                                                                    |
| **Application Health Alarms**   | CloudWatch alarms indicating app health per Region; used to calculate actual recovery time.                                         |
| **Post-recovery Workflow**      | Optional workflow that runs after recovery to prepare for future events.                                                            |
| **Plan Evaluation**             | Automated checks verifying plan execution readiness. Verifies IAM permissions, resource existence and configuration, capacity, etc. |
| **Automatic Execution Reports** | PDF reports delivered to S3 after each plan execution for compliance/audit.                                                         |

### Execution Modes

Recommend using graceful execution unless not possible (e.g., when an execution block has a dependency on the impaired Region — such as Aurora/DocumentDB/Neptune switchover requiring connectivity to the impaired Region, or a Custom Action Lambda deployed in the impaired Region).

- **Graceful**: Runs all steps in orderly sequence. Preferred for planned switchovers, DR tests, and any scenario where the source Region is still healthy.
- **Ungraceful**: Skips or modifies certain execution blocks — only critical steps run. Use only when the source Region is impaired and graceful execution is not possible.
- **Post-recovery**: Runs after successful recovery in the previously-impaired Region. Requires both Regions to be healthy. Supports a subset of execution blocks — see the [Add execution blocks](https://docs.aws.amazon.com/r53recovery/latest/dg/working-with-rs-execution-blocks.html) documentation for the current set.

### Active/Passive vs Active/Active

| Approach           | Workflows Needed                                                                          | Behavior                                                         |
| ------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **Active/Passive** | 1 activation workflow (either Region) OR 2 separate activation workflows (one per Region) | Failover from primary to standby; failback when primary recovers |
| **Active/Active**  | 1 activation workflow + 1 deactivation workflow per Region                                | Shift-away from impaired Region + return when healthy            |

### Supported Execution Blocks

Execution blocks are the individual step types a Region switch workflow is composed of — each performs one recovery action, spanning traffic/DNS rerouting, compute scaling, database failover, custom-action Lambdas, manual-approval gates, and nested child plans.

**Do not rely on a hardcoded list of block types** — ARC adds and changes execution blocks over time. Retrieve the current supported set at query time from the [Components & concepts](https://docs.aws.amazon.com/r53recovery/latest/dg/components-rs.html) and [Add execution blocks](https://docs.aws.amazon.com/r53recovery/latest/dg/working-with-rs-execution-blocks.html) documentation.

### Recovery Time Tracking

- **Recovery Time Objective (RTO)**: Set when creating a plan
- **Actual Recovery Time**: Plan execution time + time for application health alarms to return to green
- Visible on plan execution details page for comparison against RTO

### Plan Evaluation

- Validates: IAM permissions, resource configurations, running capacity
- Warnings surfaced in console, EventBridge, and API
- Passing evaluation alone is NOT sufficient — always test by executing plans

### Automatic Execution Reports

- PDF reports generated after each plan execution
- Delivered to customer-specified S3 bucket (within ~30 min)
- Customers must configure the S3 bucket and update permissions for the PlanExecutionRole to enable reporting
- Contents: executive summary, plan config, execution timeline, resource states, alarm history, child plan details, glossary
- Useful for regulatory compliance and DR audit evidence
- See Security Considerations for encryption and access control guidance

## Cross-Account Support

Plans can orchestrate resources across multiple AWS accounts via IAM roles with cross-account trust policies. This is a key enterprise differentiator — always mention it for large customers.

When configuring cross-account trust policies:

- Include condition keys (`aws:SourceArn`, `aws:SourceAccount`, `sts:ExternalId`) to prevent confused deputy attacks
- Scope IAM policies to least privilege — avoid `*` resource wildcards and `FullAccess` managed policies
- Scope permissions to only the specific resources (ASG ARNs, Aurora cluster ARNs, Route 53 health check ARNs, etc.) referenced in execution blocks

## Regional Availability

Available in multiple commercial AWS Regions and AWS GovCloud (US) Regions — always verify the current list before stating availability to a customer, as Region coverage changes over time. Each Region has its own data-plane endpoint (`arc-region-switch.<region>.api.aws`), ensuring execution doesn't depend on the impaired Region.

> Verify the complete list of available regions/endpoints at [AWS Regions & endpoints](https://docs.aws.amazon.com/r53recovery/latest/dg/aws-regions-rs.html).

## Security Considerations

### IAM Least Privilege

- Scope cross-account IAM roles to only the specific resources referenced in execution blocks (ASG ARNs, Aurora cluster ARNs, Route 53 health check ARNs, Lambda function ARNs, etc.)
- Avoid `*` resource wildcards and `FullAccess` managed policies
- Include condition keys (`aws:SourceArn`, `aws:SourceAccount`, `sts:ExternalId`) in cross-account trust policies to prevent confused deputy attacks

### Execution Reports S3 Bucket

- Enable default encryption (SSE-KMS preferred) on the reports S3 bucket
- Add a bucket policy denying requests where `aws:SecureTransport` is `false` (enforce TLS)
- Restrict bucket access to authorized personnel only — reports contain sensitive infrastructure details (plan config, execution timeline, resource states, alarm history)
- Enable S3 bucket versioning and MFA Delete for tamper protection
- Ensure the bucket is not publicly accessible

### Custom Action Lambda Security

- Apply least-privilege execution roles to Custom Action Lambda functions
- Validate inputs within Lambda functions
- Do not embed secrets in Lambda environment variables — use Secrets Manager or Parameter Store

### Notification & Event Targets

- Restrict EventBridge rule targets (SNS topics, Lambda functions, etc.) that receive plan-evaluation warnings and execution events to authorized recipients only
- Lock down SNS topic subscription policies and Lambda resource policies so sensitive infrastructure details (plan configuration, resource ARNs, execution state) are not exposed to unauthorized parties

### Logging and Monitoring

- Enable AWS CloudTrail for auditing all ARC Region switch API calls
- Configure CloudWatch alarms for unexpected or unauthorized plan executions
- Enable S3 access logging on the execution reports bucket
- See [Logging and monitoring for Region switch](https://docs.aws.amazon.com/r53recovery/latest/dg/logging-and-monitoring-rs.html)

## Positioning

Customer-facing framing, the Region switch vs Routing Controls comparison, analyst talking
points, and per-audience conversation guidance are maintained in
**[Positioning](references/positioning.md)**. Load that reference for any customer-positioning,
competitive-comparison, or analyst-briefing question. Key rules that always apply:

- Use "Region switch" (plan-based orchestration) framing; do NOT present legacy "routing controls"
  / "ARC clusters" language as the Region switch (plan-based) approach.
- Always mention **cross-account** support and **data-plane-per-Region** isolation for enterprise customers.

## Documentation Links

The curated documentation index and the "when to link which doc" guidance live in
**[Documentation Links](references/doc-links.md)**. Load that reference to attach the right AWS
doc to an answer (overview, components & concepts, execution blocks, API/CLI, security & IAM,
logging & monitoring, quotas, Terraform provider).

## Troubleshooting

### Customer confuses triggers with health alarms

Triggers are CloudWatch alarms that **start** plan execution. Application health alarms **measure** when recovery is complete. They serve different purposes and are configured separately.

### Customer assumes Region switch handles data sync

Clarify: Region switch orchestrates failover of existing replicas (e.g., Aurora Global DB promotion). The customer must set up multi-Region data replication independently.

### Cross-account execution fails

Usually missing IAM permissions. Verify: cross-account trust policy includes condition keys (`aws:SourceArn`, `aws:SourceAccount`, `sts:ExternalId`), target IAM role ARN is correct, and permissions are scoped to the specific resources in the execution blocks.

### Plan evaluation warnings

Warnings indicate IAM, resource, or capacity issues. Fix the underlying issue — but note that passing evaluation alone isn't sufficient; always test by executing plans.

### Wrong Regional endpoint used

When deactivating a Region, `start-plan-execution` MUST be called from the healthy Region. When activating a Region, it MUST be called from the Region being activated. Using the wrong endpoint will fail or produce unexpected behavior. See [StartPlanExecution API](https://docs.aws.amazon.com/arc-region-switch/latest/api/API_StartPlanExecution.html).
