---
name: auth-security-reviewer
description: Reviews authentication and authorization implementation for session management, CSRF, cookie security, and auth flow vulnerabilities with findings, severity assessment, and fix recommendations. Use for "auth review", "session security", "CSRF protection", or "authentication audit".
---

# Auth Security Reviewer

Comprehensive security review of authentication systems.

## Session Security Checklist

```typescript
// ❌ INSECURE Session Configuration
app.use(
  session({
    secret: "weak-secret", // Too simple
    resave: true, // Unnecessary
    saveUninitialized: true, // Creates unnecessary sessions
    cookie: {
      secure: false, // Not HTTPS-only
      httpOnly: false, // Accessible via JavaScript
      sameSite: false, // CSRF vulnerable
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year - too long
    },
  }),
);

// ✅ SECURE Session Configuration
app.use(
  session({
    secret: process.env.SESSION_SECRET, // From environment
    resave: false,
    saveUninitialized: false,
    name: "sessionId", // Don't use default 'connect.sid'
    cookie: {
      secure: true, // HTTPS only
      httpOnly: true, // No JavaScript access
      sameSite: "strict", // CSRF protection
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      domain: process.env.COOKIE_DOMAIN,
    },
    store: new RedisStore({
      client: redisClient,
      ttl: 86400,
    }),
  }),
);
```

## JWT Security Review

```typescript
// ❌ INSECURE JWT Implementation
const token = jwt.sign(
  { userId: user.id },
  "weak-secret", // Hardcoded secret
  { algorithm: "HS256" }, // No expiration
);

// Store in localStorage
localStorage.setItem("token", token); // XSS vulnerable

// ✅ SECURE JWT Implementation
const token = jwt.sign(
  {
    userId: user.id,
    role: user.role,
    iat: Math.floor(Date.now() / 1000),
  },
  process.env.JWT_SECRET, // Strong secret from env
  {
    algorithm: "HS256",
    expiresIn: "15m", // Short-lived
    issuer: "myapp.com",
    audience: "myapp.com",
  },
);

// Store in httpOnly cookie
res.cookie("accessToken", token, {
  httpOnly: true,
  secure: true,
  sameSite: "strict",
  maxAge: 15 * 60 * 1000,
});

// Refresh token with longer expiry
const refreshToken = jwt.sign(
  { userId: user.id, type: "refresh" },
  process.env.REFRESH_TOKEN_SECRET,
  { expiresIn: "7d" },
);

// Store refresh token in database
await storeRefreshToken(user.id, refreshToken);
```

## CSRF Protection

```typescript
// Using csurf middleware
import csrf from "csurf";

const csrfProtection = csrf({ cookie: true });

// Apply to state-changing routes
app.post("/api/transfer", csrfProtection, async (req, res) => {
  // Protected from CSRF
  await processTransfer(req.body);
  res.json({ success: true });
});

// Provide CSRF token to frontend
app.get("/api/csrf-token", csrfProtection, (req, res) => {
  res.json({ csrfToken: req.csrfToken() });
});

// Frontend usage
const csrfToken = await fetch("/api/csrf-token").then((r) => r.json());

await fetch("/api/transfer", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken.csrfToken,
  },
  body: JSON.stringify({ amount: 100 }),
});
```

## Password Security

```typescript
// ❌ INSECURE Password Handling
const password = req.body.password;
const hash = crypto.createHash("md5").update(password).digest("hex"); // MD5 is broken
await db.user.create({ password: hash });

// ✅ SECURE Password Handling
import bcrypt from "bcrypt";

// Hashing
const saltRounds = 12; // Adjust based on security requirements
const hash = await bcrypt.hash(password, saltRounds);
await db.user.create({ passwordHash: hash });

// Verification
const isValid = await bcrypt.compare(password, user.passwordHash);

// Password requirements
function validatePassword(password: string): boolean {
  return (
    password.length >= 12 &&
    /[A-Z]/.test(password) && // Uppercase
    /[a-z]/.test(password) && // Lowercase
    /[0-9]/.test(password) && // Number
    /[^A-Za-z0-9]/.test(password) // Special char
  );
}

// Check against breached passwords
import { pwnedPassword } from "hibp";

const breachCount = await pwnedPassword(password);
if (breachCount > 0) {
  throw new Error("This password has been found in data breaches");
}
```

## Multi-Factor Authentication

```typescript
// TOTP-based MFA
import speakeasy from "speakeasy";
import qrcode from "qrcode";

// Generate secret
const secret = speakeasy.generateSecret({
  name: `MyApp (${user.email})`,
  issuer: "MyApp",
});

// Store secret
await db.user.update({
  where: { id: user.id },
  data: {
    mfaSecret: secret.base32,
    mfaEnabled: false, // Not enabled until verified
  },
});

// Generate QR code
const qrCodeUrl = await qrcode.toDataURL(secret.otpauth_url);

// Verify TOTP token
function verifyMFA(token: string, secret: string): boolean {
  return speakeasy.totp.verify({
    secret,
    encoding: "base32",
    token,
    window: 2, // Allow 2 time steps before/after
  });
}

// Backup codes
function generateBackupCodes(): string[] {
  return Array.from({ length: 10 }, () => crypto.randomBytes(4).toString("hex").toUpperCase());
}
```

