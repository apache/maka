---
name: threat-model-generator
description: Creates comprehensive threat models using STRIDE methodology with asset identification, threat enumeration, mitigation strategies, and residual risk assessment. Use for "threat modeling", "security analysis", "STRIDE", or "risk assessment".
---

# Threat Model Generator

Systematically identify and mitigate security threats.

## STRIDE Methodology

```
S - Spoofing: Impersonating someone/something
T - Tampering: Modifying data or code
R - Repudiation: Claiming you didn't do something
I - Information Disclosure: Exposing protected information
D - Denial of Service: Making system unavailable
E - Elevation of Privilege: Gaining unauthorized permissions
```

## Asset Identification

```typescript
interface Asset {
  name: string;
  type: "data" | "service" | "user" | "infrastructure";
  sensitivity: "public" | "internal" | "confidential" | "restricted";
  criticality: "low" | "medium" | "high" | "critical";
}

const assets: Asset[] = [
  {
    name: "User Credentials (passwords, tokens)",
    type: "data",
    sensitivity: "restricted",
    criticality: "critical",
  },
  {
    name: "Payment Information (credit cards)",
    type: "data",
    sensitivity: "restricted",
    criticality: "critical",
  },
  {
    name: "API Service",
    type: "service",
    sensitivity: "internal",
    criticality: "high",
  },
  {
    name: "User Profile Data",
    type: "data",
    sensitivity: "confidential",
    criticality: "medium",
  },
];
```

## Threat Enumeration

```typescript
interface Threat {
  id: string;
  category: "S" | "T" | "R" | "I" | "D" | "E";
  description: string;
  asset: string;
  attackVector: string;
  likelihood: "low" | "medium" | "high";
  impact: "low" | "medium" | "high" | "critical";
  riskScore: number;
}

const threats: Threat[] = [
  {
    id: "T-001",
    category: "S",
    description: "Attacker impersonates user with stolen credentials",
    asset: "User Credentials",
    attackVector: "Phishing, credential stuffing, brute force",
    likelihood: "high",
    impact: "critical",
    riskScore: 9,
  },
  {
    id: "T-002",
    category: "T",
    description: "SQL injection allows data modification",
    asset: "User Profile Data",
    attackVector: "Malicious SQL in input fields",
    likelihood: "medium",
    impact: "high",
    riskScore: 7,
  },
  {
    id: "T-003",
    category: "I",
    description: "API exposes sensitive user data without auth",
    asset: "User Profile Data",
    attackVector: "Direct API access, IDOR",
    likelihood: "medium",
    impact: "high",
    riskScore: 7,
  },
  {
    id: "T-004",
    category: "D",
    description: "DDoS attack overwhelms API",
    asset: "API Service",
    attackVector: "Volumetric attack, application-layer flood",
    likelihood: "medium",
    impact: "high",
    riskScore: 7,
  },
  {
    id: "T-005",
    category: "E",
    description: "Privilege escalation via role manipulation",
    asset: "User Profile Data",
    attackVector: "Parameter tampering, insecure direct object reference",
    likelihood: "low",
    impact: "critical",
    riskScore: 6,
  },
];
```

## Mitigation Strategies

```typescript
interface Mitigation {
  threatId: string;
  strategy: string;
  implementation: string;
  effectiveness: "low" | "medium" | "high";
  cost: "low" | "medium" | "high";
  priority: 1 | 2 | 3;
}

const mitigations: Mitigation[] = [
  {
    threatId: "T-001",
    strategy: "Multi-factor authentication",
    implementation: "TOTP via authenticator app + SMS backup",
    effectiveness: "high",
    cost: "medium",
    priority: 1,
  },
  {
    threatId: "T-001",
    strategy: "Rate limiting on login attempts",
    implementation: "Max 5 attempts per 15 minutes per IP",
    effectiveness: "medium",
    cost: "low",
    priority: 1,
  },
  {
    threatId: "T-002",
    strategy: "Parameterized queries",
    implementation: "Use ORM (Prisma) for all database access",
    effectiveness: "high",
    cost: "low",
    priority: 1,
  },
  {
    threatId: "T-003",
    strategy: "Authentication & Authorization",
    implementation: "JWT tokens + RBAC middleware on all routes",
    effectiveness: "high",
    cost: "low",
    priority: 1,
  },
  {
    threatId: "T-004",
    strategy: "Rate limiting & CDN",
    implementation: "CloudFlare with rate limits + WAF rules",
    effectiveness: "high",
    cost: "medium",
    priority: 2,
  },
  {
    threatId: "T-005",
    strategy: "Role-based access control",
    implementation: "Enforce RBAC checks on all mutations",
    effectiveness: "high",
    cost: "low",
    priority: 1,
  },
];
```

## Residual Risk Assessment

