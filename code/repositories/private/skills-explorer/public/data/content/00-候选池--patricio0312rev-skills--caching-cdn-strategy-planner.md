---
name: caching-cdn-strategy-planner
description: Designs multi-layer caching strategy with edge CDN, server-side caching, cache invalidation, and CDN configuration. Use for "caching strategy", "CDN setup", "cache invalidation", or "performance optimization".
---

# Caching & CDN Strategy Planner

Design effective caching at all layers.

## Caching Layers

```
Client → CDN (Edge) → Server Cache → Database
```

## CDN Configuration (CloudFront)

```typescript
const distribution = {
  Origins: [
    {
      DomainName: "api.example.com",
      CustomHeaders: [
        {
          HeaderName: "X-CDN-Secret",
          HeaderValue: process.env.CDN_SECRET,
        },
      ],
    },
  ],
  DefaultCacheBehavior: {
    ViewerProtocolPolicy: "redirect-to-https",
    AllowedMethods: ["GET", "HEAD", "OPTIONS"],
    CachedMethods: ["GET", "HEAD"],
    Compress: true,
    DefaultTTL: 86400, // 1 day
    MaxTTL: 31536000, // 1 year
    MinTTL: 0,
    ForwardedValues: {
      QueryString: true,
      Cookies: { Forward: "none" },
      Headers: ["Accept", "Accept-Encoding"],
    },
  },
  CacheBehaviors: [
    {
      PathPattern: "/api/static/*",
      DefaultTTL: 31536000, // 1 year - never changes
    },
    {
      PathPattern: "/api/dynamic/*",
      DefaultTTL: 300, // 5 min - changes frequently
    },
  ],
};
```

## Server-side Caching (Redis)

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL);

async function getCachedOrFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl: number = 3600
): Promise<T> {
  // Try cache
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached);
  }

  // Fetch and cache
  const data = await fetcher();
  await redis.setex(key, ttl, JSON.stringify(data));

  return data;
}

// Usage
app.get('/api/user/:id', async (req, res) => {
  const user = await getCachedOrFetch(
    \`user:\${req.params.id}\`,
    () => prisma.user.findUnique({ where: { id: req.params.id } }),
    3600
  );

  res.json(user);
});
```

## Cache Invalidation

```typescript
// Invalidate on update
app.put('/api/user/:id', async (req, res) => {
  const user = await prisma.user.update({
    where: { id: req.params.id },
    data: req.body,
  });

  // Invalidate cache
  await redis.del(\`user:\${req.params.id}\`);

  // Invalidate CDN
  await cloudfront.createInvalidation({
    DistributionId: DISTRIBUTION_ID,
    InvalidationBatch: {
      Paths: { Items: [\`/api/user/\${req.params.id}\`] },
      CallerReference: Date.now().toString(),
    },
  });

  res.json(user);
});
```

## Cache Headers

```typescript
app.get("/api/products", (req, res) => {
  res.set({
    "Cache-Control": "public, max-age=3600", // Browser + CDN: 1h
    ETag: generateETag(products),
    "Last-Modified": new Date(products.updatedAt).toUTCString(),
  });

  res.json(products);
});

app.get("/api/user/profile", (req, res) => {
  res.set({
    "Cache-Control": "private, no-cache", // No caching (sensitive)
  });

  res.json(profile);
});
```

## Output Checklist

- [ ] CDN configured
- [ ] Server cache implemented
- [ ] Invalidation strategy
- [ ] Cache headers set
- [ ] Monitoring configured
      ENDFILE
