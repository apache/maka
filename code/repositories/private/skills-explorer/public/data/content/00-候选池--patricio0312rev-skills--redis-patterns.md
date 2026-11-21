---
name: redis-patterns
description: Implements Redis patterns for caching, sessions, rate limiting, pub/sub, and distributed locks with best practices. Use when users request "Redis caching", "session storage", "rate limiter", "pub/sub messaging", or "distributed locks".
---

# Redis Patterns

Implement common Redis patterns for high-performance applications.

## Core Workflow

1. **Setup connection**: Configure Redis client
2. **Choose pattern**: Caching, sessions, queues, etc.
3. **Implement operations**: CRUD with proper TTL
4. **Handle errors**: Reconnection, fallbacks
5. **Monitor performance**: Memory, latency
6. **Optimize**: Pipelining, clustering

## Connection Setup

```typescript
// redis/client.ts
import { Redis } from "ioredis";

// Single instance
export const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: parseInt(process.env.REDIS_PORT || "6379"),
  password: process.env.REDIS_PASSWORD,
  db: parseInt(process.env.REDIS_DB || "0"),

  // Connection options
  maxRetriesPerRequest: 3,
  retryStrategy(times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },

  // Performance options
  enableReadyCheck: true,
  enableOfflineQueue: true,
  connectTimeout: 10000,

  // TLS for production
  tls: process.env.NODE_ENV === "production" ? {} : undefined,
});

// Event handlers
redis.on("connect", () => console.log("Redis connecting..."));
redis.on("ready", () => console.log("Redis ready"));
redis.on("error", (err) => console.error("Redis error:", err));
redis.on("close", () => console.log("Redis connection closed"));

// Cluster connection
export const cluster = new Redis.Cluster(
  [
    { host: "redis-node-1", port: 6379 },
    { host: "redis-node-2", port: 6379 },
    { host: "redis-node-3", port: 6379 },
  ],
  {
    redisOptions: {
      password: process.env.REDIS_PASSWORD,
    },
    scaleReads: "slave",
    maxRedirections: 16,
  },
);

// Graceful shutdown
process.on("SIGTERM", async () => {
  await redis.quit();
});
```

## Caching Pattern

```typescript
// patterns/cache.ts
import { redis } from "./client";

interface CacheOptions {
  ttl?: number; // seconds
  prefix?: string;
}

export class Cache {
  private prefix: string;
  private defaultTTL: number;

  constructor(options: CacheOptions = {}) {
    this.prefix = options.prefix || "cache:";
    this.defaultTTL = options.ttl || 3600;
  }

  private key(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const data = await redis.get(this.key(key));
    if (!data) return null;

    try {
      return JSON.parse(data) as T;
    } catch {
      return data as unknown as T;
    }
  }

  async set<T>(key: string, value: T, ttl?: number): Promise<void> {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);

    await redis.setex(this.key(key), ttl || this.defaultTTL, serialized);
  }

  async getOrSet<T>(key: string, fetcher: () => Promise<T>, ttl?: number): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;

    const value = await fetcher();
    await this.set(key, value, ttl);
    return value;
  }

  async delete(key: string): Promise<void> {
    await redis.del(this.key(key));
  }

  async deletePattern(pattern: string): Promise<void> {
    const keys = await redis.keys(this.key(pattern));
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  }

  // Cache with stale-while-revalidate
  async getStale<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: { ttl: number; staleTTL: number },
  ): Promise<T> {
    const cacheKey = this.key(key);
    const staleKey = `${cacheKey}:stale`;

    const cached = await redis.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    // Check stale data
    const stale = await redis.get(staleKey);
    if (stale) {
      // Return stale, refresh in background
      this.refreshCache(key, fetcher, options).catch(console.error);
      return JSON.parse(stale);
    }

    return this.refreshCache(key, fetcher, options);
  }

  private async refreshCache<T>(
    key: string,
    fetcher: () => Promise<T>,
    options: { ttl: number; staleTTL: number },
  ): Promise<T> {
    const value = await fetcher();
    const serialized = JSON.stringify(value);

    const pipeline = redis.pipeline();
    pipeline.setex(this.key(key), options.ttl, serialized);
    pipeline.setex(`${this.key(key)}:stale`, options.staleTTL, serialized);
    await pipeline.exec();

    return value;
  }
}

// Usage
const cache = new Cache({ prefix: "user:", ttl: 3600 });

async function getUser(id: string) {
  return cache.getOrSet(
    `profile:${id}`,
    async () => {
      return await db.users.findById(id);
    },
    1800,
  );
}
```

