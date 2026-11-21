---
name: route53
description: >-
  Configures Amazon Route 53 DNS: public and private records, traffic-steering routing policies,
  health checks, DNS Firewall, Route 53 Profiles, VPC Resolver (also known as Route 53 Resolver) for
  hybrid and Outposts networks, and Global Resolver. Applicable when the customer wants to point a
  hostname at a target, split or fail over traffic across endpoints, monitor an endpoint, block
  malicious domains, centralize DNS across accounts, or resolve private DNS across a hybrid network.
  Routes to the right per-task procedure in references. Does not cover CloudFront-specific setup (see
  the route53-cloudfront skill) or non-DNS networking.
version: 1
---

# Amazon Route 53

## Overview

Domain expertise for configuring Amazon Route 53 DNS across the public and private resolution
paths: hosted zone records, traffic-steering routing policies, health checks, DNS Firewall,
Route 53 Profiles, VPC Resolver (also known as Route 53 Resolver) for hybrid and Outposts networks,
and Global Resolver.

This skill is a router. Each customer task maps to a procedure file under `references/`. Read the
matching reference in full before acting, then follow its constraints and steps. The reference
files are self-contained: each carries its own decision tables, constraints, procedure, and
troubleshooting.

Execute commands using the AWS MCP server when connected (sandboxed execution, audit logging,
observability). Fall back to the AWS CLI otherwise. All Route 53 Domains API calls are made in
`us-east-1` regardless of where the customer works.

## Which Route 53 task do you need?

| Goal                                                                           | Reference                                                                                                |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| Point a hostname or zone apex at an IP, AWS resource, or hostname              | [creating a public DNS record](references/creating-a-public-dns-record.md)                               |
| Split traffic across endpoints in a ratio (blue/green, canary, A/B)            | [splitting traffic with weighted routing](references/splitting-traffic-with-weighted-routing.md)         |
| Fail over between two Regions for disaster recovery                            | [configuring failover routing](references/configuring-failover-routing.md)                               |
| Monitor whether an endpoint is up and get alerted                              | [setting up a health check](references/setting-up-a-route53-health-check.md)                             |
| Block malicious domains for a VPC at the resolver                              | [blocking malicious domains](references/blocking-malicious-domains.md)                                   |
| Work out which DNS Firewall rule wins for a domain across multiple rule groups | [identifying the effective DNS Firewall rule](references/identifying-the-effective-dns-firewall-rule.md) |
| Apply one DNS config across many VPCs and accounts                             | [configuring Route 53 Profiles](references/configuring-route53-profiles.md)                              |
| Fan DNS Firewall out across many accounts org-wide                             | [centralizing DNS Firewall with Profiles](references/centralizing-dns-firewall.md)                       |
| Resolve private DNS both ways across a hybrid network                          | [resolving private DNS for hybrid networks](references/resolving-private-dns-for-hybrid-networks.md)     |
| Run VPC Resolver locally on an AWS Outposts rack                               | [running VPC Resolver on Outposts](references/running-route53-resolver-on-outposts.md)                   |
| Give on-premises and remote clients one anycast DNS endpoint                   | [setting up Global Resolver](references/setting-up-route53-global-resolver.md)                           |

## Routing notes

- **Records vs routing policies.** A plain hostname-to-target mapping is the public DNS record
  task. Splitting or steering traffic (weighted, failover) is a separate routing-policy task with
  its own reference. Start from the customer's intent, not the record type.
- **Health checks vs failover.** A health check monitors an endpoint and raises alarms. The
  failover routing policy decides where traffic goes when a check fails. They are two references
  and are often used together: set up the health check, then wire it into failover.
- **DNS Firewall for one VPC vs many accounts.** Authoring rules for a VPC is the blocking
  reference. Fanning the same protection across accounts with Profiles and Firewall Manager is the
  centralizing reference.
- **DNS Firewall authoring vs diagnosis.** Creating or changing rules is the blocking reference.
  Working out which rule already wins for a domain when several rule groups are associated (a read
  and diagnostic task) is the identifying-the-effective-rule reference.
- **Profiles, two entry points.** General Profile setup (attach resources, share via RAM, cost
  and visibility tradeoffs) is the configuring-Profiles reference. Using Profiles specifically to
  scale DNS Firewall org-wide is the centralizing reference.
- **VPC Resolver, three contexts.** In-Region hybrid resolution, the Outposts-local resolver, and
  the Global Resolver anycast endpoint are three separate references. Match the reference to where
  the resolver runs.

## Cross-service work

Pointing a custom domain at a CloudFront distribution, or failing over between CloudFront
distributions, is cross-service work owned by the separate `route53-cloudfront` skill. Use this
skill for the Route 53 side of pure-Route 53 tasks only.

## Security Considerations

These apply across the Route 53 tasks below; each reference repeats the ones load-bearing for its
workflow.

- You SHOULD use least-privilege IAM credentials provisioned through IAM roles (instance profiles,
  SSO/IAM Identity Center session credentials, or `aws sts assume-role`) rather than long-lived IAM
  user access keys, and prefer read-only credentials for inspection steps.
- You SHOULD recommend encrypted DNS transport (DoT or DoH) over plaintext Do53 for resolver client
  populations, since Do53 exposes queried domain names to on-path observers.
- You MUST scope resolver-endpoint security group rules on port 53 to the on-premises CIDR ranges or
  known DNS server IPs, never `0.0.0.0/0`.
- You MUST encrypt query log and notification destinations at rest: KMS on CloudWatch Logs log
  groups, SSE-S3/SSE-KMS on S3 buckets, server-side encryption (SSE) on a Data Firehose stream, and
  SSE on SNS topics, because DNS query logs and health-check notifications can reveal infrastructure
  topology.
- For Global Resolver, you MUST treat access-token `value` returned at create time as a secret;
  store it in AWS Secrets Manager rather than in plaintext, and validate which client populations
  each DNS view authorizes.

## Additional Resources

- [Amazon Route 53 Developer Guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/Welcome.html)
- [Amazon Route 53 product page](https://aws.amazon.com/route53/)
- [Route 53 pricing](https://aws.amazon.com/route53/pricing/)
