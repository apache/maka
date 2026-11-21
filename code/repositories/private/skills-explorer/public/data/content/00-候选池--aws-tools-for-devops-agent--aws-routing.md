---
name: aws-routing
description: 'Analyze and troubleshoot AWS routing and BGP path selection - how AWS chooses a network path, why traffic takes an unexpected route, and how to steer it. Use for AWS Cloud WAN route evaluation and CNE path selection; Direct Connect Gateway (DXGW) path selection and local vs remote region preference; Transit Gateway route tables, ECMP, and peering; VPC route tables and longest-prefix-match; BGP traffic engineering with local-preference communities (7224:7100/7200/7300), AS-path prepending, and MED; DX + VPN redundancy and active/active vs active/passive design; asymmetric routing and failover. Activate on symptoms like "traffic is leaving the region", "not using my local Direct Connect", "routing to the wrong VIF/location", "path is asymmetric", or "how do I make AWS prefer this path". Read-only: analysis, recommendations, and describe/get/list validation commands grounded in public AWS docs.'
metadata:
  version: "1.2.3"
  author: midakin
---

## Overview

This skill provides routing-first analysis for AWS networking. It reasons about the full traffic
path, applies the documented route-evaluation logic for each service, and grounds recommendations
in public AWS documentation. It is **read-only**: it produces analysis, recommendations, and
read-only validation commands (`describe-*`, `get-*`, `list-*`) - never mutating actions.

## Verification & Anti-Hallucination Directives (Mandatory)

- Do not generate any fact, citation, or source that is not fully verifiable. If you lack a verified
  source, state "I cannot verify this" rather than inventing details.
- State assumptions explicitly before answering.
- Cross-check each claim against public AWS documentation or the `references/` files. Omit claims you
  cannot confirm.
- Only cite AWS documentation URLs you have actually retrieved or confirmed. Do not fabricate links.

## When to use this skill

Activate when the user asks about:

- Cloud WAN route evaluation / Core Network Edge (CNE) path selection
- Direct Connect Gateway path selection, local-region preference, or LP communities
- Transit Gateway route evaluation, ECMP, or peering routing
- VPC route tables and longest-prefix-match behavior
- BGP traffic engineering (communities, AS-path prepending, MED)
- DX + VPN redundancy, active/active vs active/passive, or failover design
- Why traffic is taking an unexpected path

## What this skill does NOT do

This skill is **read-only and advisory**. It will not:

- **Design or apply infrastructure changes.** It does not create, modify, or delete AWS resources,
  and it does not run mutating CLI/API calls (`create-*`, `modify-*`, `associate-*`, `delete-*`,
  `put-*`, `update-*`) or write Infrastructure-as-Code to be deployed. Any change it describes is a
  _recommendation_ for you to review and implement yourself.
- **Configure BGP or push routing policy.** It explains which communities, AS-path, or MED settings
  to use, but it does not apply them to VIFs, route tables, or Cloud WAN policy documents.
- **Execute anything against a live account beyond read-only validation.** Commands it provides are
  limited to `describe-*`, `get-*`, and `list-*` for confirming state.
- **Guarantee production outcomes.** It recommends non-production testing and blue/green rollout;
  it does not perform the cutover or validate the result for you.
- **Provide compliance, security, or contractual sign-off**, or make claims it cannot ground in
  public AWS documentation or the `references/` files.

For designing and applying changes, hand the recommendation to a change-capable workflow (with
appropriate review, approvals, and testing).

## How to analyze a routing problem

1. **Establish the path.** Identify source, destination, and every routing construct in between
   (VPC route table → TGW/Cloud WAN CNE → DXGW → VIF → on-prem, or the relevant subset).
2. **Name the route table.** Be explicit about which table makes each decision (VPC RT, TGW RT,
   CNE RT, DXGW internal selection).
3. **Apply the evaluation order for that construct** (see below).
4. **Identify the deciding attribute** (longest prefix, local preference, AS-path, MED, source type).
5. **Flag non-determinism** (e.g., ECMP or "deterministically random" tiebreakers) and recommend a
   deterministic alternative.
6. **Cite the AWS documentation** that supports the behavior.
7. **Provide read-only validation commands** the user can run to confirm.

## Key evaluation rules

### Cloud WAN (per CNE)

Longest prefix match → static → VPC-propagated (same region) → unequal AS-path/MED (shortest wins) →
equal AS-path & MED source preference: DXGW-propagated → Cloud WAN Connect → S2S VPN → other
(TGW peering, remote CNEs; identical from 2+ sources = deterministically random).

### Direct Connect (private/transit VIF, outbound AWS→on-prem)

Longest prefix match → local preference → AS_PATH length → MED → ECMP (equal AS_PATH and BGP
attributes). LP communities `7224:7300/7200/7100` (High/Medium/Low) set local preference and are
evaluated before AS-path. DXGW prefers the local associated-region DX by default.

### Direction & tooling guidance

- **AWS → on-prem (egress):** control with DX LP communities.
- **On-prem → AWS (ingress):** control with the customer router's local-pref/weight/MED.
- **AS-path prepending:** within a region only - unreliable across regions because DXGW local-region
  LP overrides it. **LP communities:** work within-region and cross-region.

## Reference material

Detailed mechanics, patterns, and caveats are in `references/`:

- `cloudwan-dx-routing-patterns.md` - Cloud WAN route evaluation, DXGW path selection, community
  traffic-engineering patterns, regional inspection, multi-region egress
- `dx-routing-patterns.md` - DX BGP mechanics, BFD, MED, ASN ranges, VIF considerations, CloudHub,
  when VIFs can talk, active/active vs active/passive
- `tgw-routing-patterns.md` - TGW route evaluation, ECMP limits, DX/VPN caveats, failover, peering
- `vpn-dx-redundancy-patterns.md` - VPN + DX redundancy, route preference, ECMP limits, asymmetry
- `networking-strategic-questions.md` - discovery questions per service

## Output expectations

- Explain the route-evaluation logic step by step.
- Name the specific route table involved.
- Give the end-to-end traffic path.
- Compare options with tradeoffs (determinism, complexity, failover) when multiple solutions exist.
- Include read-only AWS CLI validation commands.
- Recommend testing in a non-production environment and blue/green for migrations.
