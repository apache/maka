---
name: skill-writer
description: Create, synthesize, and iteratively improve agent skills following the Agent Skills specification. Use when asked to "create a skill", "write a skill", "synthesize sources into a skill", "improve a skill from positive/negative examples", "update a skill", or "maintain skill docs and registration". Handles source capture, precision passes, authoring, registration, and validation.
---

# Skill Writer

Use this as the single canonical workflow for skill creation and improvement.
Primary success condition: maximize high-value input coverage before authoring while minimizing wasted runtime tokens.

Follow the workflow steps in order. Load only the reference files required for the step you are on.
`SKILL.md` is the primary router: every bundled reference file should be flat under `references/` and listed here with a direct "open when..." reason.

## Core Workflow References

| Open when you need to...                                                             | Read                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------- |
| choose the minimum workflow path for create, update, iterate, or research-first work | `references/mode-selection.md`            |
| choose the simplest adequate execution shape before deciding files                   | `references/execution-shapes.md`          |
| apply writing constraints for depth, concision, and portability                      | `references/design-principles.md`         |
| decide what belongs in `SKILL.md`, `references/`, `SPEC.md`, or supporting files     | `references/reference-architecture.md`    |
| create or update the maintenance contract for a skill                                | `references/spec-template.md`             |
| find missing high-signal sources, including history and regressions                  | `references/source-discovery.md`          |
| adapt an upstream prompt, workflow, rubric, benchmark, or docs into a skill          | `references/source-adaptation.md`         |
| run the full synthesis pass with coverage checks and source capture                  | `references/synthesis-path.md`            |
| author or update `SKILL.md`, `SPEC.md`, and supporting files                         | `references/authoring-path.md`            |
| improve trigger language and false-positive/false-negative behavior                  | `references/description-optimization.md`  |
| iterate from positive, negative, or fix examples                                     | `references/iteration-path.md`            |
| store persistent working and holdout examples for future revisions                   | `references/iteration-evidence.md`        |
| choose a response template, schema, or output contract                               | `references/output-contracts.md`          |
| add or update evals for a skill's generated outputs or runtime behavior              | `references/skill-evals.md`               |
| troubleshoot overloaded layouts, hidden refs, or other structure failures            | `references/structure-troubleshooting.md` |
| register the skill and run final validation checks                                   | `references/registration-validation.md`   |

## Artifact Layout References

| Open when you need to...                                       | Read                                          |
| -------------------------------------------------------------- | --------------------------------------------- |
| keep the whole skill inline in one coherent `SKILL.md`         | `references/layout-inline-skill.md`           |
| split optional deep knowledge into focused routed references   | `references/layout-reference-backed-skill.md` |
| add scripts for deterministic automation or validation         | `references/layout-script-backed-workflow.md` |
| define a skill that is usually invoked with explicit arguments | `references/layout-argument-driven-skill.md`  |
| ship reusable templates, schemas, or other static assets       | `references/layout-asset-template-skill.md`   |

## Workflow Mechanic References

| Open when you need to...                                       | Read                                           |
| -------------------------------------------------------------- | ---------------------------------------------- |
| break a task into fixed ordered steps                          | `references/workflow-prompt-chaining.md`       |
| classify requests and route them to different downstream paths | `references/workflow-routing.md`               |
| split independent work into parallel units or votes            | `references/workflow-parallel.md`              |
| discover work units dynamically and coordinate worker outputs  | `references/workflow-orchestrator-workers.md`  |
| run validate-fix-repeat checks during authoring or execution   | `references/workflow-validation-loops.md`      |
| validate a plan before executing a risky action                | `references/workflow-plan-validate-execute.md` |

## Claude Code References

| Open when you need to...                                           | Read                                          |
| ------------------------------------------------------------------ | --------------------------------------------- |
| use Claude-specific frontmatter or invocation controls             | `references/claude-frontmatter-invocation.md` |
| use Claude argument fields or substitution variables               | `references/claude-argument-substitutions.md` |
| build a skill that runs in isolated `context: fork`                | `references/claude-subagent-fork.md`          |
| build a skill that uses Claude hooks for deterministic enforcement | `references/claude-hook-backed.md`            |
| use Claude shell preprocessing for dynamic context injection       | `references/claude-dynamic-context.md`        |

## Example Profiles

