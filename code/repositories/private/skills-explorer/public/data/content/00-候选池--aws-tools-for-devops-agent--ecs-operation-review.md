---
name: ecs-operation-review
description: >
  Performs a comprehensive Amazon ECS operations review across the 6 review
  pillars (Resiliency & HA, Observability, Security, Operations, Performance,
  Additional Analysis) using read-only AWS APIs, with a 7-day CloudWatch
  metrics baseline, recommended alarm thresholds for IDR onboarding, per-pillar
  PASS/FAIL/N/A scorecards, and a prioritized, remediation-linked report
  artifact. Triggers on: "ECS operations review", "ECS assessment",
  "ECS review", "review my ECS service", "ECS reliability review",
  "ECS security review", "ECS best practices audit", "review ECS services
  for a workload".
metadata:
  author: shyamkulkarni
  version: "2.5.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon ECS"
---

# ECS Operations Review Skill

## Overview

Execute a comprehensive Amazon ECS operations review across the 6 review pillars with ✓/✗/N/A observations, 7-day CloudWatch baseline metrics, and alarm threshold recommendations for IDR onboarding.

## Usage

- User mentions "ECS operations review", "ECS assessment", "ECS review"
- User provides ECS service ARN(s) for operations review
- User asks to review ECS services for a workload
- User requests ECS reliability or security review
- Delegated ECS service assessment from UOPS

## Core Concepts

- **Review Pillars**: Six assessment dimensions — Resiliency & HA, Observability, Security, Operations, Performance, Additional Analysis
- **ECS Service/Cluster**: The primary resources assessed — includes tasks, services, and cluster configuration
- **AWS API**: Public AWS service APIs used for all data collection, called read-only (describe/list/get) via the AWS CLI, an AWS SDK, or an AWS API MCP
- **Baseline Metrics**: 7-day CloudWatch metric history used to establish normal operating patterns

## Prerequisites

- Read-only AWS API access (describe/list/get) for ECS, CloudWatch, IAM, Application Auto Scaling, ELB, ECR, EC2 APIs — via AWS CLI, an AWS SDK, or an AWS API MCP
- AWS Knowledge MCP access (search_documentation, read_documentation, recommend, list_regions, get_regional_availability)
- AWS account ID and region
- CloudWatch metrics access (7-day minimum for baseline)
- ECS service ARN — format: arn:aws*:ecs:_:_:service/_/_

## Skill Files

- **references/checks.md** — Checks **index**: pillar→file map, check-ID ranges, counts, and the access-limitation / minimum-baseline rules. Read this FIRST.
- **references/pillars/resiliency.md** — Resiliency & HA checks (REL1-REL14). Read only when running the Resiliency pillar.
- **references/pillars/observability.md** — Observability checks (OBS1-OBS9). Read only when running the Observability pillar.
- **references/pillars/security.md** — Security checks (SEC1-SEC20). Read only when running the Security pillar.
- **references/pillars/operations.md** — Operations checks (OPS1-OPS9). Read only when running the Operations pillar.
- **references/pillars/performance.md** — Performance checks (PERF1-PERF11). Read only when running the Performance pillar.
- **references/pillars/additional-analysis.md** — Additional Analysis checks (ADD1-ADD7). Read only when running the Additional pillar.
- **references/alarm-thresholds.md** — Recommended CloudWatch alarm thresholds for IDR onboarding.
- **references/common-checks-coverage.md** — Crosswalk proving the review covers the shared **`review-common`** baseline (tagging, encryption, IAM least-privilege, alarms, logging, cost) via existing ECS check IDs. Read for any full review / CWR.
- **references/report-format.md** — Required report/artifact structure, severity model, finding-block format, and the **coverage gate**. Read before generating the report.

### Context Management for Checks

Do NOT read all 6 pillar files at once. Read `references/checks.md` (the index) first, then read each `references/pillars/<pillar>.md` file ONE AT A TIME as you run that pillar's checks. Agent may add checks beyond the baseline using the next sequential ID in the pillar.

## <required> Assessment Workflow

