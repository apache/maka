---
name: incident-runbook-generator
description: Creates step-by-step incident response runbooks for common outages with actions, owners, rollback procedures, and communication templates. Use for "incident runbook", "outage response", "incident management", or "on-call procedures".
---

# Incident Runbook Generator

Create actionable runbooks for common incidents.

## Runbook Template

````markdown
# Runbook: Database Connection Pool Exhausted

**Severity:** P1 (Critical)
**Estimated Time to Resolve:** 15-30 minutes
**Owner:** Database Team (On-call)

## Symptoms

- Application errors: "connection pool exhausted"
- Increased API latency (>5s)
- Failed health checks
- CloudWatch alarm: `DatabaseConnectionsHigh`

## Detection

- Alert: DatabaseConnectionPoolExhausted
- Metrics: `active_connections > max_connections * 0.9`
- Logs: "Error: connect ETIMEDOUT"

## Immediate Actions (5 min)

1. **Verify the issue**
   ```bash
   # Check current connections
   SELECT count(*) FROM pg_stat_activity;
   ```
````

2. **Identify long-running queries**

   ```sql
   SELECT pid, now() - pg_stat_activity.query_start AS duration, query
   FROM pg_stat_activity
   WHERE state = 'active'
   ORDER BY duration DESC
   LIMIT 10;
   ```

3. **Kill blocking queries** (if safe)
   ```sql
   SELECT pg_terminate_backend(pid)
   FROM pg_stat_activity
   WHERE state = 'idle in transaction'
   AND now() - state_change > interval '5 minutes';
   ```

## Mitigation (10 min)

1. **Scale up connection pool** (temporary)

   ```bash
   # Update RDS parameter group
   aws rds modify-db-parameter-group \
     --db-parameter-group-name prod-params \
     --parameters "ParameterName=max_connections,ParameterValue=200"
   ```

2. **Restart application** (if needed)

   ```bash
   kubectl rollout restart deployment/api
   ```

3. **Monitor recovery**
   ```bash
   watch -n 5 'psql -c "SELECT count(*) FROM pg_stat_activity;"'
   ```

## Root Cause Investigation

Check for:

- [ ] Recent deployment (new code with connection leaks)
- [ ] Traffic spike (legitimate or DDoS)
- [ ] Slow queries holding connections
- [ ] Connection pool configuration too small
- [ ] Application not releasing connections

## Rollback Steps

If caused by deployment:

```bash
# Rollback to previous version
kubectl rollout undo deployment/api

# Verify
kubectl rollout status deployment/api
```

## Communication Template

**Initial (within 5 min):**

```
🚨 INCIDENT: Database connection pool exhausted
Status: Investigating
Impact: API errors and slowness
ETA: 15-30 min
Next update: 10 min
```

**Update (every 10 min):**

```
UPDATE: Killed long-running queries
Status: Mitigating
Impact: Still degraded, improving
Actions: Scaling connection pool
Next update: 10 min
```

**Resolution:**

```
✅ RESOLVED: Database connections normalized
Duration: 25 minutes
Root cause: Connection leak in v2.3.4
Fix: Rolled back to v2.3.3
Follow-up: Bug fix PR #1234
Postmortem: [link]
```

## Prevention

- [ ] Add connection pool metrics to dashboards
- [ ] Implement connection timeout (30s)
- [ ] Add connection leak detection in tests
- [ ] Set up pre-deployment load testing
- [ ] Review connection pool sizing

## Related Runbooks

- Database High CPU
- Slow Database Queries
- Application OOM

```

## Output Checklist

- [ ] Symptoms documented
- [ ] Detection criteria
- [ ] Step-by-step actions
- [ ] Owner assigned
- [ ] Rollback procedure
- [ ] Communication templates
- [ ] Prevention measures
ENDFILE
```
