---
name: capacity-planning-helper
description: Estimates infrastructure needs based on traffic forecasts, workload analysis, and performance requirements with sizing recommendations and cost trade-offs. Use for "capacity planning", "infrastructure sizing", "resource estimation", or "scalability planning".
---

# Capacity Planning Helper

Right-size infrastructure for current and future needs.

## Traffic Forecasting

```typescript
interface TrafficForecast {
  current: {
    dailyUsers: number;
    peakRPS: number;
    avgRPS: number;
  };
  projected: {
    timeframe: "6m" | "12m" | "24m";
    dailyUsers: number;
    peakRPS: number;
    avgRPS: number;
    growthRate: number;
  };
}

const forecast: TrafficForecast = {
  current: {
    dailyUsers: 100000,
    peakRPS: 500,
    avgRPS: 200,
  },
  projected: {
    timeframe: "12m",
    dailyUsers: 500000, // 5x growth
    peakRPS: 2500,
    avgRPS: 1000,
    growthRate: 4.0, // 400% growth
  },
};
```

## Resource Estimation

```typescript
interface ResourceNeeds {
  compute: {
    instanceType: string;
    instanceCount: number;
    cpu: number;
    memory: number;
  };
  database: {
    instanceType: string;
    instanceCount: number;
    storage: number;
    iops: number;
  };
  cache: {
    instanceType: string;
    nodes: number;
    memory: number;
  };
}

function estimateResources(forecast: TrafficForecast): ResourceNeeds {
  const { peakRPS } = forecast.projected;

  // Rule of thumb: 100 RPS per instance (with headroom)
  const instanceCount = Math.ceil(peakRPS / 100);

  // Database: 1000 connections per 2vCPU
  const dbInstances = Math.ceil((peakRPS * 2) / 1000);

  return {
    compute: {
      instanceType: "t3.large",
      instanceCount: instanceCount * 1.5, // 50% headroom
      cpu: 2 * instanceCount,
      memory: 8 * instanceCount,
    },
    database: {
      instanceType: "db.r6g.xlarge",
      instanceCount: dbInstances,
      storage: 1000, // GB
      iops: 10000,
    },
    cache: {
      instanceType: "cache.r6g.large",
      nodes: 2, // Primary + replica
      memory: 12, // GB
    },
  };
}
```

## Cost Estimation

```typescript
interface CostEstimate {
  monthly: {
    compute: number;
    database: number;
    cache: number;
    storage: number;
    bandwidth: number;
    total: number;
  };
  annual: number;
}

const pricing = {
  "t3.large": 0.0832, // $/hour
  "db.r6g.xlarge": 0.336,
  "cache.r6g.large": 0.226,
  storage: 0.1, // $/GB/month
  bandwidth: 0.09, // $/GB
};

function estimateCost(resources: ResourceNeeds, trafficGB: number): CostEstimate {
  const hoursPerMonth = 730;

  const monthly = {
    compute: resources.compute.instanceCount * pricing["t3.large"] * hoursPerMonth,
    database: resources.database.instanceCount * pricing["db.r6g.xlarge"] * hoursPerMonth,
    cache: resources.cache.nodes * pricing["cache.r6g.large"] * hoursPerMonth,
    storage: resources.database.storage * pricing.storage,
    bandwidth: trafficGB * pricing.bandwidth,
    total: 0,
  };

  monthly.total = Object.values(monthly).reduce((sum, cost) => sum + cost, 0);

  return {
    monthly,
    annual: monthly.total * 12,
  };
}
```

## Scale Triggers

```yaml
# auto-scaling-config.yml
scaling:
  triggers:
    - metric: cpu_utilization
      threshold: 70%
      action: scale_up
      cooldown: 5m

    - metric: cpu_utilization
      threshold: 30%
      action: scale_down
      cooldown: 15m

    - metric: request_queue_depth
      threshold: 1000
      action: scale_up
      cooldown: 1m

  limits:
    min_instances: 2
    max_instances: 20

  schedule:
    # Pre-scale for known traffic patterns
    - time: "08:00"
      target_instances: 10
    - time: "22:00"
      target_instances: 4
```

## Cost/Performance Tradeoffs

```markdown
# Infrastructure Options

## Option 1: Cost-Optimized ($2,500/mo)

- Compute: 4x t3.large
- Database: 1x db.r6g.large
- Cache: 1x cache.r6g.medium
- **Pros:** Lowest cost
- **Cons:** Limited headroom, potential latency issues

## Option 2: Balanced ($5,000/mo)

- Compute: 8x t3.large
- Database: 2x db.r6g.xlarge
- Cache: 2x cache.r6g.large
- **Pros:** Good headroom, redundancy
- **Cons:** Moderate cost

## Option 3: Performance-Optimized ($10,000/mo)

- Compute: 12x c6g.xlarge
- Database: 3x db.r6g.2xlarge
- Cache: 3x cache.r6g.xlarge
- **Pros:** Maximum performance, high availability
- **Cons:** Higher cost

## Recommendation

Start with Option 2, monitor for 1 month, adjust based on:

- Actual CPU/memory utilization
- Database query performance
- Cache hit rates
```

## Capacity Planning Spreadsheet

```
| Metric              | Current | 6mo Proj | 12mo Proj | Notes                    |
|---------------------|---------|----------|-----------|--------------------------|
| Daily Users         | 100k    | 250k     | 500k      | 5x growth expected       |
| Peak RPS            | 500     | 1250     | 2500      | Linear w/ users          |
| DB Connections      | 100     | 250      | 500       | 2 per instance           |
| Storage (GB)        | 100     | 300      | 1000      | User data + logs         |
| Bandwidth (TB)      | 1       | 3        | 10        | Images + video           |
| Instance Count      | 4       | 10       | 20        | Auto-scaling             |
| Monthly Cost        | $2k     | $5k      | $10k      | AWS estimate             |
```

## Output Checklist

- [ ] Traffic forecast
- [ ] Resource estimates
- [ ] Cost analysis
- [ ] Scale triggers
- [ ] Performance targets
- [ ] Growth plan
      ENDFILE
