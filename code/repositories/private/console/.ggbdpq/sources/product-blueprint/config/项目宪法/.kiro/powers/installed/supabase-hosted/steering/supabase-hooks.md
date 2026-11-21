# Hooks Setup

Add a hook to .kiro/hooks/review-advisors.kiro.hook

```
{
  "enabled": true,
  "name": "Review Database Performance & Security",
  "description": "Verify database follows performance/security best practices",
  "version": "1",
  "when": {
    "type": "userTriggered"
  },
  "then": {
    "type": "askAgent",
    "prompt": "Activate the Supabase power, read appropriate steering files, then execute `get_advisors` via MCP to check for \"performance\" and \"security\" concerns"
  }
}
```

Add a hook to .kiro/hooks/review-database-logs.kiro.hook

```
{
  "enabled": true,
  "name": "Review Database Logs",
  "description": "Check database logs for issues",
  "version": "1",
  "when": {
    "type": "userTriggered"
  },
  "then": {
    "type": "askAgent",
    "prompt": "Activate the Supabase power, read appropriate steering files, then execute `get_logs` via MCP for \"postgres\" logs to look for slow queries, errors, or connection issues"
  }
}
```

Add a hook to .kiro/hooks/review-edge-functions.kiro.hook

```
{
  "enabled": true,
  "name": "Review Edge Functions",
  "description": "Verify edge functions follow best practices and have no recent errors.",
  "version": "1",
  "when": {
    "type": "userTriggered"
  },
  "then": {
    "type": "askAgent",
    "prompt": "Activate the Supabase power, read appropriate steering files, then review all edge functions (with MCP `get_edge_function` if available, or by reading files in `supabase/functions/`) and check them against the best practices documented in `supabase-prompts-edge-functions.md`. For each function, verify compliance with the guidelines and provide a detailed report of any issues found or improvements needed. Include specific file names and line numbers where applicable. Execute MCP `get_logs` and check \"functions\" logs for errors."
  }
}
```