---
name: rfc-generator
description: Generates Request for Comments documents for technical proposals including problem statement, solution design, alternatives, risks, and rollout plans. Use for "RFC", "technical proposals", "design docs", or "architecture proposals".
---

# RFC Generator

Create comprehensive technical proposals with RFCs.

## RFC Template

```markdown
# RFC-042: Implement Read Replicas for Analytics

**Status:** Draft | In Review | Accepted | Rejected | Implemented
**Author:** Alice (alice@example.com)
**Reviewers:** Bob, Charlie, David
**Created:** 2024-01-15
**Updated:** 2024-01-20
**Target Date:** Q1 2024

## Summary

Add PostgreSQL read replicas to separate analytical queries from transactional workload, improving database performance and enabling new analytics features.

## Problem Statement

### Current Situation

Our PostgreSQL database serves both transactional (OLTP) and analytical (OLAP) workloads:

- 1000 writes/min (checkout, orders, inventory)
- 5000 reads/min (user browsing, search)
- 500 analytics queries/min (dashboards, reports)

### Issues

1. **Performance degradation**: Analytics queries slow down transactions
2. **Resource contention**: Complex reports consume CPU/memory
3. **Blocking features**: Can't add more dashboards without impacting users
4. **Peak hour problems**: Analytics scheduled during business hours

### Impact

- Checkout p95 latency: 800ms (target: <300ms)
- Database CPU: 75% average, 95% peak
- Customer complaints about slow pages
- Product team blocked on analytics features

### Success Criteria

- Checkout latency <300ms p95
- Database CPU <50%
- Support 2x more analytics queries
- Zero impact on transactional performance

## Proposed Solution

### High-Level Design
```

┌─────────────┐
│ Primary │────────────────┐
│ (Write) │ │
└─────────────┘ │
▼
┌─────────────┐
│ Replica 1 │
│ (Read) │
└─────────────┘
▼
┌─────────────┐
│ Replica 2 │
│ (Analytics)│
└─────────────┘

````

### Architecture
1. **Primary database**: Handles all writes and critical reads
2. **Read Replica 1**: Serves user-facing read queries
3. **Read Replica 2**: Dedicated to analytics/reporting

### Routing Strategy
```typescript
const db = {
  primary: primaryConnection,
  read: replicaConnection,
  analytics: analyticsConnection,
};

// Write
await db.primary.users.create(data);

// Critical read (always fresh)
await db.primary.users.findById(id);

// Non-critical read (can be slightly stale)
await db.read.products.search(query);

// Analytics
await db.analytics.orders.aggregate(pipeline);
````

### Replication

- **Type:** Streaming replication
- **Lag:** <1 second for read replica, <5 seconds acceptable for analytics
- **Monitoring:** Alert if lag >5 seconds

## Detailed Design

### Database Configuration

```yaml
# Primary
max_connections: 200
shared_buffers: 4GB
work_mem: 16MB

# Read Replica
max_connections: 100
shared_buffers: 8GB
work_mem: 32MB

# Analytics Replica
max_connections: 50
shared_buffers: 16GB
work_mem: 64MB
```

### Connection Pooling

```typescript
const pools = {
  primary: new Pool({ max: 20, min: 5 }),
  read: new Pool({ max: 50, min: 10 }),
  analytics: new Pool({ max: 10, min: 2 }),
};
```

### Query Classification

```typescript
enum QueryType {
  WRITE = "primary",
  CRITICAL_READ = "primary",
  READ = "read",
  ANALYTICS = "analytics",
}

