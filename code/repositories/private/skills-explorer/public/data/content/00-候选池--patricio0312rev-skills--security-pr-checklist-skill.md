---
name: security-pr-checklist-skill
description: Creates repeatable security review checklist for PRs with required checks, common pitfalls, and automated gating. Use for "security review", "PR checklist", "code review", or "security gates".
---

# Security PR Checklist Skill

Standardized security review for pull requests.

## PR Security Checklist

```markdown
## Security Review Checklist

### Authentication & Authorization

- [ ] No hardcoded credentials
- [ ] Authorization checks on all endpoints
- [ ] Session management secure
- [ ] Rate limiting on auth endpoints

### Input Validation

- [ ] All inputs validated
- [ ] Output properly encoded
- [ ] No SQL injection risks
- [ ] No XSS vulnerabilities

### Data Protection

- [ ] Sensitive data encrypted at rest
- [ ] HTTPS enforced
- [ ] No PII in logs
- [ ] Secure cookie configuration

### Dependencies

- [ ] No new high/critical vulnerabilities
- [ ] Dependencies up to date
- [ ] No suspicious packages

### Secrets Management

- [ ] No secrets in code
- [ ] Environment variables used
- [ ] .env files in .gitignore

### Error Handling

- [ ] No sensitive info in errors
- [ ] Generic error messages
- [ ] Proper logging
```

## Output Checklist

- [ ] PR template created
- [ ] Required security checks
- [ ] Common pitfalls documented
- [ ] Automated checks in CI
- [ ] Review guidelines
      ENDFILE
