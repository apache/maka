---
name: aws-billing-and-cost-management
description: |
  Analyze AWS costs, find savings, manage budgets, evaluate Savings Plans and
  Reserved Instances, right-size EC2/Lambda/RDS/EBS with Compute Optimizer,
  look up service pricing, query CUR with Athena, detect cost anomalies,
  scope costs to billing views, and monitor Free Tier usage. Triggers on:
  AWS bill, cost analysis, reduce spend, savings plan, reserved instance,
  right-size, budget alert, cost optimization, pricing, free tier, cost
  anomaly, CUR, cost audit, billing view, billing view ARN.
metadata:
  version: "1"
---

# Billing and Cost Management

## Overview

Analyze, optimize, and manage AWS costs. This skill encodes domain expertise from AWS's cost management products — gotchas, correct API usage patterns, and optimization workflows that models frequently get wrong.

## Usage

Use this skill when:

- Analyzing AWS spending, cost trends, or cost breakdowns
- Setting up or managing budget alerts
- Evaluating Savings Plans or Reserved Instance purchases
- Right-sizing EC2, Lambda, RDS, or EBS resources
- Looking up AWS service pricing
- Running cost audits or investigating cost spikes
- Querying CUR data with Athena
- Scoping cost analysis to a specific billing view
- Checking Free Tier usage

## Core Concepts

- **Cost Explorer** — query cost/usage data by service, account, tag, or time range
- **Budgets** — set spending thresholds with alerts; supports billing view scoping
- **Billing Views** — scope cost data to a subset of billing (custom view, billing group, or primary)
- **Compute Optimizer** — right-sizing recommendations for EC2, Lambda, EBS, RDS
- **Cost Optimization Hub** — aggregated savings recommendations across services
- **Savings Plans / Reserved Instances** — commitment-based discounts
- **CUR 2.0** — detailed line-item billing data queryable via Athena

**Recommended setup:** Use the AWS MCP server for sandboxed execution, audit logging, and enterprise controls. See: https://docs.aws.amazon.com/aws-mcp/

**Without AWS MCP:** All commands use standard AWS CLI syntax and work with any agent that has CLI access.

## Critical Rule: Always Check the Current Date

**Before making ANY Cost Explorer, Budgets, or Savings Plans API call, you MUST determine the current date.** Use a tool to get the current date and time — do NOT assume or guess the year. LLMs frequently default to dates from their training data instead of the actual current date, producing analyses of stale data that appear correct but are completely wrong.

## Critical Rule: Deterministic Calculations

**You MUST NEVER perform numerical calculations (sums, averages, percentages, comparisons, counts, min/max) by reasoning in your response.** LLM arithmetic is unreliable and produces wrong answers on cost data.

**You MUST ALWAYS use a script or calculator tool** for any math on data returned from API calls. Write a Python script that performs the calculation and prints the result. If the AWS MCP server's `run_script` tool is available, use it. Otherwise, run the script locally.

Read `references/deterministic-calculations.md` for patterns and examples.

## Decision Guide

