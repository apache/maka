---
name: service-quota-check
description: Use this skill during any incident investigation, capacity planning, or
  operational troubleshooting when the issue may be caused by hitting AWS service limits.
  Activate when you observe throttling errors (ThrottlingException, TooManyRequestsException,
  LimitExceededException), resource creation failures, capacity-related alarms, or when
  a recommendation involves provisioning new AWS resources.
metadata:
  author: yuriypr
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Incident RCA"
  aws-devops-agent-skills.aws-services: "AWS Service Quotas, Amazon CloudWatch"
  aws-devops-agent-skills.technical-domains: "Operations, Capacity Planning"
---

# Service Quota Check

Use this skill to check AWS service quota utilization during investigations and before
provisioning new resources. It determines whether a quota is nearing its limit (85%+
utilization) and takes action: requesting a quota increase via the Service Quotas API
when possible, or recommending a support case when programmatic increases are not supported.

## When to Use This Skill

- An error message indicates throttling or limit exceeded (e.g., `ThrottlingException`,
  `TooManyRequestsException`, `LimitExceededException`, `ResourceLimitExceeded`).
- A resource creation or scaling operation fails with capacity errors.
- An investigation recommendation involves provisioning additional AWS resources
  (e.g., adding EC2 instances, creating VPCs, adding NAT Gateways, launching RDS instances).
- Capacity planning or pre-launch readiness checks.
- Proactive monitoring of quota utilization across services.

## Prerequisites

- The agent must have permissions to call Service Quotas APIs:
  - `servicequotas:ListServices`
  - `servicequotas:ListServiceQuotas`
  - `servicequotas:GetServiceQuota`
  - `servicequotas:RequestServiceQuotaIncrease`
  - `servicequotas:ListRequestedServiceQuotaChangeHistory`
  - `servicequotas:CreateSupportCase`
- For utilization data via CloudWatch, the agent needs:
  - `cloudwatch:GetMetricData`
  - `cloudwatch:GetMetricStatistics`
- Service Quotas is a regional service. Quotas must be checked in the region
  where resources are deployed.

---

## Step 1: Identify the Service and Quota Context

Determine which service and quota to check based on the investigation context:

1. **From error messages** — extract the service name and specific limit mentioned.
2. **From recommendations** — if the recommendation is to provision resources, identify
   the service (e.g., EC2, VPC, RDS, Lambda, ELB) and the resource type.
3. **From alarms** — if a CloudWatch alarm indicates capacity pressure, identify the
   underlying service.

### Common service codes

| AWS Service               | Service Code           |
| ------------------------- | ---------------------- |
| Amazon EC2                | `ec2`                  |
| Amazon VPC                | `vpc`                  |
| Elastic Load Balancing    | `elasticloadbalancing` |
| Amazon RDS                | `rds`                  |
| AWS Lambda                | `lambda`               |
| Amazon ECS                | `ecs`                  |
| Amazon EKS                | `eks`                  |
| Amazon S3                 | `s3`                   |
| Amazon DynamoDB           | `dynamodb`             |
| AWS Fargate               | `fargate`              |
| Amazon CloudWatch         | `monitoring`           |
| AWS CloudFormation        | `cloudformation`       |
| Amazon SQS                | `sqs`                  |
| Amazon SNS                | `sns`                  |
| Amazon ElastiCache        | `elasticache`          |
| Amazon OpenSearch Service | `es`                   |
| Auto Scaling              | `autoscaling`          |

If you do not know the service code, use:

```bash
aws service-quotas list-services \
  --query "Services[?contains(ServiceName, '<keyword>')]" \
  --region <region>
```

---

## Step 2: Retrieve Quota Value and Utilization

### Get the applied quota value

```bash
aws service-quotas get-service-quota \
  --service-code <service-code> \
  --quota-code <quota-code> \
  --region <region>
```

The response includes:

- `Value` — the current quota limit (applied value, or default if no increase was granted)
- `Adjustable` — whether the quota can be increased
- `UsageMetric` — CloudWatch metric to check current utilization (if available)

### If you do not know the quota code

List all quotas for the service:

```bash
aws service-quotas list-service-quotas \
  --service-code <service-code> \
  --region <region>
```

Filter by quota name keyword:

```bash
aws service-quotas list-service-quotas \
  --service-code <service-code> \
  --region <region> \
  --query "Quotas[?contains(QuotaName, '<keyword>')]"
```

### Get current utilization via CloudWatch

If the `UsageMetric` field is present in the quota response, query CloudWatch for actual usage:

