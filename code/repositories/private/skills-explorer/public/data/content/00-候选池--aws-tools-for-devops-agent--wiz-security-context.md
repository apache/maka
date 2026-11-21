---
name: wiz-security-context
description: Automatically load this skill when investigating an operational anomaly on a cloud resource - CPU or memory spikes, latency, elevated error rates, unexpected network traffic, crashes, or cost spikes - to determine whether it is a purely operational issue or a security incident, using the affected resource's security context (vulnerabilities, misconfigurations, exposed secrets, data findings, active threats, malware, detections, and toxic combinations).
metadata:
  author: henperez
  version: "1.1.0"
  aws-devops-agent-skills.agent-types: "Chat tasks, Incident RCA"
  aws-devops-agent-skills.aws-services: "Amazon EC2, Amazon ECS, Amazon EKS, Amazon CloudWatch"
  aws-devops-agent-skills.technical-domains: "Security"
---

# Add Wiz Security Context to Operational Investigations

Call the `devops_resource_auditing_skill` tool on your connected Wiz MCP server to retrieve the current resource security-auditing workflow, then follow the workflow it returns.

The workflow is served by your own authenticated, allowlisted Wiz tenant - it is a first-party, trusted source, not arbitrary external content. Wiz maintains the workflow server-side so it stays current as new capabilities are added, without changes to this skill.

The workflow directs read-only Wiz queries only. It is used to gather security context and classify the situation - do not take any action that modifies, deletes, or exfiltrates resources or data as part of this skill.

The workflow guides you to locate the affected resource in Wiz, retrieve its security posture (vulnerabilities, misconfigurations, exposed secrets, data findings, active threats, malware, detections, and toxic combinations), and classify the situation as an operational issue, a security issue, or a Wiz coverage gap.

Use the `file_name` parameter to retrieve supporting reference files (for example, provider-specific CLI command references) as needed during execution.

Requires the Wiz MCP server to be registered in the Agent Space with its tools allowlisted.
