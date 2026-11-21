---
name: design-generator
description: Generate a design-system package containing `DESIGN.md` or `design.md`, `preview.html`, and `preview-dark.html` by analyzing a local codebase, an existing project folder, screenshots, a live website URL, or a brand-new product idea. Use when Codex needs to extract an existing product's visual grammar with high fidelity, keep future UI work aligned with source code, or synthesize a concrete design system and previews from a product brief without falling back to generic defaults.
---

# Design Generator

## Overview

Turn an existing app, site, screenshot set, or product concept into one design-system package with three deliverables:

- `DESIGN.md` or `design.md`: the reusable design system document that future agents can follow
- `preview.html`: a light preview catalog of the extracted visual system
- `preview-dark.html`: a dark preview catalog of the same system or a dark inspection view

Use this skill in two modes:

- **Extraction mode**: derive the system from an existing codebase, product, website, or screenshot set.
- **Synthesis mode**: create the system from a new product idea while keeping it specific, implementation-ready, and category-appropriate.

Do not produce a vague moodboard. Always output a reusable design document plus previews that another agent can build from directly.

## Quick Start

1. Classify the request: local source path, live URL, screenshots, product idea, or a combination.
2. Read [references/design-md-corpus.md](references/design-md-corpus.md) to choose the right interface archetype and preview composition.
3. Read [references/input-analysis.md](references/input-analysis.md) for the matching evidence workflow.
4. Read [references/output-contract.md](references/output-contract.md) before writing.
5. Decide the output location and markdown filename:

- Follow an existing project convention if the repo already uses `DESIGN.md` or `design.md`
- If the user explicitly asks for `design.md`, use that exact filename
- Otherwise default to `DESIGN.md` to match this repository's corpus

6. Scaffold the folder before writing:

```bash
python3 scripts/scaffold_design_folder.py --output /absolute/path/to/DESIGN --name "Product Name" --markdown-name DESIGN.md
```

7. Use `assets/DESIGN.template.md`, `assets/preview.template.html`, and `assets/preview-dark.template.html` as starting points.
8. Write the actual design system and previews.
9. Validate the result:

```bash
python3 scripts/validate_design_folder.py /absolute/path/to/DESIGN --markdown-name DESIGN.md
```

## Workflow

### 1. Classify the request and choose the output convention

Decide which of these paths applies:

- **Local project or source path**: extract the current system with the highest fidelity
- **Live website URL**: inspect the visible site and recover reusable design rules
- **Screenshots**: infer the system conservatively from repeated visual evidence
- **New product idea**: define a fresh but concrete design language from the brief

Choose the output location early:

- If the user gives a project path: write into that project, usually a single `DESIGN/`, `design/`, or named target folder
- If the user gives only a URL, screenshots, or a concept: write to `./DESIGN` unless the user specifies another path

Create exactly one markdown design file in the target folder. Do not create both `DESIGN.md` and `design.md` for the same target.

### 2. Choose the evidence hierarchy

Prefer the strongest available evidence in this order:

1. Source code tokens and component primitives
2. Live rendered UI and real screenshots
3. Explicit product brief, business context, and user constraints
4. Reasonable inference from repeated patterns or chosen references

If two sources conflict, prefer the source that most closely matches the user's target. State the mismatch explicitly inside `DESIGN.md` if it affects the output.

### 3. Analyze the input deeply

Follow the appropriate branch in [references/input-analysis.md](references/input-analysis.md):

- Local source path: inspect theme files, CSS variables, Tailwind config, design tokens, component primitives, app shells, screenshots, and route-level patterns. Preserve the actual framework, component library, and layout grammar that the code already uses.
- Live website URL: inspect the live UI across multiple page types and states, and extract visible tokens from computed styles or markup when possible. If the site contains both marketing and app surfaces, prioritize the one closest to the user's goal.
- Screenshots: infer tokens conservatively from repeated evidence and mark uncertain conclusions as inferred rather than observed.
- Product idea: identify the target user, primary workflows, interface archetype, density level, trust or creativity posture, and one to three benchmark products or corpus examples. Make reasonable assumptions when the brief is incomplete, and record them explicitly instead of blocking.

Do not stop at colors. Extract:

- visual mood and density
- typography hierarchy and font stacks
- semantic color roles
- component states
- layout grammar and spacing scale
- radius and shadow system
- responsive behavior
- repeated page patterns such as nav, filters, cards, tables, drawers, or forms

For new product ideas, additionally define:

- the primary interface archetype, for example marketing-led SaaS, product dashboard, enterprise admin, editor workspace, or documentation-heavy developer tool
- the core page grammar that should recur in future generations
- the default component families and states
- the dark-mode strategy: real dark system, optional dark system, or inspection-only dark preview
- the benchmark influences to borrow from and the traits to avoid

