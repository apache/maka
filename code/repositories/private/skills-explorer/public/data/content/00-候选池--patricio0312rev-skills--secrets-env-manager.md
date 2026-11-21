---
name: secrets-env-manager
description: Validates environment variables in CI, prevents secret leaks, enforces masking, and provides fail-fast validation with clear documentation. Use for "secrets management", "env var validation", "credential security", or "secret masking".
---

# Secrets & Env Manager

Secure secrets handling and environment variable validation in CI/CD.

## Environment Variable Validation

```yaml
validate-env:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4

    - name: Validate required environment variables
      run: |
        REQUIRED_VARS=(
          "DATABASE_URL"
          "API_KEY"
          "AWS_REGION"
          "STRIPE_SECRET_KEY"
        )

        MISSING=()
        for var in "${REQUIRED_VARS[@]}"; do
          if [ -z "${!var}" ]; then
            MISSING+=("$var")
          fi
        done

        if [ ${#MISSING[@]} -ne 0 ]; then
          echo "❌ Missing required environment variables:"
          printf '%s\n' "${MISSING[@]}"
          exit 1
        fi

        echo "✅ All required environment variables are set"
      env:
        DATABASE_URL: ${{ secrets.DATABASE_URL }}
        API_KEY: ${{ secrets.API_KEY }}
        AWS_REGION: ${{ secrets.AWS_REGION }}
        STRIPE_SECRET_KEY: ${{ secrets.STRIPE_SECRET_KEY }}
```

## Secret Masking

```yaml
- name: Mask sensitive values
  run: |
    # Automatically masked in GitHub Actions
    echo "::add-mask::${{ secrets.API_KEY }}"
    echo "::add-mask::${{ secrets.DATABASE_PASSWORD }}"

    # Safe to use in commands
    curl -H "Authorization: Bearer ${{ secrets.API_KEY }}" https://api.example.com
```

## Leak Prevention

```yaml
- name: Check for leaked secrets
  uses: trufflesecurity/trufflehog@main
  with:
    path: ./
    base: ${{ github.event.repository.default_branch }}
    head: HEAD

- name: Detect hardcoded secrets
  uses: reviewdog/action-detect-secrets@master
  with:
    github_token: ${{ secrets.GITHUB_TOKEN }}
    reporter: github-pr-review
```

## Environment-specific Secrets

```yaml
deploy:
  runs-on: ubuntu-latest
  environment:
    name: ${{ github.event.inputs.environment }}
  steps:
    - name: Deploy
      run: |
        # Environment-specific secrets are automatically scoped
        echo "Deploying to ${{ github.event.inputs.environment }}"
      env:
        DATABASE_URL: ${{ secrets.DATABASE_URL }}
        API_KEY: ${{ secrets.API_KEY }}
```

## Secret Validation Script

```typescript
// scripts/validate-env.ts
import * as fs from "fs";

interface EnvConfig {
  required: string[];
  optional: string[];
}

const config: EnvConfig = {
  required: ["DATABASE_URL", "JWT_SECRET", "STRIPE_SECRET_KEY"],
  optional: ["SENTRY_DSN", "LOG_LEVEL"],
};

function validateEnv(): boolean {
  const missing: string[] = [];

  config.required.forEach((key) => {
    if (!process.env[key]) {
      missing.push(key);
    }
  });

  if (missing.length > 0) {
    console.error("❌ Missing required environment variables:");
    missing.forEach((key) => console.error(`  - ${key}`));
    return false;
  }

  console.log("✅ All required environment variables are set");
  return true;
}

if (!validateEnv()) {
  process.exit(1);
}
```

## .env.example Template

```bash
# .env.example - Check into git
# Copy to .env and fill in values

# Database
DATABASE_URL=postgresql://user:password@localhost:5432/mydb

# Authentication
JWT_SECRET=your-secret-here
JWT_EXPIRY=24h

# External APIs
STRIPE_SECRET_KEY=sk_test_...
SENDGRID_API_KEY=SG....

# AWS
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1

# Optional
SENTRY_DSN=https://...
LOG_LEVEL=info
```

## Documentation Template

```markdown
# Environment Variables

## Required Variables

### DATABASE_URL

**Description:** PostgreSQL connection string
**Format:** `postgresql://user:password@host:5432/database`
**Example:** `postgresql://app:secret@localhost:5432/myapp`
**Where to get:** Create database on Heroku/RDS

### STRIPE_SECRET_KEY

**Description:** Stripe API secret key
**Format:** `sk_test_...` or `sk_live_...`
**Example:** `sk_test_51abc123...`
**Where to get:** Stripe Dashboard → Developers → API Keys
**⚠️ Never commit to git**

## Optional Variables

### LOG_LEVEL

**Description:** Logging verbosity
**Format:** `error | warn | info | debug`
**Default:** `info`
```

## Fail-Fast Validation

```yaml
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate secrets exist
        run: |
          if [ -z "${{ secrets.DATABASE_URL }}" ]; then
            echo "::error::DATABASE_URL secret not set"
            exit 1
          fi

          if [ -z "${{ secrets.API_KEY }}" ]; then
            echo "::error::API_KEY secret not set"
            exit 1
          fi

  deploy:
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - name: Deploy
        run: echo "Deploying..."
```

## Best Practices

1. **Never log secrets**: Always mask sensitive values
2. **Validate early**: Check secrets before deployment
3. **Use GitHub Secrets**: Never hardcode in workflows
4. **Environment separation**: Dev/staging/prod secrets
5. **Rotate regularly**: Update secrets periodically
6. **Principle of least privilege**: Minimal permissions
7. **Document clearly**: Where to get each secret
8. **Scan for leaks**: Automated detection

## Output Checklist

- [ ] Required env vars validated
- [ ] Secret masking configured
- [ ] Leak detection enabled
- [ ] .env.example template
- [ ] Environment variables documented
- [ ] Fail-fast validation
- [ ] Environment-specific secrets
- [ ] Rotation policy documented
