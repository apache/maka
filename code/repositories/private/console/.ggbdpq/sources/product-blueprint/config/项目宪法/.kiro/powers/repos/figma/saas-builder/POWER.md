---
name: "saas-builder"
displayName: "SaaS Builder"
description: "Build production-ready multi-tenant SaaS applications with serverless architecture, integrated billing, and enterprise-grade security"
keywords: ["saas", "multi-tenant", "serverless", "aws", "lambda", "dynamodb", "stripe", "billing", "react", "typescript"]
author: "Allen Helton"
---

# SaaS Builder Power

Build production-ready multi-tenant SaaS applications with serverless architecture, integrated billing, and enterprise-grade security.

## Overview

The SaaS Builder power provides tools and patterns for building scalable, cost-efficient SaaS applications on AWS. It combines serverless infrastructure, multi-tenant data isolation, subscription management, and usage-based billing into a cohesive development framework.

## Core Capabilities

- **Multi-tenant architecture** with tenant isolation at the data layer
- **Serverless-first** infrastructure (Lambda, API Gateway, DynamoDB)
- **Integrated billing** with Stripe and usage metering
- **Authentication & authorization** with JWT and RBAC
- **Cost-per-tenant economics** with zero idle costs
- **React + TypeScript** frontend with Tailwind CSS

## MCP Servers

- **fetch**: HTTP requests for external API integration
- **stripe**: Payment processing and subscription management (disabled by default)
- **aws-knowledge-mcp-server**: AWS documentation and best practices
- **awslabs.dynamodb-mcp-server**: DynamoDB operations with tenant isolation
- **awslabs.aws-serverless-mcp**: Serverless application deployment
- **playwright**: Browser automation for testing (disabled by default)

## Architecture Principles

### Multi-Tenancy
- Tenant ID prefix in all database keys: `${tenantId}#${entityType}#${id}`
- Lambda authorizer injects tenant context from JWT
- No cross-tenant data access
- Tenant-specific feature flags and quotas

### Cost Optimization
- Pay-per-use serverless components
- DynamoDB on-demand pricing
- Zero cost when idle
- Linear scaling economics

### Security
- Managed authentication (Cognito/Auth0)
- JWT tokens with tenant claims
- Role-based access control (RBAC)
- Encryption at rest and in transit

## Repository Structure

```
/
├── frontend/          # React + TypeScript + Tailwind
├── backend/           # Lambda functions
│   ├── functions/     # API handlers
│   │   ├── authorizer/
│   │   ├── api/
│   │   └── billing/
│   ├── lib/           # Business logic
│   └── infrastructure/ # IaC (CDK/SAM)
├── schema/            # API contracts (OpenAPI)
└── .kiro/             # Kiro configuration
```

## Billing & Payments

### Money Handling
- Integer cents only (never floats)
- Store: `amount_cents: 1999` (represents $19.99)
- Currency code with every amount

### Payment Integration
- Stripe for payment processing
- Webhook verification and idempotency
- Subscription lifecycle management
- Usage-based metering with EventBridge

### Subscription States
- `trial`, `active`, `past_due`, `canceled`, `expired`
- Grace periods for payment failures
- Prorated plan changes

## Implementation Patterns

### API Design
- RESTful conventions: `/api/v1/users`, `/api/v1/users/{id}`
- Versioned endpoints
- OpenAPI specification
- Proper HTTP status codes

### Lambda Functions
Every function follows this pattern:
1. Extract tenant context from authorizer
2. Extract user roles from authorizer
3. Validate parameters
4. Check permissions (RBAC)
5. Prefix database operations with tenant ID
6. Return proper status codes
7. Log with tenant context

### DynamoDB
- Composite keys: `pk: ${tenantId}#${entityType}#${id}`
- GSI for queries: `GSI1PK: ${tenantId}`, `GSI1SK: ${entityType}#${timestamp}`
- Tenant-scoped queries only

### Frontend
- Functional React components with hooks
- TypeScript strict mode
- Tailwind utility classes
- Tenant context in React Context
- Feature flags for tenant-specific UI

## Getting Started

1. Configure AWS credentials and region in `mcp.json`
2. Enable Stripe integration if using payments
3. Review steering files for detailed patterns
4. Use OpenAPI schema as source of truth
5. Implement Lambda authorizer first
6. Build tenant-aware API endpoints
7. Add usage metering for billable operations

## Configuration

Edit `saas-builder/mcp.json` to:
- Set AWS profile and region for serverless deployment
- Enable Stripe integration (update `disabled: false`)
- Enable Playwright for browser testing
- Configure auto-approve for trusted tools

## Best Practices

- Never use floats for money calculations
- Always validate tenant context
- Check user roles before operations
- Prefix all keys with tenant ID
- Use idempotency keys for payments
- Verify webhook signatures
- Implement rate limiting per tenant
- Monitor cost per tenant
- Test cross-tenant isolation
- Design for 10x growth

## Testing

- Unit tests for business logic
- Integration tests for tenant isolation
- Test cross-tenant data leakage
- Use Stripe test mode
- Test webhook delivery failures
- Load test with multi-tenant traffic

## Compliance

- PCI compliance via Stripe (never store cards)
- GDPR support (data export/deletion)
- Audit logging per tenant
- Data residency support
- Encryption at rest and in transit