| Open when you need to...                               | Read                                           |
| ------------------------------------------------------ | ---------------------------------------------- |
| see the expected depth for a documentation-heavy skill | `references/example-documentation-skill.md`    |
| see the expected depth for a workflow-process skill    | `references/example-workflow-process-skill.md` |
| see what a good routed skill looks like                | `references/example-router-skill.md`           |
| see what a good subagent-fork skill looks like         | `references/example-subagent-fork-skill.md`    |
| see what a good hook-backed skill looks like           | `references/example-hook-backed-skill.md`      |

## Step 1: Resolve target, path, and shape

1. Resolve the intended operation (`create`, `update`, `synthesize`, `iterate`) and inspect workspace prior art before choosing where files belong.
2. Choose the target skill root from observed conventions. If the canonical location is still unclear after inspection, ask one direct question before editing files.
3. Read `references/mode-selection.md` to choose the minimum required workflow paths.
4. Read `references/execution-shapes.md` to choose the primary execution shape.
5. Default to the simplest adequate shape. If selecting a more complex shape, record why simpler shapes were rejected.
6. Load only the exact artifact-layout, workflow-mechanic, and provider-specific leaf files required by that shape.
7. Before adding guidance, identify what existing rule, section, or file should be narrowed, replaced, or removed.
8. Record portability implications before using provider-specific mechanics.

## Step 2: Run synthesis when needed

Read `references/synthesis-path.md`.

1. Use this path for new skills, material changes, and research-first planning.
2. Collect and score relevant sources with provenance.
3. Read `references/source-discovery.md` when source material is thin, stale, or ambiguous.
4. Read `references/source-adaptation.md` when adapting an upstream prompt, workflow, rubric, benchmark, or docs.
5. Produce source-backed decisions and coverage/gap status, including the class and execution-shape choice.
6. Load example profiles only when they add concrete depth for the selected class or shape.
7. If the skill uses provider-specific mechanics, include current official provider docs and capture usage constraints.
8. Do not move to authoring until required coverage is understood or gaps are explicit.

## Step 3: Run iteration first when improving from outcomes/examples

Read `references/iteration-path.md` first when selected path includes `iteration` (for example operation `iterate`).

1. Capture and anonymize examples with provenance.
2. Read `references/iteration-evidence.md` when examples should persist beyond the current turn.
3. Review skill behavior against working and holdout slices.
4. Propose improvements from positive/negative/fix evidence.
5. Carry concrete behavior deltas into authoring.

Skip this step when selected path does not include `iteration`.

## Step 4: Author or update skill artifacts

Read `references/authoring-path.md`.

1. Write or update `SKILL.md` in imperative voice with trigger-rich description.
2. Keep `SKILL.md` as the runtime router, not an encyclopedia.
3. Run the pre-edit precision check in `references/authoring-path.md` before creating new sections or files.
4. Read `references/reference-architecture.md` before adding bulk instructions or new reference files.
5. Create or update `SPEC.md` using `references/spec-template.md` when creating a new skill or materially changing its contract.
6. Create focused reference files, scripts, and assets only when each one has a clear "open when..." reason and cannot be handled by tightening an existing file.
7. If you add a bundled reference file, add a direct routing entry for it in this `SKILL.md`.
8. Prefer checklists, tables, templates, and input/output examples over explanatory prose.
9. Follow only the specific artifact-layout, workflow-mechanic, Claude-specific, and output-contract references selected for this skill.
10. For advanced execution shapes, add the required routing, delegation, or safety contracts before considering the skill complete.
11. For authoring/generator skills, include transformed examples in references:

- happy-path
- secure/robust variant
- anti-pattern + corrected version

12. Read `references/skill-evals.md` when the request asks for evals, regression cases, benchmark cases, or model-graded quality checks for the skill being authored.
13. After any skill artifact changes, run the post-change precision pass in `references/authoring-path.md` before description optimization or validation.

## Step 5: Optimize description quality

Read `references/description-optimization.md`.

1. Validate should-trigger and should-not-trigger query sets.
2. Reduce false positives and false negatives with targeted description edits.
3. Keep trigger language generic across providers unless the skill is intentionally provider-specific.

## Step 6: Register and validate

Read `references/registration-validation.md`.

1. Apply repository registration steps for the active layout you verified in the workspace.
2. Run quick validation for structural checks.
3. Review validator warnings, precision-pass results, and coverage gaps with judgment before completion.

## Output format

Return:

1. `Summary`
2. `Changes Made`
3. `Validation Results`
4. `Open Gaps`