```typescript
interface ResidualRisk {
  threatId: string;
  originalRisk: number;
  mitigatedRisk: number;
  residualRisk: number;
  acceptanceReason?: string;
  monitoringRequired: boolean;
}

function calculateResidualRisk(threat: Threat, mitigations: Mitigation[]): ResidualRisk {
  const threatMitigations = mitigations.filter((m) => m.threatId === threat.id);

  // Calculate risk reduction
  const maxEffectiveness = Math.max(
    ...threatMitigations.map((m) => {
      if (m.effectiveness === "high") return 0.8;
      if (m.effectiveness === "medium") return 0.5;
      return 0.2;
    }),
  );

  const mitigatedRisk = threat.riskScore * (1 - maxEffectiveness);

  return {
    threatId: threat.id,
    originalRisk: threat.riskScore,
    mitigatedRisk,
    residualRisk: Math.round(mitigatedRisk),
    acceptanceReason: mitigatedRisk < 3 ? "Risk reduced to acceptable level" : undefined,
    monitoringRequired: mitigatedRisk >= 3,
  };
}
```

## Threat Model Document Template

```markdown
# Threat Model: User Authentication System

**Date:** 2024-01-15
**Owner:** Security Team
**Reviewers:** Engineering, Product

## 1. System Overview

### Architecture

- Frontend: React SPA
- Backend: Node.js + Express
- Database: PostgreSQL
- Auth: JWT tokens

### Trust Boundaries

- Internet → CDN
- CDN → Backend API
- Backend API → Database

## 2. Assets

| Asset            | Type | Sensitivity  | Criticality |
| ---------------- | ---- | ------------ | ----------- |
| User Credentials | Data | Restricted   | Critical    |
| Session Tokens   | Data | Restricted   | Critical    |
| User Profile     | Data | Confidential | Medium      |

## 3. Threats (STRIDE)

### Spoofing (S)

**T-001: Credential Theft**

- **Likelihood:** High
- **Impact:** Critical
- **Risk Score:** 9
- **Attack Vector:** Phishing, credential stuffing
- **Mitigations:**
  - MFA required for all accounts
  - Rate limiting on login (5 attempts/15min)
  - Breach password detection
- **Residual Risk:** 3 (Low)

### Tampering (T)

**T-002: Token Modification**

- **Likelihood:** Medium
- **Impact:** High
- **Risk Score:** 7
- **Attack Vector:** Token tampering, replay attacks
- **Mitigations:**
  - HMAC signature on JWT
  - Short token expiry (15 min)
  - Refresh token rotation
- **Residual Risk:** 2 (Low)

### Information Disclosure (I)

**T-003: Sensitive Data Leakage**

- **Likelihood:** Medium
- **Impact:** High
- **Risk Score:** 7
- **Attack Vector:** Error messages, logs, API responses
- **Mitigations:**
  - Generic error messages
  - PII redaction in logs
  - HTTPS everywhere
- **Residual Risk:** 2 (Low)

## 4. Risk Summary

| Priority | Threats | Mitigated | Residual Risk |
| -------- | ------- | --------- | ------------- |
| P1       | 3       | 3         | Low           |
| P2       | 2       | 1         | Medium        |
| P3       | 1       | 0         | Medium        |

## 5. Recommendations

1. **Immediate (P1)**

   - Implement MFA
   - Add rate limiting
   - Deploy PII redaction

2. **Short-term (P2)**

   - Add DDoS protection
   - Implement RBAC auditing

3. **Long-term (P3)**
   - Security training for team
   - Penetration testing

## 6. Acceptance

- [ ] Security Team Approval
- [ ] Engineering Lead Approval
- [ ] Product Manager Approval
```

## Automated Threat Detection

```typescript
// scripts/detect-threats.ts
interface CodePattern {
  pattern: RegExp;
  threat: string;
  severity: "low" | "medium" | "high" | "critical";
}

const patterns: CodePattern[] = [
  {
    pattern: /eval\(/,
    threat: "Code injection via eval()",
    severity: "critical",
  },
  {
    pattern: /innerHTML\s*=/,
    threat: "XSS via innerHTML",
    severity: "high",
  },
  {
    pattern: /process\.env\./,
    threat: "Hardcoded environment variable",
    severity: "medium",
  },
  {
    pattern: /password|secret|key/i,
    threat: "Potential secret in code",
    severity: "high",
  },
];
```

## Best Practices

1. **Regular updates**: Quarterly threat model reviews
2. **Include stakeholders**: Security, Engineering, Product
3. **Document decisions**: Why threats accepted/mitigated
4. **Test mitigations**: Verify controls work
5. **Monitor residual risks**: Track over time
6. **Automate where possible**: Integrate into CI/CD

## Output Checklist

- [ ] Assets identified and classified
- [ ] Threats enumerated using STRIDE
- [ ] Attack vectors documented
- [ ] Mitigations defined for each threat
- [ ] Residual risk calculated
- [ ] Risk acceptance documented
- [ ] Monitoring plan created
- [ ] Threat model document generated
- [ ] Stakeholder approval obtained
- [ ] Review schedule set