### 4. Lock the design direction before writing

Before drafting files, build a short internal lockup that covers:

- one-sentence product posture
- chosen markdown filename and output folder
- 6 to 12 semantic color roles
- typography hierarchy
- primary component families
- page grammar
- responsive behavior
- confidence level and any inferred gaps

For **source-code mode**, this lockup must be anchored to actual files, tokens, or repeated UI primitives. Favor fidelity over novelty.

For **product-idea mode**, this lockup must be coherent and singular. Choose one clear direction; do not mash together incompatible references just to sound original.

### 5. Write the markdown design file

Follow the contract in [references/output-contract.md](references/output-contract.md).

Keep the document grounded in observable behavior:

- Describe repeated patterns, not one-off art direction flourishes
- Prefer semantic names such as "Primary Action Blue" over raw swatch names
- Preserve the product's locale and terminology in examples
- Keep section prose concrete enough that another agent can reproduce the look without seeing the original product

For **source-code mode**:

- name the real layout wrappers, component primitives, utility systems, or library conventions when they materially affect future implementation
- preserve the existing platform tone and interaction density
- do not "upgrade" the product into a different brand language if the codebase does not support it

For **product-idea mode**:

- explain who the interface is for and what kind of work it supports
- define the visual direction concretely enough that future agents do not fall back to generic SaaS defaults
- make the chosen references transferable, not copy-pasted

If a value is inferred, say so directly, for example:

- `Likely inferred from repeated screenshots`
- `Approximate hover state because source code was unavailable`
- `Assumption based on the product brief and selected benchmark direction`

### 6. Build the preview catalogs

Preview pages are token catalogs, not business mockups.

Choose showcase modules that match the source product or the chosen product archetype:

- Marketing site: hero, CTA buttons, pricing-style card, feature block, navigation, form
- Product/dashboard: app shell, filters, table/list row, form, card, modal/drawer, status pills
- Consumer/productivity UI: sidebar, content card, composer/input, modal, tabs, chip/tag
- Enterprise/admin: search toolbar, title/action strip, table, drawer, status tags, pagination, shell preview
- Editor/workbench: sidebar, canvas/editor panel, inspector panel, toolbar, command or query area

Both preview files must be self-contained HTML files with CSS variables at the top. External fonts are acceptable; build steps are not.

For `preview-dark.html`:

- If the source product has a real dark mode, represent it faithfully
- If the source product is light-only, create a dark inspection board using the same brand system on dark-neutral surfaces
- Do not invent a second brand language just to make the dark preview look dramatic

### 7. Validate and refine

Run the validator after writing the files. Fix every hard failure. Treat warnings as real unless there is a deliberate reason to ignore them.

Then perform a final manual pass:

- check that the chosen markdown filename is correct for the target project
- check that no placeholder text remains
- check that colors, fonts, spacing, and sample components align with the source
- check that a concept-generated system is coherent and fits the product category
- check that the previews surface the system clearly enough for future reuse

## Output Rules

- Always create exactly one design-system package for the requested target.
- Always include one markdown design file (`DESIGN.md` or `design.md`), `preview.html`, and `preview-dark.html`.
- Always make the markdown design file the source of truth; previews are visual companions, not substitutes.
- Always keep the output implementation-ready. Another agent should be able to build new pages from the markdown file alone.
- When the input is source code, preserve the product's actual design language and implementation grammar instead of inventing a prettier alternative.
- When the input is a product idea, choose a strong direction and carry it through all three files without retreating to generic templates.
- Never pad the previews with unrelated components that were not visible in the source system.

## Resources

### `references/design-md-corpus.md`

Read this first to understand the patterns in the `design-md` corpus, select the closest interface archetype, and decide how the previews should be composed.

### `references/input-analysis.md`

Read this when deciding how to inspect a codebase, live URL, screenshot set, or product concept.

### `references/output-contract.md`

Read this before writing. It defines the required file set, section contract, naming rules, preview expectations, and quality bar.

### `scripts/scaffold_design_folder.py`

Use this to create a clean output folder from bundled templates. Pass `--markdown-name` to match the requested naming convention.

### `scripts/validate_design_folder.py`

Use this to catch missing files, naming mismatches, missing numbered sections, and weak preview structure before finishing.

### `assets/DESIGN.template.md`

Open this only when you need a starting skeleton for the markdown deliverable.

### `assets/preview.template.html`

Open this only when you need a starting skeleton for the light preview catalog.

### `assets/preview-dark.template.html`

Open this only when you need a starting skeleton for the dark preview catalog.
