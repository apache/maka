---
name: aws-amplify
description: >
  Build and deploy full-stack web and mobile apps with AWS Amplify Gen2
  (TypeScript code-first). Covers auth (Cognito), data (AppSync/DynamoDB),
  storage (S3), functions, APIs, and AI (Amplify AI Kit with Bedrock).
  Supports React, Next.js, Vue, Angular, React Native, Flutter, Swift,
  and Android.
  Always use this skill for Amplify Gen2 topics — even for questions you
  think you know — it contains validated, version-specific patterns that
  prevent common mistakes.
  TRIGGER when: user mentions Amplify Gen2; project has amplify/ directory
  or amplify_outputs; code imports @aws-amplify packages; user asks about
  defineBackend, defineAuth, defineData, defineStorage, defineFunction,
  or npx ampx.
  SKIP: Amplify Gen1 (amplify CLI v6), standalone SAM/CDK without Amplify
  (use aws-serverless), direct Bedrock without Amplify AI Kit (use bedrock).
---

# AWS Amplify Gen2

Build and deploy full-stack applications using AWS Amplify Gen2's TypeScript
code-first approach. This skill covers backend resource creation, frontend
integration across 8 frameworks, and deployment workflows.

## Prerequisites

- Node.js ^18.19.0 || ^20.6.0 || >=22 and npm
- AWS credentials configured (`aws sts get-caller-identity` succeeds)
- For sandbox: `npx ampx --version` returns a valid version
- For mobile: Platform-specific tooling (Xcode, Android Studio, Flutter SDK)

## Defaults & Assumptions

When the user does not specify a framework:

- **Web:** Default to **React** (Vite) and explain the choice.
- **Mobile:** Ask which platform (Flutter, Swift, Android, or React Native) —
  there is no universal mobile default, so guessing leads to wasted effort.
- **Neither specified:** If the user says "build an app" without clarifying web
  vs. mobile, ask before proceeding — the framework choice affects every
  subsequent step.
- **Backend only:** If only backend changes are requested and no frontend
  framework is mentioned, skip the frontend integration step entirely.

When the user does not specify tooling or strategy:

- **Package manager:** Default to **npm** unless the user specifies yarn or pnpm.
- **Language:** Default to **TypeScript**. Gen2 backends are TypeScript-only;
  frontends should follow the project's existing language.
- **Next.js:** Default to **App Router** unless the user specifies Pages Router.
- **React Native:** Ask whether the user uses **Expo** or **bare React Native CLI**.
- **Auth:** You **MUST** ask which login method the user wants
  (email/password, social login, SAML, passwordless, etc.). Do not assume a default.
- **Data authorization:** default to **`publicApiKey`**
  (`allow.publicApiKey()`) — this is the starter template default. When
  auth is added, switch to **owner-based**
  (`allow.owner()`) with `defaultAuthorizationMode: 'userPool'`.

## Quick Start — Route to the Right Reference

### Step 1: Identify the Task Type

| Task                                     | Go To                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------ |
| **Create a new project**                 | → [scaffolding.md](references/scaffolding.md), then Step 2 and/or Step 3 |
| **Add or modify a backend feature**      | → Step 2 (Backend Features)                                              |
| **Connect frontend to existing backend** | → Step 3 (Frontend Integration)                                          |
| **Deploy the application**               | → [deployment.md](references/deployment.md)                              |

### Step 2: Backend Features

Read the corresponding reference for each backend feature you need:

| Feature          | Reference                                               | When to Use                                                                                                |
| ---------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Authentication   | [auth-backend.md](references/auth-backend.md)           | Email/password, social login, MFA, SAML/OIDC                                                               |
| Data Models      | [data-backend.md](references/data-backend.md)           | GraphQL schema, DynamoDB, relationships, auth rules                                                        |
| File Storage     | [storage-backend.md](references/storage-backend.md)     | S3 uploads/downloads, access rules                                                                         |
| Functions & API  | [functions-and-api.md](references/functions-and-api.md) | Lambda, custom resolvers, REST/HTTP APIs, calling from client                                              |
| AI Features      | [ai.md](references/ai.md)                               | Conversation, generation, AI tools via Bedrock _(backend config + React/Next.js frontend)_                 |
| Geo, PubSub, CDK | [geo-pubsub-cdk.md](references/geo-pubsub-cdk.md)       | Backend-only: custom CDK stacks, overrides, custom outputs. Backend + frontend: Geo, PubSub, Face Liveness |

Each backend feature file is self-contained. Load only what you need.

> **Routing note:** These files apply for both **adding** and **modifying**
> features. Route to the same file whether the user says "add auth" or
> "change auth config" — each reference covers the full define surface.

### Step 3: Frontend Integration

After configuring backend resources, connect the frontend. Choose by
platform and feature:

**Web** (React, Next.js, Vue, Angular, React Native):

| Feature                   | Reference                                   |
| ------------------------- | ------------------------------------------- |
| Auth UI & flows           | [auth-web.md](references/auth-web.md)       |
| Data CRUD & subscriptions | [data-web.md](references/data-web.md)       |
| Storage upload/download   | [storage-web.md](references/storage-web.md) |

