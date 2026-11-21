--- 
inclusion: always 
---

# SaaS Architecture Principles

## Multi-Tenancy First
- Every data model MUST include tenant isolation (tenant_id prefix in all keys)
- Prefix all entity keys with tenant: `pk: ${tenantId}#${entityType}#${id}`
- Use separate tables per entity type, not single-table design
- Never allow cross-tenant data access - validate tenant context on every operation
- Tenant ID comes from Lambda authorizer JWT claims, never from request body
- Design for tenant-level feature flags and configuration overrides
- Plan for tenant-specific rate limits and quotas from day one

## Cost-Per-Tenant Economics
- Serverless-first: AWS Lambda, API Gateway, DynamoDB (on-demand), S3
- Zero cost when idle - pay only for active tenant usage
- Design for horizontal scaling: more tenants = same per-tenant cost
- Avoid shared resources that don't scale linearly (RDS, fixed-size caches)
- Use DynamoDB on-demand pricing until predictable traffic patterns emerge
- Monitor cost per tenant to identify pricing model opportunities

## Authentication & Authorization
- Use managed auth: AWS Cognito or Auth0 (never roll your own)
- JWT tokens with tenant claims and user roles embedded
- Lambda authorizer validates tokens and injects tenant context + user roles
- EVERY Lambda function MUST check user roles before performing operations
- Role-based access control (RBAC) within tenants - check permissions at function entry
- Never assume authorization - explicitly verify user has required role/permission
- Support SSO/SAML for enterprise tenants
- API keys for programmatic access with tenant scoping

## Data Isolation & Compliance
- Logical isolation via tenant_id (pool model) for cost efficiency
- Physical isolation (separate tables/databases) only for enterprise tier
- Encrypt at rest (DynamoDB encryption) and in transit (TLS)
- Design for data residency requirements (multi-region support)
- Audit logging per tenant for compliance (CloudTrail, custom audit tables)
- Support tenant data export and deletion (GDPR, right to be forgotten)

## Subscription & Billing Integration
- Design features with usage metering from the start
- Track billable events: API calls, storage, compute time, seats
- Use EventBridge to publish usage events to billing system
- Support multiple pricing tiers with feature gating
- Plan for trial periods, freemium, and usage-based pricing
- Graceful degradation when tenant exceeds quota or payment fails

## Operational Excellence
- Tenant-aware monitoring: CloudWatch metrics tagged by tenant_id
- Isolate noisy neighbors: per-tenant rate limiting and circuit breakers
- Feature flags for gradual rollout and A/B testing
- Zero-downtime deployments with blue/green or canary
- Tenant-specific health checks and status pages
- Support tenant impersonation for debugging (with audit trail)

## Scalability Patterns
- Stateless services: no session affinity required
- Async processing for heavy workloads (SQS, Step Functions)
- Cache tenant config in Lambda memory (refresh on cold start)
- Design for 10x growth: what breaks at 100 tenants? 1000? 10000?
- Use DynamoDB GSIs for tenant-specific queries
- Avoid fan-out queries across all tenants

## Testing Strategy
- Backend: Unit tests for business logic, integration tests for tenant isolation
- Test cross-tenant data leakage scenarios explicitly
- Load test with realistic multi-tenant traffic patterns
- Frontend: Manual testing preferred, focus on tenant-specific UI variations

## Dependency Management
- Minimize third-party libraries - prefer AWS SDKs and built-in language features
- Pin versions to avoid breakages
- Prefer AWS-managed services over self-hosted alternatives
- Evaluate libraries for multi-tenant safety (no global state)
