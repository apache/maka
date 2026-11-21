---
name: aws-blocks
description: Guides building full-stack applications with AWS Blocks — an Infrastructure-from-Code framework. Applies when creating APIs, selecting Building Blocks (KVStore, DistributedTable, Database, AuthBasic, AuthCognito, Realtime, AsyncJob, FileBucket, etc.), running local development, or deploying AWS Blocks applications. Also covers AWS Blocks topics with validated, version-specific patterns that prevent common mistakes. Triggers when user mentions AWS Blocks; project has aws-blocks/ directory; code imports @aws-blocks packages.
---

# AWS Blocks Application Development

> **Package naming:** All packages are published under the `@aws-blocks` scope (e.g., `@aws-blocks/core`, `@aws-blocks/blocks`, `@aws-blocks/bb-kv-store`).

## Overview

AWS Blocks is an Infrastructure-from-Code framework where Building Blocks bundle CDK, SDK, and local mocks into a single API. It provides 18+ Building Blocks covering storage, authentication, real-time communication, background jobs, file management, AI/search, email, and observability — all working locally without AWS credentials.

**Key characteristics:**

- One `aws-blocks/` directory defines the entire backend
- Frontend imports are fully typed — no client generation needed
- All Building Blocks work locally without AWS (mocks persist to `.bb-data/`)
- Deploy ephemeral, individual testing environments with `npm run sandbox` and long-lived environments with `npm run deploy` using least-privilege credentials

## Scaffolding a New Project

```bash
npx @aws-blocks/create-blocks-app my-app
cd my-app
```

### To add AWS Blocks to an existing project:

```bash
npx @aws-blocks/create-blocks-app .
```

This detects the existing project and adds an `aws-blocks/` workspace alongside your code.

### To add AWS Blocks to an Amplify Gen 2 project:

```bash
npx @aws-blocks/create-blocks-app .
```

When the CLI detects `amplify/backend.ts`, it automatically integrates AWS Blocks with your Amplify backend.

### With a specific template:

```bash
npx @aws-blocks/create-blocks-app my-app --template demo
cd my-app
```

### Available Templates

| Template       | Description                                                                                                                                                                     |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `default`      | Vite + lit-html starter app with basic authentication, data persistence, and realtime to help demonstrate basic app architecture and patterns (used when --template is omitted) |
| `bare`         | Vite + lit-html starter with a single "hello world" API method and a bare frontend                                                                                              |
| `react`        | React + Vite starter with a single API endpoint and typed React frontend                                                                                                        |
| `backend`      | Backend-only — no frontend, just the AWS Blocks API with a single endpoint                                                                                                      |
| `demo`         | Todo app with AuthBasic, KVStore, DistributedTable, Zod schemas, indexes, and auth-protected CRUD                                                                               |
| `auth-cognito` | Full AuthCognito passwordless email-OTP with roles, device management, and Authenticator UI                                                                                     |
| `nextjs`       | Next.js + React starter with AWS Blocks backend integration (SSR + Server Components)                                                                                           |

## Development Workflow

After scaffolding, refer to **node_modules/@aws-blocks/blocks/README.md** for the complete development workflow including:

- Core concepts (Architecture, Building Block selection)
- Project structure and Scope organization
- Error handling patterns
- Schema validation
- Local development
- Best practices and common mistakes
- Deployment IAM role setup and security guidance

When implementing a specific Building Block, read its package README for the detailed API reference (e.g., `node_modules/@aws-blocks/bb-kv-store/README.md`). These are the authoritative docs for your installed version.

## Security Considerations

- Use `await auth.requireAuth(context)` in every method that shouldn't be public — ApiNamespace methods are **unauthenticated by default**
- Use `new AppSetting(scope, id, { secret: true })` for API keys and credentials — never hardcode or use `.env` files
- Always attach a schema to KVStore/AppSetting that accepts user data — the RPC layer validates structure but not business logic
- Do not add broad `*` IAM policies — each Building Block already grants least-privilege scoped to its own resources
- Never change `blockPublicAccess` on FileBucket — serve public files through CloudFront instead
- Configure `CORS_ALLOWED_ORIGINS` explicitly for production — avoid wildcards
- For cross-domain deployments, pass `crossDomain: true` to auth constructors (enables `SameSite=None; Secure; Partitioned`)
- Enable `monitoring: { enabled: true, snsTopicArn: '...' }` on Hosting for production alerts
- Add WAF and API Gateway throttling via CDK for public-facing apps — not included by default
- Logger provides serialization safety (circular refs, type coercion) but does NOT redact sensitive content — never pass raw credentials, tokens, or secrets to Logger methods; sanitize context objects before logging
