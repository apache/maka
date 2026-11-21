---
name: monorepo-ci-optimizer
description: Optimizes CI pipelines for monorepos by detecting affected packages/apps and running only necessary builds and tests. Includes Turborepo/Nx strategies, caching, and parallel execution. Use for "monorepo CI", "affected detection", "incremental builds", or "workspace optimization".
---

# Monorepo CI Optimizer

Run only affected builds and tests in monorepos for faster CI.

## Affected Detection Strategy

### Using Turborepo

```yaml
# .github/workflows/ci.yml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Need full history for affected detection

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "pnpm"

      - run: pnpm install

      - name: Build affected
        run: |
          pnpm turbo run build --filter='...[origin/main]'

      - name: Test affected
        run: |
          pnpm turbo run test --filter='...[origin/main]'

      - name: Lint affected
        run: |
          pnpm turbo run lint --filter='...[origin/main]'
```

### Using Nx

```yaml
build:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0

    - uses: nrwl/nx-set-shas@v4

    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "npm"

    - run: npm ci

    - name: Build affected projects
      run: npx nx affected:build --base=$NX_BASE --head=$NX_HEAD

    - name: Test affected projects
      run: npx nx affected:test --base=$NX_BASE --head=$NX_HEAD --parallel=3

    - name: Lint affected projects
      run: npx nx affected:lint --base=$NX_BASE --head=$NX_HEAD
```

## Remote Caching (Turborepo)

```yaml
- name: Setup Turborepo cache
  uses: actions/cache@v3
  with:
    path: .turbo
    key: ${{ runner.os }}-turbo-${{ github.sha }}
    restore-keys: |
      ${{ runner.os }}-turbo-

- name: Build with remote cache
  run: pnpm turbo run build
  env:
    TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
    TURBO_TEAM: ${{ secrets.TURBO_TEAM }}
```

## Nx Cloud Integration

```yaml
- name: Setup Nx Cloud
  run: |
    npx nx-cloud start-ci-run --distribute-on="3 linux-medium-js"
  env:
    NX_CLOUD_ACCESS_TOKEN: ${{ secrets.NX_CLOUD_ACCESS_TOKEN }}

- name: Run affected
  run: |
    npx nx affected --target=build --parallel=3
    npx nx affected --target=test --parallel=3
    npx nx affected --target=lint --parallel=3
```

## Manual Affected Detection

```typescript
// scripts/get-affected.ts
import * as path from "path";
import { execSync } from "child_process";
import * as fs from "fs";

interface Package {
  name: string;
  path: string;
  dependencies: string[];
}

function getChangedFiles(base: string = "origin/main"): string[] {
  const output = execSync(`git diff --name-only ${base}...HEAD`, {
    encoding: "utf-8",
  });
  return output.split("\n").filter(Boolean);
}

function getPackages(): Package[] {
  const packagesDir = path.join(process.cwd(), "packages");
  return fs.readdirSync(packagesDir).map((name) => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(packagesDir, name, "package.json"), "utf-8"),
    );
    return {
      name: packageJson.name,
      path: `packages/${name}`,
      dependencies: [
        ...Object.keys(packageJson.dependencies || {}),
        ...Object.keys(packageJson.devDependencies || {}),
      ],
    };
  });
}

function getAffectedPackages(): string[] {
  const changedFiles = getChangedFiles();
  const packages = getPackages();
  const affected = new Set<string>();

  // Direct changes
  changedFiles.forEach((file) => {
    packages.forEach((pkg) => {
      if (file.startsWith(pkg.path)) {
        affected.add(pkg.name);
      }
    });
  });

  // Dependent packages
  let changed = true;
  while (changed) {
    changed = false;
    packages.forEach((pkg) => {
      if (!affected.has(pkg.name)) {
        const hasAffectedDep = pkg.dependencies.some((dep) => affected.has(dep));
        if (hasAffectedDep) {
          affected.add(pkg.name);
          changed = true;
        }
      }
    });
  }

  return Array.from(affected);
}

// Output for GitHub Actions
const affected = getAffectedPackages();
console.log(`::set-output name=packages::${affected.join(",")}`);
console.log(`Affected packages: ${affected.join(", ")}`);
```

## Matrix Strategy for Affected Packages

```yaml
detect-affected:
  runs-on: ubuntu-latest
  outputs:
    packages: ${{ steps.affected.outputs.packages }}
  steps:
    - uses: actions/checkout@v4
      with:
        fetch-depth: 0

    - id: affected
      run: |
        PACKAGES=$(node scripts/get-affected.ts)
        echo "packages=$PACKAGES" >> $GITHUB_OUTPUT

test-affected:
  needs: detect-affected
  if: needs.detect-affected.outputs.packages != ''
  runs-on: ubuntu-latest
  strategy:
    matrix:
      package: ${{ fromJSON(needs.detect-affected.outputs.packages) }}
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "pnpm"

    - run: pnpm install

    - name: Test ${{ matrix.package }}
      run: pnpm --filter ${{ matrix.package }} test
```

## Workspace-aware Caching

```yaml
- name: Cache workspace builds
  uses: actions/cache@v3
  with:
    path: |
      packages/*/dist
      packages/*/node_modules/.cache
    key: ${{ runner.os }}-workspace-${{ hashFiles('**/pnpm-lock.yaml') }}-${{ hashFiles('packages/**/*.ts') }}
    restore-keys: |
      ${{ runner.os }}-workspace-${{ hashFiles('**/pnpm-lock.yaml') }}-
      ${{ runner.os }}-workspace-
```

## Parallel Execution

```yaml
- name: Build all packages in parallel
  run: pnpm turbo run build --parallel

- name: Test with controlled parallelism
  run: pnpm turbo run test --concurrency=3
```

## Optimization Metrics

```markdown
## Before Optimization

- Full build: 25 minutes
- All tests: 15 minutes
- Total: 40 minutes
- Runs on every PR

## After Affected Detection

- Affected build: 5 minutes (80% reduction)
- Affected tests: 3 minutes (80% reduction)
- Total: 8 minutes (80% reduction)
- Only runs necessary checks

## With Remote Caching

- Cache hit build: 30 seconds (98% reduction)
- Cache hit tests: 1 minute (93% reduction)
- Total: 1.5 minutes (96% reduction)
```

## Best Practices

1. **Fetch full history**: `fetch-depth: 0` for accurate diffs
2. **Topological order**: Build dependencies first
3. **Remote caching**: Share cache across CI runs
4. **Parallel execution**: Run independent tasks concurrently
5. **Incremental builds**: Only rebuild what changed
6. **Dependency graph**: Track package relationships
7. **Force full build**: On main branch merges

## Output Checklist

- [ ] Affected detection implemented
- [ ] Turborepo or Nx configured
- [ ] Remote caching enabled
- [ ] Parallel execution optimized
- [ ] Matrix strategy for packages
- [ ] Workspace-aware caching
- [ ] Dependency graph documented
- [ ] Before/after metrics tracked
