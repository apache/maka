---
name: deep-architecture-research
description: Deeply research technical architecture, source code, mechanisms, SDKs, frameworks, project comparisons, and system-design options across repositories, history, official docs, issues, discussions, and high-quality community signals. Use when the user asks for deep research, source-level understanding, architecture comparison, mechanism satisfaction, or evidence for designing a system. Always map the question and obtain confirmation before beginning substantive research; skip for simple factual lookups or straightforward implementation tasks.
---

# Deep Architecture Research

Outsource the legwork, not the problem definition. Work as a senior engineer reporting to a human architect.

## 1. Confirmation gate

Use one confirmation gate per research objective. A follow-up that stays inside an already confirmed scope continues without restarting the gate.

Before searching, cloning, or delegating substantive research, send a 500–1,000 Chinese-character framing brief in the user's language. Keep it near 500 characters when possible and include one compact box diagram.

The brief must make four things explicit:

1. **Objects**: what systems, projects, versions, or relationships will be studied.
2. **Questions**: the decisions, mechanisms, and satisfaction gaps to resolve.
3. **Dimensions**: orthogonal axes, layers, dependencies, boundaries, and scenarios.
4. **Sources and output**: repositories, history, docs, community signals, and intended artifact.

Use this shape, adapting labels to the task:

```text
┌──────────────┐     ┌────────────────┐
│ Research objects│──>│ Core questions │
└──────┬───────┘     └───────┬────────┘
       │                     │
       ▼                     ▼
┌──────────────┐     ┌────────────────┐
│ Dimensions   │────>│ Evidence/output │
└──────────────┘     └────────────────┘
```

End by asking whether the map is correct and what should be added or removed. Stop there. The gate is complete only after the user confirms or corrects the scope.

## 2. Research after confirmation

First, organize work by questions and mechanisms, not by vendor names. Define bounded work packages and the evidence each must return.

**MANDATORY — READ ENTIRE FILE:** Before gathering evidence, read [references/evidence-protocol.md](references/evidence-protocol.md). It defines source priority, local-clone practice, history windows, community use, evidence labels, and code-example rules.

Delegate independent work when it improves coverage or cross-checking. Each agent receives one bounded question and returns:

- finding and architectural consequence;
- source URL or local path, commit/tag/version, and date;
- current, historical, planned, deprecated, or inferred status;
- uncertainty and unresolved contradictions.

Subagents may delegate narrower evidence collection when useful. The parent remains responsible for deduplication, contradiction resolution, and the final judgment; do not substitute a pile of agent notes for synthesis.

## 3. Analyze the mechanism, not the brochure

For each important system, determine:

- what the stable subject and authoritative state are;
- which layer owns identity, lifecycle, persistence, authority, and effects;
- how the recommended development path changed over time;
- which scenarios work naturally, require adapters, or break the abstraction;
- what users and maintainers identify as hard, unsupported, or uneconomic;
- whether a claimed feature is core, hosted product, extension, preview, roadmap, or archived surface.

Build comparisons around the user's relationship and satisfaction requirements. A feature matrix is supporting evidence, not the conclusion.

## Hard failures

- **NEVER begin substantive research before the confirmation gate.** A beautifully researched answer to the wrong question is still failure.
- **NEVER inspect available source only through isolated web pages when a local clone is practical.** It hides call paths, tests, branches, and history.
- **NEVER promote community complaints, README claims, open PRs, or roadmaps into current implementation facts.** Calibrate each with stronger evidence and status.
- **NEVER let delegation replace synthesis.** Agent notes are evidence inputs; the parent must resolve conflicts and choose the architectural conclusion.

## 4. Synthesize for decision

Choose the main contradiction and give one recommended architecture or decision. Separate verified implementation facts, official claims, community signals, and inference.

For substantive research, write one durable Markdown artifact in the repository's existing research location. Record source snapshots and unresolved items. Keep scratch notes out of shared deliverable paths.

**MANDATORY FINAL REPORT:** Read and apply [Understanding-First Report](../understanding-first-report/SKILL.md). For technical reports, also follow its visual and code-evidence reference. The chat handoff stays concise even when the artifact is extensive.

## Completion bar

Research is complete only when every confirmed question is answered or explicitly marked unresolved, every decisive claim has traceable evidence, named systems have coverage, current facts are separated from history and plans, and the final recommendation follows from the evidence rather than project popularity.
