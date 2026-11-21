---
name: eks-operation-review
description: Comprehensive Amazon EKS operational review aligned with the AWS EKS
  Best Practices Guide. Use this skill when a user asks to review, audit, or assess
  EKS clusters for best practices compliance, operational readiness, security posture,
  cost optimization, reliability, networking, scalability, or upgrade readiness.
  Triggers on requests like "EKS review", "EKS best practices audit", "EKS operational
  assessment", "review my EKS cluster", or "EKS health check".
metadata:
  author: yakiratz-aws
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Evaluation"
  aws-devops-agent-skills.aws-services: "Amazon EKS"
  aws-devops-agent-skills.technical-domains: "Containers"
---

# EKS Operational Review

Conduct a comprehensive operational review of Amazon EKS clusters aligned with the
[EKS Best Practices Guide](https://docs.aws.amazon.com/eks/latest/best-practices/introduction.html).

## When to Use

Activate this skill when the user asks to:

- Review, audit, or assess EKS clusters
- Check EKS best practices compliance
- Evaluate EKS security, cost, reliability, networking, or scalability
- Perform an EKS operational readiness review
- Investigate EKS cluster health or configuration

## Step 1: Identify Target Clusters

Ask the user which EKS clusters to review. Accept:

- Specific cluster names and regions
- "all clusters" in specific regions
- "all clusters in all regions"

Use the EKS topology data available in the Agent Space to identify clusters.
Query CloudWatch and AWS APIs to discover clusters:

- List EKS clusters across the configured account regions
- For each cluster, collect configuration details

## Step 2: Collect Cluster Configuration

**Data source priority**: If Kubernetes API access is available (via connected MCP servers such as kubernetes-mcp-server, EKS MCP server, or direct K8s API tools), use it FIRST to get live cluster state. K8s API provides the most accurate, real-time data. Fall back to AWS APIs and CloudWatch only for data not available via K8s API.

**K8s API tools** (use first when available):

- `resources_list` / `resources_get` — list/read any K8s resource by apiVersion and kind
- `pods_list` / `pods_get` / `pods_log` / `pods_top` — pod operations
- `nodes_top` — node resource usage
- `events_list` — K8s events
- `configuration_contexts_list` — available cluster contexts

For EACH cluster, gather the following data. **Try K8s API first, then AWS API as fallback**:

### 2.1 EKS Cluster Config

**AWS API** (no K8s equivalent): Kubernetes version, platform version, control plane logging, secrets encryption, endpoint access, authentication mode, access entries, Auto Mode, tags

### 2.2 Node Groups & Compute

**K8s API first**:

- `resources_list(apiVersion="v1", kind="Node")` — live node list with labels, capacity, allocatable, conditions
- `nodes_top` — actual CPU/memory usage per node
- `resources_list(apiVersion="karpenter.sh/v1", kind="NodePool")` — Karpenter NodePools
- `resources_get(apiVersion="karpenter.sh/v1", kind="NodePool", name=<name>)` — full NodePool spec (consolidation, limits, disruption, requirements)
- `resources_list(apiVersion="karpenter.k8s.aws/v1", kind="EC2NodeClass")` — EC2NodeClasses
- `resources_get(apiVersion="karpenter.k8s.aws/v1", kind="EC2NodeClass", name=<name>)` — full spec (amiFamily, blockDeviceMappings, metadataOptions, subnets, SGs)

**AWS API fallback**: Managed node groups (instance types, scaling config, AMI type, capacity type, AZ distribution)

### 2.3 Add-ons

**K8s API first**:

- `resources_list(apiVersion="apps/v1", kind="Deployment", namespace="kube-system")` — all system deployments with image versions
- `resources_list(apiVersion="apps/v1", kind="DaemonSet", namespace="kube-system")` — all system daemonsets with image versions

**AWS API fallback**: EKS managed add-ons (name, version, status, health)

### 2.4 Networking

**K8s API first**:

- `resources_get(apiVersion="apps/v1", kind="DaemonSet", name="aws-node", namespace="kube-system")` — VPC CNI config (env vars: ENABLE_PREFIX_DELEGATION, WARM_IP_TARGET, etc.)
- `resources_get(apiVersion="v1", kind="ConfigMap", name="coredns", namespace="kube-system")` — CoreDNS Corefile
- `resources_get(apiVersion="apps/v1", kind="Deployment", name="coredns", namespace="kube-system")` — CoreDNS replicas, resources, topology
- `resources_list(apiVersion="networking.k8s.io/v1", kind="NetworkPolicy")` — network policies
- `resources_list(apiVersion="v1", kind="Service")` — services and load balancers

**AWS API** (no K8s equivalent): VPC CIDR, subnet IP availability, security groups, VPC endpoints, NAT gateways

### 2.5 Security

**K8s API first**:

- `resources_list(apiVersion="rbac.authorization.k8s.io/v1", kind="ClusterRoleBinding")` — RBAC bindings (check cluster-admin, system:anonymous)
- `resources_list(apiVersion="rbac.authorization.k8s.io/v1", kind="ClusterRole")` — roles with wildcard permissions
- `resources_get(apiVersion="v1", kind="ConfigMap", name="aws-auth", namespace="kube-system")` — aws-auth status
- `resources_list(apiVersion="v1", kind="ServiceAccount")` — check IRSA annotations (eks.amazonaws.com/role-arn)
- `resources_list(apiVersion="v1", kind="Namespace")` — check Pod Security Standards labels (pod-security.kubernetes.io/enforce)

**AWS API** (no K8s equivalent): Access entries, Pod Identity associations, IAM role policies, ECR scan config

### 2.6 Workloads

**K8s API first**:

- `resources_list(apiVersion="apps/v1", kind="Deployment")` — all deployments
- `resources_get(apiVersion="apps/v1", kind="Deployment", name=<name>, namespace=<ns>)` — full spec: probes, resources, securityContext, topologySpreadConstraints, terminationGracePeriodSeconds
- `resources_list(apiVersion="apps/v1", kind="StatefulSet")` — statefulsets
- `resources_list(apiVersion="autoscaling/v2", kind="HorizontalPodAutoscaler")` — HPAs
- `resources_list(apiVersion="policy/v1", kind="PodDisruptionBudget")` — PDBs
- `pods_top` — actual pod resource usage vs requests
- `pods_list(fieldSelector="status.phase!=Running,status.phase!=Succeeded")` — failing pods
- TopologySpreadConstraints for HA

### 2.7 Storage

**K8s API first**:

- `resources_list(apiVersion="storage.k8s.io/v1", kind="StorageClass")` — check gp3 vs gp2, provisioner
- `resources_list(apiVersion="v1", kind="PersistentVolume")` — PV status, reclaim policy
- `resources_list(apiVersion="v1", kind="PersistentVolumeClaim")` — bound/unbound PVCs
- `resources_list(apiVersion="v1", kind="ResourceQuota")` — namespace quotas
- `resources_list(apiVersion="v1", kind="LimitRange")` — default limits

## Step 3: Collect Observability Data (7-Day Historical)

### 3.1 CloudWatch Metrics (7 days)

**Container Insights** (namespace: ContainerInsights):

- node_cpu_utilization (Average, Maximum)
- node_memory_utilization (Average, Maximum)
- pod_cpu_utilization (Average)
- pod_memory_utilization (Average)
- node_filesystem_utilization (Average)
- cluster_node_count (Average)
- cluster_failed_node_count (Maximum)
- pod_number_of_container_restarts (Sum)

**EKS Control Plane** (namespace: AWS/EKS):

- apiserver_request_duration_seconds (Average)
- apiserver_admission_webhook_rejection_count (Sum)
- scheduler_pending_pods (Maximum)

**EC2 Node Metrics** (namespace: AWS/EC2, per instance):

- CPUUtilization (Average, Maximum)
- StatusCheckFailed (Maximum)

### 3.2 CloudWatch Logs (7 days)

Query control plane logs for error patterns:

- `ERROR` — general errors (count)
- `429` — API server throttling
- `OOMKilled` — memory limit issues
- `FailedScheduling` — capacity/constraint issues
- `Evicted` — node pressure evictions

### 3.3 CloudTrail Events (7 days)

Query EKS API events:

- UpdateClusterConfig, UpdateNodegroupConfig — configuration changes
- CreateAccessEntry — new access granted
- DeleteCluster — cluster deletions
- AccessDenied/UnauthorizedAccess errors — security concerns

### 3.4 EKS Upgrade Insights

Fetch upgrade readiness insights:

- UPGRADE_READINESS category insights
- MISCONFIGURATION category insights
- Status, description, recommendations, affected resources for each

## Step 4: Analyze Against Best Practices

Evaluate ALL collected data against these 12 sections from the EKS Best Practices Guide.
Assign severity to every finding: CRITICAL, HIGH, MEDIUM, LOW, or INFO.

### 4.1 Security

Ref: https://docs.aws.amazon.com/eks/latest/best-practices/security.html

**IAM & Access Management** (Ref: https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html):

- Authentication mode: API recommended. CONFIG_MAP only → HIGH
- Access Entries: minimize AmazonEKSClusterAdminPolicy. Cluster creator admin removed? → MEDIUM if not
- aws-auth ConfigMap still in use → MEDIUM (migrate to Access Entries)
- aws-auth maps to system:masters → HIGH
- EKS Pod Identity: associations present? Roles least-privilege? Preferred over IRSA
- IRSA: ServiceAccount annotations, OIDC provider, role policies
- Cluster/node role: least-privilege (no admin/wildcard)
- RBAC: ClusterRoleBindings to cluster-admin minimized. system:anonymous → CRITICAL
- Regional STS endpoint (not global sts.amazonaws.com)

**Pod Security**: Pod Security Standards enforced, no privileged containers, SecurityContext set
**Runtime Security**: Non-root containers, read-only root filesystems
**Network Security**: NetworkPolicies present, VPC endpoints for private access
**Multi-tenancy**: Namespace isolation, RBAC per namespace, ResourceQuotas
**Detective Controls**: All 5 log types enabled, CloudTrail events, CloudWatch alarms
**Infrastructure Security**: Private endpoint, IMDSv2 enforced (httpTokens=required), AMI currency
**Data Encryption**: KMS envelope encryption, EBS encryption
**Image Security**: ECR scan-on-push, image pull policies

### 4.2 Reliability

Ref: https://docs.aws.amazon.com/eks/latest/best-practices/reliability.html

**Applications**: Probes (liveness/readiness/startup), PDBs, TopologySpreadConstraints, graceful shutdown, resource requests/limits
**Control Plane**: Version within N-2, all logs enabled, insights passing. 7-day: API latency, throttling (429), webhook rejections, pending pods
**Data Plane**: Multi-AZ (≥2, ideally 3), managed node groups, auto-scaling. 7-day: failed nodes, CPU/memory saturation, StatusCheckFailed

### 4.3 Karpenter

Ref: https://docs.aws.amazon.com/eks/latest/best-practices/karpenter.html

Per NodePool: consolidationPolicy (WhenEmptyOrUnderutilized recommended), disruption budgets, instance diversity, Spot usage, AZ spread, resource limits
Per EC2NodeClass: amiFamily, blockDeviceMappings, metadataOptions (httpTokens=required), subnet/SG selectors, AMI age

### 4.4 Cluster Autoscaler

Deployment present, expander strategy, scale-down settings, balance-similar-node-groups, version compatibility

### 4.5 EKS Auto Mode

Auto mode enabled/disabled, node pool configuration, disruption controls

### 4.6 Networking

Ref: https://docs.aws.amazon.com/eks/latest/best-practices/networking.html

VPC CNI version and config, prefix delegation, subnet IP availability:

- CRITICAL if any subnet <50 IPs
- HIGH if any subnet <20% free
- MEDIUM if total IPs < 2x node count
  VPC CIDR size (/16 recommended), CoreDNS config and scaling, VPC endpoints, NAT redundancy

### 4.7 Scalability

Ref: https://docs.aws.amazon.com/eks/latest/best-practices/scalability.html

Control plane: API throttling (429 in logs), CRD count
Data plane: Node scaling headroom, instance diversity, Karpenter NodePool limits vs actual
Cluster services: CoreDNS scaled, metrics-server, addon versions
Workloads: HPA configured, resource requests set, pod restart count (>50 in 7d → MEDIUM, >200 → HIGH)

**Data Plane Scaling** (Ref: https://docs.aws.amazon.com/eks/latest/best-practices/scale-data-plane.html):

- Automatic autoscaling configured (Karpenter preferred)
- Instance type diversity (avoid single type)
- T-series burstable in production → MEDIUM
- AMI update automation (EKS optimized/Bottlerocket, age check)
- Multiple EBS volumes for container state
- Patching strategy (SSM Patch Manager, update operators)

### 4.8 Cluster Upgrades

Ref: https://docs.aws.amazon.com/eks/latest/best-practices/cluster-upgrades.html

Version currency: CRITICAL if N-3+, HIGH if N-2, MEDIUM if N-1
EKS upgrade insights (UPGRADE_READINESS): list all with status, recommendations
Addon compatibility, deprecated API usage, PDB coverage, node group update strategy

### 4.9 Cost Optimization

Ref: https://docs.aws.amazon.com/eks/latest/best-practices/cost-opt.html

**Resource Utilization Summary** (from 7-day metrics):
| Metric | 7-Day Avg | 7-Day Max | Assessment |
Under-utilized (<30% CPU / <40% mem) → cost waste. Over-utilized (>70%) → saturation risk.

**Recommendations**:

1. Instance right-sizing: per-instance CPU/memory vs capacity
2. Spot adoption: Karpenter NodePool capacity-type, stateless workloads
3. Graviton migration: x86 → arm64 families (~20% savings)
4. Storage: gp2 → gp3, unused PV cleanup
5. Karpenter consolidation: WhenEmpty → WhenEmptyOrUnderutilized
6. Karpenter NodePool cost review: Spot vs On-Demand, instance sizes vs pod requests, limits vs actual, EBS cost
7. Cost allocation tags
8. Idle resources: 0-replica Deployments, orphaned PVCs
9. Savings Plans for baseline on-demand
10. Namespace resource quotas

### 4.10–4.12 Conditional Sections

- Windows Containers (if detected)
- Hybrid Deployments (if detected)
- AI/ML Workloads (if GPU node groups detected)

## Step 5: Generate Report

**Generate a separate shareable report artifact for EACH cluster reviewed.**

Artifact naming: `eks-review-<cluster-name>-<YYYY-MM-DD>.md`
Example: `eks-review-prod-cluster-2026-04-29.md`

For each cluster, create the artifact as a Markdown document with these sections:

### Report Header

```
# EKS Operational Review — <cluster-name>
Account: <account-id> | Region: <region> | Date: <YYYY-MM-DD> | K8s Version: <version>
```

### Executive Summary

- Cluster health: ✅ HEALTHY / ⚠️ WARNINGS / ❌ CRITICAL
- Finding counts by severity
- Top 3 critical/high items

### Add-ons Inventory

| Add-on | Version | Type | Status | Notes |

### Findings by Section

For each of the 12 sections above, present:
| # | Finding | Severity | Current State | Recommendation |

### CloudWatch Metrics (7-Day)

| Metric | Category | 7-Day Avg | 7-Day Max | Status | Finding |

### CloudWatch Logs Analysis (7-Day)

| Pattern | Occurrences | Severity | Finding |

### CloudTrail Events (7-Day)

Event summary + notable events + findings

### EKS Upgrade Insights

All insights with status, description, recommendations

### Resource Utilization & Cost

Utilization summary table + specific cost optimization recommendations

### Priority Matrix

| # | Finding | Severity | Section | Effort | Impact |
All findings sorted by severity

### Next Steps

- Immediate (CRITICAL/HIGH — 7 days)
- Short-term (MEDIUM — 30 days)
- Long-term (LOW — 90 days)

### Appendix — Reference Links

- Security: https://docs.aws.amazon.com/eks/latest/best-practices/security.html
- IAM: https://docs.aws.amazon.com/eks/latest/best-practices/identity-and-access-management.html
- Reliability: https://docs.aws.amazon.com/eks/latest/best-practices/reliability.html
- Networking: https://docs.aws.amazon.com/eks/latest/best-practices/networking.html
- Scalability: https://docs.aws.amazon.com/eks/latest/best-practices/scalability.html
- Data Plane Scaling: https://docs.aws.amazon.com/eks/latest/best-practices/scale-data-plane.html
- Cluster Upgrades: https://docs.aws.amazon.com/eks/latest/best-practices/cluster-upgrades.html
- Cost Optimization: https://docs.aws.amazon.com/eks/latest/best-practices/cost-opt.html
- Karpenter: https://docs.aws.amazon.com/eks/latest/best-practices/karpenter.html
- Auto Mode: https://docs.aws.amazon.com/eks/latest/best-practices/automode.html

## Severity Definitions

| Severity | Definition                                                  | SLA                     |
| -------- | ----------------------------------------------------------- | ----------------------- |
| CRITICAL | Immediate risk to availability, security, or data integrity | Fix within 24-48 hours  |
| HIGH     | Significant gap that could lead to incidents                | Fix within 1 week       |
| MEDIUM   | Notable improvement opportunity                             | Plan within 30 days     |
| LOW      | Minor optimization or hardening                             | Address when convenient |
| INFO     | Observation, no action required                             | N/A                     |
