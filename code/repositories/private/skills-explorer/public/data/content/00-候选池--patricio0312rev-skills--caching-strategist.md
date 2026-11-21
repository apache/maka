---
name: caching-strategist
description: Defines caching strategies with cache keys, TTL values, invalidation triggers, consistency patterns, and correctness checklist. Provides code examples for Redis, CDN, and application-level caching. Use when implementing "caching", "performance optimization", "cache strategy", or "Redis caching".
---

# Caching Strategist

Design effective caching strategies for performance and consistency.

## Cache Layers

**CDN**: Static assets, public pages (TTL: days/weeks)
**Application Cache** (Redis): API responses, sessions (TTL: minutes/hours)
**Database Cache**: Query results (TTL: seconds/minutes)
**Client Cache**: Browser/app local cache

## Cache Key Strategy

```typescript
// Hierarchical key structure
const CACHE_KEYS = {
  user: (id: string) => `user:${id}`,
  userPosts: (userId: string, page: number) => `user:${userId}:posts:${page}`,
  post: (id: string) => `post:${id}`,
  postComments: (postId: string) => `post:${postId}:comments`,
};

// Include version in keys for easy invalidation
const CACHE_VERSION = "v1";
const key = `${CACHE_VERSION}:${CACHE_KEYS.user(userId)}`;
```

## TTL Strategy

```typescript
const TTL = {
  // Frequently changing
  REALTIME: 10, // 10 seconds
  SHORT: 60, // 1 minute

  // Moderate updates
  MEDIUM: 300, // 5 minutes
  STANDARD: 3600, // 1 hour

  // Rarely changing
  LONG: 86400, // 1 day
  VERY_LONG: 604800, // 1 week
};

// Usage
await redis.setex(key, TTL.MEDIUM, JSON.stringify(data));
```

## Cache-Aside Pattern

```typescript
export const getCachedUser = async (userId: string): Promise<User> => {
  const key = CACHE_KEYS.user(userId);

  // Try cache first
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  // Cache miss - fetch from DB
  const user = await db.users.findById(userId);

  // Store in cache
  await redis.setex(key, TTL.STANDARD, JSON.stringify(user));

  return user;
};
```

## Cache Invalidation

```typescript
// Invalidate on update
export const updateUser = async (userId: string, data: UpdateUserDto) => {
  const user = await db.users.update(userId, data);

  // Invalidate cache
  await redis.del(CACHE_KEYS.user(userId));

  // Invalidate related caches
  await redis.del(CACHE_KEYS.userPosts(userId, "*"));

  return user;
};

// Tag-based invalidation
const addCacheTags = (key: string, tags: string[]) => {
  tags.forEach((tag) => {
    redis.sadd(`cache_tag:${tag}`, key);
  });
};

const invalidateByTag = async (tag: string) => {
  const keys = await redis.smembers(`cache_tag:${tag}`);
  if (keys.length) {
    await redis.del(...keys);
    await redis.del(`cache_tag:${tag}`);
  }
};
```

## Cache Warming

```typescript
// Pre-populate cache for common queries
export const warmCache = async () => {
  const popularPosts = await db.posts.findPopular(100);

  for (const post of popularPosts) {
    const key = CACHE_KEYS.post(post.id);
    await redis.setex(key, TTL.LONG, JSON.stringify(post));
  }
};

// Schedule warming
cron.schedule("0 */6 * * *", warmCache); // Every 6 hours
```

## Cache Stampede Prevention

```typescript
// Use locks to prevent multiple simultaneous fetches
export const getCachedWithLock = async (key: string, fetchFn: () => Promise<any>) => {
  const cached = await redis.get(key);
  if (cached) return JSON.parse(cached);

  const lockKey = `lock:${key}`;
  const acquired = await redis.set(lockKey, "1", "EX", 10, "NX");

  if (acquired) {
    try {
      // Fetch and cache
      const data = await fetchFn();
      await redis.setex(key, TTL.STANDARD, JSON.stringify(data));
      return data;
    } finally {
      await redis.del(lockKey);
    }
  } else {
    // Wait for other request to finish
    await new Promise((resolve) => setTimeout(resolve, 100));
    return getCachedWithLock(key, fetchFn);
  }
};
```

## Cache Correctness Checklist

```markdown
- [ ] Cache keys are unique and predictable
- [ ] TTL is appropriate for data freshness
- [ ] Invalidation happens on all updates
- [ ] Related caches invalidated together
- [ ] Cache stampede prevention in place
- [ ] Fallback to DB if cache fails
- [ ] Monitoring cache hit rate
- [ ] Cache size doesn't grow unbounded
- [ ] Sensitive data not cached or encrypted
- [ ] Cache warming for critical paths
```

## Best Practices

- Cache immutable data aggressively
- Short TTLs for frequently changing data
- Invalidate on write, not on read
- Monitor hit rates and adjust
- Use tags for bulk invalidation
- Prevent cache stampedes
- Graceful degradation if cache down

## Output Checklist

- [ ] Cache key naming strategy
- [ ] TTL values per data type
- [ ] Invalidation triggers documented
- [ ] Cache-aside implementation
- [ ] Stampede prevention
- [ ] Cache warming strategy
- [ ] Monitoring/metrics setup
- [ ] Correctness checklist completed
