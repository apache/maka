---
name: skill-review
description: "Quality review and audit for Claude Code skills. Analyzes skill structure, description quality, workflow design, token efficiency, and anti-patterns against best practices. Use when user wants to review a skill, audit a skill, check skill quality, evaluate a skill, critique a skill, lint a skill, or validate a skill. Triggers: 'review skill', 'audit skill', 'skill quality', 'check my skill', 'evaluate skill', 'skill lint', 'validate skill', 'skill review', 'is this skill good', 'improve this skill'."
---

# Skill Review

IRON LAW: Be specific and actionable. Never say "could be improved" without stating exactly what to change and why it matters for model output quality.

## Workflow

```
Skill Review Progress:

- [ ] Step 1: Load Target ⚠️ REQUIRED
  - [ ] 1.1 Identify skill path
  - [ ] 1.2 Read SKILL.md and inventory all files
- [ ] Step 2: Analyze ⚠️ REQUIRED
  - [ ] 2.1 Structure compliance
  - [ ] 2.2 Description quality
  - [ ] 2.3 Workflow design
  - [ ] 2.4 Token efficiency
  - [ ] 2.5 Anti-pattern detection
- [ ] Step 3: Report ⚠️ REQUIRED
  - [ ] 3.1 Strengths (what's done well)
  - [ ] 3.2 Suggestions (prioritized improvements)
```

## Step 1: Load Target ⚠️ REQUIRED

Identify the skill to review. Accept:

- Explicit path: `/skill-review path/to/skill`
- Current directory context: if user is already in a skill folder
- Skill name: search within the workspace for matching skill directory

Read the full SKILL.md and list all files in the skill directory. Count SKILL.md line count — this is a key metric.

## Step 2: Analyze ⚠️ REQUIRED

Load references/review-criteria.md for detailed criteria. Evaluate the skill across five dimensions:

### 2.1 Structure Compliance

Questions to answer:

- Does the directory follow the standard layout (SKILL.md, scripts/, references/, assets/)?
- Is SKILL.md under 500 lines?
- Does frontmatter contain only `name` and `description` (plus optional `allowed-tools`, `license`, `metadata`)?
- Are there unnecessary files (README.md, CHANGELOG.md, LICENSE duplicates)?
- Are references organized by domain with one level of nesting?

### 2.2 Description Quality

Questions to answer:

- Does the description include concrete trigger keywords and phrases?
- Does it use keyword bombing (multiple phrasings of the same intent)?
- Is it self-contained — can a router understand what this skill does without reading the body?
- Does it avoid putting "When to Use" info in the body instead of the description?
- Would a user's natural language query match this description?

### 2.3 Workflow Design

Questions to answer:

- Is there a trackable checklist with copy-paste-friendly format?
- Are critical steps marked with ⚠️ REQUIRED or ⛔ BLOCKING?
- Are there confirmation gates before destructive/generative operations?
- Is the workflow linear and progressive, or does it jump around?
- Are sub-steps used where complexity demands it?

### 2.4 Token Efficiency

Questions to answer:

- Is there an Iron Law or core constraint at the top?
- Does SKILL.md only contain what Claude doesn't already know?
- Are references loaded progressively (on-demand) rather than all upfront?
- Are instructions in imperative form (not "You should...")?
- Are scripts executed rather than loaded into context?
- Is there redundancy between SKILL.md and reference files?

### 2.5 Anti-Pattern Detection

Check for these known bad patterns:

- Vague directives ("ensure good quality", "make it better")
- Placeholder residue (TODO, FIXME, xxx, TBD)
- Over-specification of things Claude already knows
- No anti-patterns section (model has no guardrails against lazy defaults)
- Missing pre-delivery checklist (no concrete verification criteria)
- Giant monolithic SKILL.md with no reference extraction
- Instructions that describe WHAT rather than constrain HOW

## Step 3: Report ⚠️ REQUIRED

### Output Format

Present the review in this order:

**1. Strengths** — What this skill does well. Be specific: quote the actual lines or patterns that work. Minimum 2 strengths, even for weak skills (find what's salvageable).

**2. Suggestions** — Improvements sorted by impact (highest first). Each suggestion must include:

- **What**: the specific issue found
- **Where**: file and location
- **Fix**: concrete actionable change (show before/after when helpful)

Group suggestions by dimension only if there are many (5+). Otherwise present as a flat prioritized list.

### Tone

- Direct, constructive, collegial
- Lead with genuine strengths — not filler praise
- Suggestions are opportunities, not failures
- If the skill is already solid, say so briefly and move on

## Anti-Patterns for This Skill

- Giving vague praise ("nice structure!") without quoting what specifically works
- Listing problems without actionable fixes
- Reviewing against personal taste rather than the documented principles
- Suggesting over-engineering for simple skills
- Flagging missing features that the skill intentionally omits (check if simplicity is the point)
