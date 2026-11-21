---
name: shieldadvanced
description: >-
  Configures AWS Shield Advanced for enhanced Distributed Denial of Service (DDoS) protection:
  subscribing accounts and adding resource protections, enabling automatic application layer (layer 7)
  mitigation through AWS WAF, configuring health-based detection with Route 53 health checks, setting
  up Shield Response Team (SRT) access and proactive engagement, reviewing DDoS events and requesting
  cost protection credits, and aggregating resources into protection groups. Applicable when the user
  wants stronger DDoS protection for internet-facing resources (CloudFront, Application or Network
  Load Balancers, Elastic IP addresses, Global Accelerator, or Route 53 hosted zones), wants expert
  help during an attack, or wants to recover attack-driven scaling charges. Routes to the right
  per-task procedure in references. Not applicable for authoring AWS WAF rules (waf skill), creating
  Route 53 health checks (route53 skill), or org-wide Shield Advanced rollout with Firewall Manager
  (firewallmanager skill).
version: 1
---

# AWS Shield Advanced

## Overview

Domain expertise for configuring AWS Shield Advanced, the paid tier that adds enhanced Distributed
Denial of Service (DDoS) protection, automatic application layer mitigation, attack visibility, expert support, and
cost protection on top of the always-on AWS Shield Standard. Covers subscribing and protecting
resources, automatic application layer mitigation, health-based detection, Shield Response Team
(SRT) access and proactive engagement, event review and cost protection credits, and protection
groups.

This skill is a router. Each customer task maps to a procedure file under `references/`. Read the
matching reference in full before acting, then follow its constraints and steps. The reference
files are self-contained: each carries its own decision tables, constraints, procedure, and
troubleshooting.

Execute commands using the AWS MCP server when connected (sandboxed execution, audit logging,
observability). Fall back to the AWS CLI otherwise. Shield Advanced is a global service: its
control-plane API calls run in `us-east-1`, so pass `--region us-east-1` on every `aws shield`
command.

## Which Shield Advanced task do you need?

| Goal                                                                           | Reference                                                                                                                        |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Decide whether Shield Advanced is needed at all (vs Shield Standard + AWS WAF) | [deciding between Shield Standard and Advanced](references/deciding-between-shield-standard-and-advanced.md)                     |
| Subscribe an account and add resources to protection                           | [subscribing to Shield Advanced and protecting resources](references/subscribing-to-shield-advanced-and-protecting-resources.md) |
| Respond to layer 7 floods automatically through AWS WAF                        | [enabling automatic application layer mitigation](references/enabling-automatic-application-layer-mitigation.md)                 |
| Feed resource health into detection with a Route 53 health check               | [configuring health-based detection](references/configuring-health-based-detection.md)                                           |
| Get the Shield Response Team to act or reach out during an attack              | [setting up SRT support and proactive engagement](references/setting-up-srt-support-and-proactive-engagement.md)                 |
| Review a DDoS event and recover attack-driven scaling charges                  | [reviewing DDoS events and requesting cost protection](references/reviewing-ddos-events-and-requesting-cost-protection.md)       |
| Treat related resources as one unit for detection                              | [aggregating resources into protection groups](references/aggregating-resources-into-protection-groups.md)                       |

## Routing notes

- **Decide before you subscribe.** Shield Advanced is a paid subscription that auto-renews on a
  one-year commitment. Before subscribing, confirm the customer actually needs it: Shield Standard
  (free, always on) plus AWS WAF rate-based rules and the AWS WAF Anti-DDoS managed rule group
  (`AWSManagedRulesAntiDDoSRuleSet`) covers many layer 7 cases at lower cost. Route to the deciding
  reference first when the customer has not made that call; route to the waf skill for the WAF rules
  themselves.
- **Subscribe and protect comes first.** A subscription protects nothing on its own; resources have
  to be added explicitly. Every other task here assumes the resource is already subscribed and
  protected. Run the subscribing reference before any of the others if the customer is starting
  from scratch.
