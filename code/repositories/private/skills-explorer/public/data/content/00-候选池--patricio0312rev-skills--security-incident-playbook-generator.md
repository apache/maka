---
name: security-incident-playbook-generator
description: Creates response procedures for security incidents with containment steps, communication templates, and evidence collection. Use for "incident response", "security playbook", "breach response", or "IR plan".
---

# Security Incident Playbook Generator

Prepare for security incidents with structured response plans.

## Incident Response Phases

```markdown
# Security Incident Response Playbook

## Phase 1: Detection & Triage (0-15 min)

### Detection Sources

- Security alerts (CloudWatch, Sentry)
- User reports
- Anomaly detection
- Penetration test findings

### Initial Assessment

- [ ] Identify incident type
- [ ] Assess severity (P0-P3)
- [ ] Determine scope
- [ ] Alert on-call security

## Phase 2: Containment (15-60 min)

### Immediate Actions

- [ ] Isolate affected systems
- [ ] Revoke compromised credentials
- [ ] Block malicious IPs
- [ ] Enable enhanced monitoring

### Evidence Preservation

- [ ] Capture logs
- [ ] Take system snapshots
- [ ] Document timeline
- [ ] Preserve artifacts

## Phase 3: Eradication (1-24 hours)

- [ ] Remove malware
- [ ] Close vulnerabilities
- [ ] Reset passwords
- [ ] Update firewall rules

## Phase 4: Recovery (24-72 hours)

- [ ] Restore from backup
- [ ] Verify system integrity
- [ ] Resume operations
- [ ] Monitor for reinfection

## Phase 5: Post-Incident (1 week)

- [ ] Document lessons learned
- [ ] Update procedures
- [ ] Security training
- [ ] Notify affected users (if required)
```

## Output Checklist

- [ ] Response phases defined
- [ ] Containment procedures
- [ ] Communication templates
- [ ] Evidence collection rules
- [ ] Post-incident review
      ENDFILE
