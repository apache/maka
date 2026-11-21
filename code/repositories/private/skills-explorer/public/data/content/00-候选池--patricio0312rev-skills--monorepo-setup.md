---
name: monorepo-setup
description: Sets up monorepo architecture with Turborepo, pnpm workspaces, shared packages, and optimized build pipelines. Use when users request "monorepo setup", "Turborepo", "pnpm workspaces", "shared packages", or "multi-package repository".
---

# Monorepo Setup

Configure a scalable monorepo with Turborepo and pnpm workspaces.

## Core Workflow

1. **Initialize structure**: Create workspace layout
2. **Configure pnpm**: Setup workspaces
3. **Add Turborepo**: Configure build pipeline
4. **Create shared packages**: Common utilities
5. **Setup apps**: Applications consuming packages
6. **Configure CI/CD**: Optimized builds

## Directory Structure

```
monorepo/
├── apps/
│   ├── web/                 # Next.js app
│   ├── api/                 # Express/Fastify API
│   └── mobile/              # React Native app
├── packages/
│   ├── ui/                  # Shared UI components
│   ├── config/              # Shared configs
│   ├── tsconfig/            # TypeScript configs
│   ├── eslint-config/       # ESLint configs
│   └── utils/               # Shared utilities
├── tooling/
│   ├── scripts/             # Build scripts
│   └── docker/              # Docker configs
├── turbo.json
├── pnpm-workspace.yaml
├── package.json
└── .npmrc
```

## Root Configuration

### pnpm Workspace

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"
  - "tooling/*"
```

### Root Package.json

```json
{
  "name": "monorepo",
  "private": true,
  "packageManager": "pnpm@8.15.0",
  "engines": {
    "node": ">=20.0.0",
    "pnpm": ">=8.0.0"
  },
  "scripts": {
    "build": "turbo run build",
    "dev": "turbo run dev",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "typecheck": "turbo run typecheck",
    "clean": "turbo run clean && rm -rf node_modules",
    "format": "prettier --write \"**/*.{ts,tsx,md,json}\"",
    "changeset": "changeset",
    "version-packages": "changeset version",
    "release": "turbo run build --filter=./packages/* && changeset publish"
  },
  "devDependencies": {
    "@changesets/cli": "^2.27.0",
    "prettier": "^3.2.0",
    "turbo": "^2.0.0",
    "typescript": "^5.3.0"
  }
}
```

### NPM Configuration

```ini
# .npmrc
auto-install-peers=true
strict-peer-dependencies=false
shamefully-hoist=true
node-linker=hoisted

