---
inclusion: always
---

# Repository Structure

## Root Layout

```
/
├── frontend/          # React + TypeScript + Tailwind
├── backend/           # Serverless functions (language-agnostic)
├── schema/            # Shared API contracts and types
├── .kiro/             # Kiro configuration
└── README.md          # Project documentation
```

## frontend/

React + TypeScript + Tailwind CSS application (Vite or Next.js)

```
frontend/
├── src/
│   ├── features/          # Feature-oriented structure (e.g., billing/, auth/)
│   ├── components/        # Shared UI components
│   ├── hooks/             # Custom React hooks
│   ├── utils/             # Helper functions
│   └── styles/            # Tailwind config and global CSS
```

### Conventions
- PascalCase for components: `UserProfile.tsx`
- camelCase for hooks: `useAuth.ts`, `useTenant.ts`
- Import types from `schema/` - never duplicate
- Store API URLs in `.env` files - never commit secrets
- Feature-oriented structure: group by domain (e.g., `features/billing/`, `features/tenants/`)
- Tenant context available via React Context or auth state

## backend/

Serverless functions (language-agnostic: Python, Node.js, Go, Java, etc.)

```
backend/
├── functions/         # Lambda function handlers
│   ├── authorizer/    # Lambda authorizer (validates JWT, injects tenant context)
│   ├── api/           # API endpoint handlers
│   ├── billing/       # Usage tracking and metering functions
│   └── admin/         # Tenant management functions
├── lib/               # Business logic modules (or services/)
│   ├── auth/          # RBAC and permission checks
│   ├── tenants/       # Tenant isolation logic
│   └── usage/         # Usage metering utilities
├── db/                # Data access layer (tenant-aware queries)
└── infrastructure/    # IaC (CDK, SAM, Terraform)
    ├── api.yaml       # API Gateway definition
    ├── database.yaml  # DynamoDB tables
    └── auth.yaml      # Cognito/Auth0 config
```

### Conventions
- Follow language-specific conventions (PEP8 for Python, etc.)
- Import schemas from `schema/` for validation
- Keep handlers thin - business logic in `lib/` or `services/`
- Stateless design - no global state
- Consistent naming with frontend (e.g., both use "Order", not "Order" vs "Purchase")
- All functions extract tenant context from authorizer claims
- All database operations prefixed with tenant ID

## schema/

Shared API contracts and types (language-agnostic)

```
schema/
├── openapi.yaml       # API specification (primary source of truth)
├── types/             # Generated or shared types
│   ├── User.ts        # TypeScript types for frontend
│   ├── Tenant.ts
│   └── Subscription.ts
└── events/            # Event schemas for EventBridge
    └── usage-events.json
```

### Conventions
- Use OpenAPI spec as single source of truth
- Generate language-specific types from OpenAPI (TypeScript for frontend, etc.)
- No business logic - only structure
- Include tenant-related models (Tenant, Subscription, Usage)
- Keep in sync with API implementation

## Monorepo Setup (Optional)

If using TypeScript/Node.js for backend, use Yarn Workspaces or PNPM:

```json
{
  "workspaces": ["frontend", "backend", "schema"]
}
```

For other backend languages, schema sharing happens via:
- OpenAPI spec generation/consumption
- Shared proto files (gRPC)
- Code generation tools

## Key Principles

- Clean separation: frontend (UI), backend (logic), schema (contracts)
- No duplication: API contracts defined once in `schema/`
- Consistent naming across all layers
- Multi-tenant by default: organize code by tenant-aware patterns
- Optimize for low cost: static frontend, serverless backend
- Use local emulators (DynamoDB Local, LocalStack) for development

## SaaS-Specific Organization

### Tenant Management
- Authorizer function validates JWT and injects tenant context
- Tenant CRUD operations in `backend/functions/admin/`
- Tenant configuration cached in Lambda memory

### Billing & Usage
- Usage tracking functions in `backend/functions/billing/`
- EventBridge events for metering in `schema/events/`
- Quota enforcement at API Gateway and function level

### Feature Flags
- Tenant-specific feature flags stored in DynamoDB
- Checked at API boundary or in business logic
- Frontend consumes feature flags from API
