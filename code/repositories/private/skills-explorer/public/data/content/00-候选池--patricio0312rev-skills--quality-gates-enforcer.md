---
name: quality-gates-enforcer
description: Enforces minimum quality thresholds in CI including code coverage, linting, type checking, and security scanning. Provides required checks, PR rules, and automated enforcement. Use for "quality gates", "CI checks", "code quality", or "PR requirements".
---

# Quality Gates Enforcer

Enforce minimum quality standards before merging code.

## Coverage Requirements

```yaml
# .github/workflows/quality-gates.yml
name: Quality Gates

on:
  pull_request:

jobs:
  coverage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - run: npm ci

      - name: Run tests with coverage
        run: npm test -- --coverage

      - name: Check coverage threshold
        run: |
          COVERAGE=$(node -p "require('./coverage/coverage-summary.json').total.lines.pct")
          THRESHOLD=80

          if (( $(echo "$COVERAGE < $THRESHOLD" | bc -l) )); then
            echo "❌ Coverage $COVERAGE% is below threshold $THRESHOLD%"
            exit 1
          fi

          echo "✅ Coverage $COVERAGE% meets threshold $THRESHOLD%"

      - name: Comment coverage on PR
        uses: romeovs/lcov-reporter-action@v0.3.1
        with:
          lcov-file: ./coverage/lcov.info
          github-token: ${{ secrets.GITHUB_TOKEN }}
          delete-old-comments: true
```

## Jest Configuration

```javascript
// jest.config.js
module.exports = {
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80,
    },
    "./src/critical/": {
      branches: 90,
      functions: 90,
      lines: 90,
      statements: 90,
    },
  },
};
```

## Linting Gate

```yaml
lint:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "npm"

    - run: npm ci

    - name: Run ESLint
      run: npm run lint -- --max-warnings 0

    - name: Check formatting
      run: npm run format:check
```

## Type Checking Gate

```yaml
typecheck:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "npm"

    - run: npm ci

    - name: TypeScript check
      run: npx tsc --noEmit
```

## Security Scanning

```yaml
security:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: Run Snyk security scan
      uses: snyk/actions/node@master
      env:
        SNYK_TOKEN: ${{ secrets.SNYK_TOKEN }}
      with:
        args: --severity-threshold=high

    - name: Audit dependencies
      run: npm audit --audit-level=moderate

    - name: Check for outdated dependencies
      run: |
        OUTDATED=$(npm outdated || true)
        if [ ! -z "$OUTDATED" ]; then
          echo "⚠️ Outdated dependencies found:"
          echo "$OUTDATED"
        fi
```

## Bundle Size Gate

```yaml
bundle-size:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "npm"

    - run: npm ci
    - run: npm run build

    - name: Check bundle size
      uses: andresz1/size-limit-action@v1
      with:
        github_token: ${{ secrets.GITHUB_TOKEN }}
        skip_step: install
```

## Required Status Checks

```yaml
# .github/workflows/required-checks.yml
name: Required Checks

on:
  pull_request:

jobs:
  required:
    runs-on: ubuntu-latest
    needs: [lint, typecheck, test, coverage, security]
    if: always()
    steps:
      - name: Check all required jobs passed
        run: |
          if [ "${{ contains(needs.*.result, 'failure') }}" == "true" ]; then
            echo "❌ Required checks failed"
            exit 1
          fi
          echo "✅ All required checks passed"
```

## Quality Thresholds

```typescript
// quality-thresholds.ts
export const QUALITY_GATES = {
  coverage: {
    lines: 80,
    branches: 80,
    functions: 80,
    statements: 80,
  },
  linting: {
    maxWarnings: 0,
    maxErrors: 0,
  },
  bundleSize: {
    maxSize: "200kb",
    maxGzipSize: "100kb",
  },
  performance: {
    maxLighthouseScore: 90,
  },
  security: {
    maxVulnerabilities: 0,
    maxSeverity: "moderate",
  },
  dependencies: {
    maxOutdated: 5,
  },
};
```

## Branch Protection Rules

```yaml
# Configure via GitHub settings or API
{
  "required_status_checks":
    {
      "strict": true,
      "contexts": ["lint", "typecheck", "test", "coverage", "security", "bundle-size"],
    },
  "required_pull_request_reviews":
    {
      "required_approving_review_count": 1,
      "dismiss_stale_reviews": true,
      "require_code_owner_reviews": true,
    },
  "enforce_admins": true,
  "restrictions": null,
}
```

## Quality Report

```yaml
- name: Generate quality report
  run: |
    cat > quality-report.md << EOF
    # Quality Report

    ## Coverage
    - Lines: $(node -p "require('./coverage/coverage-summary.json').total.lines.pct")%
    - Branches: $(node -p "require('./coverage/coverage-summary.json').total.branches.pct")%
    - Functions: $(node -p "require('./coverage/coverage-summary.json').total.functions.pct")%

    ## Linting
    - ESLint warnings: $(npm run lint 2>&1 | grep -c warning || echo 0)
    - ESLint errors: $(npm run lint 2>&1 | grep -c error || echo 0)

    ## Type Safety
    - TypeScript errors: $(npx tsc --noEmit 2>&1 | grep -c error || echo 0)

    ## Security
    - Vulnerabilities: $(npm audit --json | jq '.metadata.vulnerabilities.total')

    ## Bundle Size
    - Main bundle: $(ls -lh dist/main.js | awk '{print $5}')
    EOF

- name: Comment report on PR
  uses: actions/github-script@v7
  with:
    script: |
      const fs = require('fs');
      const report = fs.readFileSync('quality-report.md', 'utf8');
      github.rest.issues.createComment({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        body: report
      });
```

## Auto-fail on Thresholds

```yaml
- name: Check all quality gates
  run: |
    EXIT_CODE=0

    # Coverage
    COVERAGE=$(node -p "require('./coverage/coverage-summary.json').total.lines.pct")
    if (( $(echo "$COVERAGE < 80" | bc -l) )); then
      echo "❌ Coverage below 80%"
      EXIT_CODE=1
    fi

    # Lint warnings
    WARNINGS=$(npm run lint 2>&1 | grep -c warning || echo 0)
    if [ "$WARNINGS" -gt 0 ]; then
      echo "❌ Found $WARNINGS lint warnings"
      EXIT_CODE=1
    fi

    # TypeScript errors
    if ! npx tsc --noEmit; then
      echo "❌ TypeScript errors found"
      EXIT_CODE=1
    fi

    # Security vulnerabilities
    if ! npm audit --audit-level=moderate; then
      echo "❌ Security vulnerabilities found"
      EXIT_CODE=1
    fi

    exit $EXIT_CODE
```

## Best Practices

1. **Strict thresholds**: No compromises on quality
2. **Fast feedback**: Run checks early in CI
3. **Clear messages**: Explain why checks failed
4. **Incremental improvement**: Gradually increase thresholds
5. **Bypass mechanism**: For emergencies only
6. **Local pre-commit**: Catch issues before push
7. **Team agreement**: Align on standards

## Output Checklist

- [ ] Coverage threshold enforced (80%+)
- [ ] Linting with zero warnings
- [ ] Type checking required
- [ ] Security scanning enabled
- [ ] Bundle size checks
- [ ] Branch protection rules
- [ ] Quality report generated
- [ ] PR comments automated
