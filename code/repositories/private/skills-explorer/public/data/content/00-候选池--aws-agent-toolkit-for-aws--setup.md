---
name: setup
description: Set up the AWS DevOps Agent and AWS Security Agent connections. Use when the user says "set up", "configure", "connect", or when MCP tools are missing.
---

# Setup

Run these skills in order:

1. Invoke the `setup-devops-agent` skill to configure the DevOps Agent MCP connection.
2. Invoke the `setup-security-agent` skill to configure the Security Agent workspace (agent space, IAM role, S3 bucket).

If the user only needs one agent, run only the relevant skill.