## Authorization Vulnerabilities

```typescript
// ❌ INSECURE: Missing authorization check
app.get("/api/users/:id/profile", async (req, res) => {
  const profile = await db.user.findUnique({
    where: { id: req.params.id },
  });
  res.json(profile); // Anyone can access any profile!
});

// ✅ SECURE: Proper authorization
app.get("/api/users/:id/profile", authenticate, async (req, res) => {
  // Check if user can access this profile
  if (req.user.id !== req.params.id && req.user.role !== "ADMIN") {
    return res.status(403).json({ error: "Forbidden" });
  }

  const profile = await db.user.findUnique({
    where: { id: req.params.id },
  });
  res.json(profile);
});

// ❌ INSECURE: IDOR vulnerability
app.delete("/api/orders/:id", async (req, res) => {
  await db.order.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});

// ✅ SECURE: Verify ownership
app.delete("/api/orders/:id", authenticate, async (req, res) => {
  const order = await db.order.findUnique({
    where: { id: req.params.id },
  });

  if (!order) {
    return res.status(404).json({ error: "Not found" });
  }

  if (order.userId !== req.user.id) {
    return res.status(403).json({ error: "Forbidden" });
  }

  await db.order.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});
```

## Session Fixation Prevention

```typescript
// ❌ INSECURE: Session not regenerated on login
app.post("/login", async (req, res) => {
  const user = await authenticate(req.body);
  req.session.userId = user.id;
  res.json({ success: true });
});

// ✅ SECURE: Regenerate session on login
app.post("/login", async (req, res) => {
  const user = await authenticate(req.body);

  // Regenerate session to prevent fixation
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Server error" });

    req.session.userId = user.id;
    res.json({ success: true });
  });
});

// Also regenerate on privilege escalation
app.post("/admin/elevate", async (req, res) => {
  // Verify admin credentials
  await verifyAdminPassword(req.body.password);

  // Regenerate session
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "Server error" });

    req.session.isAdmin = true;
    res.json({ success: true });
  });
});
```

## Rate Limiting on Auth Endpoints

```typescript
import rateLimit from "express-rate-limit";

// Strict rate limit for login
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: "Too many login attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
  // Use IP + username for more granular limiting
  keyGenerator: (req) => `${req.ip}-${req.body.email}`,
});

app.post("/api/login", loginLimiter, async (req, res) => {
  // Login logic
});

// Even stricter for password reset
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: "Too many password reset attempts",
});

app.post("/api/password-reset", resetLimiter, async (req, res) => {
  // Password reset logic
});
```

## Security Testing

```typescript
// tests/auth-security.test.ts
describe("Auth Security", () => {
  describe("Session Security", () => {
    it("should set httpOnly cookie", async () => {
      const response = await request(app)
        .post("/api/login")
        .send({ email: "test@example.com", password: "password123" });

      const cookie = response.headers["set-cookie"][0];
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("SameSite=Strict");
    });

    it("should regenerate session on login", async () => {
      const agent = request.agent(app);

      // Get initial session
      await agent.get("/");
      const initialCookie = agent.jar.getCookie("sessionId");

      // Login
      await agent.post("/api/login").send({
        email: "test@example.com",
        password: "password123",
      });

      const loginCookie = agent.jar.getCookie("sessionId");

      // Session ID should change
      expect(loginCookie.value).not.toBe(initialCookie.value);
    });
  });

  describe("CSRF Protection", () => {
    it("should reject requests without CSRF token", async () => {
      await request(app).post("/api/transfer").send({ amount: 100 }).expect(403);
    });

    it("should accept requests with valid CSRF token", async () => {
      const { csrfToken } = await request(app)
        .get("/api/csrf-token")
        .then((r) => r.body);

      await request(app)
        .post("/api/transfer")
        .set("X-CSRF-Token", csrfToken)
        .send({ amount: 100 })
        .expect(200);
    });
  });

  describe("Authorization", () => {
    it("should prevent IDOR attacks", async () => {
      const user1 = await createUser();
      const user2 = await createUser();

      const token1 = generateToken(user1);

      // Try to access user2's profile with user1's token
      await request(app)
        .get(`/api/users/${user2.id}/profile`)
        .set("Authorization", `Bearer ${token1}`)
        .expect(403);
    });
  });
});
```

## Best Practices

1. **Regenerate sessions**: On login and privilege changes
2. **Short-lived tokens**: 15min access, 7-day refresh
3. **CSRF protection**: All state-changing operations
4. **Rate limiting**: Prevent brute force
5. **Secure cookies**: HttpOnly, Secure, SameSite
6. **MFA**: For sensitive operations
7. **Audit logs**: Track authentication events

## Output Checklist

- [ ] Session configuration reviewed
- [ ] JWT implementation secured
- [ ] CSRF protection enabled
- [ ] Password hashing with bcrypt
- [ ] MFA implementation (if required)
- [ ] Authorization checks on all endpoints
- [ ] Session fixation prevention
- [ ] Rate limiting on auth endpoints
- [ ] Security tests written
- [ ] Audit logging configured
