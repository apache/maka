---
name: aws-network-monitoring
description: >-
  Installs, configures, and troubleshoots Network Flow Monitor agents on EC2 instances
  to monitor network path health. Covers agent installation, IAM permissions, monitoring
  network paths, and troubleshooting agents reporting no metrics, HTTP 403 errors, or
  connectivity failures.
version: 1
---

# AWS Network Monitoring

## Overview

Domain expertise for installing and configuring Amazon CloudWatch Network Flow
Monitor agents on EC2 instances. Covers IAM permission setup, agent
installation via SSM Distributor or command-line install, agent activation,
verification, and troubleshooting.

Network Flow Monitor agents are lightweight software that publish performance
metrics (latency, packet loss) to the Network Flow Monitor backend, enabling
monitoring of network path health between workloads.

**Works best with** the [AWS MCP server](https://docs.aws.amazon.com/aws-mcp/) — enables running SSM commands, attaching IAM policies, and validating agent status directly. All guidance also works with standard AWS CLI access.

## Routing

| User need                                                                   | Action                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Installing Network Flow Monitor agents on EC2                               | Read [agent-install-ec2.md](references/agent-install-ec2.md)          |
| Configuring IAM for Network Flow Monitor agents                             | Read [agent-permissions.md](references/agent-permissions.md)          |
| Troubleshooting Network Flow Monitor agents (403, no metrics, connectivity) | Read [troubleshooting.md](references/troubleshooting.md)              |
| Spans multiple areas                                                        | Read the most specific reference first, then consult others as needed |

## Files

| File                                                    | Content                                                                                             |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [agent-install-ec2.md](references/agent-install-ec2.md) | End-to-end Network Flow Monitor agent installation via SSM Distributor, activation, verification    |
| [agent-permissions.md](references/agent-permissions.md) | IAM policy setup for Network Flow Monitor agent metric publishing                                   |
| [troubleshooting.md](references/troubleshooting.md)     | Error → cause → fix for Network Flow Monitor agent issues (HTTP 403, missing metrics, connectivity) |

## Supported versions

For supported Linux distributions, kernel versions, and architectures, see the
[AWS documentation](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-NetworkFlowMonitor-agents-versions.html).
Windows is not supported.

## Security Considerations

- **Least-privilege IAM**: Attach only `CloudWatchNetworkFlowMonitorAgentPublishPolicy` for publishing metrics and `AmazonSSMManagedInstanceCore` for SSM management. Do not use `*FullAccess` policies.
- **Private subnets**: When the instance is in a private subnet, prefer VPC endpoints for SSM (`com.amazonaws.<region>.ssm`, `.ssmmessages`, `.ec2messages`) over a NAT gateway to keep traffic on the AWS network.
- **Credential storage**: Never embed AWS credentials on the instance; the publish policy MUST be attached to the instance role, not configured as static keys.
- **Audit trail**: Ensure CloudTrail is enabled in the account so SSM `SendCommand` invocations and IAM `AttachRolePolicy` actions performed during agent setup are logged for security investigations.
- **References**: [CloudWatch Network Flow Monitor security](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-NetworkFlowMonitor-security.html), [IAM best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/best-practices.html)
