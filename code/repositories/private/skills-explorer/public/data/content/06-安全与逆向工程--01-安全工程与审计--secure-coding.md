---
name: secure-coding
description: Secure coding reference and vulnerability prevention guidelines across 15+ tech stacks. Covers OWASP Top 10, input validation, authentication, crypto.
allowed-tools:
  - Bash(echo *)
---

# Secure Coding — Vulnerability Prevention

Security reference for writing secure code. Covers common vulnerability patterns.

## Coverage

| Category             | Topics                                                |
| -------------------- | ----------------------------------------------------- |
| **OWASP Top 10**     | Injection, broken auth, XSS, insecure deserialization |
| **Input Validation** | Sanitization, parameterized queries, allowlists       |
| **Authentication**   | Password hashing, session management, MFA             |
| **API Security**     | Rate limiting, request validation, CORS               |

## Common Patterns

### SQL Injection Prevention

```python
# BAD
query = f"SELECT * FROM users WHERE id = {user_input}"
# GOOD
cursor.execute("SELECT * FROM users WHERE id = %s", (user_input,))
```

## Best Practices

1. Defense in depth
2. Least privilege
3. Input validation on both client and server
4. Regular dependency auditing for CVEs