## Session Storage

```typescript
// patterns/session.ts
import { redis } from "./client";
import { nanoid } from "nanoid";

interface Session {
  id: string;
  userId: string;
  data: Record<string, any>;
  createdAt: number;
  expiresAt: number;
}

export class SessionStore {
  private prefix = "session:";
  private userPrefix = "user:sessions:";
  private ttl = 86400 * 7; // 7 days

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  async create(userId: string, data: Record<string, any> = {}): Promise<Session> {
    const session: Session = {
      id: nanoid(32),
      userId,
      data,
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttl * 1000,
    };

    const pipeline = redis.pipeline();

    // Store session
    pipeline.setex(this.key(session.id), this.ttl, JSON.stringify(session));

    // Track user's sessions
    pipeline.sadd(`${this.userPrefix}${userId}`, session.id);
    pipeline.expire(`${this.userPrefix}${userId}`, this.ttl);

    await pipeline.exec();

    return session;
  }

  async get(sessionId: string): Promise<Session | null> {
    const data = await redis.get(this.key(sessionId));
    if (!data) return null;

    const session = JSON.parse(data) as Session;

    // Check expiration
    if (session.expiresAt < Date.now()) {
      await this.destroy(sessionId);
      return null;
    }

    return session;
  }

  async update(sessionId: string, data: Record<string, any>): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) throw new Error("Session not found");

    session.data = { ...session.data, ...data };

    await redis.setex(this.key(sessionId), this.ttl, JSON.stringify(session));
  }

  async refresh(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;

    session.expiresAt = Date.now() + this.ttl * 1000;

    await redis.setex(this.key(sessionId), this.ttl, JSON.stringify(session));
  }

  async destroy(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (!session) return;

    const pipeline = redis.pipeline();
    pipeline.del(this.key(sessionId));
    pipeline.srem(`${this.userPrefix}${session.userId}`, sessionId);
    await pipeline.exec();
  }

  async destroyAllForUser(userId: string): Promise<void> {
    const sessionIds = await redis.smembers(`${this.userPrefix}${userId}`);

    if (sessionIds.length > 0) {
      const keys = sessionIds.map((id) => this.key(id));
      await redis.del(...keys, `${this.userPrefix}${userId}`);
    }
  }
}
```

## Rate Limiting

```typescript
// patterns/rate-limiter.ts
import { redis } from "./client";

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export class RateLimiter {
  // Fixed window rate limiting
  async fixedWindow(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = `ratelimit:fixed:${key}`;
    const now = Math.floor(Date.now() / 1000);
    const window = Math.floor(now / windowSeconds);
    const windowKey = `${redisKey}:${window}`;

    const count = await redis.incr(windowKey);

    if (count === 1) {
      await redis.expire(windowKey, windowSeconds);
    }

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: (window + 1) * windowSeconds * 1000,
    };
  }

  // Sliding window rate limiting
  async slidingWindow(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
    const redisKey = `ratelimit:sliding:${key}`;
    const now = Date.now();
    const windowStart = now - windowSeconds * 1000;

    const pipeline = redis.pipeline();

    // Remove old entries
    pipeline.zremrangebyscore(redisKey, 0, windowStart);

    // Add current request
    pipeline.zadd(redisKey, now, `${now}:${Math.random()}`);

    // Count requests in window
    pipeline.zcard(redisKey);

    // Set expiration
    pipeline.expire(redisKey, windowSeconds);

    const results = await pipeline.exec();
    const count = results?.[2]?.[1] as number;

    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetAt: now + windowSeconds * 1000,
    };
  }

  // Token bucket rate limiting
  async tokenBucket(
    key: string,
    bucketSize: number,
    refillRate: number, // tokens per second
    tokensNeeded: number = 1,
  ): Promise<RateLimitResult> {
    const redisKey = `ratelimit:bucket:${key}`;
    const now = Date.now();

    // Lua script for atomic token bucket
    const script = `
      local key = KEYS[1]
      local bucket_size = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local tokens_needed = tonumber(ARGV[3])
      local now = tonumber(ARGV[4])

      local bucket = redis.call('HMGET', key, 'tokens', 'last_refill')
      local tokens = tonumber(bucket[1]) or bucket_size
      local last_refill = tonumber(bucket[2]) or now

      -- Calculate refill
      local elapsed = (now - last_refill) / 1000
      local refill = elapsed * refill_rate
      tokens = math.min(bucket_size, tokens + refill)

      -- Check if enough tokens
      local allowed = 0
      if tokens >= tokens_needed then
        tokens = tokens - tokens_needed
        allowed = 1
      end

      -- Save state
      redis.call('HMSET', key, 'tokens', tokens, 'last_refill', now)
      redis.call('EXPIRE', key, math.ceil(bucket_size / refill_rate) + 1)

      return {allowed, tokens}
    `;

    const result = (await redis.eval(
      script,
      1,
      redisKey,
      bucketSize,
      refillRate,
      tokensNeeded,
      now,
    )) as [number, number];

    return {
      allowed: result[0] === 1,
      remaining: Math.floor(result[1]),
      resetAt: now + Math.ceil((tokensNeeded - result[1]) / refillRate) * 1000,
    };
  }
}

// Express middleware
export function rateLimitMiddleware(
  limiter: RateLimiter,
  options: { limit: number; window: number },
) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || "anonymous";
    const result = await limiter.slidingWindow(key, options.limit, options.window);

    res.setHeader("X-RateLimit-Limit", options.limit);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Reset", result.resetAt);

    if (!result.allowed) {
      return res.status(429).json({
        error: "Too Many Requests",
        retryAfter: Math.ceil((result.resetAt - Date.now()) / 1000),
      });
    }

    next();
  };
}
```

