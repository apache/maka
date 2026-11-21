---
name: waf
description: >-
  Configures AWS WAF to filter web traffic: creating web access control lists (web ACLs) on
  CloudFront, Application Load Balancers, API Gateway, and AppSync; AWS Managed Rules tuned in Count
  mode; rate-based rules for HTTP floods; IP set and geographic match rules; Bot Control (Common and
  Targeted); turning bot labels into a confidence signal; stripping spoofed inbound x-amzn-waf-*
  headers; recovering the real client IP behind a CDN; Fraud Control (account takeover and account
  creation fraud prevention); and logging and request sampling. Use when the user wants to protect a
  web application or API from common exploits, bots, credential stuffing, fake-account creation, or
  HTTP floods at the application layer (layer 7). Routes to the right per-task procedure in
  references. Do NOT use for L3/L4 DDoS protection (shieldadvanced skill), multi-account WAF rollout
  (firewallmanager skill), CloudFront configuration (cloudfront skill), or Route 53 health checks or
  records (route53 skill).
version: 1
---

# AWS WAF

## Overview

Domain expertise for configuring AWS WAF, the web application firewall that filters HTTP and HTTPS
traffic to CloudFront distributions, Application Load Balancers, API Gateway REST APIs, and AppSync
GraphQL APIs. Covers web ACL creation and association, AWS Managed Rules, rate-based rules, match
rules (IP set and geographic), Bot Control and the signal-forwarding workflows built on top of it,
Fraud Control for logins and signups, AI and LLM crawler management, and the logging that every
tuning workflow depends on.

This skill is a router. Each customer task maps to a procedure file under `references/`. Read the
matching reference in full before acting, then follow its constraints and steps. The reference
files are self-contained: each carries its own decision tables, constraints, procedure, and
troubleshooting.

Execute commands using the AWS MCP server when connected (sandboxed execution, audit logging,
observability). Fall back to the AWS CLI otherwise. A web ACL's scope is fixed at creation: a
CloudFront web ACL must be created in `us-east-1` with `CLOUDFRONT` scope, while a regional web ACL
(Application Load Balancer, API Gateway, AppSync) is created in the resource's Region with
`REGIONAL` scope.

## Which WAF task do you need?

| Goal                                               | Reference                                                                                                                    |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Create a web ACL and attach it to a resource       | [creating a web ACL and associating it with a resource](references/creating-a-web-acl-and-associating-it-with-a-resource.md) |
| Set up logging and sampling before tuning anything | [setting up logging and request sampling](references/setting-up-logging-and-request-sampling.md)                             |
| Add AWS Managed Rules and tune false positives     | [adding managed rules and tuning with count mode](references/adding-managed-rules-and-tuning-with-count-mode.md)             |
| Throttle HTTP floods and brute force               | [adding rate-based rules](references/adding-rate-based-rules.md)                                                             |
| Allow or block by IP range or country              | [using ip sets and geographic match rules](references/using-ip-sets-and-geographic-match-rules.md)                           |
| Detect and control bots (the on-ramp)              | [protecting against bots with bot control](references/protecting-against-bots-with-bot-control.md)                           |
| Collapse bot labels into one confidence signal     | [turning bot control labels into a confidence signal](references/turning-bot-control-labels-into-a-confidence-signal.md)     |
| Forward all signals to the origin with one rule    | [forwarding signals with dynamic label interpolation](references/forwarding-signals-with-dynamic-label-interpolation.md)     |
| Decide what the app does with the forwarded signal | [adaptive mitigation playbook for forwarded signals](references/adaptive-mitigation-playbook-for-forwarded-signals.md)       |
| Stop attackers from spoofing forwarded headers     | [stripping inbound waf headers before trusting them](references/stripping-inbound-waf-headers-before-trusting-them.md)       |
| Recover the real client IP behind a CDN            | [recovering the real client ip behind a cdn](references/recovering-the-real-client-ip-behind-a-cdn.md)                       |
| Protect logins and signups from fraud              | [protecting logins and signups with fraud control](references/protecting-logins-and-signups-with-fraud-control.md)           |
| See and manage AI and LLM crawler traffic          | [seeing and managing ai crawler traffic](references/seeing-and-managing-ai-crawler-traffic.md)                               |

## Routing notes