This skill is self-contained — the procedural workflow is embedded below (this copy lives in `aws-operations-review` and does not depend on any external `agent-sops/` SOP). Execute the steps in order; this skill's `references/` files supply the check definitions and alarm thresholds.

1. **Setup** — Create the output directory and a scratchpad for raw API responses. Record account ID, region, and timestamp.
2. **Parse ARN** — Validate the ECS service ARN (`arn:aws*:ecs:*:*:service/*/*`); extract cluster name and service name. Halt if the ARN region does not match the region parameter.
3. **Collect configuration data** — Call the AWS APIs following the tier order in the _API Tier Dependency Chain_ below. Tier 1 (`ecs.describeServices`) MUST succeed before any other call. Save each response verbatim to the scratchpad. On non-Tier-1 access/API errors, mark dependent checks N/A and continue.
4. **Resolve compute platform** — Before grading any pillar, classify the service's compute platform from `launchType` + `capacityProviderStrategy` + `ecs.describeCapacityProviders`: **Fargate** (FARGATE/FARGATE_SPOT), **EC2 ASG capacity provider** (`autoScalingGroupProvider`), **Managed Instances** (`managedInstancesProvider`), **launchType-only EC2/Fargate** (no strategy), or **ECS Anywhere** (EXTERNAL). Mixed strategies are valid — record every platform present. This decision drives check applicability in every pillar (full rules in `references/checks.md`). Record the platform in the report header.
5. **Run pillar checks** — Read `references/checks.md` (the index) first, then for EACH pillar read its `references/pillars/<pillar>.md` file one at a time and apply its checks against the collected data, recording ✓ / ✗ / N/A with an observation. Use the exact check IDs and severities; mark platform-specific checks N/A where they don't apply (per the resolved compute platform). May add checks beyond the baseline.
6. **Generate report** — Produce the per-service review artifact following [`references/report-format.md`](references/report-format.md) exactly (Workload Details, per-pillar ✓/✗/N/A scorecards for **all 6 pillars**, Prioritized Action Plan, Detailed Findings, Recommended CloudWatch Alarms from `references/alarm-thresholds.md`, Access Limitations, Review Summary). **Before finalizing, run the report-format Coverage gate** — every check ID across all 6 pillars must appear in a scorecard as ✓/✗/N/A (including passes; no pillar dropped or truncated), the alarms table must be present, every ✗ needs a detailed finding block, and the shared **`review-common`** baseline must be accounted for per [`references/common-checks-coverage.md`](references/common-checks-coverage.md) (all eight common checks covered via their ECS equivalents or ⚪ N/A with a reason). Default to a Markdown artifact; render DOCX only if asked (build from the same content). Strip internal check IDs from the customer-facing report. Return the Review Summary with verified counts, then delete the scratchpad.

**Review Pillars:**

- **Resiliency and High Availability (REL1-REL14)** — Multi-AZ, desired count, deployment config, circuit breaker, deployment alarms, health checks, subnet AZ spread, capacity-provider managed termination protection, target-group deregistration delay, capacity provider infrastructure multi-AZ
- **Observability (OBS1-OBS9)** — Container Insights, CloudWatch alarms, logging, log retention, distributed tracing, metrics monitoring
- **Security (SEC1-SEC20)** — IAM least privilege, network mode, secrets management, ECR image scanning, security groups, VPC endpoints, private connectivity, encryption at rest, encryption in transit (TLS), VPC Flow Logs, GuardDuty Runtime Monitoring
- **Operations (OPS1-OPS9)** — Deployment controller, resource tagging, IaC-managed, platform version, ECS agent version, ECS Exec posture and session audit logging
- **Performance (PERF1-PERF11)** — Auto scaling, CPU/memory rightsizing, capacity provider strategy, managed scaling / targetCapacity headroom, CapacityProviderReservation 7-day baseline analysis, base/weight strategy design, Compute Optimizer recommendations
- **Additional Analysis & Recommendations (ADD1-ADD7)** — Graviton/ARM64, Fargate Spot, Service Connect, cost optimization, CloudWatch Logs Insights queries, ECS Managed Instances evaluation

