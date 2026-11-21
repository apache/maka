---
name: rate-limiting-abuse-protection
description: Implements rate limiting and abuse prevention with per-route policies, IP/user-based limits, sliding windows, safe error responses, and observability. Use when adding "rate limiting", "API protection", "abuse prevention", or "DDoS protection".
---

# Rate Limiting & Abuse Protection

Protect APIs from abuse with intelligent rate limiting.

## Rate Limit Strategies

**Fixed Window**: 100 requests per hour
**Sliding Window**: More accurate, prevents bursts
**Token Bucket**: Allow bursts up to limit
**Leaky Bucket**: Smooth request rate

## Implementation (Express)

```typescript
import rateLimit from "express-rate-limit";

// Global rate limit
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // 100 requests per window
  message: "Too many requests, please try again later",
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
});

// Stricter limit for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Only 5 attempts
  skipSuccessfulRequests: true, // Don't count successful logins
});

app.use("/api/", globalLimiter);
app.use("/api/auth/login", authLimiter);
```

## Redis-based Rate Limiting

```typescript
import Redis from "ioredis";

const redis = new Redis();

export const checkRateLimit = async (
  key: string,
  max: number,
  window: number,
): Promise<{ allowed: boolean; remaining: number }> => {
  const now = Date.now();
  const windowStart = now - window;

  await redis
    .multi()
    .zremrangebyscore(key, 0, windowStart)
    .zadd(key, now, `${now}`)
    .zcard(key)
    .expire(key, Math.ceil(window / 1000))
    .exec();

  const count = await redis.zcard(key);

  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
  };
};
```

## Per-User Rate Limiting

```typescript
export const userRateLimit = (max: number, window: number) => {
  return async (req, res, next) => {
    if (!req.user) return next();

    const key = `rate_limit:user:${req.user.id}`;
    const result = await checkRateLimit(key, max, window);

    res.setHeader("X-RateLimit-Limit", max);
    res.setHeader("X-RateLimit-Remaining", result.remaining);

    if (!result.allowed) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        retryAfter: window / 1000,
      });
    }

    next();
  };
};
```

## IP-based Protection

```typescript
// Block suspicious IPs
const ipBlocklist = new Set<string>();

export const checkIPReputation = async (ip: string): Promise<boolean> => {
  if (ipBlocklist.has(ip)) return false;

  // Check against threat intelligence API
  const reputation = await checkThreatIntel(ip);
  if (reputation.isMalicious) {
    ipBlocklist.add(ip);
    return false;
  }

  return true;
};
```

## Response Headers

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1640000000
Retry-After: 3600
```

## Best Practices

- Different limits for different endpoints
- Lower limits for expensive operations
- Skip rate limit for internal services
- Return helpful error messages
- Log rate limit violations
- Monitor for abuse patterns
- Allowlist trusted IPs

## Output Checklist

- [ ] Rate limiter middleware
- [ ] Per-route policies
- [ ] User-based limiting
- [ ] IP-based limiting
- [ ] Rate limit headers
- [ ] Safe error responses
- [ ] Observability/logging
- [ ] Bypass for internal services
