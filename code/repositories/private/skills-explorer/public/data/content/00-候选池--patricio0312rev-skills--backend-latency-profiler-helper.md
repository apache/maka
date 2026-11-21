---
name: backend-latency-profiler-helper
description: Identifies API latency hotspots and bottlenecks with profiling tools, slow endpoint detection, suspected causes, and fix roadmap. Use for "latency profiling", "performance bottlenecks", "slow APIs", or "backend performance".
---

# Backend Latency Profiler Helper

Find and fix API performance bottlenecks.

## Slow Endpoint Detection

```typescript
// Middleware to track latency
app.use((req, res, next) => {
  const start = Date.now();

  res.on("finish", () => {
    const duration = Date.now() - start;

    if (duration > 1000) {
      logger.warn(
        {
          endpoint: req.path,
          method: req.method,
          duration_ms: duration,
          userId: req.user?.id,
        },
        "Slow request detected",
      );
    }
  });

  next();
});
```

## Top Slow Endpoints

```sql
-- Query from logs
SELECT
  endpoint,
  AVG(duration_ms) as avg_ms,
  MAX(duration_ms) as max_ms,
  COUNT(*) as requests
FROM request_logs
WHERE created_at > NOW() - INTERVAL '1 day'
GROUP BY endpoint
HAVING AVG(duration_ms) > 500
ORDER BY avg_ms DESC
LIMIT 10;
```

## Suspected Causes

```typescript
interface PerformanceBottleneck {
  endpoint: string;
  avgLatency: number;
  suspectedCauses: string[];
  fixPriority: "high" | "medium" | "low";
}

const bottlenecks: PerformanceBottleneck[] = [
  {
    endpoint: "GET /api/users/:id",
    avgLatency: 2500,
    suspectedCauses: [
      "N+1 query fetching user orders",
      "No database index on user_id",
      "Expensive JSON serialization",
    ],
    fixPriority: "high",
  },
];
```

## Fix Roadmap

```markdown
# Performance Fix Roadmap

## Week 1: Quick Wins

- [ ] Add database indexes
- [ ] Enable response caching
- [ ] Fix N+1 queries

## Week 2: Medium Effort

- [ ] Optimize slow database queries
- [ ] Implement Redis caching
- [ ] Add connection pooling

## Week 3: Long-term

- [ ] Database query optimization
- [ ] Service decomposition
- [ ] CDN integration
```

## Output Checklist

- [ ] Slow endpoints identified
- [ ] Causes analyzed
- [ ] Fix roadmap created
- [ ] Monitoring configured
      ENDFILE