## AWS API Summary

All calls below are public AWS API operations. Use read-only (describe/list/get) operations only, via the AWS CLI, an AWS SDK (e.g. boto3), or an AWS API MCP with least-privilege read-only credentials.

### ECS APIs (Tier 1, 2, 3)

| API                            | Tier | Purpose                                                                                                                                                                                 |
| ------------------------------ | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ecs.describeServices           | 1    | Foundation — service config, task def, LB, deployment, network                                                                                                                          |
| ecs.describeTaskDefinition     | 2    | Container defs, CPU/memory, roles, log config, network mode                                                                                                                             |
| ecs.describeClusters           | 2    | Cluster settings, Container Insights, capacity providers, Exec logging config (`include=["CONFIGURATIONS"]` for OPS9)                                                                   |
| ecs.listTasks                  | 2    | Running task ARNs for the service                                                                                                                                                       |
| ecs.describeTasks              | 3    | Task health, AZ spread, connectivity status                                                                                                                                             |
| ecs.listContainerInstances     | 2    | Container instance ARNs for EC2 launch type clusters                                                                                                                                    |
| ecs.describeContainerInstances | 3    | Agent version, AMI ID, instance status (EC2 only)                                                                                                                                       |
| ecs.describeCapacityProviders  | 2    | Compute platform classification (ASG vs Managed Instances vs Fargate), managed termination protection (REL12), managed scaling status/targetCapacity (PERF9), MI network config (REL14) |

### Application Auto Scaling APIs (Tier 2)

| API                                            | Tier | Purpose                               |
| ---------------------------------------------- | ---- | ------------------------------------- |
| applicationautoscaling.describeScalingPolicies | 2    | Auto scaling policies for the service |
| applicationautoscaling.describeScalableTargets | 2    | Min/max capacity configuration        |

### ELB APIs (Tier 2)

| API                      | Tier | Purpose                                                                                                                                                                                                  |
| ------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| alb.describeTargetHealth | 2    | Target health for service tasks behind ALB/NLB (skip if no LB configured)                                                                                                                                |
| alb.describeTargetGroups | 2    | Target group details including LoadBalancerArns — used to determine LB type (ALB vs NLB) by ARN path segment: `/app/` = ALB, `/net/` = NLB, for correct alarm recommendations (skip if no LB configured) |
| elbv2.describeListeners  | 2    | Listener protocol/port for the LB fronting the service — HTTPS/TLS vs plaintext HTTP/TCP for encryption-in-transit (SEC20); uses LoadBalancerArns from `describeTargetGroups` (skip if no LB configured) |

### IAM APIs (Tier 4a, 4b)

| API                          | Tier | Purpose                                         |
| ---------------------------- | ---- | ----------------------------------------------- |
| iam.listAttachedRolePolicies | 4a   | Managed policies on execution/task roles        |
| iam.listRolePolicies         | 4a   | Inline policy names on execution/task roles     |
| iam.getRolePolicy            | 4b   | Inline policy document for execution/task roles |

### ECR APIs (Tier 3)

| API                      | Tier | Purpose                                                           |
| ------------------------ | ---- | ----------------------------------------------------------------- |
| ecr.describeRepositories | 3    | Image scanning config, tag immutability for container image repos |

### EC2/VPC APIs (Tier 2, 3, 4)

| API                        | Tier | Purpose                                                                                                              |
| -------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------- |
| ec2.describeSecurityGroups | 2    | Security group rules for service ENIs (awsvpc mode)                                                                  |
| ec2.describeSubnets        | 2    | Subnet AZ distribution for service network config                                                                    |
| ec2.describeVpcEndpoints   | 3    | VPC endpoints for ECR, CloudWatch Logs, Secrets Manager (uses VPC ID from describeSubnets)                           |
| ec2.describeRouteTables    | 3    | Route table entries for NAT/internet access assessment                                                               |
| ec2.describeNatGateways    | 3    | NAT Gateway availability for private subnets                                                                         |
| ec2.describeImages         | 4    | AMI creation date for container instance AMI currency check (EC2 only, uses imageId from describeContainerInstances) |
| ec2.describeVolumes        | 3    | EBS volume encryption status for task-attached / container-instance volumes (SEC17)                                  |
| ec2.describeFlowLogs       | 3    | VPC Flow Logs enablement for the service VPC (SEC18, uses VPC ID from describeSubnets)                               |

