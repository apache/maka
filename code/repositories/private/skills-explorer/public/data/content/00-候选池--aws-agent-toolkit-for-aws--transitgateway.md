---
name: transitgateway
description: >-
  Configures AWS Transit Gateway: creating a hub and attaching VPCs, segmenting traffic with route
  tables, centralizing egress and inspection through a hub (appliances or a Gateway Load Balancer
  endpoint), forcing east-west traffic between VPCs through AWS Network Firewall, connecting
  on-premises networks over the transit-gateway side of a Site-to-Site VPN or Direct Connect
  attachment (including ECMP to aggregate bandwidth across multiple VPN tunnels), peering transit
  gateways across Regions, migrating from a VPC peering mesh, and routing IP multicast. Applicable
  when connecting many VPCs through one router, isolating environments, forcing VPC-to-VPC traffic
  through a central Network Firewall, reaching on-premises over the hub, linking Regions, or moving
  off a peering mesh. Not applicable for single-VPC routing, VPC peering between two VPCs (vpcpeering
  skill), Direct Connect gateway or virtual interface setup (directconnect skill), or Route 53 DNS
  work.
version: 1
---

# AWS Transit Gateway

## Overview

Domain expertise for configuring AWS Transit Gateway, the Regional network hub that connects many
VPCs and on-premises networks through a single router instead of a mesh of point-to-point
connections. Covers building the hub and attaching VPCs, segmenting traffic with route tables,
centralizing egress and inspection, east-west inspection with AWS Network Firewall, hybrid
connectivity over Site-to-Site VPN and Direct Connect, inter-Region peering, migrating off a VPC
peering mesh, and IP multicast.

This skill is a router. Each customer task maps to a procedure file under `references/`. Read the
matching reference in full before acting, then follow its constraints and steps. The reference
files are self-contained: each carries its own decision tables, constraints, procedure, and
troubleshooting.

Execute commands using the AWS MCP server when connected (sandboxed execution, audit logging,
observability). Fall back to the AWS CLI otherwise. All CLI operations require least-privilege,
ephemeral credentials (an assumed IAM role through AWS STS or AWS IAM Identity Center / SSO), never
long-lived IAM user access keys. A transit gateway is a Regional resource: run each `aws ec2`
transit gateway command in the Region that holds the hub.

## Which Transit Gateway task do you need?

| Goal                                                               | Reference                                                                                                              |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Create a Regional hub and connect VPCs to it                       | [creating a transit gateway and attaching VPCs](references/creating-a-transit-gateway-and-attaching-vpcs.md)           |
| Isolate some VPCs while letting others share services              | [segmenting traffic with route tables](references/segmenting-traffic-with-route-tables.md)                             |
| Send all spoke traffic out through one inspected egress VPC        | [centralizing egress and inspection](references/centralizing-egress-and-inspection.md)                                 |
| Inspect traffic between VPCs with AWS Network Firewall             | [inspecting east-west traffic with Network Firewall](references/inspecting-east-west-traffic-with-network-firewall.md) |
| Reach on-premises networks over Site-to-Site VPN or Direct Connect | [connecting on-premises networks](references/connecting-on-premises-networks.md)                                       |
| Link transit gateways in two Regions over the AWS network          | [peering transit gateways across Regions](references/peering-transit-gateways-across-regions.md)                       |
| Move off a VPC peering mesh without dropping traffic               | [migrating from VPC peering](references/migrating-from-vpc-peering.md)                                                 |
| Distribute IP multicast across attached VPCs                       | [routing multicast traffic](references/routing-multicast-traffic.md)                                                   |

## Routing notes

- **Decide segmentation before you build.** "Default route table association" and "Default route
  table propagation" are on by default, which wires every attachment into one open mesh. If the
  customer plans isolated environments, the creating reference disables the defaults up front and
  hands off to the segmenting reference. Retrofitting isolation onto an open hub is a re-architect.
- **North-south egress vs east-west inspection.** Centralizing egress sends spoke traffic out to
  the internet through a central VPC. East-west inspection keeps traffic between spokes internal
  and forces it through a firewall on the way. They look similar but use different route table
  recipes. Match the reference to the direction of traffic the customer actually has.
- **Appliance vs Gateway Load Balancer for inspection.** Raw third-party appliances and a Gateway
  Load Balancer (GWLB) endpoint are two paths to the same goal. GWLB is the recommended approach
  for new designs. Both live in the centralizing-egress reference; appliance mode and the GWLB endpoint
  route table entries differ and the reference covers each.
- **Appliance mode is required for stateful cross-Availability-Zone inspection, with a tradeoff.** Appliance mode
  keeps each flow on one Availability Zone's appliance so request and response do not split. It
  also disables cross-Availability-Zone failover for that attachment, so the inspection design must
  pair it with health-check-based failover. Both the egress and east-west references carry this.
- **Transit gateway side vs Direct Connect side.** The connecting-on-premises reference covers the
  transit gateway side: Site-to-Site VPN attachment options, route propagation, and equal-cost multi-path
  (ECMP). The Direct Connect gateway and virtual interface setup belongs to the separate
  `directconnect` skill. Do not restate the Direct Connect side here.

## Security considerations

A transit gateway is the central routing point for many VPCs and on-premises networks, so a
misconfiguration here has blast radius across every attached network. Apply these controls
regardless of the specific task; each per-task reference carries the detail.

- You MUST enable Transit Gateway Flow Logs for traffic visibility, audit, and incident response
  across the hub, and MUST enable encryption at rest on the destination (a KMS key on the CloudWatch
  log group, or SSE-KMS on the S3 bucket).
- You MUST, when a KMS key encrypts a flow log destination (CloudWatch log group or S3 bucket) or a
  CloudTrail destination, scope the KMS key policy with condition keys (`aws:SourceArn`,
  `aws:SourceAccount`, and `kms:ViaService`) so only the specific log group, bucket, or trail in the
  expected account and service can use the key, preventing cross-account or cross-service misuse.
- You SHOULD apply least-privilege IAM for transit gateway administration, avoiding service
  wildcards and FullAccess policies, restricting who can create attachments, modify route tables,
  and change associations or propagations.
- You SHOULD ensure Site-to-Site VPN tunnels use strong encryption (for example AES-256-GCM with IKEv2) and enable tunnel
  logging to CloudWatch Logs with encryption enabled (a KMS key) to protect sensitive connection
  state and IKE negotiation detail from unauthorized access (see the connecting on-premises networks
  reference).
- You MUST treat a misconfigured transit gateway route table as a security risk, since wrong
  associations or propagations can expose workloads across environments meant to stay isolated (see
  the segmenting traffic reference).
- You MUST enable AWS CloudTrail to detect unauthorized changes to transit gateway route tables,
  associations, and propagations, MUST enable encryption at rest on the CloudTrail destination (a KMS
  key), and use AWS Config rules to detect drift from the intended design.

## Additional Resources

- [AWS Transit Gateway Guide](https://docs.aws.amazon.com/vpc/latest/tgw/what-is-transit-gateway.html)
- [AWS Transit Gateway product page](https://aws.amazon.com/transit-gateway/)
- [AWS Transit Gateway pricing](https://aws.amazon.com/transit-gateway/pricing/)
