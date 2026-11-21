---
name: skip-scheduled-maintenance
description: Skip low-priority incidents during a scheduled maintenance window.
  Use this skill to automatically filter MEDIUM and LOW severity alarms that
  fire during planned maintenance, avoiding unnecessary investigations for
  expected disruptions.
metadata:
  author: dgorin6
  version: "1.0.0"
  aws-devops-agent-skills.agent-types: "Incident Triage"
---

# Skip Scheduled Maintenance

Skip all incidents that meet BOTH of the following criteria:

1. The incident arrived between **2025-03-15 02:00 UTC** and **2025-03-15 06:00 UTC**
2. Severity is MEDIUM or LOW

Do NOT skip HIGH or CRITICAL severity incidents, even during the maintenance window.