### CloudWatch APIs (Tier 2, 5)

| API                            | Tier | Purpose                                                                                                                                    |
| ------------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| cloudwatch.describeAlarms      | 2    | Existing alarms for ECS service                                                                                                            |
| cloudwatch.getMetricStatistics | 5    | 7-day baseline: CPU, memory, task count; plus CapacityProviderReservation (AWS/ECS/ManagedScaling) for EC2 ASG capacity providers (PERF10) |

### CloudWatch Logs APIs (Tier 3)

| API                    | Tier | Purpose                                                                                                                              |
| ---------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| logs.describeLogGroups | 3    | Log retention setting and Logs Insights query targeting for the awslogs group (OBS8, ADD6 — uses awslogs-group from task definition) |

### GuardDuty APIs (Tier 2)

| API                     | Tier | Purpose                                                                                 |
| ----------------------- | ---- | --------------------------------------------------------------------------------------- |
| guardduty.listDetectors | 2    | Detector presence in region (SEC19)                                                     |
| guardduty.getDetector   | 2    | Runtime Monitoring feature status for ECS (SEC19 — uses detector ID from listDetectors) |

### Compute Optimizer APIs (Tier 2)

| API                                           | Tier | Purpose                                                         |
| --------------------------------------------- | ---- | --------------------------------------------------------------- |
| computeoptimizer.getECSServiceRecommendations | 2    | ECS service task CPU/memory rightsizing recommendations (PERF8) |

### AWS Knowledge MCP

| Tool                            | Purpose                                                                 |
| ------------------------------- | ----------------------------------------------------------------------- |
| aws___search_documentation      | Search across all AWS documentation with optional topic-based filtering |
| aws___read_documentation        | Retrieve and convert AWS documentation pages to markdown                |
| aws___recommend                 | Get content recommendations for AWS documentation pages                 |
| aws___list_regions              | Retrieve a list of all AWS regions                                      |
| aws___get_regional_availability | Retrieve AWS regional availability information                          |

## API Tier Dependency Chain

```
Tier 1: ecs.describeServices (FOUNDATION — must complete first)
  ├─ extracts: taskDefinition ARN, clusterArn, loadBalancers,
  │            desiredCount, launchType, networkConfiguration, tags
  │
  ├─► Tier 2 (parallel): ecs.describeTaskDefinition, ecs.describeClusters,
  │     ecs.listTasks, cloudwatch.describeAlarms,
  │     applicationautoscaling.describeScalingPolicies,
  │     applicationautoscaling.describeScalableTargets,
  │     ecs.describeCapacityProviders (compute platform classification;
  │       ASG providers — REL12/PERF9; Managed Instances providers — REL14),
  │     guardduty.listDetectors ─► guardduty.getDetector (SEC19),
  │     computeoptimizer.getECSServiceRecommendations (PERF8),
  │     alb.describeTargetHealth (if LB configured),
  │     alb.describeTargetGroups (if LB configured — resolves ALB vs NLB type from LoadBalancerArns: /app/ = ALB, /net/ = NLB; also deregistration delay for REL13),
  │     elbv2.describeListeners (if LB configured — listener protocol for encryption-in-transit SEC20),
  │     ec2.describeSecurityGroups (from networkConfiguration.securityGroups),
  │     ec2.describeSubnets (from networkConfiguration.subnets),
  │     ecs.listContainerInstances (EC2 launch type only)
  │     │
  │     ├─► Tier 3: ecs.describeTasks (using task ARNs from listTasks)
  │     │            ecs.describeContainerInstances (EC2 only, using instance ARNs from listContainerInstances)
  │     │            ecr.describeRepositories (using repo name from task definition image URI)
  │     │            ec2.describeVpcEndpoints (using VPC ID from describeSubnets)
  │     │            ec2.describeRouteTables (using subnet IDs from describeSubnets)
  │     │            ec2.describeNatGateways (using VPC ID from describeSubnets)
  │     │            ec2.describeFlowLogs (using VPC ID from describeSubnets — SEC18)
  │     │            ec2.describeVolumes (task-attached / container-instance EBS encryption — SEC17)
  │     │            logs.describeLogGroups (using awslogs-group from task definition — OBS8, ADD6)
  │     │
  │     ├─► Tier 4 (EC2 only): ec2.describeImages (using imageId from describeContainerInstances)
  │     │
  │     └─► Tier 4a (parallel): iam.listAttachedRolePolicies (execution + task role),
  │           iam.listRolePolicies (execution + task role)
  │           │
  │           └─► Tier 4b: iam.getRolePolicy (execution + task role)
  │                 (uses policy names from listRolePolicies)
  │
  └─► Tier 5 (per-metric loop): cloudwatch.getMetricStatistics
```

