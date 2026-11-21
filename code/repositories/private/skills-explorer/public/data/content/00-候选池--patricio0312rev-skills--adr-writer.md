---
name: adr-writer
description: Creates Architecture Decision Records documenting key technical decisions with context, alternatives considered, tradeoffs, consequences, and decision owners. Use when documenting "architecture decisions", "technical choices", "design decisions", or "ADRs".
---

# ADR Writer

Document architecture decisions with clear context, alternatives, and consequences.

## ADR Template

```markdown
# ADR-001: [Title of Decision]

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-XXX
**Date:** 2024-01-15
**Deciders:** Alice (Tech Lead), Bob (Principal Engineer)
**Owner:** Alice

## Context

What is the issue we're facing? What factors are driving this decision?

We need to choose a database for our new analytics service. Current
requirements:

- 10M+ events per day
- Complex aggregation queries
- Real-time dashboards
- Budget: $5k/month
- Team familiar with SQL

## Decision

We will use PostgreSQL with TimescaleDB extension.

## Alternatives Considered

### Option 1: PostgreSQL + TimescaleDB (CHOSEN)

**Pros:**

- Team already knows PostgreSQL
- Time-series optimization for analytics
- Reliable and proven
- Good query performance
- Reasonable cost (~$3k/month)

**Cons:**

- Requires manual scaling effort
- Not purpose-built for analytics

### Option 2: ClickHouse

**Pros:**

- Excellent query performance for analytics
- Built for analytics workloads
- Column-oriented storage

**Cons:**

- Team unfamiliar with ClickHouse
- Steeper learning curve
- Different query syntax

### Option 3: BigQuery

**Pros:**

- Fully managed
- Excellent for analytics
- Scales automatically

**Cons:**

- Higher cost (~$8k/month for our volume)
- Vendor lock-in to GCP
- Less control over optimization

## Tradeoffs

**What we're optimizing for:**

- Team velocity (familiar tech)
- Cost efficiency
- Good enough performance

**What we're sacrificing:**

- Peak analytical performance (vs ClickHouse)
- Fully managed experience (vs BigQuery)

## Consequences

### Positive

- Development can start immediately (no learning curve)
- Lower operational costs
- Can reuse existing PostgreSQL expertise
- Easy integration with current stack

### Negative

- Will need to manually optimize queries
- May need to revisit if we scale 10x
- Requires more operational work than BigQuery

### Risks

- Performance may degrade at 100M+ events/day
- **Mitigation:** Monitor query performance, plan migration at 50M events/day

## Implementation Notes

- Use TimescaleDB hypertables for event storage
- Implement continuous aggregates for common queries
- Set up read replicas for dashboard queries
- Document scaling runbook at 50M events/day

## Follow-up Actions

- [ ] Provision PostgreSQL + TimescaleDB cluster (Alice, by 2024-01-20)
- [ ] Create migration script from MySQL (Bob, by 2024-01-22)
- [ ] Set up monitoring dashboards (Alice, by 2024-01-25)
- [ ] Document scaling thresholds (Alice, by 2024-01-30)

## References

- [TimescaleDB Benchmarks](https://example.com)
- [Cost Analysis Spreadsheet](https://docs.google.com/...)
- [Team Survey Results](https://example.com)

## Revision History

- 2024-01-15: Initial draft (Alice)
- 2024-01-16: Added cost analysis (Bob)
- 2024-01-17: Accepted by architecture review board
```

## ADR Numbering

```
ADR-001: Initial System Architecture
ADR-002: Database Selection for Analytics
ADR-003: Authentication Strategy
...
```

## Status Workflow

```
Proposed → Accepted → Implemented
    ↓
Rejected

Accepted → Deprecated → Superseded by ADR-XXX
```

## Common Decision Types

**Technology Selection:**

- Database choice
- Framework selection
- Cloud provider
- Programming language

**Architecture Patterns:**

- Microservices vs Monolith
- Event-driven vs Request-response
- Sync vs Async communication

**Infrastructure:**

- Deployment strategy
- Monitoring approach
- Scaling strategy

**Security:**

- Authentication method
- Data encryption approach
- Access control model

## Quick Start Guide

```bash
# 1. Create new ADR
cp templates/adr-template.md docs/adr/ADR-042-title.md

# 2. Fill in sections
# - Context: Why are we making this decision?
# - Decision: What did we decide?
# - Alternatives: What else did we consider?
# - Consequences: What are the impacts?

# 3. Review with team
# - Share in architecture channel
# - Get feedback from stakeholders
# - Iterate on alternatives

# 4. Update status to "Accepted"
# 5. Link from main architecture docs
```

## Best Practices

1. **Write ADRs for significant decisions**: Not every choice needs an ADR
2. **Document alternatives**: Show you considered options
3. **Be honest about tradeoffs**: Every decision has downsides
4. **Keep it concise**: 1-2 pages maximum
5. **Update status**: Mark deprecated/superseded ADRs
6. **Link related ADRs**: Create decision trails
7. **Include follow-ups**: Action items with owners

## Anti-Patterns

❌ **Too detailed**: 10-page ADRs nobody reads
❌ **No alternatives**: Looks like decision was predetermined
❌ **Missing consequences**: Ignoring downsides
❌ **No owner**: Nobody accountable
❌ **Outdated status**: Old ADRs marked "Proposed"

## Review Checklist

- [ ] Clear problem statement in Context
- [ ] Decision is stated explicitly
- [ ] 2+ alternatives considered
- [ ] Tradeoffs honestly assessed
- [ ] Consequences (positive and negative) documented
- [ ] Risks identified with mitigations
- [ ] Decision owner assigned
- [ ] Follow-up actions with deadlines
- [ ] Status is current

## Output Checklist

- [ ] ADR document created
- [ ] Context explains the problem
- [ ] Decision clearly stated
- [ ] 2-3 alternatives documented
- [ ] Tradeoffs section filled
- [ ] Consequences listed (positive & negative)
- [ ] Risks identified with mitigations
- [ ] Decision date and owners
- [ ] Follow-up actions assigned
- [ ] Status is set
