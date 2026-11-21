---
name: secure-headers-csp-builder
description: Implements security headers and Content Security Policy with safe rollout strategy (report-only → enforce), testing, and compatibility checks. Use for "security headers", "CSP", "HTTP headers", or "XSS protection".
---

# Secure Headers & CSP Builder

Add security headers safely without breaking functionality.

## Essential Security Headers

```typescript
// middleware/security-headers.ts
import { Request, Response, NextFunction } from "express";

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  // Prevent clickjacking
  res.setHeader("X-Frame-Options", "DENY");

  // Prevent MIME sniffing
  res.setHeader("X-Content-Type-Options", "nosniff");

  // XSS Protection (legacy browsers)
  res.setHeader("X-XSS-Protection", "1; mode=block");

  // Referrer Policy
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  // Permissions Policy (replaces Feature-Policy)
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self), payment=()");

  // HSTS - Force HTTPS (only in production)
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  }

  next();
}
```

## Content Security Policy (CSP)

### Phase 1: Report-Only Mode

```typescript
// config/csp-report-only.ts
export const cspReportOnly = {
  "default-src": ["'self'"],
  "script-src": [
    "'self'",
    "'report-sample'",
    "https://cdn.jsdelivr.net",
    "https://www.googletagmanager.com",
  ],
  "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
  "img-src": ["'self'", "data:", "https:"],
  "font-src": ["'self'", "https://fonts.gstatic.com"],
  "connect-src": ["'self'", "https://api.example.com"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "report-uri": ["/api/csp-report"],
};

function formatCSP(policy: Record<string, string[]>): string {
  return Object.entries(policy)
    .map(([key, values]) => `${key} ${values.join(" ")}`)
    .join("; ");
}

// Apply report-only header
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy-Report-Only", formatCSP(cspReportOnly));
  next();
});
```

### CSP Violation Reporter

```typescript
// routes/csp-report.ts
app.post("/api/csp-report", express.json({ type: "application/csp-report" }), (req, res) => {
  const violation = req.body["csp-report"];

  console.error("CSP Violation:", {
    documentUri: violation["document-uri"],
    violatedDirective: violation["violated-directive"],
    blockedUri: violation["blocked-uri"],
    sourceFile: violation["source-file"],
    lineNumber: violation["line-number"],
  });

  // Store in monitoring system
  trackCSPViolation({
    directive: violation["violated-directive"],
    blockedUri: violation["blocked-uri"],
    userAgent: req.headers["user-agent"],
    timestamp: new Date(),
  });

  res.status(204).send();
});
```

### Phase 2: Enforce Mode

```typescript
// config/csp-enforce.ts
export const cspEnforce = {
  "default-src": ["'self'"],
  "script-src": [
    "'self'",
    // Add nonces for inline scripts
    "'nonce-{NONCE}'",
    "https://cdn.jsdelivr.net",
    "https://www.googletagmanager.com",
  ],
  "style-src": [
    "'self'",
    // Replace unsafe-inline with nonces
    "'nonce-{NONCE}'",
    "https://fonts.googleapis.com",
  ],
  "img-src": ["'self'", "data:", "https:"],
  "font-src": ["'self'", "https://fonts.gstatic.com"],
  "connect-src": ["'self'", "https://api.example.com"],
  "frame-ancestors": ["'none'"],
  "base-uri": ["'self'"],
  "form-action": ["'self'"],
  "upgrade-insecure-requests": [],
};

// Generate nonce for each request
app.use((req, res, next) => {
  const nonce = crypto.randomBytes(16).toString("base64");
  res.locals.cspNonce = nonce;

  const policy = formatCSP(cspEnforce).replace(/{NONCE}/g, nonce);

  res.setHeader("Content-Security-Policy", policy);
  next();
});
```

### Nonce Implementation

```typescript
// views/index.ejs
<!DOCTYPE html>
<html>
<head>
  <!-- Inline script with nonce -->
  <script nonce="<%= cspNonce %>">
    console.log('This script is allowed by CSP');
  </script>

  <!-- Inline style with nonce -->
  <style nonce="<%= cspNonce %>">
    body { background: white; }
  </style>
</head>
<body>
  <h1>Secure Page</h1>
</body>
</html>
```

## Helmet.js Integration

