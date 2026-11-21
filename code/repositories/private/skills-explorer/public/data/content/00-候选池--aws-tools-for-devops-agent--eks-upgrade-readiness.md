---
name: eks-upgrade-readiness
description: Use this skill when a user asks to assess, plan, or validate an
  Amazon EKS cluster upgrade. Activate on requests mentioning "EKS upgrade",
  "Kubernetes version upgrade", "upgrade readiness", "upgrade plan",
  "pre-upgrade check", "version skew", "deprecated API", "addon compatibility",
  "node group upgrade", "control plane upgrade", "EKS end of support",
  "EKS extended support", "Karpenter drift", "kubelet version skew", or
  "blue-green cluster migration". It runs a pre-upgrade assessment per the
  AWS EKS Best Practices Guide, covering infrastructure prerequisites, EKS
  Upgrade Insights, API deprecations, addon compatibility, full data plane
  inventory (managed/self-managed nodes, Karpenter, Auto Mode, Fargate),
  AL2 to AL2023 migration, PDB/topology and StatefulSet safety, capacity
  planning, and pre/post-upgrade validation, then produces a scored readiness
  verdict with prioritized remediation. Do NOT use for ECS, general EKS
  troubleshooting unrelated to version upgrades, or EKS Anywhere/Outpost
  clusters.
metadata:
  author: LearningNewbie
  version: "2.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon EKS"
  aws-devops-agent-skills.technical-domains: "Containers"
---

# EKS Upgrade Readiness

