---
name: directconnect
description: >-
  Configures AWS Direct Connect: choosing a connection model (dedicated, hosted, or a link
  aggregation group) and completing the cross connect; creating private, public, and transit virtual
  interfaces and bringing up BGP; reaching many VPCs through a Direct Connect gateway including
  cross-account transit gateway associations; encrypting traffic with MACsec or a private IP
  Site-to-Site VPN; making the connection resilient and tuning failover; managing link aggregation
  groups; SiteLink; and migrating from a virtual private gateway to a transit gateway. Use when the
  user wants a private, consistent network link between a data center and AWS, or operates an
  existing Direct Connect setup and needs to extend, encrypt, or harden it. Routes to the right
  per-task procedure in references. Do NOT use for transit gateway route tables and attachments
  (transitgateway skill), Site-to-Site VPN without Direct Connect (sitetositevpn skill), or Route 53
  DNS routing (route53 skill).
version: 1
---

# AWS Direct Connect

## Overview

Domain expertise for configuring AWS Direct Connect, the service that gives a customer a private,
consistent network link between their own data center or colocation and AWS instead of routing over
the public internet. Covers choosing a connection model and completing the cross connect, creating
virtual interfaces and bringing up Border Gateway Protocol (BGP), reaching many VPCs through a
Direct Connect gateway, encrypting traffic in transit, making the connection resilient, managing
link aggregation groups, SiteLink, and migrating from a virtual private gateway to a transit
gateway.

This skill is a router. Each customer task maps to a procedure file under `references/`. Read the
matching reference in full before acting, then follow its constraints and steps. The reference
files are self-contained: each carries its own decision tables, constraints, procedure, and
troubleshooting.

Execute commands using the AWS MCP server when connected (sandboxed execution, audit logging,
observability). Fall back to the AWS CLI otherwise. The Direct Connect console is regional, so pass
the customer's working `--region` on `aws directconnect` commands; a Direct Connect gateway is a
global resource but is reached through a regional console view.

## Which Direct Connect task do you need?

| Goal                                                                                    | Reference                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choose dedicated vs hosted vs a link aggregation group, then complete the cross connect | [choosing a Direct Connect connection type](references/choosing-a-direct-connect-connection-type.md)                                                        |
| Create a private, public, or transit virtual interface and bring up BGP                 | [creating a virtual interface and configuring BGP](references/creating-a-direct-connect-virtual-interface-and-configuring-bgp.md)                           |
| Reach many VPCs over one connection through a Direct Connect gateway                    | [connecting many VPCs through a Direct Connect gateway](references/connecting-many-vpcs-through-a-direct-connect-gateway.md)                                |
| Encrypt traffic in transit with MACsec or a private IP Site-to-Site VPN                 | [encrypting traffic over Direct Connect](references/encrypting-traffic-over-direct-connect.md)                                                              |
| Make the connection survive a failure and tune failover speed                           | [making a Direct Connect connection resilient](references/making-a-direct-connect-connection-resilient.md)                                                  |
| Bundle connections into one logical link and manage members                             | [managing link aggregation groups](references/managing-direct-connect-link-aggregation-groups.md)                                                           |
| Connect on-premises sites to each other over the AWS backbone                           | [setting up SiteLink](references/setting-up-direct-connect-sitelink.md)                                                                                     |
| Move from a virtual private gateway to a transit gateway without dropping traffic       | [migrating from a virtual private gateway to a transit gateway](references/migrating-direct-connect-from-a-virtual-private-gateway-to-a-transit-gateway.md) |

## Routing notes

- **Connection model comes first.** The choosing-a-connection-type reference is the entry point for
  a customer with no link yet. It settles dedicated vs hosted vs a link aggregation group, checks
  location support for the chosen speed, and separates a hosted connection from a hosted virtual
  interface, a distinction customers confuse constantly. Run it before any cross connect is ordered,
  since port speed cannot change after the connection is created.