```typescript
// Using Helmet for comprehensive security headers
import helmet from "helmet";

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'nonce-{NONCE}'"],
        styleSrc: ["'self'", "'nonce-{NONCE}'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://api.example.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        objectSrc: ["'none'"],
        mediaSrc: ["'self'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    frameguard: {
      action: "deny",
    },
    xssFilter: true,
    noSniff: true,
    referrerPolicy: {
      policy: "strict-origin-when-cross-origin",
    },
  }),
);
```

## Rollout Plan

```markdown
# CSP Rollout Plan

## Week 1: Report-Only Mode

- [ ] Deploy CSP in report-only mode
- [ ] Monitor violation reports
- [ ] Identify problematic resources
- [ ] Whitelist legitimate sources

## Week 2: Analysis

- [ ] Analyze 1 week of violations
- [ ] Update CSP policy based on reports
- [ ] Fix inline scripts/styles
- [ ] Test on staging

## Week 3: Staged Rollout

- [ ] Enable enforcement for 10% of traffic
- [ ] Monitor error rates
- [ ] Check user reports
- [ ] Adjust policy if needed

## Week 4: Full Enforcement

- [ ] Enable for 50% of traffic
- [ ] Verify no issues
- [ ] Enable for 100% of traffic
- [ ] Keep report-only header for monitoring
```

## Testing CSP

```typescript
// tests/csp.test.ts
import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/app";

describe("Content Security Policy", () => {
  it("should set CSP header", async () => {
    const response = await request(app).get("/");

    expect(response.headers["content-security-policy"]).toBeDefined();
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
  });

  it("should block inline scripts without nonce", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <script>alert('blocked')</script>
      </head>
      </html>
    `;

    // This would be blocked by CSP
    // Verify in browser console or automated tests
  });

  it("should allow scripts with valid nonce", async () => {
    const response = await request(app).get("/");

    // Extract nonce from response
    const nonceMatch = response.text.match(/nonce="([^"]+)"/);
    expect(nonceMatch).toBeDefined();
  });
});
```

## Common CSP Issues & Fixes

```typescript
// Issue 1: Inline event handlers
// ❌ Bad
<button onclick="handleClick()">Click</button>

// ✅ Good
<button id="myButton">Click</button>
<script nonce="<%= cspNonce %>">
  document.getElementById('myButton').addEventListener('click', handleClick);
</script>

// Issue 2: Inline styles
// ❌ Bad
<div style="color: red;">Text</div>

// ✅ Good
<style nonce="<%= cspNonce %>">
  .red-text { color: red; }
</style>
<div class="red-text">Text</div>

// Issue 3: eval() usage
// ❌ Bad
eval('console.log("test")');

// ✅ Good
// Don't use eval - refactor code

// Issue 4: Third-party scripts
// ❌ Bad - no CSP entry
<script src="https://cdn.example.com/script.js"></script>

// ✅ Good - whitelisted in CSP
script-src: ['self', 'https://cdn.example.com']
```

## Monitoring & Alerts

```typescript
// monitoring/csp-violations.ts
import { CloudWatch } from "@aws-sdk/client-cloudwatch";

const cloudwatch = new CloudWatch();

export async function trackCSPViolation(violation: {
  directive: string;
  blockedUri: string;
  userAgent: string;
  timestamp: Date;
}) {
  await cloudwatch.putMetricData({
    Namespace: "Security/CSP",
    MetricData: [
      {
        MetricName: "Violations",
        Value: 1,
        Unit: "Count",
        Timestamp: violation.timestamp,
        Dimensions: [
          {
            Name: "Directive",
            Value: violation.directive,
          },
          {
            Name: "BlockedUri",
            Value: violation.blockedUri,
          },
        ],
      },
    ],
  });

  // Alert if violations spike
  if (await isViolationSpike()) {
    await sendAlert({
      title: "CSP Violation Spike Detected",
      message: `High number of violations for ${violation.directive}`,
    });
  }
}
```

## Best Practices

1. **Start report-only**: Don't break production
2. **Gradual rollout**: 10% → 50% → 100%
3. **Use nonces**: Better than unsafe-inline
4. **Monitor violations**: Track and analyze
5. **Test thoroughly**: All pages and features
6. **Document exceptions**: Why resources whitelisted
7. **Regular audits**: Quarterly CSP review

## Output Checklist

- [ ] Security headers implemented
- [ ] CSP policy defined (report-only)
- [ ] CSP violation reporter endpoint
- [ ] Nonce generation for inline scripts
- [ ] Helmet.js configured
- [ ] Rollout plan documented
- [ ] Testing strategy implemented
- [ ] Monitoring and alerts configured
- [ ] Team trained on CSP
- [ ] Staged rollout completed
