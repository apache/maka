---
name: conventional-commits
description: Generates semantic commit messages following the Conventional Commits specification with proper types, scopes, breaking changes, and footers. Use when users request "write commit message", "conventional commit", "semantic commit", or "format commit".
---

# Conventional Commits

Write standardized, semantic commit messages that enable automated versioning and changelog generation.

## Core Workflow

1. **Analyze changes**: Review staged files and modifications
2. **Determine type**: Select appropriate commit type (feat, fix, etc.)
3. **Identify scope**: Optional component/module affected
4. **Write description**: Concise summary in imperative mood
5. **Add body**: Optional detailed explanation
6. **Include footer**: Breaking changes, issue references

## Commit Message Format

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

## Commit Types

| Type       | Description                 | Semver | Example                              |
| ---------- | --------------------------- | ------ | ------------------------------------ |
| `feat`     | New feature                 | MINOR  | `feat: add user authentication`      |
| `fix`      | Bug fix                     | PATCH  | `fix: resolve login redirect loop`   |
| `docs`     | Documentation only          | -      | `docs: update API reference`         |
| `style`    | Formatting, whitespace      | -      | `style: fix indentation in utils`    |
| `refactor` | Code change, no feature/fix | -      | `refactor: extract validation logic` |
| `perf`     | Performance improvement     | PATCH  | `perf: optimize database queries`    |
| `test`     | Adding/fixing tests         | -      | `test: add unit tests for auth`      |
| `build`    | Build system, dependencies  | -      | `build: upgrade to Node 20`          |
| `ci`       | CI/CD configuration         | -      | `ci: add GitHub Actions workflow`    |
| `chore`    | Maintenance tasks           | -      | `chore: update .gitignore`           |
| `revert`   | Revert previous commit      | -      | `revert: undo feature flag change`   |

## Scopes

Scopes indicate the area of the codebase affected:

```bash
# Component/module scopes
feat(auth): add OAuth2 support
fix(api): handle timeout errors
docs(readme): add installation steps

# File-based scopes
style(eslint): update linting rules
build(docker): optimize image size

# Layer scopes
refactor(service): extract user service
test(e2e): add checkout flow tests
```

## Breaking Changes

Mark breaking changes with `!` or `BREAKING CHANGE` footer:

```bash
# Using ! notation
feat(api)!: change response format to JSON:API

# Using footer
feat(api): change response format

BREAKING CHANGE: Response now follows JSON:API specification.
Clients must update their parsers.
```

## Commit Message Examples

### Simple Feature

```
feat: add dark mode toggle
```

### Feature with Scope

```
feat(ui): add dark mode toggle to settings page
```

### Bug Fix with Issue Reference

```
fix(auth): resolve session expiration race condition

The session refresh was racing with the expiration check,
causing intermittent logouts.

Fixes #234
```

### Breaking Change

```
feat(api)!: migrate to v2 response format

BREAKING CHANGE: All API responses now use camelCase keys
instead of snake_case. Update client parsers accordingly.

Migration guide: https://docs.example.com/v2-migration
```

### Multiple Footers

```
fix(payments): correct tax calculation for EU customers

Updated tax calculation to use customer's billing country
instead of shipping country for digital goods.

Fixes #456
Reviewed-by: Alice
Co-authored-by: Bob <bob@example.com>
```

### Revert Commit

```
revert: feat(auth): add OAuth2 support

This reverts commit abc123def456.

Reason: OAuth provider has rate limiting issues in production.
Will re-implement with proper caching.
```

## Description Guidelines

### Do

- Use imperative mood: "add" not "added" or "adds"
- Keep under 72 characters
- Start with lowercase
- No period at the end
- Be specific and concise

### Don't

- "Fixed bug" (too vague)
- "Updated stuff" (not descriptive)
- "WIP" (commit when ready)
- "misc changes" (split into separate commits)

### Good Examples

```bash
feat: add email verification flow
fix: prevent duplicate form submissions
refactor: extract payment processing to service
perf: cache user preferences in memory
docs: add API authentication examples
```

### Bad Examples

```bash
# Too vague
fix: fixed it
update: updates

# Wrong tense
feat: added new feature
fix: fixes the bug

# Too long
feat: add a new feature that allows users to export their data in multiple formats including CSV, JSON, and XML
```

