---
name: deep-codebase-audit
description: Deep codebase audit identifying architectural friction, dead code, technical debt, and refactoring opportunities. Use this skill when the user wants a comprehensive analysis of codebase health and actionable refactoring recommendations.
allowed-tools:
  - Bash(grep *)
  - Bash(find *)
---

# Deep Codebase Audit

Comprehensive codebase audit that identifies architectural friction, dead code, technical debt, and prioritizes refactoring opportunities.

## Audit Dimensions

| Dimension | What It Finds |
|-----------|---------------|
| **Architecture** | Circular dependencies, layer violations, god objects |
| **Dead Code** | Unused exports, unreachable branches, orphaned files |
| **Technical Debt** | TODO/FIXME density, outdated patterns, test gaps |
| **Performance** | N+1 queries, large bundle contributors, render inefficiencies |
| **Security** | Hardcoded secrets, injection vectors, weak crypto |

## Workflow

1. **Scan** — analyze the codebase structure and metrics
2. **Identify** — surface specific issues with file/line references
3. **Prioritize** — rank by impact vs effort
4. **Recommend** — actionable refactoring steps with expected outcomes

## Best Practices

1. Run audit before major refactoring efforts to identify priorities
2. Focus on high-impact, low-effort items first (low-hanging fruit)
3. Track audit results over time to measure improvement
4. Combine with code-review for ongoing quality enforcement
