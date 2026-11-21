---
name: git-hygiene-enforcer
description: Establishes git workflow guardrails including conventional commits, commit message hooks, branch naming conventions, PR templates, and code review processes. Provides hook configurations, workflow templates, and emergency bypass instructions. Use when users request "setup git hooks", "enforce commit conventions", "add PR templates", or "standardize git workflow".
---

# Git Hygiene Enforcer

Enforce consistent, high-quality git practices across your team.

## Core Workflow

1. **Choose conventions**: Select commit format (Conventional Commits, Angular, etc.)
2. **Setup commit hooks**: Install commitlint with git hooks
3. **Configure branch rules**: Define naming patterns and protection
4. **Create PR templates**: Standardize pull request descriptions
5. **Add workflows**: GitHub Actions or GitLab CI for automated checks
6. **Document process**: Write CONTRIBUTING.md with git guidelines
7. **Provide bypasses**: Document emergency override procedures

## Conventional Commits

Format: `<type>(<scope>): <description>`

**Types:**

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Test additions or changes
- `chore`: Build/tool changes
- `perf`: Performance improvements
- `ci`: CI/CD changes

**Examples:**

```
feat(auth): add OAuth2 login
fix(api): resolve race condition in user endpoint
docs(readme): update installation instructions
refactor(utils): simplify date formatting logic
```

## Commit Hook Setup

### Using Husky + Commitlint

1. Install dependencies:

```bash
npm install --save-dev @commitlint/cli @commitlint/config-conventional husky
npx husky init
```

2. Configure commitlint (commitlint.config.js):

```javascript
module.exports = {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      ["feat", "fix", "docs", "style", "refactor", "test", "chore", "perf", "ci"],
    ],
    "subject-case": [2, "never", ["upper-case"]],
    "subject-empty": [2, "never"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 100],
  },
};
```

3. Add commit-msg hook (.husky/commit-msg):

```bash
#!/bin/sh
npx --no -- commitlint --edit $1
```

### Using pre-commit (Python)

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/compilerla/conventional-pre-commit
    rev: v3.0.0
    hooks:
      - id: conventional-pre-commit
        stages: [commit-msg]
```

## Branch Naming Conventions

**Pattern:** `<type>/<ticket-id>-<description>`

**Examples:**

```
feature/AUTH-123-oauth-login
bugfix/API-456-user-race-condition
hotfix/PROD-789-payment-error
refactor/DB-321-optimize-queries
```

**Branch Protection Rules:**

- Require PR reviews (1-2 reviewers)
- Require status checks to pass
- Require branches to be up to date
- Enforce linear history (no merge commits)
- Require signed commits (optional)

## Pull Request Templates

### .github/pull_request_template.md

```markdown
## Description

<!-- Describe your changes in detail -->

## Type of Change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation update

## Related Issue

Closes #<!-- issue number -->

## How Has This Been Tested?

<!-- Describe the tests you ran to verify your changes -->

- [ ] Unit tests
- [ ] Integration tests
- [ ] Manual testing

## Checklist

- [ ] My code follows the style guidelines of this project
- [ ] I have performed a self-review of my own code
- [ ] I have commented my code, particularly in hard-to-understand areas
- [ ] I have made corresponding changes to the documentation
- [ ] My changes generate no new warnings
- [ ] I have added tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] Any dependent changes have been merged and published

## Screenshots (if applicable)

<!-- Add screenshots to help explain your changes -->
```

### Alternative: Simple Template

```markdown
## What

<!-- What does this PR do? -->

## Why

<!-- Why are we making this change? -->

## How

<!-- How did you implement it? -->

## Testing

<!-- How can reviewers verify this works? -->
```

## GitHub Actions Workflow

### .github/workflows/pr-checks.yml

```yaml
name: PR Checks

on:
  pull_request:
    branches: [main, develop]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Validate PR title
        uses: amannn/action-semantic-pull-request@v5
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Check branch naming
        run: |
          BRANCH="${{ github.head_ref }}"
          if [[ ! $BRANCH =~ ^(feature|bugfix|hotfix|refactor|docs|chore)/.+ ]]; then
            echo "Branch name doesn't follow convention: <type>/<description>"
            exit 1
          fi

      - name: Lint commits
        uses: wagoid/commitlint-github-action@v5

      - name: Check for merge commits
        run: |
          if git log --merges origin/${{ github.base_ref }}..HEAD | grep -q 'Merge'; then
            echo "Merge commits detected. Please rebase your branch."
            exit 1
          fi
```

## Git Configuration

### .gitattributes

```
# Auto detect text files and perform LF normalization
* text=auto

