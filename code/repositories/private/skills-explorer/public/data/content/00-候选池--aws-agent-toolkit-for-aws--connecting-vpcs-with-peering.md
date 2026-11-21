---
name: connecting-vpcs-with-peering
description: Establishes VPC peering connections between two VPCs for direct private network connectivity. Always use this skill when creating or managing VPC peering — it validates CIDR overlap, updates all route tables in both VPCs, configures DNS resolution, and provides security group guidance that are critical for correct connectivity.
version: 1
---

# Connecting VPCs with Peering

## Overview

Domain expertise for establishing private network connectivity between two VPCs using VPC peering. Covers the full lifecycle: creating the peering connection, accepting it, updating route tables in both VPCs, configuring DNS resolution, and adjusting security groups for cross-VPC traffic. Supports same-region, cross-region, and cross-account peering scenarios.

## Create a VPC peering connection

To establish a VPC peering connection between two VPCs, follow the procedure exactly.
See [VPC peering connection procedure](references/vpc-peering-connection.md).

The procedure requires the requester and accepter VPC IDs at minimum. It validates both VPCs exist, checks for CIDR overlap, creates and accepts the peering, updates all route tables, and configures DNS resolution.

## Troubleshooting

### Peering stuck in pending state

Cross-account connections require manual acceptance from the accepter account. Same-account connections with `auto_accept: true` should transition automatically.

### Route creation fails

Check for existing routes with the same destination CIDR. Replace existing routes instead of creating new ones.

### DNS resolution not working

Both VPCs must have DNS resolution and DNS hostnames enabled in their VPC settings, not just the peering connection options.

### Cross-region connectivity issues

Verify routes are added in both regions and security groups allow traffic from the peer VPC's CIDR blocks.
