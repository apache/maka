---
name: scalability-playbook
description: Identifies performance bottlenecks and provides ordered scaling strategies with triggers, phased plans, and cost implications. Use for "scalability planning", "performance bottlenecks", "capacity planning", or "growth strategy".
---

# Scalability Playbook

Systematic approach to identifying and resolving scalability bottlenecks.

## Bottleneck Analysis

### Current System Profile

```
Traffic: 1,000 req/min
Users: 10,000 active
Data: 100GB database
Response time: p95 = 500ms
```

### Identified Bottlenecks

#### 1. Database Queries

**Symptom:** Slow page loads (2-3s)
**Measurement:** Query time p95 = 800ms
**Impact:** HIGH - affects all reads
**Trigger:** When p95 >500ms

#### 2. Single Server

**Symptom:** High CPU (>80%)
**Measurement:** Load average >4
**Impact:** MEDIUM - intermittent slowdowns
**Trigger:** When CPU >70%

#### 3. No Caching

**Symptom:** Repeated DB queries
**Measurement:** Cache hit rate = 0%
**Impact:** MEDIUM - unnecessary load
**Trigger:** When query volume >10k/min

## Scaling Strategies (Ordered)

### Level 1: Quick Wins (Days)

#### 1.1 Add Database Indexes

**Problem:** Slow queries
**Solution:**

```sql
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_orders_user_created ON orders(user_id, created_at);
```

**Expected Impact:** 80% faster queries
**Cost:** $0
**Effort:** 1 day

#### 1.2 Enable Query Caching

**Problem:** Repeated queries
**Solution:** Redis cache layer

```typescript
const cached = await redis.get(`user:${userId}`);
if (cached) return JSON.parse(cached);

const user = await db.users.findById(userId);
await redis.setex(`user:${userId}`, 3600, JSON.stringify(user));
```

**Expected Impact:** 60% reduction in DB load
**Cost:** $50/month
**Effort:** 2 days

### Level 2: Horizontal Scaling (Weeks)

#### 2.1 Add Read Replicas

**Problem:** Read-heavy workload
**Solution:** Route reads to replicas

```
Write Load: Primary DB
Read Load: 3x Read Replicas
```

**Expected Impact:** 3x read capacity
**Cost:** $300/month
**Effort:** 1 week

#### 2.2 Load Balancer + Multiple Servers

**Problem:** Single point of failure
**Solution:**

```
ALB
 ├── Server 1
 ├── Server 2
 └── Server 3
```

**Expected Impact:** 3x throughput
**Cost:** $400/month
**Effort:** 1 week

### Level 3: Architecture Changes (Months)

#### 3.1 CDN for Static Assets

**Problem:** Slow asset delivery
**Solution:** CloudFront CDN
**Expected Impact:** 90% faster asset loads
**Cost:** $100/month
**Effort:** 1 week

#### 3.2 Async Processing

**Problem:** Slow sync operations
**Solution:** Background job queues

```typescript
// Before: Sync
await sendEmail(user);
await processPayment(order);
await updateAnalytics(event);
return response; // Waits 5+ seconds

// After: Async
await queue.add("send-email", { userId });
await queue.add("process-payment", { orderId });
await queue.add("update-analytics", { event });
return response; // Returns immediately
```

**Expected Impact:** 80% faster responses
**Cost:** $50/month (SQS)
**Effort:** 2 weeks

### Level 4: Data Layer Optimization (Months)

#### 4.1 Database Sharding

**Problem:** Single DB too large
**Solution:** Shard by user_id

```
Shard 1: user_id 0-24999
Shard 2: user_id 25000-49999
Shard 3: user_id 50000-74999
Shard 4: user_id 75000-99999
```

**Expected Impact:** 4x capacity
**Cost:** $1,200/month
**Effort:** 2 months

#### 4.2 Event-Driven Architecture

**Problem:** Tight coupling, cascading failures
**Solution:** Message broker (Kafka)

```
Service A → Kafka → Service B
          ↘        ↗ Service C
```

**Expected Impact:** Better isolation, resilience
**Cost:** $500/month
**Effort:** 3 months

## Scaling Triggers

```markdown
| Metric           | Current | Warning | Critical | Action                  |
| ---------------- | ------- | ------- | -------- | ----------------------- |
| CPU              | 40%     | 70%     | 85%      | Add servers             |
| Memory           | 50%     | 75%     | 90%      | Upgrade instances       |
| DB Connections   | 20      | 40      | 50       | Add read replicas       |
| Query Time (p95) | 200ms   | 500ms   | 1000ms   | Add indexes             |
| Queue Depth      | 100     | 1000    | 5000     | Add workers             |
| Error Rate       | 0.1%    | 1%      | 5%       | Investigate immediately |
```

## Phased Scaling Plan

### Phase 1: Current → 10x (0-3 months)

**Target:** 10,000 req/min, 100K users

**Actions:**

1. Add database indexes (Week 1)
2. Implement Redis caching (Week 2)
3. Add 3x read replicas (Week 4)
4. Horizontal scale app servers (Week 6)
5. CDN for static assets (Week 8)

**Cost:** $500 → $1,000/month

### Phase 2: 10x → 100x (3-12 months)

**Target:** 100,000 req/min, 1M users

**Actions:**

1. Database sharding (Month 4-6)
2. Multi-region deployment (Month 6-8)
3. Microservices extraction (Month 8-12)
4. Event-driven architecture (Month 10-12)

**Cost:** $1,000 → $10,000/month

### Phase 3: 100x → 1000x (12-24 months)

**Target:** 1M req/min, 10M users

**Actions:**

1. Global CDN (Month 13)
2. Advanced caching (L1/L2) (Month 14-15)
3. Custom DB solutions (Month 16-18)
4. Edge computing (Month 18-20)

**Cost:** $10,000 → $100,000/month

## Load Testing Plan

```bash
# Current baseline
hey -n 10000 -c 100 https://api.example.com/users

# Target 10x
hey -n 100000 -c 1000 https://api.example.com/users

# Measure:
# - Requests/sec
# - p50, p95, p99 latency
# - Error rate
# - Resource utilization
```

## Cost-Benefit Analysis

```markdown
| Strategy      | Cost/Month | Expected Impact    | ROI | Priority |
| ------------- | ---------- | ------------------ | --- | -------- |
| DB Indexes    | $0         | 80% faster queries | ∞   | HIGH     |
| Redis Cache   | $50        | 60% less DB load   | 12x | HIGH     |
| Read Replicas | $300       | 3x capacity        | 10x | MEDIUM   |
| Load Balancer | $400       | 3x throughput      | 7x  | MEDIUM   |
| DB Sharding   | $1,200     | 4x capacity        | 3x  | LOW      |
```

## Best Practices

1. **Measure first**: Don't optimize blindly
2. **Low-hanging fruit**: Start with easy wins
3. **Load test**: Validate before production
4. **Monitor continuously**: Set up alerts
5. **Plan ahead**: Scale before hitting limits
6. **Cost-conscious**: ROI-driven decisions
7. **Incremental**: Small, safe changes

## Output Checklist

- [ ] Current system profile
- [ ] Bottlenecks identified and measured
- [ ] Scaling strategies ordered by effort
- [ ] Triggers defined for each action
- [ ] Phased plan (1x → 10x → 100x)
- [ ] Cost estimates per phase
- [ ] Load testing plan
- [ ] Monitoring dashboard
- [ ] Rollback procedures
