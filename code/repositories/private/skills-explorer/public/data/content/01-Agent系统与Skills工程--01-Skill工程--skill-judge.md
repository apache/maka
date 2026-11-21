---
name: skill-judge
description: Evaluate Agent Skill design quality with an opinionated, practice-derived rubric informed by public specifications and examples. Use when reviewing, auditing, comparing, or improving SKILL.md files and skill packages. Produces evidence-backed findings, optional multi-dimensional scoring, and prioritized changes; treat the result as diagnostic guidance, not official certification or a universal standard.
---

# Skill Judge

Review a Skill as an executable knowledge package, not as an essay. Judge whether the package triggers at the right time, adds knowledge the AI model needs, routes to the right resources, and helps an agent produce better work.

## Applicability

Use this as an opinionated diagnostic framework. It is informed by public specifications, examples, and practical use, but it is not an official compliance suite. Do not turn a numeric score into a claim of universal quality.

## Choose the review depth

- **Quick review**: identify blockers, the highest-value weakness, and the next change. Do not score unless a score helps the decision.
- **Full audit**: inspect the entire package, score all dimensions, and produce prioritized recommendations. Read [rubric.md](references/rubric.md) completely before scoring.
- **Comparison**: evaluate each Skill independently first, then compare evidence and trade-offs. Do not force a winner when the Skills serve different use cases.
- **Revision review**: compare the current package with the previous version and judge whether the change improves real behavior, not only presentation.

## Read the complete package

1. Read `SKILL.md` completely.
2. List every bundled reference, script, asset, and agent metadata file.
3. Follow every resource link and loading instruction that affects behavior.
4. Check whether referenced files exist and whether shipped scripts or examples are plausible and tested.
5. Distinguish observed facts from assumptions about how an agent might behave.

Do not score a package from its frontmatter or first screen alone.

## Apply the hard gates first

Report these before subjective scoring:

- missing or invalid `SKILL.md` frontmatter;
- folder name and `name` mismatch;
- vague description that does not communicate function and trigger context;
- broken resource paths or routing instructions;
- advertised capabilities that the package does not implement;
- unsafe scripts or instructions without proportionate guardrails;
- contradictory requirements that make correct execution impossible.

A polished package with a hard-gate failure is not ready.

## Evaluate actual knowledge value

Classify substantive sections using three labels:

- **Expert**: non-obvious decisions, trade-offs, failure modes, domain procedures, or local knowledge the AI model is unlikely to supply reliably.
- **Activation**: knowledge the AI model may know but benefits from seeing at the right moment.
- **Redundant**: generic explanation, obvious advice, or repeated content that consumes context without changing behavior.

Use this classification diagnostically. Do not invent precise paragraph percentages when the boundary is ambiguous.

Ask:

- What would the agent do better after loading this Skill?
- Which content changes a decision rather than merely describing the domain?
- Which instructions encode experience that is difficult to reconstruct on demand?
- Which sections could disappear without affecting the result?

## Review trigger quality

The description is the primary activation surface. It should make clear:

- what the Skill does;
- when it should be used;
- which concrete tasks, artifacts, file types, tools, or user phrases should trigger it;
- when a neighboring Skill is a better choice, if overlap is likely.

Do not reward keyword stuffing. A long description that triggers everywhere creates routing conflicts instead of discoverability.

## Review package architecture

Check whether the package uses progressive disclosure intentionally:

- Keep core decisions and routing in `SKILL.md`.
- Put detailed variants, schemas, examples, and domain references in bundled resources.
- State when to load each resource and when not to load it.
- Avoid orphan references that are shipped but never routed.
- Avoid a large `SKILL.md` that loads an entire manual for every request.
- Avoid fragmentation that forces the agent to open many tiny files for one simple task.

The target is the smallest context that preserves correct behavior, not a fixed line count.

## Review behavioral quality

Look for:

- explicit decision criteria where several paths are possible;
- appropriate freedom for the task's risk and variability;
- specific anti-patterns with reasons, not vague warnings;
- failure handling, fallback paths, and realistic edge cases;
- evidence that scripts and examples work as described;
- boundaries that prevent the Skill from competing with unrelated or more specific Skills;
- instructions that remain practical in the target environment.

## Score only with evidence

For a full audit, use the 120-point rubric in [rubric.md](references/rubric.md). For every dimension:

1. cite concrete package evidence;
2. name the behavioral consequence;
3. assign a score using the published anchors;
4. state what would materially raise the score.

Do not award points for length, polish, confident wording, or the number of bundled files.

## Prioritize findings

Use four severity levels:

- **Blocker**: prevents reliable activation, execution, safety, or installation.
- **High**: materially degrades common outcomes or creates misleading behavior.
- **Medium**: causes avoidable friction, context waste, or incomplete coverage.
- **Low**: worthwhile refinement with limited behavioral effect.

Prioritize by expected improvement to real use, not by ease of editing.

## Output format

Lead with the verdict.

```markdown
# Skill Review: [name]

## Verdict

[Ready / usable with changes / not ready, plus one sentence explaining why]

## Applicability

[What context the judgment assumes and what it does not establish]

## Findings

1. **[Severity] [Issue]**
   - Evidence: [file and relevant location]
   - Effect: [how behavior or usability suffers]
   - Change: [specific improvement]

## Score

[Include only for a full audit: dimension table, total, and grade]

## Highest-value next changes

1. [First change]
2. [Second change]
3. [Third change]

## What is already strong

[Only evidence-backed strengths worth preserving]
```

Keep praise short. Make weaknesses specific enough that another agent can implement the improvement without reconstructing the audit.

## Bad review patterns

- Giving a high score because the package looks professional.
- Treating every long procedure as expert knowledge.
- Calling a practice-derived rubric an official standard.
- Penalizing all repetition without considering activation value.
- Recommending more files without a loading strategy.
- Recommending fewer files when separation protects context.
- Reporting stylistic preferences as behavioral defects.
- Evaluating an example link inside a fenced code block as a broken live link.
- Ignoring mismatches between advertised and implemented capabilities.

## Final question

Ask: **Does this package reliably transfer useful judgment or operational knowledge at the moment an agent needs it?**

If the answer is unclear, the review is not finished.
