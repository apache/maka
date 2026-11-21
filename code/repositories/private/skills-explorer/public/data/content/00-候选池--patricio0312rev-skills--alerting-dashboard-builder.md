---
name: alerting-dashboard-builder
description: Creates SLO-based alerts and operational dashboards with key charts, alert thresholds, and runbook links. Use for "alerting", "dashboards", "SLO", or "monitoring".
---

# Alerting & Dashboard Builder

Build effective alerts and dashboards based on SLOs.

## SLO Definition

```yaml
slos:
  - name: api_availability
    objective: 99.9%
    window: 30d
    sli: |
      sum(rate(http_requests_total{status_code!~"5.."}[5m])) /
      sum(rate(http_requests_total[5m]))

  - name: api_latency
    objective: 95% # 95% of requests under 500ms
    window: 30d
    sli: |
      histogram_quantile(0.95,
        rate(http_request_duration_seconds_bucket[5m])
      ) < 0.5
```

## Alert Rules

```yaml
groups:
  - name: slo_alerts
    rules:
      # Fast burn (1% budget in 1h)
      - alert: AvailabilitySLOFastBurn
        expr: |
          (1 - (sum(rate(http_requests_total{status_code!~"5.."}[1h])) /
          sum(rate(http_requests_total[1h])))) > 0.01
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: "Burning 1% error budget per hour"
          runbook: "https://runbooks.example.com/availability-fast-burn"

      # Slow burn (10% budget in 24h)
      - alert: AvailabilitySLOSlowBurn
        expr: |
          (1 - (sum(rate(http_requests_total{status_code!~"5.."}[24h])) /
          sum(rate(http_requests_total[24h])))) > 0.001
        for: 1h
        labels:
          severity: warning
        annotations:
          summary: "Burning error budget slowly"
```

## Dashboard Template

```json
{
  "title": "Service Health Dashboard",
  "rows": [
    {
      "title": "Golden Signals",
      "panels": [
        {
          "title": "Request Rate",
          "query": "sum(rate(http_requests_total[5m]))",
          "type": "graph"
        },
        {
          "title": "Error Rate",
          "query": "sum(rate(http_requests_total{status_code=~"5.."}[5m]))",
          "type": "graph"
        },
        {
          "title": "Latency (p50, p95, p99)",
          "queries": [
            "histogram_quantile(0.50, rate(http_request_duration_seconds_bucket[5m]))",
            "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))",
            "histogram_quantile(0.99, rate(http_request_duration_seconds_bucket[5m]))"
          ]
        },
        {
          "title": "Saturation (CPU, Memory)",
          "queries": [
            "rate(process_cpu_seconds_total[5m])",
            "process_resident_memory_bytes"
          ]
        }
      ]
    },
    {
      "title": "SLO Tracking",
      "panels": [
        {
          "title": "Error Budget Remaining",
          "query": "1 - ((1 - 0.999) - (1 - slo_availability))"
        }
      ]
    }
  ]
}
```

## What to Do When Alert Fires

```markdown
# Alert Response Guide

## HighErrorRate

**What it means:** More than 5% of requests are failing

**First steps:**

1. Check recent deployments (rollback if needed)
2. Review error logs for patterns
3. Check dependent services health
4. Verify database connectivity

**Escalation:** If not resolved in 15 min, page on-call lead

## HighLatency

**What it means:** p95 latency above 2 seconds

**First steps:**

1. Check database query performance
2. Review recent code changes
3. Check cache hit rates
4. Look for slow external API calls

**Temporary mitigation:**

- Scale up instances
- Enable aggressive caching

## LowAvailability

**What it means:** Availability below 99.5%

**First steps:**

1. Check infrastructure (AWS status page)
2. Review load balancer health checks
3. Check for DDoS activity
4. Verify auto-scaling functioning
```

## Output Checklist

- [ ] SLOs defined
- [ ] Alert rules configured
- [ ] Dashboards created
- [ ] Runbooks linked
- [ ] Response guides documented
      ENDFILE
