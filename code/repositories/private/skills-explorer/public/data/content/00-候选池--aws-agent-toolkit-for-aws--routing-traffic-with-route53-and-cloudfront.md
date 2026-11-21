---
name: routing-traffic-with-route53-and-cloudfront
description: Configures Amazon Route 53 to route traffic to a CloudFront distribution using a custom domain. Use when setting up DNS alias records, alternate domain names (CNAMEs), ACM certificates for HTTPS, and IPv6 support for CloudFront.
version: 1
---

# Routing Traffic with Route 53 and CloudFront

## Overview

Domain expertise for configuring Amazon Route 53 to route traffic to Amazon CloudFront distributions using custom domain names. Covers hosted zone management, alias A/AAAA records, alternate domain name (CNAME) configuration, and ACM certificate setup for HTTPS.

## Configure Route 53 to route traffic to a CloudFront distribution

To set up a custom domain for a CloudFront distribution with Route 53 DNS, follow the procedure exactly.
See [Route 53 CloudFront routing procedure](references/route53-cloudfront-routing.md).

The procedure covers:

- Verifying CloudFront distribution status and CNAME configuration
- Requesting and validating ACM certificates (must be in us-east-1)
- Creating or locating public hosted zones
- Creating alias A and AAAA records pointing to CloudFront
- Monitoring DNS propagation

## Troubleshooting

### Domain not in CloudFront CNAMEs

Add the domain as an alternate domain name in the CloudFront distribution configuration before creating Route 53 records.

### SSL certificate issues

ACM certificates for CloudFront must be in us-east-1. Ensure the certificate is validated and associated with the distribution.

### Private hosted zone

CloudFront only works with public hosted zones. Create a public hosted zone if only a private one exists.

### DNS propagation delays

Changes typically propagate within 60 seconds but full global propagation can take up to 48 hours. Use `nslookup` or `dig` to verify.