- **A connection carries no traffic until a virtual interface exists.** After the cross connect is
  live, the creating-a-virtual-interface reference is the required next step. The virtual interface
  type (private, public, or transit) decides what the connection can reach and is fixed at creation.
  The jumbo-frame maximum transmission unit (MTU) should be set at creation but, on a private or
  transit virtual interface, can be changed later with a brief connectivity disruption.
- **One VPC vs many VPCs.** A single VPC in one Region can be reached over a private virtual
  interface to a virtual private gateway. Reaching many VPCs, crossing accounts, or crossing Regions
  is the Direct Connect gateway reference, which also owns the cross-account transit gateway
  proposal-and-acceptance handshake.
- **Encryption is a separate, deliberate step.** Direct Connect is not encrypted in transit by
  default. The encrypting-traffic reference compares MACsec (Layer 2, over the cross connect) against
  a private IP Site-to-Site VPN over a transit virtual interface (the recommended IPsec path). Route
  here whenever the customer mentions regulated data or encryption.
- **Resiliency model vs failover speed are two different questions.** The resiliency reference covers
  both: the Resiliency Toolkit sets the topology and service level target, while BGP hold-timer
  tuning and Bidirectional Forwarding Detection (BFD) set how fast failover actually converges.
- **Link aggregation group as a model vs as ongoing management.** The connection-type reference
  introduces the link aggregation group as a model choice at order time. The managing-link-aggregation-groups
  reference owns ongoing member add/remove and minimum-links behavior, where removing a member can
  take the whole group down.
- **Migration is order-dependent.** The virtual-private-gateway-to-transit-gateway migration
  reference exists because doing the cutover steps out of order drops production traffic. Route any
  "we outgrew the single-VPC model" request here rather than to the plain Direct Connect gateway
  reference.

## Security Considerations

Direct Connect provides a private link into VPC resources, so the security posture differs from the
public internet path. Carry these into every task:

- **Not encrypted by default.** Direct Connect does not encrypt traffic in transit. You MUST treat
  encryption as a separate, deliberate step (MACsec or a private IP Site-to-Site VPN) before
  regulated or sensitive data crosses the link. See the encrypting-traffic reference.
- **Physical and colocation security.** The link terminates on customer equipment at a Direct Connect
  location or partner colocation. You SHOULD remind the customer that physical access control and
  partner trust at that facility are part of the connection's security boundary.
- **Monitoring and alerting.** You SHOULD recommend CloudWatch alarms on connection state and virtual
  interface BGP status so connection-state changes and failures trigger alerts rather than relying on
  manual detection.
- **Audit logging.** You SHOULD confirm CloudTrail is enabled and logging `directconnect` API calls
  (connection, virtual interface, and gateway-association changes) so all configuration changes are
  captured for audit and compliance.
- **CloudWatch Logs encryption.** You SHOULD encrypt CloudWatch Logs log groups that receive Direct
  Connect-related logs or alarm state data with a KMS key, so sensitive connection metadata is
  protected at rest.
- **Least-privilege IAM.** You MUST scope IAM permissions for `directconnect` API actions to the
  specific actions and resources each principal needs, and prefer ephemeral IAM credentials
  over long-lived IAM user access keys. You MUST NOT grant `directconnect:*` on resource `*` or attach
  any `*FullAccess` managed policy; instead scope actions to specific resource ARNs, e.g.
  `arn:aws:directconnect:*:*:dxcon/{connection_id}` for a connection, so a compromised principal cannot
  touch every Direct Connect resource in the account.
- **Route leaks between VPCs.** You SHOULD warn that advertising a supernet that overlaps VPC CIDRs
  can cause unintended VPC-to-VPC traffic over a shared Direct Connect gateway; mitigate with specific
  prefixes, separate gateways, or transit gateway blackhole routes.

## Additional Resources

- [AWS Direct Connect User Guide](https://docs.aws.amazon.com/directconnect/latest/UserGuide/Welcome.html)
- [Security in AWS Direct Connect (AWS Direct Connect User Guide)](https://docs.aws.amazon.com/directconnect/latest/UserGuide/security.html)
- [AWS Direct Connect product page](https://aws.amazon.com/directconnect/)
- [AWS Direct Connect pricing](https://aws.amazon.com/directconnect/pricing/)