## Distributed Locks

```typescript
// patterns/lock.ts
import { redis } from "./client";
import { nanoid } from "nanoid";

export class DistributedLock {
  private prefix = "lock:";

  async acquire(resource: string, ttlMs: number = 10000): Promise<string | null> {
    const lockKey = `${this.prefix}${resource}`;
    const lockValue = nanoid();
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    const acquired = await redis.set(lockKey, lockValue, "EX", ttlSeconds, "NX");

    return acquired === "OK" ? lockValue : null;
  }

  async release(resource: string, lockValue: string): Promise<boolean> {
    const lockKey = `${this.prefix}${resource}`;

    // Lua script for atomic release
    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('DEL', KEYS[1])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, lockKey, lockValue);
    return result === 1;
  }

  async extend(resource: string, lockValue: string, ttlMs: number): Promise<boolean> {
    const lockKey = `${this.prefix}${resource}`;
    const ttlSeconds = Math.ceil(ttlMs / 1000);

    const script = `
      if redis.call('GET', KEYS[1]) == ARGV[1] then
        return redis.call('EXPIRE', KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, lockKey, lockValue, ttlSeconds);
    return result === 1;
  }

  async withLock<T>(
    resource: string,
    fn: () => Promise<T>,
    options: { ttl?: number; retries?: number; retryDelay?: number } = {},
  ): Promise<T> {
    const { ttl = 10000, retries = 3, retryDelay = 100 } = options;

    let lockValue: string | null = null;
    let attempts = 0;

    while (attempts < retries) {
      lockValue = await this.acquire(resource, ttl);
      if (lockValue) break;

      attempts++;
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
    }

    if (!lockValue) {
      throw new Error(`Failed to acquire lock for ${resource}`);
    }

    try {
      return await fn();
    } finally {
      await this.release(resource, lockValue);
    }
  }
}

// Usage
const lock = new DistributedLock();

async function processPayment(orderId: string) {
  return lock.withLock(`order:${orderId}`, async () => {
    // Critical section - only one process can execute
    const order = await db.orders.findById(orderId);
    if (order.status !== "pending") {
      throw new Error("Order already processed");
    }

    await processStripePayment(order);
    await db.orders.update(orderId, { status: "paid" });
  });
}
```

## Pub/Sub Pattern

```typescript
// patterns/pubsub.ts
import { Redis } from "ioredis";

// Separate connections for pub/sub
const subscriber = new Redis(process.env.REDIS_URL!);
const publisher = new Redis(process.env.REDIS_URL!);

type MessageHandler<T> = (message: T, channel: string) => void | Promise<void>;

export class PubSub {
  private handlers: Map<string, Set<MessageHandler<any>>> = new Map();

