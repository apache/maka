---
name: cost-estimation
description: 'Forecast Azure spend and price planned resources or workloads. WHEN: "forecast Azure spending", "project next month cost", "compare forecast to my planning target", "how much will Azure cost", "estimate VM cost", "compare storage tiers", "compare Azure regions", "retail price", "EA rate card", "negotiated pricesheet". DO NOT USE FOR: configured budget health or alerts, bill analysis, cost spikes, rightsizing, or commitments.'
license: MIT
metadata:
  author: Microsoft
  version: "1.1.1"
---

# Azure Cost Estimation

## Quick Reference

| Intent                  | Workflow                                              | Primary tools    |
| ----------------------- | ----------------------------------------------------- | ---------------- |
| Forecast existing spend | [Cost forecast](references/cost-forecast/workflow.md) | `forecast_costs` |
| Price planned resources | [Pricing estimate](references/pricing-estimate.md)    | Pricing tools    |

## When to Use This Skill

Use for forecasts, pricing, and planning targets.

## MCP Tools

| Tool                                                 | Use                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------- |
| `forecast_costs`                                     | Forecast a scope.                                                           |
| `get_retail_prices`                                  | Get public prices.                                                          |
| `start_pricesheet_download`, `get_pricesheet_status` | Get Enterprise Agreement (EA) or Microsoft Customer Agreement (MCA) prices. |

Fallback: [API mappings](references/tool-fallback.md).

## Workflow

1. Distinguish forecasts from hypothetical pricing.
2. Confirm scope, assumptions, period, region, OS, and currency.
3. Load the matching workflow and label every value type.
4. Never transform MCP results in a shell or interpreter; request tool-side
   filtering or bounded follow-up queries.

## Error Handling

| Error                | Action                                |
| -------------------- | ------------------------------------- |
| Ambiguous meter      | Ask for OS, term, tier, or usage.     |
| Forecast unavailable | Explain the history requirement.      |
| Pricesheet pending   | Honor the returned polling interval.  |
| Multiple currencies  | Never combine currencies.             |
| Server error         | Retry once; then report the trace ID. |
