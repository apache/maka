---
name: auth-module-builder
description: Implements secure authentication patterns including login/registration, session management, JWT tokens, password hashing, cookie settings, and CSRF protection. Provides auth routes, middleware, security configurations, and threat model documentation. Use when building "authentication", "login system", "JWT auth", or "session management".
---

# Auth Module Builder

Implement secure, production-ready authentication systems.

## Core Components

**Routes**: POST /login, /register, /logout, /refresh, /forgot-password
**Middleware**: authenticate, requireAuth, optionalAuth
**Security**: bcrypt hashing, JWT signing, secure cookies, CSRF tokens
**Session**: Redis/DB storage, expiration, refresh tokens
**Threats**: Document common attacks and mitigations

## JWT Pattern

```typescript
// Generate tokens
const accessToken = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET, {
  expiresIn: "15m",
});

const refreshToken = jwt.sign(
  { userId: user.id, type: "refresh" },
  process.env.JWT_REFRESH_SECRET,
  { expiresIn: "7d" },
);

// Verify middleware
export const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.userId);
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};
```

## Session Pattern

```typescript
// Express session with Redis
app.use(
  session({
    store: new RedisStore({ client: redisClient }),
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      sameSite: "lax",
    },
  }),
);
```

## Password Security

```typescript
import bcrypt from "bcrypt";

// Hash password
const hashedPassword = await bcrypt.hash(password, 10);

// Verify password
const isValid = await bcrypt.compare(password, user.hashedPassword);
```

## Security Checklist

- [ ] Passwords hashed with bcrypt (cost ≥10)
- [ ] JWT secrets from environment, rotated regularly
- [ ] HTTPS only in production
- [ ] httpOnly, secure cookies
- [ ] CSRF protection enabled
- [ ] Rate limiting on auth routes
- [ ] Account lockout after failed attempts
- [ ] Password reset tokens expire
- [ ] Email verification for new accounts

## Threat Model

**Brute Force**: Rate limit + account lockout
**Token Theft**: Short expiry, httpOnly cookies, HTTPS only
**CSRF**: SameSite cookies + CSRF tokens
**Session Fixation**: Regenerate session ID on login
**XSS**: Sanitize inputs, CSP headers
