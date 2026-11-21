---
name: secrets-scanner
description: Detects leaked API keys, tokens, passwords, and credentials in code with pre-commit hooks, CI checks, scanning rules, and remediation procedures. Use for "secret scanning", "credential detection", "API key leaks", or "secret management".
---

# Secrets Scanner

Detect and prevent leaked credentials in your codebase.

## Secret Detection Patterns

````yaml
# .gitleaks.toml
title = "Gitleaks Configuration"

[[rules]]
id = "aws-access-key"
description = "AWS Access Key"
regex = '''(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}'''
tags = ["key", "AWS"]

[[rules]]
id = "aws-secret-key"
description = "AWS Secret Key"
regex = '''(?i)aws(.{0,20})?(?-i)['\"][0-9a-zA-Z\/+]{40}['\"]'''
tags = ["key", "AWS"]

[[rules]]
id = "github-token"
description = "GitHub Personal Access Token"
regex = '''ghp_[0-9a-zA-Z]{36}'''
tags = ["key", "GitHub"]

[[rules]]
id = "github-oauth"
description = "GitHub OAuth Token"
regex = '''gho_[0-9a-zA-Z]{36}'''
tags = ["key", "GitHub"]

[[rules]]
id = "slack-webhook"
description = "Slack Webhook URL"
regex = '''https://hooks\.slack\.com/services/T[a-zA-Z0-9_]{8,10}/B[a-zA-Z0-9_]{8,10}/[a-zA-Z0-9_]{24}'''
tags = ["webhook", "Slack"]

[[rules]]
id = "private-key"
description = "Private Key"
regex = '''-----BEGIN (RSA|OPENSSH|DSA|EC|PGP) PRIVATE KEY-----'''
tags = ["key", "private"]

[[rules]]
id = "generic-api-key"
description = "Generic API Key"
regex = '''(?i)(api[_-]?key|apikey|access[_-]?key)(.{0,20})?['"][0-9a-zA-Z]{32,}['"]'''
tags = ["key", "generic"]

[[rules]]
id = "database-connection"
description = "Database Connection String"
regex = '''(?i)(postgresql|mysql|mongodb):\/\/[^\s:]+:[^\s@]+@[^\s\/]+'''
tags = ["database", "credentials"]

[allowlist]
description = "Allowlist"
paths = [
  '''node_modules/''',
  '''\.git/''',
  '''\.lock$''',
]

regexes = [
  '''EXAMPLE_KEY_123''',
  '''your_api_key_here''',
  '''<API_KEY>''',
]

## Pre-commit Hook Setup

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/gitleaks/gitleaks
    rev: v8.18.0
    hooks:
      - id: gitleaks

  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.4.0
    hooks:
      - id: detect-secrets
        args: ['--baseline', '.secrets.baseline']

  - repo: local
    hooks:
      - id: check-env-files
        name: Check for .env files
        entry: bash -c 'if git diff --cached --name-only | grep -E "\.env$"; then echo "❌ .env file detected! Add to .gitignore"; exit 1; fi'
        language: system
        pass_filenames: false
````

```bash
# Install pre-commit
pip install pre-commit

# Install hooks
pre-commit install

# Run on all files
pre-commit run --all-files
```

## CI Integration

```yaml
# .github/workflows/secrets-scan.yml
name: Secrets Scan

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main, develop]

jobs:
  gitleaks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # Full history for scanning

      - name: Run Gitleaks
        uses: gitleaks/gitleaks-action@v2
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          GITLEAKS_LICENSE: ${{ secrets.GITLEAKS_LICENSE }}

  trufflehog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: TruffleHog OSS
        uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: ${{ github.event.repository.default_branch }}
          head: HEAD
          extra_args: --debug --only-verified
```

## Custom Secret Scanner

```typescript
// scripts/scan-secrets.ts
import * as fs from "fs";
import * as path from "path";

interface SecretPattern {
  name: string;
  regex: RegExp;
  severity: "critical" | "high" | "medium";
}

const SECRET_PATTERNS: SecretPattern[] = [
  {
    name: "AWS Access Key",
    regex: /(A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/g,
    severity: "critical",
  },
  {
    name: "Private Key",
    regex: /-----BEGIN (RSA|OPENSSH|DSA|EC|PGP) PRIVATE KEY-----/g,
    severity: "critical",
  },
  {
    name: "Generic API Key",
    regex: /['"]?[a-zA-Z0-9_-]*api[_-]?key['"]?\s*[:=]\s*['"][a-zA-Z0-9]{32,}['"]/gi,
    severity: "high",
  },
  {
    name: "Database URL",
    regex: /(postgresql|mysql|mongodb):\/\/[^\s:]+:[^\s@]+@[^\s\/]+/gi,
    severity: "critical",
  },
  {
    name: "JWT Token",
    regex: /eyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]*/g,
    severity: "high",
  },
];

interface SecretFinding {
  file: string;
  line: number;
  column: number;
  pattern: string;
  match: string;
  severity: string;
}

function scanFile(filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const content = fs.readFileSync(filePath, "utf-8");
  const lines = content.split("\n");

  lines.forEach((line, lineIndex) => {
    SECRET_PATTERNS.forEach((pattern) => {
      const matches = line.matchAll(pattern.regex);

      for (const match of matches) {
        findings.push({
          file: filePath,
          line: lineIndex + 1,
          column: match.index || 0,
          pattern: pattern.name,
          match: match[0].substring(0, 50) + "...",
          severity: pattern.severity,
        });
      }
    });
  });

  return findings;
}

function scanDirectory(dir: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const files = fs.readdirSync(dir, { withFileTypes: true });

  const ignorePaths = ["node_modules", ".git", "dist", "build"];

  files.forEach((file) => {
    const fullPath = path.join(dir, file.name);

    if (file.isDirectory() && !ignorePaths.includes(file.name)) {
      findings.push(...scanDirectory(fullPath));
    } else if (file.isFile()) {
      findings.push(...scanFile(fullPath));
    }
  });

  return findings;
}

// Run scan
const findings = scanDirectory("./src");

if (findings.length > 0) {
  console.error("🚨 Secrets detected!\n");

  findings.forEach((f) => {
    console.error(`[${f.severity.toUpperCase()}] ${f.file}:${f.line}:${f.column}`);
    console.error(`  Pattern: ${f.pattern}`);
    console.error(`  Match: ${f.match}\n`);
  });

  process.exit(1);
} else {
  console.log("✅ No secrets detected");
}
```