- **Logging comes before tuning.** Every Count-mode tuning workflow assumes logging and request
  sampling are on. If the customer has not set up logging, run that reference first; otherwise
  Count-mode tuning has nothing to read.
- **Web ACL scope is fixed at creation.** A CloudFront web ACL is `CLOUDFRONT` scope in
  `us-east-1`; a regional resource needs a `REGIONAL` web ACL in its own Region. Scope cannot be
  changed later, so the creating reference settles it before anything is built.
- **Bot Control is a chain, not one task.** Protecting against bots is the on-ramp (turn on, choose
  Common vs Targeted, observe). Turning labels into a confidence signal, forwarding that signal,
  and deciding what the application does with it are three separate references that build on it in
  that order. The header-stripping reference is the mandatory safety companion whenever a signal is
  forwarded to the origin.
- **Common vs Targeted is not a soft choice.** Common only catches self-identifying bots and
  known-bad IPs. For login, checkout, or any high-value endpoint facing evasive bots, Targeted with
  the application integration SDK is required. The bots reference pushes Targeted for real bot
  threats rather than presenting it as optional.
- **Rate limiting vs Fraud Control.** Rate-based rules blunt volumetric HTTP floods. Credential
  stuffing and fake-account creation are account-based abuse that rate limiting misses; those go to
  the Fraud Control reference (ATP and ACFP), not the rate-based reference.
- **Forwarded headers need the strip rule.** Any time the customer forwards a signal or the client
  IP to the origin in `x-amzn-waf-*` headers, the inbound-header-stripping reference is required to
  prevent spoofing. The confidence-signal, interpolation, and client-IP references all point at it.
- **What lives in other skills.** L3/L4 DDoS protection and Shield cost-protection credits are the
  shieldadvanced skill. Multi-account WAF rollout is the firewallmanager skill. CloudFront and
  Application Load Balancer configuration are their own skills. This skill builds the WAF rules; it
  does not configure the resources it protects.

## Security Considerations

AWS WAF is itself a security control, so misconfiguration directly weakens an application's defenses.
Apply these across every reference:

- **Least-privilege IAM.** You MUST grant only the specific `wafv2:` actions a task needs (for
  example `wafv2:CreateWebACL`, `wafv2:GetWebACL`, `wafv2:UpdateWebACL`, `wafv2:AssociateWebACL`,
  `wafv2:PutLoggingConfiguration`) rather than `wafv2:*` or the `AWSWAFFullAccess` managed policy.
- **Ephemeral credentials.** You MUST use IAM roles with temporary credentials (such as an EC2
  instance profile, SSO session, or `aws sts assume-role`) rather than long-lived IAM user access
  keys when running these WAF CLI commands.
- **Monitor configuration changes.** You SHOULD enable AWS CloudTrail on `wafv2` management events
  and set CloudWatch alarms on critical web ACL configuration changes (such as `DeleteWebACL` and
  `UpdateWebACL` rule removals) and on the web ACL's `BlockedRequests` and `CountedRequests`
  metrics, so rule changes and sudden spikes in blocked or counted traffic are detected.
- **Misconfiguration opens access.** A web ACL that is created but never associated, or one whose
  default action is left at `Allow` with no enforcing rules, filters nothing. You MUST confirm the
  web ACL is associated and that its posture matches the intended default (block vs allow) before
  reporting setup complete.
- **Protect log destinations.** Logs can capture credentials and session data. You MUST redact
  sensitive fields (such as the `authorization` header and `cookie`) and MUST enable encryption at
  rest on the log destination (CloudWatch Logs, Amazon S3, or Amazon Data Firehose).
- **Header-spoofing risk.** Any `x-amzn-waf-*` signal forwarded to the origin can be forged inbound.
  You MUST add the inbound-header-stripping rule whenever a signal or client IP is forwarded (see
  stripping-inbound-waf-headers-before-trusting-them).

## Additional Resources

- [AWS WAF Developer Guide](https://docs.aws.amazon.com/waf/latest/developerguide/waf-chapter.html)
- [How AWS WAF works (AWS WAF Developer Guide)](https://docs.aws.amazon.com/waf/latest/developerguide/how-aws-waf-works.html)
- [AWS WAF pricing](https://aws.amazon.com/waf/pricing/)
