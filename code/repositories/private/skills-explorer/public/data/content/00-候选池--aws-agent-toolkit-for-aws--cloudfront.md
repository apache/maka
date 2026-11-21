---
name: cloudfront
description: >
  Configures Amazon CloudFront content delivery across six workflows: when to use CloudFront and
  how it fits with AWS WAF, Shield, CloudFront Functions, Lambda@Edge, Route 53, and origins
  (creating a distribution, caching, and Flat Rate Pricing (FRP) versus pay-as-you-go pricing); managing
  custom-domain TLS certificates (ACM in us-east-1); configuring multi-tenant distributions;
  protecting origins with origin access control (OAC), VPC origins, and origin mutual TLS (mTLS);
  securing content with signed URLs and cookies, geographic restrictions, viewer mutual TLS, and
  edge token validation; and observing traffic with standard and real-time logs. Applicable when the
  customer wants to put CloudFront in front of content, choose pricing, lock an origin, restrict who
  can view content, or analyze logs. Not applicable for the Route 53 DNS side of a CloudFront custom
  domain or failover between distributions (see the route53-cloudfront skill), or for pure-Route 53
  DNS work (see the route53 skill).
version: 1
---

# Amazon CloudFront

## Overview

Domain expertise for configuring Amazon CloudFront content delivery: deciding when to use
CloudFront and how it fits the wider architecture, managing custom-domain certificates and
multi-tenant distributions, protecting origins, securing content, and observing traffic.

This skill is a router. Each customer task maps to a procedure file under `references/`. Read the
matching reference in full before acting, then follow its constraints and steps. The reference
files are self-contained: each carries its own decision tables, constraints, procedure, and
troubleshooting.

Execute commands using the AWS MCP server when connected (sandboxed execution, audit logging,
observability). Fall back to the AWS CLI otherwise. CloudFront is a global service; its API calls
and the AWS Certificate Manager (ACM) certificates it uses are made in `us-east-1` regardless of
where the customer's application runs.

## Which CloudFront task do you need?

| Goal                                                                                                                        | Reference                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Decide whether CloudFront is the right layer, see how it integrates, create a distribution, tune caching, or choose pricing | [when to use CloudFront](references/when-to-use-cloudfront.md)                               |
| Serve a custom domain over HTTPS, manage ACM certificates, or run many domains with a certificate per tenant                | [managing certificates with CloudFront](references/managing-certificates-with-cloudfront.md) |
| Make CloudFront the only way to reach the origin (S3 OAC, VPC origins, origin mutual TLS, security groups)                  | [protecting your origins](references/protecting-your-origins.md)                             |
| Limit who can view content by identity, location, client certificate, or auth token                                         | [securing your content](references/securing-your-content.md)                                 |
| Get visibility into traffic with standard and real-time logs, and analyze them                                              | [CloudFront observability](references/cloudfront-observability.md)                           |
| Serve multiple domains through shared configuration with per-tenant customization (SaaS, platform)                          | [multi-tenant distributions](references/multi-tenant-distributions.md)                       |

## Routing notes

- **Choosing the layer and creating a distribution vs the rest.** Whether CloudFront is the right
  entry layer, what it integrates with, creating a distribution, caching, and pricing live in the
  when-to-use reference. The other references assume a distribution exists and configure one
  aspect of it.
- **Protecting origins vs securing content.** Locking the origin so it is reachable only through
  CloudFront (OAC, VPC origins, origin mTLS) is the protecting-your-origins reference. Restricting
  which viewers can see content (signed URLs and cookies, geographic restrictions, viewer mTLS,
  edge token validation) is the securing-your-content reference. They are paired: a content control
  only holds when the origin is also locked.
- **Viewer mTLS vs origin mTLS.** Authenticating the client to CloudFront (viewer mTLS) is content
  security. Authenticating CloudFront to the origin (origin mTLS) is origin protection. Different
  controls, different references.
- **Custom domain certificate vs Route 53 DNS cutover.** Requesting and validating the ACM
  certificate and adding the alternate domain name is the managing-certificates reference here.
  Pointing the domain's DNS at the distribution, including the zone apex alias and any failover, is
  Route 53 work owned by the separate `route53-cloudfront` skill.

## Cross-service work

Pointing a custom domain's DNS at a CloudFront distribution, or failing over between distributions
with Route 53 records, is cross-service work owned by the separate `route53-cloudfront` skill. Use
this skill for the CloudFront-side configuration only.

## Additional Resources

- [Amazon CloudFront Developer Guide](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html)
- [Security best practices for Amazon CloudFront (Amazon CloudFront Developer Guide)](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/security-best-practices.html)
- [Amazon CloudFront product page](https://aws.amazon.com/cloudfront/)
- [Amazon CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/)
