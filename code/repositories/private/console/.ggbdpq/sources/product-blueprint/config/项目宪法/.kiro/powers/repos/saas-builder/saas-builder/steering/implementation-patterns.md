---
inclusion: always
---

# Implementation Patterns

## Frontend Stack
- React with TypeScript (strict mode)
- Tailwind CSS for styling
- Functional components with hooks only

## API Design

### RESTful Conventions
- Use plural nouns for collections: `/api/v1/users`, `/api/v1/users/{id}`
- HTTP methods: GET (retrieve), POST (create), PUT/PATCH (update), DELETE (delete)
- Version APIs: `/v1/`, `/v2/`
- Avoid RPC-style endpoints like `/doEverything`
- Use query parameters for filtering, not custom endpoints

### Request/Response Models
- Define schemas in `schema/` (language-agnostic format preferred)
- Validate at API boundary with appropriate validation library
- Success: Return JSON object or array
- Error: `{ "error": { "code": "...", "message": "..." } }`
- Never expose internal database fields directly
- Document with OpenAPI specification

### Error Handling
- Use proper HTTP status codes:
  - 400: Client input errors
  - 401/403: Auth errors
  - 404: Not found
  - 500: Server errors
- Log errors internally (CloudWatch), return friendly messages to clients
- Implement global exception handlers
- Never leak stack traces or raw exceptions

### Authentication & Authorization
- Require auth on all endpoints (except rare public ones)
- Use JWTs or OAuth tokens (Auth0, AWS Cognito)
- Verify tokens in Lambda authorizer
- Lambda authorizer injects tenant ID and user roles into request context
- Use scopes/roles for sensitive operations
- Enforce tenant context for data segregation
- Never rely on client-side auth checks
- Never accept tenant ID from request body - only from authorizer

### Pagination & Filtering
- Enforce pagination for large lists
- Use `?page=` and `?pageSize=` or cursor-based `?nextToken=`
- Provide filters: `/orders?status=pending&created_after=2024-01-01`
- Refuse to return extremely large payloads
- All queries automatically scoped to tenant (no cross-tenant results)

### Rate Limiting
- Use API Gateway throttling quotas per tenant
- Document limits to users
- Protect expensive operations with application-level limits
- Degrade gracefully under load
- Consider per-tenant rate limits based on subscription tier

### Usage Tracking & Metering
- Track billable events at API boundary
- Publish usage events to EventBridge for billing system
- Include tenant ID, user ID, operation type, timestamp
- Check tenant quota before expensive operations
- Return 429 (Too Many Requests) when quota exceeded

## AWS Patterns

### DynamoDB
- Composite keys: `pk: ${tenantId}#${entityType}#${id}`, `sk: metadata | #{relationType}#${relatedId}`
- GSI for queries: `GSI1PK: ${tenantId}`, `GSI1SK: ${entityType}#${timestamp}`
- Always prefix keys with tenant ID for isolation
- Design access patterns upfront to minimize queries
- Use appropriate SDK for your backend language

### Lambda Functions
- Multi-Tenant Pattern
Every Lambda function should follow this pattern:

1. **Extract tenant context** from authorizer claims (injected by Lambda authorizer)
2. **Extract user roles** from authorizer claims
3. **Validate required parameters** at function entry
4. **Check user roles/permissions** before performing operations (RBAC)
5. **Prefix all database operations** with tenant ID
6. **Return proper HTTP status codes** (403 for unauthorized, etc.)
7. **Log errors with tenant context** for debugging
8. **Never trust tenant ID from request body** - only from authorizer

Example flow:
```
handler(event) {
  tenantId = event.requestContext.authorizer.tenantId
  userRoles = event.requestContext.authorizer.roles
  
  if (!hasRequiredRole(userRoles, 'admin')) {
    return 403 Forbidden
  }
  
  // All DB queries use tenantId prefix
  result = db.get(pk: `${tenantId}#User#${userId}`)
  
  return 200 OK
}
```

### Environment Configuration
- Use environment variables for runtime config
- Use AWS Secrets Manager for sensitive values
- Never hard-code credentials or secrets

## Frontend Code Style (React + TypeScript)

### React Components
- Functional components with hooks only
- Keep under 100 lines when possible
- TypeScript interfaces for props (strict mode)
- Prefer local state over global state
- Use Tailwind utility classes
- Mobile-first responsive design

### Naming Conventions
- Components: PascalCase (`UserProfile.tsx`)
- Hooks: camelCase with `use` prefix (`useAuth.ts`)
- Files: Match component name

### Multi-Tenant Frontend Patterns
- Store tenant context in React Context or auth state
- Include tenant ID in all API requests (from auth token)
- Handle tenant-specific branding/theming
- Support feature flags for tenant-specific features
- Display tenant-scoped data only
- Handle quota exceeded errors gracefully (show upgrade prompts)

### Frontend Best Practices
- Descriptive variable names (self-documenting)
- Proper error handling with try-catch
- Avoid comments - code should be self-documenting
- Only comment complex logic when necessary

## Backend Code Style (Language-Agnostic)

### General Principles
- Descriptive variable and function names
- Proper error handling
- Structured logging (errors only, with context)
- Consistent terminology across codebase
- Follow language-specific conventions (PEP8 for Python, etc.)

### Libraries & Dependencies
- Minimize third-party libraries
- Prefer AWS SDKs and built-in language features
- Pin versions to avoid breakages
- Use libraries packaged in Lambda runtime when possible