# Explicitly mark files as text
*.js text
*.ts text
*.json text
*.md text
*.yml text

# Binary files
*.png binary
*.jpg binary
*.gif binary
*.ico binary
*.woff binary
*.woff2 binary
```

### .gitignore Best Practices

```
# Dependencies
node_modules/
vendor/

# Environment
.env
.env.local

# Build outputs
dist/
build/
*.log

# IDE
.vscode/
.idea/
*.swp

# OS
.DS_Store
Thumbs.db
```

## Code Review Guidelines

### CONTRIBUTING.md Section

```markdown
## Pull Request Process

1. **Create a branch** following naming convention: `type/description`
2. **Make commits** using conventional commit format
3. **Write tests** for new features or bug fixes
4. **Update documentation** if APIs change
5. **Ensure CI passes** before requesting review
6. **Request review** from 1-2 team members
7. **Address feedback** and update PR
8. **Squash and merge** when approved

## Code Review Checklist

**Reviewers should verify:**

- [ ] Code is clear and understandable
- [ ] Tests cover new/changed code
- [ ] No obvious bugs or security issues
- [ ] Follows project conventions
- [ ] Documentation is updated
- [ ] No unnecessary changes included

**Constructive feedback:**

- Be specific and actionable
- Assume good intent
- Ask questions instead of making demands
- Praise good solutions
```

## Commit Message Validation

### commit-msg Hook Example

```bash
#!/bin/bash
# .husky/commit-msg

commit_msg=$(cat "$1")

# Check conventional commit format
if ! echo "$commit_msg" | grep -qE '^(feat|fix|docs|style|refactor|test|chore|perf|ci)(\(.+\))?: .+'; then
  echo "Error: Commit message doesn't follow Conventional Commits format"
  echo "Format: <type>(<scope>): <description>"
  echo "Example: feat(auth): add OAuth2 login"
  exit 1
fi

# Check message length
if [ ${#commit_msg} -gt 100 ]; then
  echo "Error: Commit message too long (max 100 characters)"
  exit 1
fi
```

## Emergency Bypass Instructions

### Skipping Hooks (Use Sparingly)

```bash
# Skip commit message validation
git commit --no-verify -m "hotfix: critical production fix"

# Force push (use with caution)
git push --force-with-lease

# Override PR checks (requires admin)
# Use GitHub UI: "Merge without waiting for checks"
```

### When Bypass is Acceptable

- **Production hotfixes**: Critical bugs affecting users
- **Reverts**: Rolling back problematic changes
- **Emergency**: Infrastructure outages

### Bypass Documentation

Document in CONTRIBUTING.md:

```markdown
## Emergency Procedures

In rare cases, you may need to bypass git hooks:

1. **Commit without hooks**: `git commit --no-verify`

   - Only for production hotfixes
   - Fix commit message in follow-up PR

2. **Force push**: `git push --force-with-lease`
   - After approved history rewrite
   - Coordinate with team first

Always create a follow-up PR to fix any bypassed checks.
```

## Recommended Workflow

````markdown
## Development Workflow

1. **Start work**
   ```bash
   git checkout main
   git pull
   git checkout -b feature/TICKET-123-new-feature
   ```
````

2. **Make changes**

   ```bash
   # Make your changes
   git add .
   git commit -m "feat(api): add user search endpoint"
   ```

3. **Keep updated**

   ```bash
   git fetch origin
   git rebase origin/main
   ```

4. **Push and create PR**

   ```bash
   git push origin feature/TICKET-123-new-feature
   # Create PR via GitHub/GitLab
   ```

5. **Address feedback**

   ```bash
   # Make changes
   git add .
   git commit -m "fix: address review feedback"
   git push
   ```

6. **Merge**
   - Squash and merge via UI
   - Delete branch after merge

```

## Installation Checklist

- [ ] Commitlint config (commitlint.config.js)
- [ ] Git hooks (.husky/ or .git/hooks/)
- [ ] PR template (.github/pull_request_template.md)
- [ ] Branch protection rules (via GitHub settings)
- [ ] CI workflow for PR validation
- [ ] CONTRIBUTING.md with git guidelines
- [ ] .gitattributes for consistent line endings
- [ ] Emergency bypass documentation

## Best Practices

1. **Keep commits atomic**: One logical change per commit
2. **Write descriptive messages**: Explain why, not just what
3. **Reference tickets**: Include issue/ticket IDs
4. **Rebase before merging**: Keep history clean
5. **Review your own PR first**: Self-review catches many issues
6. **Respond to feedback promptly**: Don't leave PRs hanging
7. **Delete merged branches**: Keep repository tidy
8. **Use draft PRs**: For work-in-progress changes
```
