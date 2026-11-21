---
name: pii-redaction-logging-policy-builder
description: Prevents logging sensitive user data with redaction rules, logging policies, and safe log formatting. Use for "PII redaction", "log privacy", "GDPR logging", or "data privacy".
---

# PII Redaction & Logging Policy Builder

Protect user privacy in application logs.

## PII Redaction

```typescript
const PII_PATTERNS = {
  email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  phone: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,
  creditCard: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
};

function redactPII(message: string): string {
  let redacted = message;
  Object.entries(PII_PATTERNS).forEach(([type, pattern]) => {
    redacted = redacted.replace(pattern, `[REDACTED_${type.toUpperCase()}]`);
  });
  return redacted;
}

// Safe logging
logger.info(redactPII(\`User registered: \${email}\`));
// Output: "User registered: [REDACTED_EMAIL]"
```

## Logging Policy

```markdown
# Logging Policy

## ✅ DO Log

- Request IDs
- User IDs (hashed)
- HTTP status codes
- Response times
- Error types
- Feature flags

## ❌ DON'T Log

- Passwords
- Credit card numbers
- SSNs
- API keys
- Full emails (hash first)
- Full names
- Addresses
```

## Output Checklist

- [ ] Redaction rules defined
- [ ] Logging policy documented
- [ ] Safe logger wrapper
- [ ] Team trained
- [ ] Log monitoring
      ENDFILE