## Body Guidelines

When to include a body:

- Changes need context or explanation
- Complex logic that isn't self-evident
- Breaking changes require migration info
- Multiple related changes in one commit

```
fix(cache): invalidate user cache on profile update

Previously, profile updates were not reflected until cache expiry.
This caused confusion when users updated their avatar and didn't
see the change immediately.

The fix adds cache invalidation after successful profile updates
and ensures CDN purge for static assets.
```

## Footer Tokens

| Token             | Purpose          | Example                        |
| ----------------- | ---------------- | ------------------------------ |
| `Fixes`           | Closes issue     | `Fixes #123`                   |
| `Closes`          | Closes issue     | `Closes #456`                  |
| `Refs`            | References issue | `Refs #789`                    |
| `BREAKING CHANGE` | Breaking change  | `BREAKING CHANGE: description` |
| `Reviewed-by`     | Reviewer credit  | `Reviewed-by: Name`            |
| `Co-authored-by`  | Co-author credit | `Co-authored-by: Name <email>` |

## Integration with Tooling

### Commitlint Configuration

```javascript
// commitlint.config.js
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat",
        "fix",
        "docs",
        "style",
        "refactor",
        "perf",
        "test",
        "build",
        "ci",
        "chore",
        "revert",
      ],
    ],
    "scope-case": [2, "always", "kebab-case"],
    "subject-case": [2, "always", "lower-case"],
    "subject-max-length": [2, "always", 72],
    "body-max-line-length": [2, "always", 100],
  },
};
```

### Husky Pre-commit Hook

```bash
# .husky/commit-msg
#!/bin/sh
. "$(dirname "$0")/_/husky.sh"
npx --no-install commitlint --edit "$1"
```

### Package.json Setup

```json
{
  "devDependencies": {
    "@commitlint/cli": "^18.0.0",
    "@commitlint/config-conventional": "^18.0.0",
    "husky": "^8.0.0"
  },
  "scripts": {
    "prepare": "husky install"
  }
}
```

## Semantic Release Integration

Conventional commits enable automated versioning:

```yaml
# .releaserc.yml
branches:
  - main
plugins:
  - "@semantic-release/commit-analyzer"
  - "@semantic-release/release-notes-generator"
  - "@semantic-release/changelog"
  - "@semantic-release/npm"
  - "@semantic-release/git"
```

### Version Bumping Rules

| Commit Type       | Version Bump  | Example       |
| ----------------- | ------------- | ------------- |
| `feat`            | Minor (0.X.0) | 1.2.0 → 1.3.0 |
| `fix`             | Patch (0.0.X) | 1.2.0 → 1.2.1 |
| `perf`            | Patch (0.0.X) | 1.2.0 → 1.2.1 |
| `BREAKING CHANGE` | Major (X.0.0) | 1.2.0 → 2.0.0 |
| Others            | No bump       | 1.2.0 → 1.2.0 |

## Commit Message Generator

When analyzing changes, generate a commit message:

```bash
# 1. Check staged changes
git diff --cached --name-only

# 2. Analyze change type
# - New files = likely feat
# - Modified test files = test
# - Modified docs = docs
# - Bug-related keywords = fix

# 3. Identify scope from path
# src/components/Button.tsx → components or ui
# src/services/auth.ts → auth or services

# 4. Generate message
feat(ui): add loading state to Button component
```

## Best Practices

1. **One logical change per commit**: Don't mix features with fixes
2. **Commit early, commit often**: Small, focused commits
3. **Write for reviewers**: Messages should explain why, not just what
4. **Reference issues**: Link to tickets/issues when applicable
5. **Use scopes consistently**: Establish team conventions
6. **Review before committing**: `git diff --cached` to verify changes

## Output Checklist

Every commit message should:

- [ ] Start with valid type (feat, fix, docs, etc.)
- [ ] Use imperative mood in description
- [ ] Keep description under 72 characters
- [ ] Include scope when applicable
- [ ] Mark breaking changes with `!` or footer
- [ ] Reference related issues in footer
- [ ] Provide body for complex changes
- [ ] Follow team's scope conventions
