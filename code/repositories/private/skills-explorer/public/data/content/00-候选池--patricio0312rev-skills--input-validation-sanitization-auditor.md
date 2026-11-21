---
name: input-validation-sanitization-auditor
description: Identifies and fixes XSS, SQL injection, and command injection vulnerabilities with validation schemas, sanitization libraries, and safe coding patterns. Use for "input validation", "XSS prevention", "SQL injection", or "sanitization".
---

# Input Validation & Sanitization Auditor

Prevent injection attacks through proper input handling.

## XSS Prevention

```typescript
// ❌ DANGEROUS: Direct HTML injection
app.get("/search", (req, res) => {
  res.send(`<h1>Results for: ${req.query.q}</h1>`); // XSS!
});

// ✅ SAFE: Properly escaped
import { escape } from "html-escaper";

app.get("/search", (req, res) => {
  res.send(`<h1>Results for: ${escape(req.query.q)}</h1>`);
});

// ✅ BETTER: Template engine with auto-escaping
res.render("search", { query: req.query.q }); // EJS/Pug escape by default
```

## SQL Injection Prevention

```typescript
// ❌ DANGEROUS: String concatenation
const userId = req.params.id;
const query = `SELECT * FROM users WHERE id = '${userId}'`; // SQL Injection!
db.query(query);

// ✅ SAFE: Parameterized queries
db.query("SELECT * FROM users WHERE id = $1", [userId]);

// ✅ BEST: ORM (Prisma)
await prisma.user.findUnique({ where: { id: userId } });
```

## Input Validation Schema

```typescript
import { z } from "zod";

const userSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(12).max(128),
  age: z.number().int().min(13).max(120),
  website: z.string().url().optional(),
});

app.post("/register", async (req, res) => {
  try {
    const validated = userSchema.parse(req.body);
    await createUser(validated);
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: error.errors });
  }
});
```

## Output Checklist

- [ ] XSS prevention (escaping, CSP)
- [ ] SQL injection prevention (parameterized queries)
- [ ] Command injection prevention
- [ ] Input validation schemas
- [ ] Output encoding
- [ ] Sanitization libraries
- [ ] Security tests
      ENDFILE
