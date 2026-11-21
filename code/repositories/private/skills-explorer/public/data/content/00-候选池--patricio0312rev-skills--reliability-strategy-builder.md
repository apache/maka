---
name: reliability-strategy-builder
description: Implements reliability patterns including circuit breakers, retries, fallbacks, bulkheads, and SLO definitions. Provides failure mode analysis and incident response plans. Use for "SRE", "reliability", "resilience", or "failure handling".
---

# Reliability Strategy Builder

Build resilient systems with proper failure handling and SLOs.

## Reliability Patterns

### 1. Circuit Breaker

Prevent cascading failures by stopping requests to failing services.

```typescript
class CircuitBreaker {
  private state: "closed" | "open" | "half-open" = "closed";
  private failureCount = 0;
  private lastFailureTime?: Date;

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (this.shouldAttemptReset()) {
        this.state = "half-open";
      } else {
        throw new Error("Circuit breaker is OPEN");
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    this.state = "closed";
  }

  private onFailure() {
    this.failureCount++;
    this.lastFailureTime = new Date();

    if (this.failureCount >= 5) {
      this.state = "open";
    }
  }

  private shouldAttemptReset(): boolean {
    if (!this.lastFailureTime) return false;
    const now = Date.now();
    const elapsed = now - this.lastFailureTime.getTime();
    return elapsed > 60000; // 1 minute
  }
}
```

### 2. Retry with Backoff

Handle transient failures with exponential backoff.

```typescript
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries = 3,
  baseDelay = 1000,
): Promise<T> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxRetries) throw error;

      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt);
      await sleep(delay);
    }
  }
  throw new Error("Max retries exceeded");
}
```

### 3. Fallback Pattern

Provide degraded functionality when primary fails.

```typescript
async function getUserWithFallback(userId: string): Promise<User> {
  try {
    // Try primary database
    return await primaryDb.users.findById(userId);
  } catch (error) {
    logger.warn("Primary DB failed, using cache");

    // Fallback to cache
    const cached = await cache.get(`user:${userId}`);
    if (cached) return cached;

    // Final fallback: return minimal user object
    return {
      id: userId,
      name: "Unknown User",
      email: "unavailable",
    };
  }
}
```

### 4. Bulkhead Pattern

Isolate failures to prevent resource exhaustion.

```typescript
class ThreadPool {
  private pools = new Map<string, Semaphore>();

  constructor() {
    // Separate pools for different operations
    this.pools.set("critical", new Semaphore(100));
    this.pools.set("standard", new Semaphore(50));
    this.pools.set("background", new Semaphore(10));
  }

  async execute(priority: string, operation: () => Promise<any>) {
    const pool = this.pools.get(priority);
    await pool.acquire();

    try {
      return await operation();
    } finally {
      pool.release();
    }
  }
}
```

## SLO Definitions

### SLO Template

```yaml
service: user-api
slos:
  - name: Availability
    description: API should be available for successful requests
    target: 99.9%
    measurement:
      type: ratio
      success: status_code < 500
      total: all_requests
    window: 30 days

  - name: Latency
    description: 95% of requests complete within 500ms
    target: 95%
    measurement:
      type: percentile
      metric: request_duration_ms
      threshold: 500
      percentile: 95
    window: 7 days

  - name: Error Rate
    description: Less than 1% of requests result in errors
    target: 99%
    measurement:
      type: ratio
      success: status_code < 400 OR status_code IN [401, 403, 404]
      total: all_requests
    window: 24 hours
```

### Error Budget

```
Error Budget = 100% - SLO

Example:
SLO: 99.9% availability
Error Budget: 0.1% = 43.2 minutes/month downtime allowed
```

## Failure Mode Analysis

```markdown
| Component   | Failure Mode | Impact | Probability | Detection               | Mitigation                     |
| ----------- | ------------ | ------ | ----------- | ----------------------- | ------------------------------ |
| Database    | Unresponsive | HIGH   | Medium      | Health checks every 10s | Circuit breaker, read replicas |
| API Gateway | Overload     | HIGH   | Low         | Request queue depth     | Rate limiting, auto-scaling    |
| Cache       | Eviction     | MEDIUM | High        | Cache hit rate          | Fallback to DB, larger cache   |
| Queue       | Backed up    | LOW    | Medium      | Queue depth metric      | Add workers, DLQ               |
```

## Reliability Checklist

### Infrastructure

- [ ] Load balancer with health checks
- [ ] Multiple availability zones
- [ ] Auto-scaling configured
- [ ] Database replication
- [ ] Regular backups (tested!)

### Application

- [ ] Circuit breakers on external calls
- [ ] Retry logic with backoff
- [ ] Timeouts on all I/O
- [ ] Fallback mechanisms
- [ ] Graceful degradation

### Monitoring

- [ ] SLO dashboard
- [ ] Error budgets tracked
- [ ] Alerting on SLO violations
- [ ] Latency percentiles (p50, p95, p99)
- [ ] Dependency health checks

### Operations

- [ ] Incident response runbook
- [ ] On-call rotation
- [ ] Postmortem template
- [ ] Disaster recovery plan
- [ ] Chaos engineering tests

## Incident Response Plan

### Severity Levels

```
SEV1 (Critical): Complete service outage, data loss
  - Response time: <15 minutes
  - Page on-call immediately

SEV2 (High): Partial outage, degraded performance
  - Response time: <1 hour
  - Alert on-call

SEV3 (Medium): Minor issues, workarounds available
  - Response time: <4 hours
  - Create ticket

SEV4 (Low): Cosmetic issues, no user impact
  - Response time: Next business day
  - Backlog
```

### Incident Response Steps

1. **Acknowledge**: Confirm receipt within SLA
2. **Assess**: Determine severity and impact
3. **Communicate**: Update status page
4. **Mitigate**: Stop the bleeding (rollback, scale, disable)
5. **Resolve**: Fix root cause
6. **Document**: Write postmortem

## Best Practices

1. **Design for failure**: Assume components will fail
2. **Fail fast**: Don't let slow failures cascade
3. **Isolate failures**: Bulkhead pattern
4. **Graceful degradation**: Reduce functionality, don't crash
5. **Monitor SLOs**: Track error budgets
6. **Test failure modes**: Chaos engineering
7. **Document runbooks**: Clear incident response

## Output Checklist

- [ ] Circuit breakers implemented
- [ ] Retry logic with backoff
- [ ] Fallback mechanisms
- [ ] Bulkhead isolation
- [ ] SLOs defined (availability, latency, errors)
- [ ] Error budgets calculated
- [ ] Failure mode analysis
- [ ] Monitoring dashboard
- [ ] Incident response plan
- [ ] Runbooks documented