# Private registry (optional)
# @company:registry=https://npm.company.com/
# //npm.company.com/:_authToken=${NPM_TOKEN}
```

## Turborepo Configuration

```json
// turbo.json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": ["**/.env.*local"],
  "globalEnv": ["NODE_ENV", "CI"],
  "pipeline": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**", ".next/**", "!.next/cache/**"],
      "env": ["DATABASE_URL", "API_URL"]
    },
    "dev": {
      "dependsOn": ["^build"],
      "cache": false,
      "persistent": true
    },
    "lint": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "typecheck": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "test": {
      "dependsOn": ["build"],
      "outputs": ["coverage/**"]
    },
    "clean": {
      "cache": false
    }
  }
}
```

## Shared TypeScript Config

```json
// packages/tsconfig/base.json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "display": "Default",
  "compilerOptions": {
    "composite": false,
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "inlineSources": false,
    "isolatedModules": true,
    "moduleResolution": "bundler",
    "noUnusedLocals": false,
    "noUnusedParameters": false,
    "preserveWatchOutput": true,
    "skipLibCheck": true,
    "strict": true,
    "strictNullChecks": true
  },
  "exclude": ["node_modules"]
}
```

```json
// packages/tsconfig/nextjs.json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "display": "Next.js",
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["dom", "dom.iterable", "ES2022"],
    "module": "ESNext",
    "target": "ES2022",
    "jsx": "preserve",
    "noEmit": true,
    "plugins": [{ "name": "next" }],
    "allowJs": true,
    "incremental": true,
    "resolveJsonModule": true
  }
}
```

```json
// packages/tsconfig/library.json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "display": "Library",
  "extends": "./base.json",
  "compilerOptions": {
    "lib": ["ES2022"],
    "module": "ESNext",
    "target": "ES2022",
    "outDir": "dist",
    "rootDir": "src"
  }
}
```

## Shared UI Package

```json
// packages/ui/package.json
{
  "name": "@repo/ui",
  "version": "0.0.0",
  "private": true,
  "exports": {
    ".": "./src/index.ts",
    "./button": "./src/button.tsx",
    "./card": "./src/card.tsx",
    "./styles.css": "./src/styles.css"
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "peerDependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0"
  },
  "devDependencies": {
    "@repo/eslint-config": "workspace:*",
    "@repo/tsconfig": "workspace:*",
    "@types/react": "^18.2.0",
    "react": "^18.2.0",
    "tsup": "^8.0.0",
    "typescript": "^5.3.0"
  }
}
```

```typescript
// packages/ui/src/button.tsx
import { ButtonHTMLAttributes, forwardRef } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline';
  size?: 'sm' | 'md' | 'lg';
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center rounded-md font-medium transition-colors';

    const variants = {
      primary: 'bg-blue-600 text-white hover:bg-blue-700',
      secondary: 'bg-gray-200 text-gray-900 hover:bg-gray-300',
      outline: 'border border-gray-300 bg-transparent hover:bg-gray-100',
    };

    const sizes = {
      sm: 'h-8 px-3 text-sm',
      md: 'h-10 px-4',
      lg: 'h-12 px-6 text-lg',
    };

    return (
      <button
        ref={ref}
        className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
        {...props}
      />
    );
  }
);

Button.displayName = 'Button';
```

```typescript
// packages/ui/src/index.ts
export { Button, type ButtonProps } from "./button";
export { Card, type CardProps } from "./card";
```

```typescript
// packages/ui/tsup.config.ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  external: ["react", "react-dom"],
});
```

## Shared Utils Package

```json
// packages/utils/package.json
{
  "name": "@repo/utils",
  "version": "0.0.0",
  "private": true,
  "main": "./dist/index.js",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.mjs",
      "require": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf dist"
  },
  "devDependencies": {
    "@repo/tsconfig": "workspace:*",
    "tsup": "^8.0.0",
    "typescript": "^5.3.0",
    "vitest": "^1.2.0"
  }
}
```

```typescript
// packages/utils/src/index.ts
export { cn } from "./cn";
export { formatDate, formatRelativeTime } from "./date";
export { debounce, throttle } from "./timing";
export { sleep, retry } from "./async";
```

```typescript
// packages/utils/src/cn.ts
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
```

## Next.js App Configuration

```json
// apps/web/package.json
{
  "name": "@repo/web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "clean": "rm -rf .next .turbo"
  },
  "dependencies": {
    "@repo/ui": "workspace:*",
    "@repo/utils": "workspace:*",
    "next": "^14.1.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  },
  "devDependencies": {
    "@repo/eslint-config": "workspace:*",
    "@repo/tsconfig": "workspace:*",
    "@types/node": "^20.11.0",
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "typescript": "^5.3.0"
  }
}
```

```json
// apps/web/tsconfig.json
{
  "extends": "@repo/tsconfig/nextjs.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

```typescript
// apps/web/src/app/page.tsx
import { Button } from '@repo/ui/button';
import { formatDate } from '@repo/utils';

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center">
      <h1 className="text-4xl font-bold">Monorepo App</h1>
      <p className="mt-4">Today is {formatDate(new Date())}</p>
      <Button className="mt-4">Click me</Button>
    </main>
  );
}
```

## ESLint Config Package

```json
// packages/eslint-config/package.json
{
  "name": "@repo/eslint-config",
  "version": "0.0.0",
  "private": true,
  "exports": {
    "./base": "./base.js",
    "./next": "./next.js",
    "./react": "./react.js",
    "./library": "./library.js"
  },
  "devDependencies": {
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "@typescript-eslint/parser": "^7.0.0",
    "eslint": "^8.56.0",
    "eslint-config-next": "^14.1.0",
    "eslint-config-prettier": "^9.1.0",
    "eslint-plugin-react": "^7.33.0",
    "eslint-plugin-react-hooks": "^4.6.0"
  }
}
```

```javascript
// packages/eslint-config/base.js
module.exports = {
  parser: "@typescript-eslint/parser",
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended", "prettier"],
  plugins: ["@typescript-eslint"],
  env: {
    node: true,
    es2022: true,
  },
  rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    "@typescript-eslint/no-explicit-any": "warn",
  },
  ignorePatterns: ["dist/", "node_modules/", ".turbo/"],
};
```

```javascript
// packages/eslint-config/next.js
module.exports = {
  extends: ["./base.js", "next/core-web-vitals", "plugin:react-hooks/recommended"],
  rules: {
    "react/react-in-jsx-scope": "off",
  },
};
```

## CI/CD Configuration

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

env:
  TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
  TURBO_TEAM: ${{ vars.TURBO_TEAM }}

jobs:
  build:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2

      - uses: pnpm/action-setup@v3
        with:
          version: 8

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "pnpm"

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Build
        run: pnpm build

      - name: Lint
        run: pnpm lint

      - name: Type check
        run: pnpm typecheck

      - name: Test
        run: pnpm test
```

## Changeset Configuration

```json
// .changeset/config.json
{
  "$schema": "https://unpkg.com/@changesets/config@3.0.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["@repo/web", "@repo/api"]
}
```

## Best Practices

1. **Workspace protocol**: Use `workspace:*` for internal deps
2. **Shared configs**: Centralize TypeScript, ESLint
3. **Build caching**: Enable Turborepo remote caching
4. **Incremental builds**: Use `dependsOn` correctly
5. **Package exports**: Use proper `exports` field
6. **Version management**: Use Changesets
7. **Clean scripts**: Include clean in each package
8. **Consistent naming**: Use `@repo/` prefix

## Output Checklist

Every monorepo should include:

- [ ] pnpm-workspace.yaml configuration
- [ ] turbo.json with proper pipeline
- [ ] Shared TypeScript configs
- [ ] Shared ESLint configs
- [ ] UI component library
- [ ] Utility package
- [ ] Proper package.json exports
- [ ] tsup for library building
- [ ] CI/CD with caching
- [ ] Changeset for versioning