  async subscribe<T>(channel: string, handler: MessageHandler<T>): Promise<void> {
    if (!this.handlers.has(channel)) {
      this.handlers.set(channel, new Set());
      await subscriber.subscribe(channel);
    }

    this.handlers.get(channel)!.add(handler);
  }

  async unsubscribe(channel: string, handler?: MessageHandler<any>): Promise<void> {
    const handlers = this.handlers.get(channel);
    if (!handlers) return;

    if (handler) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.handlers.delete(channel);
        await subscriber.unsubscribe(channel);
      }
    } else {
      this.handlers.delete(channel);
      await subscriber.unsubscribe(channel);
    }
  }

  async publish<T>(channel: string, message: T): Promise<void> {
    await publisher.publish(channel, JSON.stringify(message));
  }

  async subscribePattern<T>(pattern: string, handler: MessageHandler<T>): Promise<void> {
    if (!this.handlers.has(pattern)) {
      this.handlers.set(pattern, new Set());
      await subscriber.psubscribe(pattern);
    }

    this.handlers.get(pattern)!.add(handler);
  }
}

// Initialize message handling
subscriber.on("message", (channel, message) => {
  const pubsub = new PubSub();
  const handlers = pubsub["handlers"].get(channel);
  if (!handlers) return;

  const parsed = JSON.parse(message);
  handlers.forEach((handler) => handler(parsed, channel));
});

// Usage
const pubsub = new PubSub();

// Subscribe to user events
await pubsub.subscribe<{ userId: string; action: string }>("user:events", async (msg) => {
  console.log(`User ${msg.userId} performed ${msg.action}`);
});

// Publish event
await pubsub.publish("user:events", { userId: "123", action: "login" });
```

## Leaderboard Pattern

```typescript
// patterns/leaderboard.ts
import { redis } from "./client";

export class Leaderboard {
  private key: string;

  constructor(name: string) {
    this.key = `leaderboard:${name}`;
  }

  async addScore(member: string, score: number): Promise<void> {
    await redis.zadd(this.key, score, member);
  }

  async incrementScore(member: string, increment: number): Promise<number> {
    return redis.zincrby(this.key, increment, member);
  }

  async getTop(count: number): Promise<Array<{ member: string; score: number }>> {
    const results = await redis.zrevrange(this.key, 0, count - 1, "WITHSCORES");

    const entries: Array<{ member: string; score: number }> = [];
    for (let i = 0; i < results.length; i += 2) {
      entries.push({
        member: results[i],
        score: parseFloat(results[i + 1]),
      });
    }

    return entries;
  }

  async getRank(member: string): Promise<number | null> {
    const rank = await redis.zrevrank(this.key, member);
    return rank !== null ? rank + 1 : null;
  }

  async getScore(member: string): Promise<number | null> {
    const score = await redis.zscore(this.key, member);
    return score !== null ? parseFloat(score) : null;
  }

  async getAroundMember(
    member: string,
    count: number,
  ): Promise<Array<{ member: string; score: number; rank: number }>> {
    const rank = await redis.zrevrank(this.key, member);
    if (rank === null) return [];

    const start = Math.max(0, rank - Math.floor(count / 2));
    const results = await redis.zrevrange(this.key, start, start + count - 1, "WITHSCORES");

    const entries: Array<{ member: string; score: number; rank: number }> = [];
    for (let i = 0; i < results.length; i += 2) {
      entries.push({
        member: results[i],
        score: parseFloat(results[i + 1]),
        rank: start + i / 2 + 1,
      });
    }

    return entries;
  }
}
```

## Best Practices

1. **Connection pooling**: Reuse connections
2. **Pipelining**: Batch multiple commands
3. **TTL everywhere**: Prevent memory leaks
4. **Key naming**: Use consistent prefixes
5. **Lua scripts**: Atomic operations
6. **Cluster ready**: Design for horizontal scaling
7. **Error handling**: Graceful degradation
8. **Memory management**: Monitor and set maxmemory

## Output Checklist

Every Redis implementation should include:

- [ ] Connection with retry strategy
- [ ] Proper key prefixing/namespacing
- [ ] TTL on all keys
- [ ] Error handling and fallbacks
- [ ] Graceful shutdown
- [ ] Pipelining for batch operations
- [ ] Lua scripts for atomicity
- [ ] Memory monitoring
- [ ] Cluster-safe operations
- [ ] Connection pooling