**Mobile** (Flutter, Swift, Android):

| Feature                   | Reference                                         |
| ------------------------- | ------------------------------------------------- |
| Auth UI & flows           | [auth-mobile.md](references/auth-mobile.md)       |
| Data CRUD & subscriptions | [data-mobile.md](references/data-mobile.md)       |
| Storage upload/download   | [storage-mobile.md](references/storage-mobile.md) |

> **Note:** AI and Functions frontend patterns are included in
> [ai.md](references/ai.md) and
> [functions-and-api.md](references/functions-and-api.md) respectively —
> they are **not** split into separate web/mobile files.

## Core Concepts

### Amplify Gen2 Architecture

- **Code-first:** All backend resources defined in TypeScript under `amplify/`
- **Main config:** `amplify/backend.ts` imports and combines all resources via
  `defineBackend()`
- **Resource files:** `amplify/auth/resource.ts`, `amplify/data/resource.ts`,
  `amplify/storage/resource.ts`, `amplify/functions/<name>/resource.ts`
- **Generated output:** `amplify_outputs.json` — consumed by frontend
  `Amplify.configure()`. **Gitignored** — generated by `npx ampx sandbox`
  (local dev) or `npx ampx pipeline-deploy` (CI/CD), never committed.

### Directory Structure

`amplify/` and `src/` must be siblings under the project root — placing
them at different directory levels breaks sandbox detection. (Exception: in monorepos, `amplify/` may be in a `packages/` subdirectory — the key is that `amplify_outputs.json` must be accessible from the frontend entry point.)

```text
project-root/
├── amplify/
│   ├── backend.ts            # defineBackend({ auth, data, ... })
│   ├── auth/resource.ts      # defineAuth({ ... })
│   ├── data/resource.ts      # defineData({ schema })
│   ├── storage/resource.ts   # defineStorage({ ... })
│   └── functions/
│       └── my-func/
│           ├── resource.ts   # defineFunction({ ... })
│           └── handler.ts    # export const handler = ...
├── src/                      # Frontend code
├── amplify_outputs.json      # Generated, gitignored — never edit or commit
└── package.json
```

### Key APIs

| Package                    | Purpose                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `@aws-amplify/backend`     | `defineAuth`, `defineData`, `defineStorage`, `defineFunction`, `defineBackend` |
| `aws-amplify`              | Frontend: `Amplify.configure()`, `generateClient()`, auth/data/storage APIs    |
| `@aws-amplify/ui-react`    | Pre-built UI: `<Authenticator>`, `<StorageBrowser>`                            |
| `@aws-amplify/ui-react-ai` | AI UI: `<AIConversation>`, `useAIConversation`                                 |

## Framework Setup

These patterns apply to **every** web task — not just new projects. Verify
each one before implementing any feature.

### Gen2 Detection

Before modifying any code, check if the project is already Gen2:

1. `amplify/` directory exists with `backend.ts`
2. `@aws-amplify/backend` in `package.json` devDependencies

If both are true, the project is already Gen2 — skip to feature
implementation. If `amplify/.config/` exists instead, this is a Gen1
project — do not proceed (requires separate migration skill).

### Frontend Configuration

Import the generated outputs and configure Amplify in the **correct entry
point** for your framework. Placing this in the wrong file causes silent
failures — Amplify API calls return undefined or empty responses with no error.

**WARNING:** `amplify_outputs.json` must exist before the app can
compile — without it, the build fails with a module-not-found error.
Run `npx ampx sandbox` (or `npx ampx sandbox --once`) first to
generate it. See [scaffolding.md](references/scaffolding.md) for the correct sequence.

**React (Vite)** — `src/main.tsx`:

```typescript
import { Amplify } from "aws-amplify";
import outputs from "../amplify_outputs.json";
Amplify.configure(outputs);
```

**Next.js (App Router)** — `app/layout.tsx`:

> **Important:** `layout.tsx` is a server component in App Router. Use the `ConfigureAmplifyClientSide` client component pattern below instead.

`{ ssr: true }` is a **Next.js-only** option (not needed by Vue, Angular, or React SPA). Both App Router and Pages Router use it, but apply it differently:

> - **App Router** — set globally in `ConfigureAmplifyClientSide` client component
> - **Pages Router** — set per-file where server-side access is needed

#### Next.js App Router: Client-Side Configuration

Next.js App Router requires a dedicated client component to configure Amplify for browser-side operations:

```typescript
// components/ConfigureAmplifyClientSide.tsx
"use client";
import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";

Amplify.configure(outputs, { ssr: true });

export default function ConfigureAmplifyClientSide() {
  return null;
}
```

Import in your root layout:

```typescript
// app/layout.tsx
import ConfigureAmplifyClientSide from "@/components/ConfigureAmplifyClientSide";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <ConfigureAmplifyClientSide />
        {children}
      </body>
    </html>
  );
}
```