| Question                                        | Tool                   | Reference                                                                                                                                |
| ----------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| What am I spending? Where are costs going up?   | Cost Explorer          | `references/cost-explorer.md`                                                                                                            |
| How much does a service cost?                   | Price List API         | `references/pricing-lookup.md`                                                                                                           |
| Where can I save money? (start here)            | Cost Optimization Hub  | `references/cost-optimization-hub.md`                                                                                                    |
| Should I buy Savings Plans?                     | CE SP Recommendations  | `references/savings-plans.md`                                                                                                            |
| Should I buy Reserved Instances?                | CE RI Recommendations  | `references/reserved-instances.md`                                                                                                       |
| Deep-dive on a specific EC2/Lambda/EBS/RDS rec? | Compute Optimizer      | `references/ec2-rightsizing.md`, `references/lambda-optimization.md`, `references/rds-optimization.md`, `references/ebs-optimization.md` |
| How do I set up budget alerts?                  | Budgets                | `references/budgets.md`                                                                                                                  |
| What's causing a cost spike?                    | Cost Anomaly Detection | `references/cost-explorer.md`                                                                                                            |
| Am I within Free Tier?                          | Free Tier API          | `references/free-tier.md`                                                                                                                |
| How do I reduce my bill?                        | Cost Audit workflow    | `references/cost-audit.md`                                                                                                               |
| How do I query detailed billing data?           | CUR 2.0 + Athena       | `references/cur-athena.md`                                                                                                               |
| How do I optimize specific services?            | Per-service patterns   | `references/service-optimization.md`                                                                                                     |
| How do I scope costs to a billing view?         | Billing Views          | See [Billing Views](#billing-views) below                                                                                                |

## Common Tasks

### Analyze costs by service

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-03-01,End=2026-04-01 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

Default to `UnblendedCost`. Exclude Credits/Refunds with `--filter '{"Not":{"Dimensions":{"Key":"RECORD_TYPE","Values":["Credit","Refund"]}}}'`. End date is exclusive.

### Run a cost audit

Read `references/cost-audit.md` for the full 7-step workflow: top cost drivers → month-over-month comparison → optimization recommendations → idle resources → commitment coverage → per-service quick wins → report.

### Get right-sizing recommendations

Compute Optimizer requires opt-in first: `aws compute-optimizer update-enrollment-status --status Active`. Then read `references/ec2-rightsizing.md` for EC2 or the relevant resource-specific reference.

### Look up service pricing

Read `references/pricing-lookup.md` for service codes and attribute filters. Common trap: Price List API service codes differ from Cost Explorer service names.

## Billing Views

A billing view scopes cost and usage data to a specific slice of an account's billing (e.g., a billing group, custom view, or the default primary view). When the user wants to analyze costs through a particular billing view, add `--billing-view-arn` to supported API calls.

### Discover available billing views

```bash
aws billing list-billing-views \
  --billing-view-types PRIMARY CUSTOM BILLING_GROUP
```

Requires `billing:ListBillingViews` permission.

### Use a billing view with Cost Explorer

```bash
aws ce get-cost-and-usage \
  --time-period Start=2026-03-01,End=2026-04-01 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE \
  --billing-view-arn arn:aws:billing::ACCOUNT_ID:billingview/BILLING_VIEW_ID
```

### Create a budget scoped to a billing view

In the `--budget` JSON, include the `BillingViewArn` field:

```bash
aws budgets create-budget --account-id ACCOUNT_ID \
  --budget '{
    "BudgetName": "TeamX-Monthly",
    "BudgetLimit": {"Amount": "1000", "Unit": "USD"},
    "TimeUnit": "MONTHLY",
    "BudgetType": "COST",
    "BillingViewArn": "arn:aws:billing::ACCOUNT_ID:billingview/BILLING_VIEW_ID"
  }'
```

### API support for `--billing-view-arn`

| Supports `--billing-view-arn`            | Does NOT support it                |
| ---------------------------------------- | ---------------------------------- |
| `ce get-cost-and-usage`                  | `ce get-reservation-coverage`      |
| `ce get-cost-and-usage-with-resources`   | `ce get-reservation-utilization`   |
| `ce get-cost-forecast`                   | `ce get-savings-plans-coverage`    |
| `ce get-usage-forecast`                  | `ce get-savings-plans-utilization` |
| `ce get-dimension-values`                |                                    |
| `ce get-tags`                            |                                    |
| `ce get-cost-comparison-drivers`         |                                    |
| `budgets create-budget` (in budget JSON) |                                    |

## Troubleshooting

| Error                                           | Cause                                                              | Fix                                                                                                           |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `ValidationException` on Cost Explorer          | Wrong dimension key (e.g., `CHARGE_TYPE` instead of `RECORD_TYPE`) | Use `RECORD_TYPE` for charge type filtering                                                                   |
| Empty results with filter                       | Filter value doesn't match exactly                                 | Call `GetDimensionValues` first to get valid values                                                           |
| `AccessDeniedException` on hourly data          | Hourly granularity not enabled                                     | Enable in Cost Explorer preferences                                                                           |
| `Account not registered` on Compute Optimizer   | Not opted in                                                       | Run `update-enrollment-status --status Active`                                                                |
| Budgets API fails outside us-east-1             | Budgets requires us-east-1                                         | Set `--region us-east-1`                                                                                      |
| Cost Explorer `Total` empty with GroupBy        | By design — totals excluded when grouping                          | Make separate call without GroupBy, or sum grouped results using a script                                     |
| `AccessDeniedException` on `list-billing-views` | Missing permission                                                 | User needs `billing:ListBillingViews` permissions                                                             |
| `ValidationException` with `--billing-view-arn` | API doesn't support billing views, or malformed ARN                | Check the API support table above; ARN format is `arn:aws:billing::ACCOUNT_ID:billingview/VIEW_ID`            |
| Budget shows `UNHEALTHY` health status          | Billing view access revoked or view deleted                        | Check `HealthStatus.StatusReason` in `describe-budget` output; ensure `billing:GetBillingViewData` is granted |

## Additional Resources

- AWS Cost Management User Guide: https://docs.aws.amazon.com/cost-management/
- AWS Pricing Calculator: https://calculator.aws/
- Compute Optimizer User Guide: https://docs.aws.amazon.com/compute-optimizer/
- Well-Architected Cost Optimization Pillar: https://docs.aws.amazon.com/wellarchitected/latest/cost-optimization-pillar/