```bash
aws cloudwatch get-metric-statistics \
  --namespace "<MetricNamespace>" \
  --metric-name "<MetricName>" \
  --dimensions <MetricDimensions> \
  --start-time "<15-minutes-ago-ISO8601>" \
  --end-time "<now-ISO8601>" \
  --period 300 \
  --statistics <MetricStatisticRecommendation> \
  --region <region>
```

The `UsageMetric` object from the quota response provides all the parameters:

- `MetricNamespace` — typically `AWS/Usage`
- `MetricName` — typically `ResourceCount`
- `MetricDimensions` — service-specific dimensions (e.g., `Class`, `Resource`, `Service`, `Type`)
- `MetricStatisticRecommendation` — either `Maximum` or `Sum`

### Alternative: count resources directly

If no `UsageMetric` is available, count resources using the service's Describe/List APIs:

| Service          | Command to count resources                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| EC2 instances    | `aws ec2 describe-instances --query "Reservations[].Instances[] \| length(@)"`                          |
| VPCs             | `aws ec2 describe-vpcs --query "Vpcs \| length(@)"`                                                     |
| NAT Gateways     | `aws ec2 describe-nat-gateways --filter Name=state,Values=available --query "NatGateways \| length(@)"` |
| EIPs             | `aws ec2 describe-addresses --query "Addresses \| length(@)"`                                           |
| RDS instances    | `aws rds describe-db-instances --query "DBInstances \| length(@)"`                                      |
| Lambda functions | `aws lambda list-functions --query "Functions \| length(@)"`                                            |
| ECS services     | `aws ecs list-services --cluster <cluster> --query "serviceArns \| length(@)"`                          |
| ALBs             | `aws elbv2 describe-load-balancers --query "LoadBalancers \| length(@)"`                                |

---

## Step 3: Calculate Utilization and Assess Risk

### Calculate utilization percentage

```
utilization_pct = (current_usage / quota_value) × 100
```

### Risk assessment thresholds

| Utilization | Risk Level | Action                                                   |
| ----------- | ---------- | -------------------------------------------------------- |
| < 70%       | Low        | No action needed. Report current state.                  |
| 70% – 84%   | Medium     | Flag as approaching limit. Monitor closely.              |
| 85% – 94%   | High       | Recommend quota increase. Proceed to Step 4.             |
| 95% – 100%  | Critical   | Urgent quota increase required. Proceed to Step 4.       |
| = 100%      | Exhausted  | Quota is blocking operations. Immediate action required. |

### Present findings

Always show the user a summary table:

```
┌─────────────────────────────────────────────────────────────────────┐
│ Service Quota Check                                                  │
├─────────────────────────┬───────────┬─────────┬─────────┬───────────┤
│ Quota Name              │ Limit     │ Used    │ % Used  │ Status    │
├─────────────────────────┼───────────┼─────────┼─────────┼───────────┤
│ Running On-Demand (std) │ 1920 vCPU │ 1740    │ 90.6%   │ ⚠️ HIGH   │
│ VPCs per Region         │ 5         │ 5       │ 100%    │ 🚫 FULL   │
│ NAT Gateways per AZ    │ 5         │ 3       │ 60%     │ ✅ OK     │
└─────────────────────────┴───────────┴─────────┴─────────┴───────────┘
```

---

## Step 4: Request Quota Increase

When utilization is at 85% or higher, proceed based on whether the quota is adjustable.

### Decision Tree

```
Is utilization >= 85%?
├── NO → Report findings, no action needed
└── YES → Check "Adjustable" field
    ├── Adjustable = true → Proceed to quota increase request
    │   ├── Ask user to confirm the increase
    │   ├── User confirms → Submit request via API (Step 4a)
    │   └── User declines → Report findings only
    └── Adjustable = false → Recommend support case (Step 4b)
```

### Step 4a: Submit Quota Increase Request via API

Before requesting, determine the desired new value. Use this formula:

```
desired_value = current_quota × 1.5   (50% increase over current limit)
```

If the quota is already exhausted (100% utilization), recommend:

```
desired_value = current_quota × 2.0   (double the current limit)
```

Present the recommendation to the user:

> "The quota **[QuotaName]** is at **[X]%** utilization ([current_usage]/[quota_value]).
> I recommend increasing it to **[desired_value]**. Shall I submit the quota increase
> request?"

If the user confirms, submit the request:

```bash
aws service-quotas request-service-quota-increase \
  --service-code <service-code> \
  --quota-code <quota-code> \
  --desired-value <desired-value> \
  --region <region>
```

