---
name: tech-debt-prioritizer
description: Scores and prioritizes technical debt by impact, risk, and effort. Provides ranked backlog with ROI analysis and quarterly paydown recommendations. Use for "tech debt", "technical debt management", "code quality", or "refactoring priorities".
---

# Tech Debt Prioritizer

Systematically prioritize and pay down technical debt.

## Scoring Rubric

### Impact Score (1-10)

**10 - Critical:**

- Prevents new features
- Causes frequent prod incidents
- Blocks multiple teams

**7-9 - High:**

- Significantly slows development
- Causes occasional incidents
- Affects one team heavily

**4-6 - Medium:**

- Moderate development friction
- Rare incidents
- Workarounds exist

**1-3 - Low:**

- Minor annoyance
- No incidents
- Easy workarounds

### Risk Score (1-10)

**10 - Critical:**

- Security vulnerability
- Data integrity issues
- Legal/compliance risk

**7-9 - High:**

- Potential data loss
- System instability
- Vendor end-of-life soon

**4-6 - Medium:**

- Performance degradation
- Occasional failures
- Deprecated but working

**1-3 - Low:**

- Code quality issues
- Minor bugs
- Style inconsistencies

### Effort Score (1-10)

**10 - Herculean:**

- 3+ months
- Multiple teams
- High risk changes

**7-9 - Large:**

- 1-3 months
- One team
- Medium risk

**4-6 - Medium:**

- 1-4 weeks
- 1-2 developers
- Low risk

**1-3 - Small:**

- Days
- Single developer
- Very low risk

## Priority Formula

```
Priority Score = (Impact * 2 + Risk * 1.5) / Effort

Higher score = Higher priority
```

## Tech Debt Inventory

```markdown
| ID     | Title                  | Impact | Risk | Effort | Score | Owner     |
| ------ | ---------------------- | ------ | ---- | ------ | ----- | --------- |
| TD-001 | Legacy auth system     | 9      | 10   | 8      | 3.7   | Auth Team |
| TD-002 | No database indexes    | 8      | 7    | 3      | 7.8   | Backend   |
| TD-003 | Monolithic build       | 7      | 4    | 6      | 4.0   | DevOps    |
| TD-004 | Duplicate API logic    | 6      | 3    | 4      | 4.1   | Backend   |
| TD-005 | Outdated dependencies  | 5      | 8    | 2      | 9.0   | All Teams |
| TD-006 | Missing error handling | 4      | 6    | 3      | 5.7   | Backend   |
| TD-007 | Poor test coverage     | 4      | 5    | 7      | 2.3   | All Teams |
| TD-008 | Inconsistent naming    | 3      | 2    | 5      | 1.6   | Frontend  |

**Sorted by Priority Score:**

1. TD-005: Outdated dependencies (9.0)
2. TD-002: No database indexes (7.8)
3. TD-006: Missing error handling (5.7)
4. TD-004: Duplicate API logic (4.1)
5. TD-003: Monolithic build (4.0)
   ...
```

## Detailed Assessment Template

```markdown
## TD-002: No Database Indexes

### Description

Critical queries lack indexes, causing slow response times and high CPU usage.

### Impact (8/10)

- Search queries take 2-5 seconds (should be <500ms)
- Database CPU at 85% during peak hours
- User complaints about slow searches
- Blocks performance optimization work

### Risk (7/10)

- Database may crash under load
- Losing customers to slow experience
- Cannot scale without addressing

### Effort (3/10)

- Identify missing indexes: 2 days
- Add indexes: 1 day
- Test performance: 1 day
- Deploy: 1 day
  **Total: 5 days**

### ROI Analysis

**Cost:** 5 developer-days = $5,000
**Benefit:**

- 80% faster queries
- 50% less DB CPU
- Better user experience
- Enables scaling

**ROI:** Very High

### Implementation Plan

1. Run EXPLAIN on slow queries
2. Identify missing indexes
3. Add indexes in development
4. Test query performance
5. Deploy to production (off-peak)
6. Monitor impact

### Dependencies

- None (can start immediately)

### Owner

Backend Team

### Status

Backlog → Prioritized for Q1
```

## Quarterly Paydown Plan

```markdown
# Q1 2024 Tech Debt Paydown

**Budget:** 20% of engineering time (4 weeks total)

## Week 1-2: High Priority

- TD-005: Update dependencies (2 days)
- TD-002: Add database indexes (5 days)
- TD-006: Add error handling (3 days)

## Week 3: Medium Priority

- TD-004: Eliminate duplicate logic (5 days)

## Week 4: Quick Wins

- TD-012: Fix broken tests (2 days)
- TD-015: Remove dead code (2 days)
- TD-018: Update README (1 day)

## Success Metrics

- Reduce P1 incidents by 30%
- Improve deployment confidence
- Decrease development friction
- Team morale improvement
```

## Decision Framework

### When to Pay Down Debt

**Pay down NOW if:**

- Security vulnerability
- Causing frequent incidents
- Blocking critical features
- High impact, low effort

**Pay down SOON if:**

- Slowing development significantly
- Medium-high risk
- Reasonable effort

**Defer if:**

- Low impact and low risk
- Very high effort
- Better alternatives exist

### When to Increase Budget

```markdown
**Indicators debt budget needs increase:**

- Velocity declining
- Incident rate increasing
- Developer satisfaction down
- Onboarding time increasing
- "It's too hard to..." complaints
```

## Tech Debt Registry

```typescript
interface TechDebt {
  id: string;
  title: string;
  description: string;

  // Scoring
  impact: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  risk: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  effort: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

  // Metadata
  owner: string;
  createdAt: Date;
  targetQuarter?: string;
  status: "backlog" | "prioritized" | "in-progress" | "done";

  // Context
  affectedSystems: string[];
  relatedDebt: string[];

  // Plan
  implementationPlan?: string;
  roi?: "low" | "medium" | "high" | "very-high";
}
```

## Quarterly Review Process

```markdown
1. **Collect new debt** (Week 1)

   - Team submits tech debt items
   - Engineering leads review and score

2. **Prioritize** (Week 2)

   - Calculate priority scores
   - Review high-priority items
   - Assign owners

3. **Plan quarter** (Week 3)

   - Allocate 10-20% capacity
   - Schedule work
   - Set success metrics

4. **Review results** (End of quarter)
   - Measure impact
   - Adjust process
   - Celebrate wins
```

## Best Practices

1. **Track systematically**: Don't rely on memory
2. **Score objectively**: Use rubric consistently
3. **Regular reviews**: Quarterly minimum
4. **Budget time**: 10-20% of sprint capacity
5. **Quick wins**: Include easy items for morale
6. **Measure impact**: Track improvements
7. **Make visible**: Dashboard, reports
8. **No judgment**: Tech debt is normal

## Output Checklist

- [ ] Tech debt items catalogued
- [ ] Impact/risk/effort scores assigned
- [ ] Priority scores calculated
- [ ] Items ranked by priority
- [ ] Top 10 items detailed
- [ ] Quarterly plan created
- [ ] Budget allocated (% of time)
- [ ] Owners assigned
- [ ] Success metrics defined
- [ ] Review cadence established