## Remediation Steps

````markdown
# Secret Leak Remediation Checklist

## Immediate Actions (< 1 hour)

1. **Revoke the compromised secret**

   - [ ] Deactivate API key/token immediately
   - [ ] Rotate credentials in production
   - [ ] Update all services using the secret

2. **Remove from git history**

   ```bash
   # Using BFG Repo-Cleaner
   bfg --replace-text secrets.txt repo.git
   git reflog expire --expire=now --all
   git gc --prune=now --aggressive

   # Force push (requires team coordination)
   git push --force --all
   ```
````

3. **Notify stakeholders**
   - [ ] Security team
   - [ ] DevOps team
   - [ ] Service owners
   - [ ] Management (if public repo)

## Short-term Actions (< 24 hours)

4. **Audit access logs**

   - [ ] Check CloudWatch/CloudTrail for suspicious activity
   - [ ] Review API usage for unauthorized access
   - [ ] Check for data exfiltration

5. **Update secret management**

   - [ ] Store in vault (AWS Secrets Manager, HashiCorp Vault)
   - [ ] Use environment variables
   - [ ] Remove hardcoded secrets

6. **Add scanning**
   - [ ] Install pre-commit hooks
   - [ ] Add CI secret scanning
   - [ ] Set up monitoring alerts

## Long-term Actions (< 1 week)

7. **Review and improve**
   - [ ] Conduct security training
   - [ ] Update secret management policies
   - [ ] Implement secret rotation schedule
   - [ ] Document incident and lessons learned

````

## Secret Management Best Practices

```typescript
// ❌ BAD: Hardcoded secrets
const API_KEY = 'sk_live_abc123xyz789';
const db = connect('mongodb://admin:password@localhost');

// ✅ GOOD: Environment variables
const API_KEY = process.env.API_KEY;
const db = connect(process.env.DATABASE_URL);

// ✅ BETTER: Secret management service
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

async function getSecret(secretName: string): Promise<string> {
  const client = new SecretsManagerClient({ region: 'us-east-1' });
  const response = await client.send(
    new GetSecretValueCommand({ SecretId: secretName })
  );
  return response.SecretString!;
}

const apiKey = await getSecret('prod/api/stripe-key');
````

## GitHub Secret Scanning

```yaml
# Enable GitHub secret scanning (Enterprise)
# Settings → Security & analysis → Secret scanning

# Configure custom patterns
# .github/secret_scanning.yml
patterns:
  - name: Company API Key
    pattern: "company_[a-zA-Z0-9]{32}"
    secret_type: company_api_key
```

## Environment Variable Validation

```typescript
// config/env-validation.ts
import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "production", "test"]),
    DATABASE_URL: z.string().url(),
    API_KEY: z.string().min(32),
    JWT_SECRET: z.string().min(64),
    // Never allow default/example values in production
  })
  .refine((env) => {
    if (env.NODE_ENV === "production") {
      const invalidValues = ["example", "test", "localhost", "changeme"];
      return !invalidValues.some((val) =>
        Object.values(env).some((envVal) => String(envVal).toLowerCase().includes(val)),
      );
    }
    return true;
  }, "Production environment cannot use example/test values");

// Validate on startup
try {
  envSchema.parse(process.env);
} catch (error) {
  console.error("❌ Invalid environment configuration:", error);
  process.exit(1);
}
```

## Monitoring & Alerts

```typescript
// monitoring/secret-monitoring.ts
import { CloudWatchClient, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";

async function monitorSecretUsage(secretName: string) {
  const cloudwatch = new CloudWatchClient();

  await cloudwatch.send(
    new PutMetricDataCommand({
      Namespace: "Security/Secrets",
      MetricData: [
        {
          MetricName: "SecretAccess",
          Value: 1,
          Unit: "Count",
          Dimensions: [
            {
              Name: "SecretName",
              Value: secretName,
            },
          ],
        },
      ],
    }),
  );
}

// Alert on unusual secret access patterns
```

## Best Practices

1. **Never commit secrets**: Use .gitignore for .env files
2. **Use secret managers**: AWS Secrets Manager, Vault
3. **Rotate regularly**: 90-day rotation policy
4. **Scan continuously**: Pre-commit + CI + scheduled scans
5. **Least privilege**: Minimal secret access
6. **Audit logs**: Track secret access
7. **Incident response**: Have remediation playbook ready

## Output Checklist

- [ ] Gitleaks configuration created
- [ ] Pre-commit hooks installed
- [ ] CI secret scanning configured
- [ ] Custom scanner implemented (optional)
- [ ] Remediation playbook documented
- [ ] Secret management best practices
- [ ] Environment validation
- [ ] Monitoring and alerts
- [ ] .gitignore includes .env files
- [ ] Team trained on secret handling