## Access Limitation Handling

When AWS API calls return access denied or authorization errors:

- Mark dependent checks as N/A with observation: "Unable to assess — access denied on {{api_name}}. Manual verification recommended."
- Include a dedicated **Access Limitations** section in the report listing all checks that could not be evaluated due to permissions
- Continue with remaining assessable checks — do NOT halt the entire assessment for non-Tier-1 access errors
- In the Review Summary, note how many checks could not be evaluated due to access limitations

## <good> Example Output

The agent produces a per-service review artifact (Markdown by default; DOCX if asked) containing: service configuration summary, **all 6 review pillar scorecards** (✓/✗/N/A with observations, every check including passes), 7-day baseline metrics, the recommended-alarms table with clickable doc links, and priority action items. A Review Summary with verified counts is returned to the orchestrator.

## <bad> What Not to Do

- Don't skip any pillar — all 6 must be assessed
- Don't use write or mutating API calls — this is a read-only assessment; use describe/list/get operations only
- Don't hardcode doc URLs for ✗ check findings — use AWS Knowledge MCP (`aws___search_documentation`) to supplement the doc links provided in checks.md
- Don't hardcode doc URLs for alarm recommendation hyperlinks — use the `doc_url` column from `references/alarm-thresholds.md` as the canonical link target
- Don't skip alarm recommendations — this is a core IDR deliverable
- Don't omit the metrics baseline section — if 7-day data is unavailable, note the limitation in the report rather than skipping it
- Don't hallucinate findings — only report what AWS API data confirms
- Don't silently skip checks when access is denied — always mark as N/A with explicit access limitation note

## Failure Recovery

- If `ecs.describeServices` fails after retries: HALT workflow — delete `{{scratchpad_dir}}/` and return error to orchestrator
- If Tier 2-5 APIs fail: mark dependent checks as N/A, continue assessment with available data
- If report generation fails: default to the Markdown artifact (no external dependency); only fall back to DOCX (`python-docx`, retry with --user on install failure) when a DOCX deliverable was explicitly requested
- If artifact write fails: capture the error, delete scratchpad, return error to orchestrator

## Success Criteria

- All 6 review pillars assessed with ✓/✗/N/A observations — **coverage gate passed**: every check ID across all 6 pillars appears in a scorecard (including passes), no pillar dropped or truncated
- Review artifact generated at `{{output_directory}}/` (Markdown by default; DOCX only if requested)
- Recommended-alarms table populated from alarm-thresholds.md, marking exist-vs-missing
- 7-day baseline metrics included (or limitation noted)
- Every ✗ has a detailed finding block; every recommendation includes a resolvable AWS documentation link
- Access limitations explicitly documented; unobtainable checks are N/A-with-reason, never omitted or guessed
- Review Summary with verified counts returned to orchestrator
- `{{scratchpad_dir}}/` deleted after report verified
