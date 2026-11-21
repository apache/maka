---
name: linting-neostandard-eslint9
description: Configures ESLint v9 flat config and neostandard for JavaScript and TypeScript projects, including migrating from legacy `.eslintrc*` files or the `standard` package. Use when you need to set up or fix linting with `eslint.config.js` or `eslint.config.mjs`, troubleshoot lint errors, configure neostandard rules, migrate from `.eslintrc` to flat config, or integrate linting into CI pipelines and pre-commit hooks.
metadata:
  tags: linting, neostandard, eslint, eslint9, flat-config, javascript, typescript
---

## When to use

Use this skill when you need to:

- Set up linting in a JavaScript or TypeScript project
- Use `neostandard` as a Standard-like ESLint v9 flat-config baseline
- Configure `eslint@9` with the flat config system (`eslint.config.js`/`eslint.config.mjs`)
- Migrate from `standard` to `neostandard` or ESLint v9
- Migrate from legacy `.eslintrc*` configuration to ESLint v9
- Run linting consistently in CI and local development

## Quick start: basic neostandard setup

Install dependencies and create a minimal `eslint.config.js`:

```bash
npm install --save-dev eslint@9 neostandard
```

```js
// eslint.config.js
import neostandard from "neostandard";

export default neostandard();
```

Verify the config works:

```bash
npx eslint .
```

## Common setup workflow (new project)

1. Install `eslint@9` and `neostandard` (see Quick start above)
2. Create `eslint.config.js` with `neostandard()` as the base
3. Add any project-specific rule overrides on top
4. Run `npx eslint .` to confirm no config errors
5. Add a lint script to `package.json`: `"lint": "eslint ."`
6. Integrate into CI with a non-fix run; use `--fix` only in local workflows

## How to use

Read individual rule files for implementation details and examples:

- [rules/neostandard.md](rules/neostandard.md) - Install, configure, and extend neostandard with ESLint
- [rules/eslint-v9-flat-config.md](rules/eslint-v9-flat-config.md) - Build ESLint v9 flat config for JS/TS projects
- [rules/migration-from-standard.md](rules/migration-from-standard.md) - Migrate from `standard` to `neostandard` or ESLint v9
- [rules/migration-from-legacy-eslint.md](rules/migration-from-legacy-eslint.md) - Migrate from `.eslintrc*` to flat config safely
- [rules/ci-and-editor-integration.md](rules/ci-and-editor-integration.md) - CI scripts, pre-commit, and editor setup

## Core principles

- Prefer reproducible linting with pinned major versions
- Keep config minimal and explicit
- Use flat config for ESLint v9 projects
- Treat lint failures as quality gates in CI
- Enable auto-fix for local workflows, but validate with non-fix CI runs
