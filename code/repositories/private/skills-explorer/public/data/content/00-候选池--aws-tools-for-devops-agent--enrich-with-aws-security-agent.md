---
name: enrich-with-aws-security-agent
description: Automatically load this skill when investigating application outages, service degradation, or errors that could have security-related root causes — including unexplained downtime, authentication or authorization failures, injection attacks, data exposure, or suspicious application behavior. Query AWS Security Agent CloudWatch logs to retrieve detailed code review findings with actionable, low-level details (file, line number, vulnerability type) that customers can directly fix.
metadata:
  author: yakiratz-aws
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Incident RCA"
  aws-devops-agent-skills.aws-services: "Amazon CloudWatch, AWS Security Agent"
  aws-devops-agent-skills.technical-domains: "Security"
---

# Enriching Investigations with AWS Security Agent Findings

## When to Use — AUTOMATIC ACTIVATION

**Load this skill automatically when ANY of these conditions apply:**

### Application-Level Symptoms (even without explicit security context)

- Application pages or endpoints are not loading or returning errors
- Unexplained service outages with no recent deployments
- Application behaving unexpectedly without clear infrastructure cause
- Services returning 4xx/5xx errors without obvious resource exhaustion

### Explicit Security Signals

- Security vulnerabilities or misconfigurations mentioned
- Suspicious code patterns or behaviors observed
- Authentication or authorization failures
- Injection vulnerabilities suspected (SQL, command, SSRF, etc.)
- Sensitive data exposure concerns
- Security-related errors in application logs
- Findings that suggest code-level security issues

### Key Insight

Many security issues (like SSRF, injection attacks, or compromised dependencies) manifest as **application outages or errors** rather than obvious security alerts. When an app stops working and there's no clear infrastructure cause (no deployments, no resource exhaustion, no config changes), **always check for security issues**.

## Overview

AWS Security Agent is an AI-powered security service that performs automated code security reviews and penetration testing. Its findings are stored in CloudWatch Logs and provide detailed, actionable information about vulnerabilities including exact file locations, line numbers, and remediation guidance.

## Steps

1. **Identify the relevant CloudWatch log group** for AWS Security Agent findings. Look for log groups with patterns like:
   - `/aws/securityagent/*`
   - Log groups containing "security-agent" or "securityagent" in the name

2. **Query the Security Agent logs** using CloudWatch Logs Insights:

   ```
   fields @timestamp, @message
   | filter @message like /finding|vulnerability|issue|risk/
   | sort @timestamp desc
   | limit 100
   ```

3. **Extract actionable details** from the findings:
   - **File path**: The exact source file containing the vulnerability
   - **Line number**: The specific line(s) of code affected
   - **Vulnerability type**: Classification (e.g., SQL injection, XSS, SSRF, hardcoded secrets)
   - **Severity**: Critical, High, Medium, Low
   - **Description**: What the vulnerability is and why it's a risk
   - **Remediation**: Suggested fix or mitigation

4. **Correlate findings with the incident** by matching:
   - Affected services or components
   - Timeframes (when the vulnerability was introduced vs. when the incident occurred)
   - Code paths involved in the failing functionality

5. **Present findings to the customer** with:
   - Clear identification of the vulnerable code location
   - Explanation of how this vulnerability may relate to the incident
   - Specific remediation steps they can take to fix the code

## Example Log Query for Specific Application

If investigating a specific application (e.g., "ssrf-demo", "orders", "account"):

```
fields @timestamp, @message
| filter @message like /ssrf|orders|account|vulnerability|finding|issue/
| sort @timestamp desc
| limit 50
```

## Important Notes

- AWS Security Agent API access may require additional IAM permissions. If API calls fail, fall back to the CloudWatch logs approach.
- Always provide the exact file and line number when available — this is the key value for customers.
- Link the security finding to the observed incident behavior when possible.
- **When in doubt, check security logs** — it's better to rule out security issues than to miss them.