function route(queryType: QueryType) {
  return pools[queryType];
}
```

## Alternatives Considered

### Alternative 1: Vertical Scaling

**Approach:** Upgrade to larger database instance

- **Pros:** Simple, no code changes
- **Cons:** Expensive ($500 → $2000/month), doesn't separate workloads, still hits limits
- **Verdict:** Rejected - doesn't solve isolation problem

### Alternative 2: Separate Analytics Database

**Approach:** Copy data to dedicated analytics DB (e.g., ClickHouse)

- **Pros:** Optimal for analytics, no impact on primary
- **Cons:** Complex ETL pipeline, eventual consistency, high maintenance
- **Verdict:** Defer - consider for future if replicas insufficient

### Alternative 3: Materialized Views

**Approach:** Pre-compute analytics results

- **Pros:** Fast queries, no replicas needed
- **Cons:** Limited to known queries, maintenance overhead
- **Verdict:** Complement to replicas, not replacement

## Tradeoffs

### What We're Optimizing For

- Performance isolation
- Cost efficiency
- Quick implementation
- Operational simplicity

### What We're Sacrificing

- Slight data staleness (acceptable for analytics)
- Additional infrastructure complexity
- Higher operational costs

## Risks & Mitigations

### Risk 1: Replication Lag

**Impact:** Analytics sees stale data
**Probability:** Medium
**Mitigation:**

- Monitor lag continuously
- Alert if >5 seconds
- Document expected lag for users

### Risk 2: Configuration Complexity

**Impact:** Routing errors, performance issues
**Probability:** Low
**Mitigation:**

- Comprehensive testing
- Gradual rollout
- Easy rollback mechanism

### Risk 3: Cost Overrun

**Impact:** Budget exceeded
**Probability:** Low
**Mitigation:**

- Use smaller instance for analytics ($300/month)
- Monitor usage
- Right-size after 1 month

## Rollout Plan

### Phase 1: Setup (Week 1-2)

- [ ] Provision read replica 1
- [ ] Provision analytics replica 2
- [ ] Configure replication
- [ ] Verify lag <1 second
- [ ] Load testing

### Phase 2: Read Replica (Week 3)

- [ ] Deploy routing logic
- [ ] Route 10% search queries to replica
- [ ] Monitor errors and latency
- [ ] Ramp to 100%

### Phase 3: Analytics Migration (Week 4-5)

- [ ] Identify analytics queries
- [ ] Update dashboard queries to analytics replica
- [ ] Test reports
- [ ] Migrate all analytics

### Phase 4: Validation (Week 6)

- [ ] Measure checkout latency improvement
- [ ] Verify CPU reduction
- [ ] User acceptance testing
- [ ] Mark as complete

## Success Metrics

### Primary Goals

- ✅ Checkout latency <300ms p95 (currently 800ms)
- ✅ Primary DB CPU <50% (currently 75%)
- ✅ Zero errors from replication lag

### Secondary Goals

- Support 2x analytics queries
- Enable new dashboard features
- Team satisfaction survey >8/10

## Cost Analysis

| Component         | Current     | Proposed      | Delta        |
| ----------------- | ----------- | ------------- | ------------ |
| Primary DB        | $500/mo     | $500/mo       | $0           |
| Read Replica      | -           | $500/mo       | +$500        |
| Analytics Replica | -           | $300/mo       | +$300        |
| **Total**         | **$500/mo** | **$1,300/mo** | **+$800/mo** |

**ROI:** Better performance enables revenue growth; analytics unlocks product insights

## Open Questions

1. What's acceptable replication lag for analytics? (Proposed: <5 sec)
2. How do we handle replica failure? (Proposed: Fallback to primary)
3. Should we add more replicas later? (Proposed: Monitor and decide in Q2)

## Timeline

- Week 1-2: Provisioning and setup
- Week 3: Read replica migration
- Week 4-5: Analytics migration
- Week 6: Validation
- **Total: 6 weeks**

## Appendix

### References

- [PostgreSQL Replication Docs](https://postgresql.org/docs/replication)
- [Cost Analysis Spreadsheet](https://docs.google.com/)
- [Load Test Results](https://example.com)

### Review History

- 2024-01-15: Initial draft (Alice)
- 2024-01-17: Added cost analysis (Bob)
- 2024-01-20: Addressed review comments

```

## RFC Process

### 1. Draft (1 week)
- Author writes RFC
- Include problem, solution, alternatives
- Share with team for early feedback

### 2. Review (1-2 weeks)
- Distribute to reviewers
- Collect comments
- Address feedback
- Iterate on design

### 3. Approval (1 week)
- Present to architecture review
- Resolve remaining concerns
- Vote: Accept/Reject
- Update status

### 4. Implementation
- Track progress
- Update RFC with learnings
- Mark as implemented

## Best Practices

1. **Clear problem**: Start with why
2. **Concrete solution**: Be specific
3. **Consider alternatives**: Show you explored options
4. **Honest tradeoffs**: Every choice has costs
5. **Measurable success**: Define done
6. **Risk mitigation**: Plan for failure
7. **Iterative**: Update based on feedback

## Output Checklist

- [ ] Problem statement
- [ ] Proposed solution with architecture
- [ ] 2+ alternatives considered
- [ ] Tradeoffs documented
- [ ] Risks with mitigations
- [ ] Rollout plan with phases
- [ ] Success metrics defined
- [ ] Cost analysis
- [ ] Timeline estimated
- [ ] Reviewers assigned
```
