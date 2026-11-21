---
name: aws-vpc-dns-investigation
description: Use this skill when a name is not resolving as expected inside a VPC, or before applying a DNS control-plane change. Activate on symptoms such as NXDOMAIN or SERVFAIL from an EC2 instance, a hostname resolving to a public address when a private endpoint was expected, an AWS service endpoint that stopped resolving after a VPC endpoint or Route 53 change, an application reaching the wrong IP, resolution that works from one instance but not another, IPv6 or dualstack resolution differences, a suspected on-premises forwarding or hybrid DNS problem, or a request to check whether enabling private DNS, adding a Resolver rule, associating a private hosted zone, attaching DNS Firewall, or associating a Route 53 Profile would break anything. It drives the aws-vpc-dns-diagnostics MCP server to observe live resolution from inside the subnet and to simulate a proposed change before it is applied.
metadata:
  author: ddericco
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Incident RCA"
  aws-devops-agent-skills.aws-services: "Amazon VPC, Amazon Route 53, Amazon EC2, AWS Systems Manager"
  aws-devops-agent-skills.technical-domains: "Networking"
---

# Investigate VPC DNS Resolution

Use the tools on the connected `aws-vpc-dns-diagnostics` MCP server.

## Step 1: Classify the request as Mode A or Mode B

Before calling any tool, determine which mode applies:

- **Mode A (live diagnosis):** The operator reports a resolution symptom from a
  running instance. They provide an instance ID (or you can identify one). The
  goal is to observe what actually resolves and compare resolvers.
- **Mode B (pre-change validation):** The operator asks whether a proposed DNS
  change is safe. They provide account, region, VPC, and a change descriptor.
  No instance is required.

If the request is ambiguous, ask the operator to clarify. Do not default to
Mode A when the input lacks an instance ID, and do not default to Mode B when
the operator describes a live symptom.

## Step 2: Load safety rules

Regardless of mode, call `get_sop` with slug `A-critical-safety-rules` and
follow every rule it contains. These are non-negotiable constraints on how you
interpret results, handle opaque constructs, and report findings.

---

## Mode A route: live diagnosis

### Required inputs

account_id, region, instance_id, and the failing DNS name.

### Tool sequence (in order)

1. `dns_probe_context` — establishes VPC-attribute preconditions: enableDnsSupport,
   enableDnsHostnames, address family, DHCP option set. A resolution result means
   nothing until you know whether the VPC resolver is answering.
2. `dns_probe_compare` — runs the allowlisted probe set inside the instance via
   SSM. Returns each resolver's answer and the resolver's own identity from
   `hostname.bind`. The VPC DHCP resolver is auto-added for comparison.
3. `get_sop` — load the pattern runbook matching the observed signature
   (see trap-to-SOP mapping below).

### Interpretation rules

- If `enableDnsSupport` is false: load `A-resolver-disabled-precondition`. The
  VPC resolver is intentionally dark and every probe failure follows from that.
- Compare the instance's `/etc/resolv.conf` (from the probe output) against the
  DHCP option set. A mismatch means the instance is not using the VPC-intended
  resolver.
- Judge answers by name category (load `A-name-category-classification`), not by
  whether resolvers agree. Two resolvers returning the same wrong answer is still
  a failure.

### Mode A trap-to-SOP mapping

| Observed signature                              | SOP slug                                |
| ----------------------------------------------- | --------------------------------------- |
| Custom resolver answers differently from VPC .2 | `A-custom-resolver-divergence`          |
| FORWARD rule and PHZ both match the name        | `A-forward-vs-phz-precedence-collision` |
| A record works, AAAA fails (or vice versa)      | `A-address-family-divergence`           |
| enableDnsSupport is false                       | `A-resolver-disabled-precondition`      |
| General live comparison procedure               | `A-mode-a-live-resolver-comparison`     |

### Reporting format for Mode A

Label every finding as **Observed** (ground truth from the probe). State which
resolver answered and what it returned. When Mode A and Mode B produce different
conclusions for the same name, **Mode A wins** because it is ground truth from
inside the subnet.

---

## Mode B route: pre-change validation

### Required inputs

account_id, region, vpc_id, and a change descriptor (structured dict with `type`
and type-specific fields). No instance required.

### Tool sequence (in order)

1. `dns_simulate_effective_config` — returns the VPC's effective DNS config: the
   union of directly attached resources and anything inherited through an
   associated Route 53 Profile, each construct tagged by source.
2. `dns_simulate_change` — applies the proposed change symbolically and returns a
   per-name impact report (before/after, delta, traps, severity, volume).
3. `get_sop` — load runbooks for any traps reported in the impact table
   (see trap-to-SOP mapping below).

### Interpretation rules

- Never recommend applying a change without simulating it first. A broad FORWARD
  rule, enabling private DNS on an interface endpoint, or a Profile association
  can silently redirect names that currently resolve correctly.
- The candidate set is limited to API-derived names (PHZ records, rule domains,
  VPCE apexes, Firewall domain lists) or operator-supplied names. It is not
  exhaustive. State the coverage boundary.
- If the operator supplies `volumes` (from Resolver Query Logs), names are ranked
  by traffic. This is enrichment; absence does not invalidate the simulation.

### Mode B trap-to-SOP mapping

| Trap label in impact report  | SOP slug                         |
| ---------------------------- | -------------------------------- |
| VPCE-shadow-NXDOMAIN         | `B-vpce-shadow-nxdomain`         |
| broad-FORWARD-sweep          | `B-broad-forward-sweep`          |
| flag-AND-mismatch            | `B-flag-and-mismatch`            |
| DNS-Firewall-block           | `B-dns-firewall-block`           |
| profile-union-shift          | `B-profile-propagation-timing`   |
| General pre-change procedure | `B-mode-b-pre-change-validation` |

### Reporting format for Mode B

Label every finding as **Predicted** (symbolic, not ground truth). State the
candidate-set size, its source (API-derived or operator-supplied), and that names
outside this set were not evaluated. Include the propagation timing caveat for
Profile changes.

---

## Cross-account opacity

Call `get_sop` with slug `C-cross-account-opaque-constructs` when the effective
config or impact report contains opaque markers. Cross-account constructs shared
via RAM or a Route 53 Profile may be enumerable but their contents are not
readable from the consumer account. Report them as "present but unknown content"
rather than treating them as absent or inferring past them.

## Limitations

Call `get_sop` with slug `C-limitations-and-boundaries` and state the relevant
boundaries to the operator. Key constraints:

- All tools are read-only. Do not modify, delete, or create DNS resources.
- Mode A requires SSM reachability (ssm, ssmmessages, ec2messages VPC endpoints
  and an instance role with AmazonSSMManagedInstanceCore).
- Mode B candidate sets are not exhaustive. The "no impacts" conclusion applies
  only within the tested set.
- Opaque constructs cannot be resolved from this account.
- Resolver Query Log ingestion is not implemented; volumes must be supplied by
  the operator.

## Final response requirements

Every response produced by this skill must include:

1. Each finding labelled **Observed** (Mode A) or **Predicted** (Mode B).
2. When both modes were used, state "Mode A wins" for any conflict.
3. The candidate-set coverage: how many names, what source, what was not tested.
4. Any opaque constructs and their impact on the conclusion.
5. Recommended next steps or the specific change to apply (never apply it).

## Prerequisites

Requires the aws-vpc-dns-diagnostics MCP server registered in the Agent Space
with its tools allowlisted. The server is at `mcp/aws-vpc-dns-diagnostics-mcp/`.
If the server is not registered or SSM is unreachable, report that as the blocker
rather than guessing at the resolution path.
