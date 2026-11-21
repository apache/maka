---
name: postmortem-writer
description: Creates comprehensive post-incident documents with timeline, root cause analysis, contributing factors, action items, and ownership. Follows SRE best practices for blameless postmortems. Use for "postmortem", "incident review", "RCA", or "post-incident".
---

# Postmortem Writer

Document incidents for learning and improvement.

## Postmortem Template

```markdown
# Postmortem: API Outage - Database Connection Pool Exhausted

**Date:** 2024-01-15
**Authors:** Jane Doe (On-call), John Smith (DBA)
**Status:** Complete
**Severity:** P1 (Critical)

## Summary

On January 15, 2024, our API experienced a complete outage for 25 minutes (14:32 - 14:57 UTC) affecting 100% of users. The root cause was database connection pool exhaustion triggered by a connection leak introduced in deployment v2.3.4.

**Impact:**

- Duration: 25 minutes
- Users affected: ~50,000
- Requests failed: ~125,000
- Revenue impact: ~$15,000

## Timeline (All times UTC)

| Time  | Event                                            |
| ----- | ------------------------------------------------ |
| 14:15 | v2.3.4 deployed to production                    |
| 14:32 | First CloudWatch alarm: HighErrorRate            |
| 14:33 | PagerDuty alert sent to on-call (Jane)           |
| 14:35 | Jane acknowledges, begins investigation          |
| 14:38 | Identified: Database connection pool at 100%     |
| 14:40 | Attempted: Kill long-running queries (no effect) |
| 14:43 | Decision: Rollback to v2.3.3                     |
| 14:45 | Rollback initiated                               |
| 14:47 | Rollback complete, connections dropping          |
| 14:50 | Error rate returning to normal                   |
| 14:57 | All systems recovered, incident closed           |
| 15:30 | Postmortem meeting scheduled                     |

## Root Cause

A code change in v2.3.4 introduced a connection leak in the user profile endpoint. The new caching layer was not properly releasing database connections after queries completed.

**Code diff:**
\`\`\`diff

- await prisma.user.findUnique({ where: { id } });

* const client = await pool.connect();
* const user = await client.query('SELECT \* FROM users WHERE id = $1', [id]);
* // Missing: client.release() ❌
  \`\`\`

## Contributing Factors

1. **Insufficient testing:** Load tests didn't catch the leak

   - Tests only ran for 5 minutes
   - Not enough concurrent connections to exhaust pool

2. **Missing monitoring:** No alerts on connection pool metrics

   - Had alarms for query latency
   - No alarms for active connections count

3. **Inadequate code review:** Reviewer didn't spot missing release()

   - PR approved without running locally
   - No checklist for connection management

4. **Deployment process:** No gradual rollout
   - Deployed to 100% of production immediately
   - No canary deployment

## What Went Well

1. ✅ **Fast detection:** Alert fired within 3 minutes
2. ✅ **Clear runbook:** DBA runbook had exact steps to follow
3. ✅ **Quick decision:** Made rollback decision in 8 minutes
4. ✅ **Communication:** Status page updated every 5 minutes
5. ✅ **Rollback capability:** Automated rollback took <2 minutes

## What Went Wrong

1. ❌ **Code review missed bug:** Connection leak not caught
2. ❌ **Testing gaps:** Load tests insufficient duration
3. ❌ **No canary:** Deployed to all instances at once
4. ❌ **Late detection:** 17 minutes between deploy and alert

## Action Items

| Action                                        | Owner   | Due Date   | Priority | Status         |
| --------------------------------------------- | ------- | ---------- | -------- | -------------- |
| Add connection pool metrics to dashboards     | Jane    | 2024-01-20 | P0       | ✅ Done        |
| Create PR checklist for connection management | John    | 2024-01-22 | P0       | ✅ Done        |
| Extend load tests to 30 minutes minimum       | QA Team | 2024-01-25 | P1       | 🔄 In Progress |
| Implement canary deployment (10% → 100%)      | DevOps  | 2024-02-01 | P1       | 📋 Planned     |
| Add connection leak detection to tests        | Jane    | 2024-01-27 | P1       | 🔄 In Progress |
| Review all DB connection usage patterns       | John    | 2024-02-05 | P2       | 📋 Planned     |
| Improve alert routing (faster escalation)     | DevOps  | 2024-02-10 | P2       | 📋 Planned     |

## Lessons Learned

1. **Code review checklists work:** Need specific items for common issues
2. **Load tests need realistic duration:** 5min insufficient for leaks
3. **Gradual rollouts catch issues:** 10% canary would have limited impact
4. **Monitoring gaps are dangerous:** Add metrics before you need them
5. **Runbooks save time:** Clear procedures enabled fast response

## Related Incidents

- [2023-11-20] Database CPU spike (similar connection pool issue)
- [2023-08-15] Memory leak in cache layer

## Prevention

To prevent similar incidents:

1. ✅ Add connection management to code review checklist
2. ✅ Monitor connection pool utilization
3. ✅ Extend load test duration
4. ✅ Implement canary deployments
5. ✅ Add automated connection leak detection

## Appendix

### Monitoring Graphs

[Insert graphs of connection pool, error rates, latency during incident]

### Communication Log

[Insert status page updates and customer communication]

### Code Fix

PR #1235: Fix connection leak in user profile endpoint
\`\`\`typescript
const client = await pool.connect();
try {
const user = await client.query('SELECT \* FROM users WHERE id = $1', [id]);
return user;
} finally {
client.release(); // ✅ Always release
}
\`\`\`
```

## Postmortem Best Practices

```markdown
# Blameless Postmortem Guidelines

## Do ✅

- Focus on systems and processes, not people
- Use timeline with exact timestamps
- Identify contributing factors, not just root cause
- Create actionable items with owners and dates
- Document what went well (positive reinforcement)
- Share widely for organizational learning

## Don't ❌

- Blame individuals or teams
- Hide or minimize the incident
- Skip the postmortem (even for small incidents)
- Create action items without owners
- Forget to follow up on action items
- Make it a blame session

## Template Sections

1. **Summary** (2-3 sentences)
2. **Impact** (numbers: users, revenue, duration)
3. **Timeline** (chronological events)
4. **Root Cause** (technical explanation)
5. **Contributing Factors** (broader context)
6. **What Went Well** (positive reinforcement)
7. **What Went Wrong** (improvement areas)
8. **Action Items** (concrete, owned, dated)
9. **Lessons Learned** (key takeaways)
```

## Output Checklist

- [ ] Timeline created
- [ ] Root cause identified
- [ ] Contributing factors documented
- [ ] Action items with owners
- [ ] Lessons learned captured
- [ ] Postmortem meeting held
- [ ] Document shared widely
- [ ] Follow-up scheduled
      ENDFILE
