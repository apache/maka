---
name: sitetositevpn
description: >
  Configures AWS Site-to-Site VPN: creating an IPsec VPN connection between an on-premises network
  and a VPC, choosing the target gateway (virtual private gateway, transit gateway, or AWS Cloud
  WAN), choosing static or dynamic (BGP) routing, sizing tunnel bandwidth (Standard 1.25 Gbps or
  Large 5 Gbps), connecting many sites through a VPN Concentrator, applying the customer gateway
  device configuration, making a connection highly available, and monitoring tunnels with
  CloudWatch. Applicable when the user wants to connect a data center or branch office to AWS over
  an encrypted tunnel, choose how routes are exchanged, scale throughput, consolidate sites, or
  diagnose a down tunnel. Routes to the right per-task procedure in references. Not for AWS Direct
  Connect (its own service), Client VPN for individual remote users, the transit gateway side of a
  VPN attachment (transitgateway skill), or Route 53 DNS work.
version: 1
---

# AWS Site-to-Site VPN

## Overview

Domain expertise for configuring AWS Site-to-Site VPN, the managed service that builds an encrypted
IP Security (IPsec) connection between an on-premises network and AWS. Covers the routing decision
(static versus dynamic (BGP) routing), creating the connection and its dependent resources in the right order,
sizing tunnel bandwidth, consolidating many sites through a VPN Concentrator, applying the customer
gateway device configuration, building for high availability, and monitoring and troubleshooting
tunnels.

This skill is a router. Each customer task maps to a procedure file under `references/`. Read the
matching reference in full before acting, then follow its constraints and steps. The reference
files are self-contained: each carries its own decision tables, constraints, procedure, and
troubleshooting.

Execute commands using the AWS MCP server when connected (sandboxed execution, audit logging,
observability). Fall back to the AWS CLI otherwise. Site-to-Site VPN is a regional service: pass
`--region {region}` matching the VPC or transit gateway the connection terminates on.

## Which Site-to-Site VPN task do you need?

| Goal                                                                         | Reference                                                                                                              |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Decide between static and dynamic (BGP) routing before creating a connection | [choosing static or dynamic routing](references/choosing-static-or-dynamic-routing.md)                                 |
| Create an encrypted VPN connection from on-premises to a VPC                 | [creating a site-to-site vpn connection](references/creating-a-site-to-site-vpn-connection.md)                         |
| Size tunnel bandwidth at Standard (1.25 Gbps) or Large (5 Gbps)              | [choosing tunnel bandwidth](references/choosing-tunnel-bandwidth-standard-or-large.md)                                 |
| Connect 25 or more low-bandwidth sites through one shared attachment         | [connecting many sites with a vpn concentrator](references/connecting-many-sites-with-a-vpn-concentrator.md)           |
| Configure the on-premises customer gateway device                            | [applying the customer gateway device configuration](references/applying-the-customer-gateway-device-configuration.md) |
| Make the connection survive tunnel maintenance and device failure            | [making a connection highly available](references/making-a-connection-highly-available.md)                             |
| Detect a down tunnel and find out why                                        | [monitoring and troubleshooting tunnels](references/monitoring-and-troubleshooting-tunnels.md)                         |

## Routing notes

- **Decide routing before you build.** The static-versus-dynamic decision shapes the customer
  gateway, the failover behavior, and whether the customer can control which routes enter their
  network. Run the choosing-static-or-dynamic-routing reference before creating the connection so
  the customer does not have to recreate it to change routing type.
- **The target gateway gates almost everything.** A virtual private gateway terminates the VPN at
  one VPC. A transit gateway fronts many VPCs and is the only target that supports Large (5 Gbps)
  tunnels, equal-cost multi-path (ECMP) bandwidth aggregation, IPv6 customer gateways, and the VPN
  Concentrator. The gateway choice lives in the creating reference and is referenced again by the
  bandwidth and concentrator references, because picking a virtual private gateway closes those
  doors.
- **Bandwidth sizing vs the Concentrator.** Both scale capacity, in opposite directions. Large
  tunnels give one connection more throughput (up to 5 Gbps per tunnel); the Concentrator gives
  many low-bandwidth sites a shared 5 Gbps attachment so each site does not need its own
  full-bandwidth connection. Match the reference to whether the customer has one high-throughput
  site or many small ones.
- **AWS side vs device side.** Creating the connection and downloading the configuration happen on
  the AWS side; applying that configuration happens on the customer's on-premises device, which AWS
  never touches. The applying-the-customer-gateway-device-configuration reference is device-side
  education, not an AWS-side step.
- **Monitoring is its own task.** Detecting and diagnosing a down tunnel (CloudWatch metrics,
  alarms, and VPN logs) is the monitoring reference, separate from building the connection.

## Additional Resources

- [AWS Site-to-Site VPN User Guide](https://docs.aws.amazon.com/vpn/latest/s2svpn/VPC_VPN.html)
- [AWS Site-to-Site VPN product page](https://aws.amazon.com/vpn/site-to-site-vpn/)
- [AWS VPN pricing](https://aws.amazon.com/vpn/pricing/)