Assess and plan Amazon EKS cluster upgrades with comprehensive pre-upgrade
validation aligned with the [EKS Best Practices Guide](https://docs.aws.amazon.com/eks/latest/best-practices/cluster-upgrades.html).

## When to Use

Activate this skill when the user asks to:

- Check if an EKS cluster is ready to upgrade
- Plan an EKS version upgrade (control plane, node groups, or both)
- Identify deprecated Kubernetes APIs before upgrading
- Validate addon compatibility with a target version
- Assess node group upgrade strategy and capacity requirements
- Review Pod Disruption Budgets or topology spread for upgrade safety
- Understand EKS end-of-support, extended support, or auto-upgrade implications
- Evaluate Karpenter Drift or node expiry upgrade behavior
- Compare in-place vs blue-green upgrade strategies
- Create an upgrade runbook or checklist
- Detect GitOps/IaC version ownership before upgrading

## Safety First

**Before doing anything, load `references/safety-invariants.md`.** It defines
the knowledge hierarchy, hard rules, operation classification, and uncertainty
handling. Keep it in context for the entire assessment.

## Critical Warnings

- **This skill is read-only.** All commands are `describe*`, `list*`, `get*`.
  The agent does NOT execute mutating APIs. Mutations are in Step 14 and
  require explicit operator approval.
- **One minor version at a time.** EKS control plane upgrades proceed one
  minor version per operation (e.g., 1.30 → 1.31).
- **Version skew policy.** Before planning an upgrade, no kubelet may be newer
  than the **current** control plane. For the target version, kubelet may be no
  more than N-3 on 1.28+ (N-2 below 1.28).
- **Addons must be upgraded AFTER the control plane** (exceptions in Step 8).
- **Auto-upgrade policy.** Clusters past the 26-month lifecycle will be
  auto-upgraded. Proactive upgrade avoids disruption.
- **Control plane rollback (July 2026+).** 7-day rollback window after upgrade.
  Conditional, not guaranteed — skill checks eligibility.
- **UNKNOWN ≠ PASS.** Any gate that cannot be assessed MUST be UNKNOWN, never
  PASS. Overall verdict cannot be READY while any gate is UNKNOWN.

## Evidence Completeness

Uses `references/required-check-registry.yaml` to track checks performed,
skipped, or blocked. EC = checks_performed / total_applicable × 100%.
EC < 50% produces a mandatory warning.

## Grading and Confidence

| Level           | Meaning                             | When to Use                                              |
| --------------- | ----------------------------------- | -------------------------------------------------------- |
| HIGH (90%+)     | Confirmed from authoritative source | EKS Insights API, direct kubectl query, AWS API response |
| MEDIUM (60-89%) | Inferred from available data        | Partial kubectl access, version matching heuristics      |
| LOW (30-59%)    | Limited data, possible gaps         | No kubectl, no logging enabled, partial API access       |
| UNKNOWN         | Cannot determine                    | Tool unavailable, no data, access denied                 |

**False-positive guards:**

- Empty query result ≠ PASS (mark UNKNOWN)
- No kubectl ≠ N/A for everything (AWS APIs still work)
- EKS Insights PASSING ≠ skip other checks (covers a subset only)
- Addon "compatible" ≠ "recommended"
- Pagination not exhausted → confidence LOW

**Verdict rules (evaluate applicable gates only; `N/A` gates are excluded):**

1. **NOT READY**: one or more applicable gates are FAIL. A known blocker wins
   over uncertainty because proceeding is unsafe.
2. **CANNOT DETERMINE**: no gate is FAIL, but one or more applicable gates are
   UNKNOWN (including inaccessible, incomplete, stale, or unpaginated data).
3. **READY WITH WARNINGS**: all applicable gates are assessed, none FAIL or
   UNKNOWN, and one or more are WARN.
4. **READY**: every applicable gate is PASS.

Format: `[PASS|FAIL|WARN|UNKNOWN|N/A] (confidence: HIGH) — <evidence>`

## Cost Awareness

- **EKS Insights API** (Step 3) is free — always use first.
- **CloudWatch Logs Insights** cost ~$0.0076/GB scanned. Default to 60-min windows.
- **Extended support** costs $0.60/cluster/hour — upgrading saves money.
- **Surge nodes** incur temporary EC2 cost during overlap period.

## Required Permissions

**AWS IAM** — see README.md "Prerequisites → IAM Permissions" for the full
read-only action list (`eks:Describe*`, `eks:List*`, `ec2:Describe*`,
`autoscaling:Describe*`, `iam:GetRole`, `servicequotas:GetServiceQuota`).

**Kubernetes RBAC** (only if `kubectl` access is available — the assessment
still runs on AWS APIs alone without it, at lower confidence for CRD/Helm/PDB
checks). Read-only `ClusterRole` covering every `kubectl get`/`describe` used
in this skill:

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: eks-upgrade-readiness-readonly
rules:
  - apiGroups: [""]
    resources:
      - nodes
      - pods
      - configmaps
      - secrets
      - events
      - persistentvolumeclaims
      - certificatesigningrequests
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apps"]
    resources: ["deployments", "statefulsets", "daemonsets", "replicasets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["policy"]
    resources: ["poddisruptionbudgets"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["apiextensions.k8s.io"]
    resources: ["customresourcedefinitions"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["admissionregistration.k8s.io"]
    resources:
      - validatingwebhookconfigurations
      - mutatingwebhookconfigurations
    verbs: ["get", "list", "watch"]
  - apiGroups: ["karpenter.sh"]
    resources: ["nodepools", "nodeclaims"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["karpenter.k8s.aws"]
    resources: ["ec2nodeclasses"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["crd.k8s.amazonaws.com"]
    resources: ["eniconfigs"]
    verbs: ["get", "list", "watch"]
  - apiGroups: ["storage.k8s.io"]
    resources: ["storageclasses", "csinodes"]
    verbs: ["get", "list", "watch"]
```

Bind with a `ClusterRoleBinding` to the identity the agent assumes (e.g. via
IRSA/Pod Identity or an EKS access entry). `secrets` read access is required
only for the Helm stored-manifest scan (Step 4) — omit that rule and accept
UNKNOWN on Helm checks if a customer's security policy disallows it.

---

## Step 1: Gather Cluster Context

```bash
aws eks describe-cluster --name <cluster-name> --region <region>
```

Extract: `cluster.version`, `platformVersion`, `status` (must be ACTIVE),
`kubernetesNetworkConfig`, `logging.clusterLogging` (audit log must be enabled),
`resourcesVpcConfig.subnetIds`, `tags` (IaC ownership detection).

Determine **target version**: ask user or default to current + 1 minor.
Confirm target is in standard support via the EKS release calendar.

## Step 2: Verify Infrastructure Prerequisites

Check these — failures are **BLOCKERs**:

1. **Subnet IP availability** — need ≥5 IPs per cluster subnet. Mode-aware:
   standard IPv4, prefix delegation, custom networking, IPv6, SGP.
   Use `aws ec2 describe-subnets` with cluster subnet IDs.
2. **EKS IAM role** — verify role exists with `eks.amazonaws.com` trust.
3. **KMS key** (if encryption enabled) — verify cluster role has key access.
4. **Service quota headroom** — EC2 vCPU (L-1216C47A) and EBS gp3 (L-7A658000)
   must have room for surge nodes. Use `aws service-quotas get-service-quota`.

VPC CNI mode and capacity-input detection:

```bash
kubectl get ds aws-node -n kube-system -o json | jq '
  .spec.template.spec.containers[0].env[]
  | select(.name | test("ENABLE_PREFIX_DELEGATION|AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG|ENABLE_POD_ENI|WARM_IP_TARGET|MINIMUM_IP_TARGET|WARM_ENI_TARGET|WARM_PREFIX_TARGET"))
  | {name, value}'
```

### VPC CNI Surge-Capacity Gate

Do not treat "mode detected" as capacity validated. First calculate the
managed-node-group surge using `references/capacity-planning.md`, distribute it
by the node group's AZ placement, then verify the relevant subnet/ENI resource
for the selected mode. Record the inputs and calculations as evidence; a missing
mode-specific input is `UNKNOWN`, not PASS.

| Mode                     | Required assessment before a node surge                                                                                                                                                                            | Pass condition                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Standard IPv4            | Inspect `WARM_IP_TARGET`, `MINIMUM_IP_TARGET`, and `WARM_ENI_TARGET` on `aws-node`; use node `status.allocatable.pods` and current pod count to calculate the additional secondary-IP demand for every surge node. | Every node subnet has enough free IPv4 addresses for its share of surge nodes, their primary ENIs, and configured warm/allocatable pod-IP demand.                       |
| Prefix delegation        | Confirm `ENABLE_PREFIX_DELEGATION=true`; each IPv4 prefix consumes a `/28` (16 addresses). Calculate required additional prefixes as `ceil(additional_pod_ips / 16)` per affected subnet/AZ.                       | `floor(availableIpAddressCount / 16)` covers the needed prefixes after allowing for node primary addresses and the configured warm-prefix target.                       |
| Custom networking        | Confirm `AWS_VPC_K8S_CNI_CUSTOM_NETWORK_CFG=true`, enumerate `ENIConfig` resources, and map each node AZ to its `spec.subnet` and security groups.                                                                 | The **ENIConfig pod subnet**, not only the cluster/node subnet, has capacity for the surge pod-IP demand in every used AZ.                                              |
| Security Groups for Pods | Confirm `ENABLE_POD_ENI=true`, inspect trunk ENIs and the instance-type-specific branch-ENI limit for each node type.                                                                                              | Required branch ENIs/pod slots for surge workloads with pod SGs do not exceed the published limit for any instance type. Do not use generic ENI limits as a substitute. |
| IPv6                     | Confirm IPv6 family and Nitro-compatible node/Fargate support. IPv6 pod addressing does not consume IPv4 pod IPs, but nodes still need valid ENI/subnet capacity.                                                  | Node ENI and subnet capacity cover surge nodes; custom networking is not assumed because it is unsupported with IPv6.                                                   |

```bash
# Custom networking: inspect every AZ-to-pod-subnet mapping
kubectl get eniconfig -o json | jq '.items[] | {name: .metadata.name, subnet: .spec.subnet, securityGroups: .spec.securityGroups}'

# Security Groups for Pods: inspect trunk/branch interfaces after mode detection
aws ec2 describe-network-interfaces \
  --filters Name=interface-type,Values=trunk,branch \
  --query 'NetworkInterfaces[].{type:InterfaceType,subnet:SubnetId,instance:Attachment.InstanceId,status:Status}'
```

### Client and CI Tooling Skew (WARN-level, not a blocker)

Operator/CI tooling that is too far behind the target version causes confusing
failures during and after the upgrade. Check installed versions where available:

```bash
kubectl version --client -o json   # client minor version
eksctl version                      # if eksctl-managed
helm version --short                # if Helm-managed workloads
```

| Tool                   | Skew Rule                                                                                                                                                                                                                                                          | Risk if Violated                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| kubectl                | Must be within ±1 minor of the target `kube-apiserver` version (upstream [Kubernetes version skew policy](https://kubernetes.io/releases/version-skew-policy/#kubectl))                                                                                            | Unrecognized fields, API calls silently rejected or misinterpreted       |
| eksctl                 | Must support the target EKS version (check release notes for the version that added support)                                                                                                                                                                       | `eksctl upgrade` commands fail or use stale defaults                     |
| Helm                   | 3.8+ recommended for OCI registry support; otherwise not EKS-version-gated                                                                                                                                                                                         | Chart operations may fail independent of the cluster upgrade             |
| Terraform AWS provider | Must be new enough to support any target-version-specific attributes in use (e.g. `upgrade_policy`, `compute_config` for Auto Mode) — check the [provider changelog](https://github.com/hashicorp/terraform-provider-aws/blob/main/CHANGELOG.md) for the attribute | `terraform apply` fails validation or silently ignores the new attribute |

Do not hardcode exact version floors here — they shift every EKS release.
Report the installed version, the rule, and a WARN if it cannot be confirmed
current; never treat "tool not detected" as PASS.

## Step 3: Check EKS Upgrade Insights

**Primary authoritative signal.** Always query first.

```bash
aws eks list-insights --cluster-name <cluster> \
  --filter '{"categories":["UPGRADE_READINESS"],"kubernetesVersions":["<target>"]}'
aws eks describe-insight --cluster-name <cluster> --id <insight-id>
```

| Status        | Gate    | Action                                                    |
| ------------- | ------- | --------------------------------------------------------- |
| ERROR         | FAIL    | Must fix before upgrade                                   |
| WARNING       | WARN    | Recommended fix                                           |
| PASSING       | PASS    | No action                                                 |
| UNKNOWN       | UNKNOWN | EKS could not evaluate the check; investigate and refresh |
| None returned | UNKNOWN | Continue other checks                                     |

**Freshness gate:** For every returned summary, capture `lastRefreshTime` and
`lastTransitionTime`, then call `DescribeInsight` to collect the status,
affected resources, and recommendation. Treat data as **stale** when
`lastRefreshTime` is more than 24 hours old at assessment time, or predates a
known relevant workload/addon change. A stale, missing, inaccessible, or
unpaginated insight set is `UNKNOWN`; never reuse it as PASS. The assessment
must not call `StartInsightsRefresh` because this skill is read-only. Instead,
ask the operator to refresh insights through an approved workflow and rerun the
assessment after the refresh completes.

**Critical:** Insights does NOT cover Helm stored manifests, CRD deprecations,
StatefulSets, Karpenter, service quotas, PDBs, or capacity planning.

## Step 4: API Deprecation Analysis

Check version-specific removal gates relevant to user's target:

- ≥1.33: AL2 AMI unavailable (Critical)
- ≥1.35: kube-proxy IPVS deprecated; ≥1.36: removed
- ≥1.25: Dockershim and PodSecurityPolicy removed
- ≥1.23: In-tree EBS provisioner deprecated

**Helm stored manifests** — the #1 missed blocker. Scan latest deployed
release secrets for deprecated `apiVersion` lines:

```bash
kubectl get secrets -A -l owner=helm,status=deployed
# Decode: base64 -d | base64 -d | gunzip | jq -r '.manifest'
```

**Third-party CRD deprecations** — check Istio, cert-manager, Karpenter,
Flux, Argo, Prometheus Operator versions against known deprecation timelines.

Tools: `kubent`, `pluto detect-all-in-cluster`, `helm mapkubeapis --dry-run`.
See `references/api-deprecations.md` for full removal schedule.

## Step 5: Addon Compatibility Check

**Managed addons:** Use live API to build compatibility matrix:

```bash
aws eks list-addons --cluster-name <cluster>
aws eks describe-addon --cluster-name <cluster> --addon-name <name>
aws eks describe-addon-versions --addon-name <name> --kubernetes-version <target>
```

**Self-managed addons:** First compare `ListAddons` with the actual
`kube-system` workloads. Explicitly detect the three core addons: `aws-node`
(VPC CNI), `coredns`, and `kube-proxy`. If a core component is absent from the
managed-addon inventory but present in-cluster, mark it self-managed/custom and
inspect its image, args, and configuration before assessing target support:

```bash
kubectl -n kube-system get daemonset aws-node kube-proxy -o json | \
  jq '.items[] | {name: .metadata.name, images: [.spec.template.spec.containers[].image], args: [.spec.template.spec.containers[].args]}'
kubectl -n kube-system get deployment coredns -o json | \
  jq '.items[] | {name: .metadata.name, images: [.spec.template.spec.containers[].image], args: [.spec.template.spec.containers[].args]}'
kubectl -n kube-system get configmap coredns aws-node -o yaml
```

For a custom CoreDNS Corefile, run the Corefile migration check. For VPC CNI,
validate custom environment/config-map values and the mode-specific capacity
gate in Step 2. For kube-proxy, validate its deployed mode and version against
its upstream support policy. Then scan other self-managed components
(aws-load-balancer, external-dns, metrics-server, cluster-autoscaler,
cert-manager, ingress-nginx, argocd, flux); extract image tags and validate
against their K8s support matrices.

**Pod Identity Agent (`eks-pod-identity-agent`):** Check like any other managed
addon via `DescribeAddon` / `DescribeAddonVersions` — its version gates which
association features are available (e.g. multiple associations per pod,
target IAM role sessions). If not installed but `kubectl get pods -A -o json`
shows service accounts with `eks.amazonaws.com/role-arn` annotations instead,
the cluster is on IRSA, not Pod Identity — note this for blue-green planning
(see `references/upgrade-troubleshooting.md` → Identity Migration Considerations).

**Upgrade order:** Pre-CP: Karpenter, Cluster Autoscaler, incompatible webhooks.
Post-CP: kube-proxy → vpc-cni → coredns → CSI drivers → others → self-managed.

See `references/addon-version-matrix.md` for static fallback reference.

## Step 6: Full Data Plane Inventory

Inventory ALL node populations. See `references/data-plane-inventory.md` for
complete detection commands.

- **MNG:** `aws eks list-nodegroups` + `describe-nodegroup` for each
- **Self-managed ASGs:** Find by cluster tag in `describe-auto-scaling-groups`
- **Karpenter:** NodePools, EC2NodeClasses, controller version and health
- **Auto Mode:** Check `cluster.computeConfig.enabled`
- **Fargate:** `aws eks list-fargate-profiles` + describe each
- **Kubelet versions:** `kubectl get nodes` — confirm within skew window

Version skew requires two independent predicates:

1. **Current-state upper bound:** no kubelet may be newer than the **current**
   control plane (`kubelet_minor <= current_control_plane_minor`). A node
   already newer than the current API server is an invalid state and must be
   corrected before planning the upgrade.
2. **Target lower bound:** for target 1.X, kubelet must be at least 1.(X-3)
   when X>=28, or 1.(X-2) when X<28.

Any node violating either predicate is a **FAIL**.

## Step 7: AL2 → AL2023 Migration Assessment

If AL2 detected and target ≥1.33: **CRITICAL** blocker (EKS releases AL2
AMIs only through 1.32). If AL2 is detected with a target <1.33: **WARNING** —
upstream Amazon Linux 2 reaches end of life on June 30, 2026.

Assess: bootstrap method (bootstrap.sh vs nodeadm), custom AMIs, user data
compatibility (yum→dnf, kubelet-extra-args→NodeConfig), cgroup v2 workload
compatibility, IMDSv2 readiness.

See `references/al2-al2023-migration.md` for full detection commands and
migration strategy.

## Step 8: Upgrade Ordering and Pre-Upgrade Alignment

**Pre-CP:** Karpenter (if needed), Cluster Autoscaler (must match target),
admission webhooks with `failurePolicy: Fail`, custom controllers using
deprecated APIs.

**Post-CP:** Standard addon and node group upgrade order (Step 5).

Webhook check:

```bash
kubectl get validatingwebhookconfigurations -o json | jq '.items[] | select(.webhooks[].failurePolicy == "Fail")'
kubectl get mutatingwebhookconfigurations -o json | jq '.items[] | select(.webhooks[].failurePolicy == "Fail")'
```

## Step 9: PDB, Topology Spread, and Workload Safety

**PDB blockers:** `maxUnavailable: 0`, `minAvailable` == replicas, orphaned PDBs:

```bash
kubectl get pdb -A -o json | jq '.items[] | select(.status.disruptionsAllowed == 0)'
```

**Pre-drain safety (DRAIN-01 to DRAIN-06):** Bare pods, emptyDir data loss,
custom finalizers, EBS AZ-pinning, webhook deadlock, CoreDNS SPOF.
See `references/pre-drain-safety.md` for full detection commands.

**TopologySpreadConstraints:** Flag multi-replica deployments without topology spread.

**StatefulSet safety:** Check `terminationGracePeriodSeconds != 0`, PVC retention
policy, single-replica without PDB, update strategy.

**Scaled-to-zero workloads:** Detect and flag for separate validation.

## Step 10: Pre-Upgrade Cluster Health Baseline

Confirm healthy steady state before upgrade. Failures compound on unhealthy clusters.

- **Node health:** All nodes Ready, no MemoryPressure/DiskPressure/PIDPressure
- **Pending CSRs:** Indicate node registration issues
- **Crash-looping system pods:** Check kube-system, monitoring, ingress namespaces
- **Metrics and DNS baseline:** Verify metrics-server and CoreDNS responding

Record baselines for post-upgrade comparison.

## Step 11: Fargate Considerations

Fargate pods upgrade when redeployed after CP upgrade. All Fargate pods must be
restarted post-upgrade. Restart command is in Step 14 (mutation, requires approval).

## Step 12: Management Plane and IaC Ownership Detection

Detect management method to route remediation correctly:

| Detection                               | Management Plane | Mutation Routing                |
| --------------------------------------- | ---------------- | ------------------------------- |
| ACK CRD + Cluster CR                    | ACK              | Patch ACK Cluster CR            |
| ACK CR with `kro.run/owned`             | KRO over ACK     | Patch kro instance              |
| Tags: `terraform:*`                     | Terraform        | Update .tf, `terraform apply`   |
| Tags: `aws:cloudformation:*`            | CloudFormation   | Update template, stack update   |
| Tags: `aws:cdk:*`                       | CDK              | Update construct, `cdk deploy`  |
| Tags: `eksctl.cluster.k8s.io/*`         | eksctl           | Update config, `eksctl upgrade` |
| Labels: `argocd.argoproj.io/*`          | ArgoCD           | Update Git source, sync         |
| Labels: `kustomize.toolkit.fluxcd.io/*` | Flux             | Update Git source, reconcile    |
| Tags: `pulumi:*`                        | Pulumi           | Update program, `pulumi up`     |
| None found                              | unknown          | Block mutations until confirmed |

Route ALL remediation through the owning tool — never suggest direct AWS CLI
when IaC is detected (causes drift).

## Step 13: Autoscaler Pause During Node Rotation

During upgrades, autoscalers can interfere with rolling replacement. Check
current Karpenter consolidation config and Cluster Autoscaler scale-down state.
Recommend pausing both before node rotation and re-enabling after completion.

Pause commands are in Step 14 (mutations, require operator approval).

## Step 14: Remediation Playbook (Operator Approval Required)

> ⚠️ **ALL commands in this section are MUTATIONS.** The agent MUST NOT execute
> these — present as a playbook for operator review.

- **14.1** Helm stored manifest fix: `helm mapkubeapis` + `helm upgrade`
- **14.2** Addon conflict resolution: first capture `DescribeAddon` output and
  `configurationValues`; use `--resolve-conflicts PRESERVE` to retain reviewed
  custom configuration, or `OVERWRITE` only after approving replacement with
  EKS defaults and recording rollback steps. `OVERWRITE` can discard custom
  configuration.
- **14.3** Fargate pod restart: `kubectl rollout restart` across namespaces
- **14.4** PDB temporary adjustment: `kubectl patch pdb` (revert after upgrade)
- **14.5** Karpenter pause: `kubectl annotate nodepools --all "karpenter.sh/do-not-disrupt=true"`
- **14.6** CA scale-down pause: patch CA config `scale-down-enabled=false`
- **14.7** Node group upgrade: MNG via `update-nodegroup-version`, Karpenter via
  EC2NodeClass patch (drift), self-managed via launch template update

## Step 15: Post-Upgrade Functional Validation

Present as validation checklist for operator:

- DNS resolution (nslookup kubernetes.default)
- Metrics server (kubectl top nodes/pods)
- Pod scheduling (run test pod)
- Load balancer health (target group check)
- IRSA / Pod Identity (sts get-caller-identity from pod)
- CoreDNS and kube-proxy pods running
- Compare against Step 10 baseline (node count, no new CrashLoopBackOff)

## Step 16: Generate Upgrade Plan and Report

**Execution Order:**

1. Pre-upgrade alignment (Karpenter/CA/webhooks)
2. Pause autoscalers
3. Control plane upgrade (15-40 min)
4. Wait for ACTIVE status
5. kube-proxy → vpc-cni → coredns → other managed addons
6. Self-managed addons
7. Node groups (one at a time, validate between)
8. Karpenter nodes (drift-based)
9. Self-managed nodes (launch template update)
10. Fargate pods (restart)
11. Re-enable autoscalers
12. Post-upgrade validation

**Rollback Matrix:**

| Component       | Reversibility              | Method                                                      |
| --------------- | -------------------------- | ----------------------------------------------------------- |
| Control plane   | CONDITIONAL (7-day window) | `aws eks update-cluster-version --kubernetes-version <N-1>` |
| Addons          | FULL                       | Downgrade to previous version                               |
| MNG             | PARTIAL                    | Can halt; completed nodes stay                              |
| Karpenter nodes | FULL                       | Revert EC2NodeClass                                         |
| Self-managed    | FULL                       | Revert launch template                                      |
| Fargate         | FULL                       | Redeploy previous config                                    |

**Rollback eligibility has two phases:**

- **Pre-upgrade (advisory only):** confirm the planned upgrade is one minor,
  document the 7-day window and component rollback order, but do not claim the
  future cluster will be eligible. Rollback readiness insights do not exist
  until after an eligible upgrade completes.
- **Post-upgrade (authoritative):** while the cluster is ACTIVE and still
  inside the 7-day window, run
  `aws eks list-insights --cluster-name <cluster> --filter '{"categories":["ROLLBACK_READINESS"]}'`,
  paginate, then `describe-insight` for each entry. `ERROR` blocks a normal
  rollback; `UNKNOWN` means EKS could not evaluate readiness and also blocks a
  normal rollback. Only `PASSING` insights support an eligible rollback.

This assessment reports the result but never performs `update-cluster-version`
or a forced rollback.

## Step 17: Report Format

```
## EKS Upgrade Readiness Report
**Cluster:** <name> (<region>)
**Current Version:** <current>
**Target Version:** <target>
**Assessment Date:** <date>
**Management Plane:** <detected>
**Evidence Completeness:** <X>% (<performed>/<applicable>)
**Overall Readiness:** READY / NOT READY / READY WITH WARNINGS / CANNOT DETERMINE

### Pre-Upgrade Health Baseline
- [PASS/FAIL] (confidence: HIGH) All nodes Ready
- [PASS/FAIL] (confidence: HIGH) No pending CSRs
- [PASS/FAIL] (confidence: HIGH) No crash-looping system pods
- [PASS/FAIL] (confidence: HIGH) DNS resolution working
- [PASS/FAIL] (confidence: HIGH) Metrics server responding

### Infrastructure Prerequisites
- [PASS/FAIL] (confidence: HIGH) Subnet IP availability (mode: <type>)
- [PASS/FAIL] (confidence: HIGH) EKS IAM role valid
- [PASS/FAIL/N/A] (confidence: HIGH) KMS key access
- [PASS/FAIL] (confidence: HIGH) EC2 vCPU quota headroom
- [PASS/FAIL] (confidence: HIGH) EBS volume quota headroom

### EKS Upgrade Insights
- [PASS/FAIL/UNKNOWN] (confidence: HIGH) <summary>

### Data Plane Inventory
- Managed Node Groups: <count> (versions: <list>)
- Self-Managed ASGs: <count> (versions: <list>)
- Karpenter NodePools: <count> (version: <ver>)
- Fargate Profiles: <count>
- Total Nodes: <count>

### Blockers (must fix)
1. [FAIL] (confidence: HIGH) <description> — <remediation>

### Warnings (recommended)
1. [WARN] (confidence: MEDIUM) <description> — <recommendation>

### Passing Checks
1. [PASS] (confidence: HIGH) <description>

### Unknown / Not Assessed
1. [UNKNOWN] <gate> — <reason>

### Upgrade Plan
<execution order from Step 16>

### Rollback Window
- Rollback eligibility: ELIGIBLE / NOT ELIGIBLE / CHECK AFTER UPGRADE
- Window: 7 days from CP upgrade completion
- Note: Add-ons and node groups must be rolled back BEFORE CP

### Pre-Drain Risks
- Bare pods (DRAIN-01): <count>
- EmptyDir data loss (DRAIN-02): <count>
- EBS AZ-pinning (DRAIN-04): <count>
- Webhook deadlock (DRAIN-05): <assessment>
- CoreDNS SPOF (DRAIN-06): <status>

### Estimated Timeline
- Control plane: ~30 min
- Addons: ~5 min each
- Node groups: ~<X> min per group
- Total: ~<Y> min
```

### Machine-Readable Output

When the operator asks for a structured result (CI/CD gating, scripted
polling, dashboards), emit this JSON alongside — never instead of — the
markdown report. Every gate in the markdown report must have a matching
entry; the JSON is a serialization of the same evidence, not a summary.

```json
{
  "cluster": "<name>",
  "region": "<region>",
  "assessmentTimestamp": "<ISO-8601>",
  "currentVersion": "<current>",
  "targetVersion": "<target>",
  "overallVerdict": "READY | READY_WITH_WARNINGS | NOT_READY | CANNOT_DETERMINE",
  "evidenceCompletenessPct": 0,
  "gates": [
    {
      "id": "<check-id from required-check-registry.yaml, e.g. NODE-04, ADDON-02, INFRA-01>",
      "name": "<human-readable check name>",
      "status": "PASS | FAIL | WARN | UNKNOWN | N_A",
      "confidence": "HIGH | MEDIUM | LOW",
      "evidence": "<short evidence string, same as markdown bullet>",
      "remediation": "<remediation text, or null if PASS>",
      "checkedAt": "<ISO-8601>"
    }
  ],
  "rollback": {
    "eligible": true,
    "windowExpiresAt": "<ISO-8601 or null>"
  }
}
```

`gates[].id` maps 1:1 to the IDs in `references/required-check-registry.yaml`
(prefixes: `PF-` pre-flight, `INFRA-` infrastructure, `NODE-` node assessment,
`ADDON-` addon assessment, `WKLD-` workload assessment, `KARP-` Karpenter,
`DRAIN-` pre-drain safety, `ROLL-` rollback), so a CI pipeline can gate on
specific check categories (e.g. fail only on `NODE-*` or `ADDON-*` FAILs,
warn-only on others) instead of just the overall verdict. `overallVerdict`
follows the same rules as the markdown report — it is never `READY` while
any gate is `UNKNOWN`.

## References

See `references/` directory for:

- `safety-invariants.md` — Hard safety rules, knowledge hierarchy, operation classification
- `required-check-registry.yaml` — All 60+ checks with IDs, categories, and severity
- `pre-flight-checks.yaml` — Blocking vs warning checks, timeouts, soak periods, rollback conditions
- `api-deprecations.md` — Full K8s API removal schedule by version
- `addon-version-matrix.md` — EKS addon compatibility per version (static fallback)
- `capacity-planning.md` — FDCR/ODCR and surge capacity guidance
- `upgrade-troubleshooting.md` — Common failures, feature removals, and tools
- `karpenter-checks.md` — Full 14-check Karpenter registry (KARP-01 to KARP-14)
- `pre-drain-safety.md` — DRAIN-01 to DRAIN-06 detection and remediation
- `al2-al2023-migration.md` — AL2→AL2023 migration assessment details
- `data-plane-inventory.md` — MNG, self-managed, Karpenter, Auto Mode, Fargate inventory commands
