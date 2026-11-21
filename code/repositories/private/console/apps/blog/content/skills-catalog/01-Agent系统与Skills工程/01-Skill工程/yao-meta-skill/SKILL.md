---
name: yao-meta-skill
description: Create, improve, or evaluate an existing skill from workflows, prompts, SOPs, scripts. Use for migration/release/package, routing, evals/tests, install/trust checks, 优化已有 skill, 补 trigger 评测. Exclude summary/translation/docs, brainstorming, one-off prompts, copy-only edits, outline-only requests.
metadata:
  author: Yao Team
---

# Yao Meta Skill

## Router Rules

- Route by frontmatter `description` using the lightest mode.
- Keep `SKILL.md` lean: guidance in `references/`, logic in `scripts/`, evidence in `reports/`.

## Modes

- `Scaffold`: exploratory; `Production`: team; `Library`: shared; `Governed`: release-critical.
- Rules: [Method](references/skill-engineering-method.md), [Modes](references/operating-modes.md), [Boundaries](references/resource-boundaries.md).

## Compact Workflow

1. Require `repeated use` + `reusable output contract`; skip one-offs.
2. Lock target path + identity before writes; self-edits require `--self`.
3. Capture job, output, exclusions, constraints, standards, mode.
4. Scan `3-5` useful external/user/local references.
5. Write `description` early; route edits need `trigger_eval.py`; release gates follow risk.
6. Add deeper profiles only when earned.

Playbooks: [Target Safety](references/target-safety.md), [Intent](references/intent-dialogue.md), [Skill IR](references/skill-ir-method.md), [Output Eval](references/output-eval-method.md), [Review Studio](references/review-studio-method.md).

## Updates

Activation: `scripts/yao.py check-update --notice --self`; show `notice_text` if requested; continue. “更新”: `scripts/yao.py self-update --self --yes`.

## Skill OS 2.0 Gates

For production/library/governed releases, run Skill IR, compiler, trigger/output eval, Atlas, conformance, trust, package/install, upgrade, drift, waiver, Review Studio.

## Governed Package Boundary

Governed/file-backed packages: label `input_files` a `file-backed fixture`; include `owner`, `review cadence`, `output contract`, `rollback boundary`; require `trust report` and `reports/output_quality_scorecard.md`; mark unavailable telemetry/approvals/metrics/benchmarks as `missing evidence`; never fabricate evidence.

Preserve labels literally when they apply: `file-backed fixture`, `input_files`, `output contract`, `rollback boundary`, `trust report`, `reports/output_quality_scorecard.md`, `missing evidence`.

## First-Turn Style

- Infer non-core gaps; ask one core-fork question per round, max two, then use recorded preferred inference.
- In Chinese, sound soft and companion-like; use [Intent Dialogue](references/intent-dialogue.md).

## Output Contract

Builds: `SKILL.md`, aligned interface, justified assets, boundary/gate summary. Audits: findings + fixes; edit only when asked. No-skill: no files.

## Reference Map

Primary: [Method](references/skill-engineering-method.md), [Artifact Design](references/artifact-design-doctrine.md), [Systems](references/systems-thinking-doctrine.md), [Governance](references/governance.md), [SkillOps](references/skillops-decision-policy.md).