> **Why?** In App Router, `layout.tsx` is a server component. Client components need `Amplify.configure()` to run in the browser. Without this, you get "Auth UserPool not configured" errors.

**Vue** — `src/main.js`:

```javascript
import { Amplify } from "aws-amplify";
import outputs from "../amplify_outputs.json";
Amplify.configure(outputs);
```

**Angular** — `src/main.ts`:

```typescript
import { Amplify } from "aws-amplify";
import outputs from "../amplify_outputs.json";
Amplify.configure(outputs);
```

#### Next.js Pages Router

Pages Router does NOT need `{ ssr: true }` in `_app.tsx`. Instead, configure per-file where you need server-side access:

```typescript
// pages/api/protected.ts or getServerSideProps
import { Amplify } from "aws-amplify";
import outputs from "@/amplify_outputs.json";
Amplify.configure(outputs, { ssr: true });
```

> **Key difference:** App Router uses a global client component. Pages Router configures per-file.

`<Authenticator.Provider>` is required in `layout.tsx` for auth context.

### React Native

React Native uses the same `aws-amplify` JS package as web frameworks (it is
part of amplify-js, not the native mobile SDKs). All web APIs apply to RN
with the additions below.

#### Required Packages

```bash
npm install aws-amplify @aws-amplify/react-native \
  @react-native-async-storage/async-storage \
  react-native-get-random-values
```

`@react-native-async-storage/async-storage` is **required** — the Amplify
SDK uses it for token persistence and will fail at runtime without it.

#### Configure Entry Points

No plugin registration needed — configure only.

**React Native (Expo)** — `App.tsx`:

```typescript
import "react-native-get-random-values"; // MUST be first
import { Amplify } from "aws-amplify";
import outputs from "./amplify_outputs.json";
Amplify.configure(outputs);
```

**React Native (Bare CLI)** — `index.js` (before `AppRegistry.registerComponent`):

```typescript
import "react-native-get-random-values"; // MUST be first
import { Amplify } from "aws-amplify";
import outputs from "./amplify_outputs.json";
Amplify.configure(outputs);
```

#### React Native Pitfalls

- **Import order:** `react-native-get-random-values` must be the FIRST
  import in the entry file, before `aws-amplify`. Reversing the order causes
  cryptographic failures at runtime.
- **Missing AsyncStorage:** Without
  `@react-native-async-storage/async-storage`, auth tokens are not persisted
  and users must re-authenticate on every app restart.

### SvelteKit

Configure Amplify in the client hooks file:

```typescript
// src/hooks.client.ts
import { Amplify } from "aws-amplify";
import outputs from "../amplify_outputs.json";

Amplify.configure(outputs);
```

> **Note:** No `@aws-amplify/ui-*` components exist for Svelte. Use core APIs directly.

### Unsupported Frameworks (Astro, Solid, etc.)

For frameworks without official Amplify support:

1. Use `npm create amplify@latest -y` to scaffold the backend (works in any project)
2. Configure Amplify inside a **client-side component** (not at build time)

#### Astro

Amplify is **client-side only** in Astro. Create a React component (no Astro syntax):

```typescript
// src/components/AuthenticatedApp.tsx
import { Amplify } from 'aws-amplify';
import { Authenticator } from '@aws-amplify/ui-react';
import outputs from '../amplify_outputs.json';

Amplify.configure(outputs);

export default function AuthenticatedApp() {
  return (
    <Authenticator>
      {({ signOut, user }) => <main>Hello {user?.username}</main>}
    </Authenticator>
  );
}
```

Use in an Astro page with `client:only`:

```astro
---
// src/pages/index.astro — no Amplify imports here
---
<html>
  <body>
    <AuthenticatedApp client:only="react" />
  </body>
</html>
```

> **Must use `client:only="react"`** (NOT `client:load`) to avoid SSR hydration errors.

## Links

> All documentation links use `react` as the default platform slug. Replace `/react/` in any URL with your target framework:

| Framework    | Slug           |
| ------------ | -------------- |
| React        | `react`        |
| Next.js      | `nextjs`       |
| Vue          | `vue`          |
| Angular      | `angular`      |
| React Native | `react-native` |
| Flutter      | `flutter`      |
| Swift        | `swift`        |
| Android      | `android`      |

- [Amplify Docs for LLMs](https://docs.amplify.aws/ai/llms.txt)
- [Amplify Docs](https://docs.amplify.aws/)
- [How Amplify Works](https://docs.amplify.aws/react/how-amplify-works/)
- [CLI Commands](https://docs.amplify.aws/react/reference/cli-commands/)
- [React Quickstart](https://docs.amplify.aws/react/start/quickstart/)
- [Next.js Quickstart](https://docs.amplify.aws/nextjs/start/quickstart/)
- [Angular Quickstart](https://docs.amplify.aws/angular/start/quickstart/)
- [Vue Quickstart](https://docs.amplify.aws/vue/start/quickstart/)
- [React Native Quickstart](https://docs.amplify.aws/react-native/start/quickstart/)