After submitting, check the response:

- `Status: PENDING` — request submitted successfully. Inform the user that AWS will
  review the request (typically processed within minutes for auto-approved quotas,
  or up to a few days for manual review).
- `Status: CASE_OPENED` — a support case was automatically created.

Report the request ID and status:

> "Quota increase request submitted successfully.
>
> - Request ID: [Id]
> - Status: [Status]
> - Desired value: [DesiredValue]
>
> You can check the status with:
> `aws service-quotas get-requested-service-quota-change --request-id <Id>`"

### Step 4b: Recommend Support Case (non-adjustable quotas)

If the quota cannot be increased via the API (`Adjustable: false`), inform the user:

> "The quota **[QuotaName]** cannot be increased programmatically via the Service
> Quotas API. To request an increase, you need to open an AWS Support case.
>
> Would you like me to:
>
> 1. Open a support case via the Service Quotas API (requires an existing pending
>    quota increase request)
> 2. Provide instructions to open a support case manually via the AWS Console"

If there is an existing pending request, use:

```bash
aws service-quotas create-support-case \
  --request-id <request-id> \
  --region <region>
```

Otherwise, provide manual instructions:

> "To request this quota increase:
>
> 1. Go to the AWS Support Center: https://console.aws.amazon.com/support/
> 2. Create a new case → Service limit increase
> 3. Select service: [ServiceName]
> 4. Select quota: [QuotaName]
> 5. Specify the new desired value: [desired_value]
> 6. Provide business justification for the increase"

---

## Step 5: Check for Pending Requests

Before submitting a new request, check if there is already a pending increase request:

```bash
aws service-quotas list-requested-service-quota-change-history-by-quota \
  --service-code <service-code> \
  --quota-code <quota-code> \
  --region <region> \
  --query "RequestedQuotas[?Status=='PENDING']"
```

If a pending request exists:

- Report the existing request details (ID, desired value, date submitted)
- Do NOT submit a duplicate request
- Offer to create a support case to expedite the existing request if needed

---

## Step 6: Post-Increase Verification

After a quota increase is approved, verify the new limit:

```bash
aws service-quotas get-service-quota \
  --service-code <service-code> \
  --quota-code <quota-code> \
  --region <region>
```

Confirm the `Value` field reflects the new limit.

---

## Multi-Quota Check (Bulk Assessment)

When a recommendation involves provisioning multiple resource types, or for proactive
capacity planning, check all relevant quotas for the service:

```bash
aws service-quotas list-service-quotas \
  --service-code <service-code> \
  --region <region>
```

For each quota that has a `UsageMetric`, calculate utilization. Report any quotas
at 70%+ utilization as part of a comprehensive capacity report.

---

## Common Quota Codes Reference

See [references/common-quota-codes.md](references/common-quota-codes.md) for a table of
frequently checked quota codes by service.

---

## Error Handling

| Error                             | Cause                                         | Resolution                                             |
| --------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `NoSuchResourceException`         | Quota code does not exist for the service     | Use `list-service-quotas` to find the correct code     |
| `TooManyRequestsException`        | Service Quotas API is throttling              | Wait and retry with exponential backoff                |
| `ResourceAlreadyExistsException`  | A pending request already exists              | Check existing requests (Step 5)                       |
| `QuotaExceededException`          | The desired value exceeds the maximum allowed | Reduce the desired value or open a support case        |
| `AccessDeniedException`           | Missing IAM permissions                       | Check that the agent has `servicequotas:*` permissions |
| `DependencyAccessDeniedException` | Missing permissions on the target service     | Verify IAM policies for the target service             |

---

## Tips

- **Check the region**: Service quotas are regional. Always query in the region where
  resources are deployed, unless the quota is global (check `GlobalQuota: true`).
- **Applied vs. default**: `get-service-quota` returns the applied value (which may differ
  from the default if a previous increase was granted). Use `get-aws-default-service-quota`
  to see the original default.
- **Auto-approved vs. manual**: Many quotas (especially EC2 vCPU limits) are auto-approved
  within minutes. Others require manual AWS review. The API does not indicate which type
  a quota is in advance — submit the request and monitor the status.
- **Resource-level quotas**: Some quotas (e.g., OpenSearch instances per domain) are
  resource-level. Use `--context-id` with the resource ARN for these.
- **Rate-based quotas**: Some quotas measure requests per second (e.g., API call rates).
  These require different monitoring approaches (CloudWatch metrics rather than resource counts).
