---
name: stackhawk
description: DAST security scanning and API security testing with HawkScan. Automated web security testing with detailed reports.
allowed-tools:
  - Bash(hawk *)
  - Bash(npx @stackhawk/*)
---

# StackHawk — DAST Security Scanning

Automated security testing for web applications and APIs using StackHawk HawkScan.

## Usage

### Basic Scan
```bash
hawk scan --api-key $HAWK_API_KEY --host https://staging.example.com
```

### API Security Scan
```bash
hawk scan --api-key $HAWK_API_KEY \
  --host https://api.staging.example.com \
  --openapi-spec https://api.example.com/openapi.json
```

## Best Practices

1. Always scan against staging/test, never production
2. Provide OpenAPI specs for comprehensive API coverage
3. Integrate into CI/CD pipeline for continuous security testing