- **Automatic mitigation vs health-based detection.** These are different controls and customers
  conflate them. Automatic application layer mitigation deploys AWS WAF rules during a layer 7
  attack. Health-based detection feeds a Route 53 health check into Shield Advanced's detection so it
  reacts sooner. A customer can run either, both, or neither. Pick the reference that matches what they
  actually want.
- **Health check is also an SRT prerequisite.** Proactive engagement (SRT reaching out) requires a
  Route 53 health check on the protected resource. If the customer wants proactive engagement,
  configuring health-based detection is the groundwork. The SRT reference points back to the
  health-based detection reference for that step.
- **Protection groups are detection-only.** A protection group changes how Shield Advanced detects
  across a set of resources. It does not apply shared mitigation; automatic mitigation still works per
  resource. Use the protection-groups reference for detection tuning, not as a mitigation control.
- **WAF rules, health checks, and org rollout live elsewhere.** Authoring the AWS WAF rules, the
  rate-based rule, or the web ACL is the waf skill. Creating the Route 53 health check is the
  route53 skill. Rolling Shield Advanced across an organization with Firewall Manager is the
  firewallmanager skill. This skill wires Shield Advanced to those pieces; it does not build them.
  AWS WAF is not optional alongside Shield Advanced: you SHOULD recommend an AWS WAF web ACL on
  every internet-facing protected resource (CloudFront distributions and Application Load Balancers)
  as defense in depth — Shield Advanced and AWS WAF are complementary layer 3/4 and layer 7
  controls, and the rate-based rule that AWS WAF provides is also what cost protection requires.

## Logging and monitoring

Visibility into both configuration changes and attack activity matters for every task here.

- You SHOULD recommend enabling AWS CloudTrail so all Shield Advanced API calls (subscription,
  protection, SRT, and protection-group changes) are logged for audit purposes.
- You SHOULD recommend enabling SSE-KMS encryption on the CloudTrail log bucket and CloudWatch Logs
  log group, since CloudTrail records sensitive API metadata (caller identities, resource ARNs,
  parameters) that must be encrypted at rest.
- You SHOULD recommend CloudWatch alarms on Shield Advanced metrics (for example `DDoSDetected` and
  `DDoSAttackBitsPerSecond`) so operations staff are alerted when an event is detected.
- You SHOULD recommend encrypting any SNS topics used for those alarms with SSE-KMS, since the
  notifications carry sensitive event data.
- You SHOULD recommend confirming that all SNS topic subscribers for Shield Advanced alarms are
  authorized personnel approved to receive sensitive DDoS event notifications.

## Security considerations

Shield Advanced setup creates IAM trust relationships and exposes log data, so call out the risks
and the controls that contain them.

- **SRT role is a third-party principal.** Granting SRT access creates an IAM role that
  `drt.shield.amazonaws.com` assumes to act in the account. Scope its trust policy with an
  `aws:SourceAccount` condition equal to the account ID to prevent confused-deputy assumption, grant
  it only the actions it needs, and revoke it with `disassociate-drt-role` when no longer required.
- **Log buckets shared with the SRT can leak data.** AWS WAF and access logs capture request URIs,
  headers, and client IPs. Confirm those buckets have server-side encryption and carry no clear-text
  PII or secrets before sharing them with the SRT.
- **Least privilege for the operator.** Scope the caller's IAM permissions to the minimum each
  procedure needs rather than broad Shield or administrator access.
- **Audit trail.** Keep AWS CloudTrail enabled and logging `shield:*` calls so every configuration
  change leaves a record.

## Additional Resources

- [AWS Shield Advanced overview (AWS WAF, AWS Firewall Manager, and AWS Shield Advanced Developer Guide)](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-overview.html)
- [How AWS Shield works (AWS WAF, AWS Firewall Manager, and AWS Shield Advanced Developer Guide)](https://docs.aws.amazon.com/waf/latest/developerguide/ddos-how-shield-works.html)
- [AWS Shield Advanced pricing](https://aws.amazon.com/shield/pricing/)
