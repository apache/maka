---
name: api-versioning-deprecation-planner
description: Plans safe API evolution with versioning strategies, client migration guides, deprecation timelines, and backward compatibility considerations. Use for "API versioning", "deprecation planning", "API evolution", or "breaking changes".
---

# API Versioning & Deprecation Planner

Safely evolve APIs without breaking existing clients.

## Versioning Strategies

### URL Versioning (Recommended)

```
/api/v1/users
/api/v2/users
```

**Pros:** Clear, easy to route, simple to document
**Cons:** URL pollution with many versions

### Header Versioning

```
GET /api/users
Accept: application/vnd.api.v1+json
```

**Pros:** Clean URLs
**Cons:** Harder to test, less visible

### Query Parameter

```
/api/users?version=1
```

**Pros:** Easy to implement
**Cons:** Not RESTful, easy to forget

## Deprecation Timeline

```markdown
# API Deprecation Plan: v1 → v2

## Timeline (6 months)

### Month 1: Announcement

- [ ] Publish deprecation notice in changelog
- [ ] Email all API consumers
- [ ] Add deprecation headers to v1 responses
- [ ] Update documentation with migration guide

### Month 2-4: Migration Period

- [ ] v2 fully available
- [ ] Both v1 and v2 supported
- [ ] Track v1 usage metrics
- [ ] Offer migration support

### Month 5: Final Warning

- [ ] Email reminder to remaining v1 users
- [ ] Increase deprecation warning visibility
- [ ] Offer 1-on-1 migration help

### Month 6: Sunset

- [ ] Disable v1 endpoints
- [ ] Return 410 Gone with migration instructions
- [ ] Monitor for issues
```

## Deprecation Response Headers

```http
HTTP/1.1 200 OK
Deprecation: true
Sunset: Sat, 31 Dec 2024 23:59:59 GMT
Link: <https://api.example.com/v2/users>; rel="alternate"
Warning: 299 - "This API version is deprecated. Migrate to v2 by Dec 31, 2024"
```

## Breaking vs Non-Breaking Changes

### Non-Breaking (Safe)

✅ Adding new endpoints
✅ Adding optional request parameters
✅ Adding fields to responses
✅ Adding new response status codes
✅ Making required fields optional

### Breaking (Requires New Version)

❌ Removing endpoints
❌ Removing request parameters
❌ Removing response fields
❌ Changing field types
❌ Making optional fields required
❌ Changing authentication

## Migration Guide Template

```markdown
# Migration Guide: API v1 → v2

## What's Changing

### Authentication

**v1:** API Key in query param
```

GET /api/v1/users?api_key=xxx

```

**v2:** Bearer token in header
```

GET /api/v2/users
Authorization: Bearer xxx

````

### Response Format
**v1:** Snake case
```json
{"user_id": 123, "first_name": "John"}
````

**v2:** Camel case

```json
{ "userId": 123, "firstName": "John" }
```

### Pagination

**v1:** Page-based

```
GET /api/v1/users?page=2&per_page=10
```

**v2:** Cursor-based

```
GET /api/v2/users?cursor=abc123&limit=10
```

## Step-by-Step Migration

### Step 1: Update Authentication

Replace query param auth with header-based:

```diff
- axios.get('/api/v1/users?api_key=xxx')
+ axios.get('/api/v2/users', {
+   headers: { 'Authorization': 'Bearer xxx' }
+ })
```

### Step 2: Update Response Handling

Adjust field name casing:

```diff
- const userId = data.user_id
+ const userId = data.userId
```

### Step 3: Update Pagination

Switch to cursor-based:

```diff
- const nextPage = page + 1
- fetch(`/api/v1/users?page=${nextPage}`)
+ const cursor = data.meta.next_cursor
+ fetch(`/api/v2/users?cursor=${cursor}`)
```

## Testing Your Migration

```bash
# 1. Test v2 in development
curl -H "Authorization: Bearer xxx" https://dev-api.example.com/v2/users

# 2. Run v1 and v2 side-by-side in staging
# Compare responses for consistency

# 3. Gradual rollout in production
# Route 10% → 50% → 100% traffic to v2
```

## Support Resources

- [API v2 Documentation](https://docs.example.com/v2)
- [Migration Examples Repo](https://github.com/example/v2-examples)
- [Support Channel](https://slack.example.com)

````

## Backward Compatibility Strategies

### 1. Parallel Versions
Run v1 and v2 simultaneously:
```typescript
app.use('/api/v1', v1Router);
app.use('/api/v2', v2Router);
````

### 2. Adapter Pattern

v1 calls v2 internally with adapter:

```typescript
// v1 endpoint
router.get("/api/v1/users", async (req, res) => {
  // Call v2
  const v2Response = await v2Controller.getUsers(req);

  // Adapt v2 response to v1 format
  const v1Response = adaptV2ToV1(v2Response);

  res.json(v1Response);
});
```

### 3. Feature Flags

Gradual feature rollout:

```typescript
if (req.version === "v2" && featureFlags.newPagination) {
  return cursorBasedPagination(req);
} else {
  return pageBasedPagination(req);
}
```

## Client Communication Plan

### Announcement Email Template

```
Subject: [ACTION REQUIRED] API v1 Deprecation - Migrate by Dec 31

Hi API Consumers,

We're deprecating API v1 on December 31, 2024. Please migrate to v2.

What's changing:
- Authentication: API keys → Bearer tokens
- Response format: snake_case → camelCase
- Pagination: page-based → cursor-based

Migration resources:
- Guide: https://docs.example.com/migration
- Examples: https://github.com/example/v2-examples
- Support: api-support@example.com

Timeline:
- Now: v2 available, v1 still works
- Oct 31: v1 will show deprecation warnings
- Dec 31: v1 will be shut down

Questions? Reply to this email.
```

## Monitoring Migration Progress

```typescript
// Track version usage
app.use((req, res, next) => {
  const version = req.path.includes('/v1') ? 'v1' : 'v2';
  metrics.increment('api.requests', { version });
  next();
});

// Dashboard metrics
- v1 requests/day: 10,000 → 5,000 → 1,000 → 0
- v2 requests/day: 0 → 5,000 → 9,000 → 10,000
- Unique v1 consumers: 50 → 25 → 5 → 0
```

## Rollback Plan

```markdown
## If Migration Goes Wrong

### Symptoms

- Spike in 5xx errors
- Client complaints
- Revenue impact

### Rollback Steps

1. Re-enable v1 endpoints
2. Update deprecation timeline
3. Communicate delay to clients
4. Fix issues in v2
5. Resume migration when stable
```

## Best Practices

1. **Announce early**: 6+ months notice
2. **Provide tools**: SDKs, migration scripts
3. **Support clients**: 1-on-1 help if needed
4. **Monitor usage**: Track who's still on v1
5. **Gradual sunset**: Don't surprise users
6. **Clear docs**: Step-by-step guides
7. **Offer grace period**: Extensions for large clients

## Output Checklist

- [ ] Versioning strategy chosen
- [ ] Deprecation timeline (6+ months)
- [ ] Migration guide written
- [ ] Breaking changes documented
- [ ] Backward compatibility plan
- [ ] Client communication drafted
- [ ] Monitoring dashboard setup
- [ ] Rollback plan documented
- [ ] Support resources prepared
