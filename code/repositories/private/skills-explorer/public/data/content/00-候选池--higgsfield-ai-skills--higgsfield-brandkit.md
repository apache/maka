---
version: 0.13.0
name: higgsfield-brandkit
description: |
  Create and extend complete visual brand systems through the Higgsfield CLI and bundled deterministic local tooling: palettes, SVG logo marks, typography, mockups, social graphics, packaging, signage, merchandise, posters, presentation decks, and editable PPTX/PDF brandbooks. Preserves official supplied assets, persists approvals locally, and regenerates only dependent outputs. Use when: "create a brand kit", "make a visual identity", "design a logo and brandbook", "apply this logo to branded assets", "make packaging or signage", or "extend our existing branding". Chain with higgsfield-generate for general image production and Marketing Studio brand-kits when importing website metadata for ads. NOT for unbranded image generation (use higgsfield-generate), product catalog photography (use higgsfield-product-photoshoot), website implementation (use higgsfield-websites), or native Figma/Canva/PSD/AI delivery.
argument-hint: "[brand brief or existing assets] [requested deliverables]"
allowed-tools: Bash
---

# Higgsfield Brandkit

Build a coherent identity and its requested applications. Treat supplied brand facts and official assets as fixed constraints.

## Bootstrap

1. Resolve `SKILL_ROOT` to this skill's installed directory and create a durable project directory:

   ```bash
   BRANDKIT_WORKDIR="${PWD}/brandkit"
   BRANDKIT_STATE="${BRANDKIT_WORKDIR}/state.json"
   mkdir -p "${BRANDKIT_WORKDIR}"
   ```

2. Read [prerequisites](references/prerequisites.md). Check tools before the stage that needs them. Never install system packages without the user's permission.
3. If `higgsfield` is missing, install it only after permission:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh | sh
   ```

4. If `higgsfield account status` fails with an authentication or workspace error, ask the user to run `higgsfield auth login` or select a workspace, then wait.
5. Inspect live model contracts before paid generation:

   ```bash
   higgsfield model get recraft_v4_1 --json
   higgsfield model get seedream_v5_pro --json
   higgsfield model get gpt_image_2 --json
   ```

## CLI mapping

| Operation                 | Command                                                                  |
| ------------------------- | ------------------------------------------------------------------------ |
| Discover a model          | `higgsfield model get <model> --json`                                    |
| Generate and poll         | `higgsfield generate create <model> ... --wait --json`                   |
| Resume a job              | `higgsfield generate wait <job_id> --json`                               |
| Upload a local asset      | `higgsfield upload create <path> --json`                                 |
| Import website metadata   | `higgsfield marketing-studio brand-kits fetch --url <url> --wait --json` |
| Read/write approval state | `python3 "$SKILL_ROOT/scripts/brandkit.py" state ...`                    |
| Render review boards      | `python3 "$SKILL_ROOT/scripts/brandkit.py" preview ...`                  |
| Inspect selected logo     | `python3 "$SKILL_ROOT/scripts/brandkit.py" logo-inspect ...`             |
| Export logo files         | `python3 "$SKILL_ROOT/scripts/brandkit.py" logo-export ...`              |
| Build a Brandbook         | `python3 "$SKILL_ROOT/scripts/brandkit.py" brandbook-build ...`          |

Local image paths passed with `--image` are auto-uploaded. Keep HTML, SVG, PPTX, and PDF deliverables as local project files unless the user explicitly needs a hosted copy.

## User-facing behavior

- Match the user's language. Keep Design Brain reasoning, prompts, state mechanics, scripts, model lookup, and QA internals private.
- Send at most one short status sentence per visible generation batch, then stay quiet until the result is ready.
- Ask one compact set of only unresolved blocking questions. Never repeat facts or force a complete identity questionnaire for a partial task.
- After each palette, logo, typography, or downstream review, stop and wait for ordinary user feedback.
- Never infer approval from silence, successful generation, or your own preference.
- Preserve exact user copy. Never invent positioning, values, claims, ingredients, prices, certifications, statistics, or regulatory content.

## Core workflow

1. **Classify the request.**
   - `apply-existing`: use supplied official assets without redesigning them.
   - `extend-partial`: create only missing slots required by the requested output.
   - `create-identity`: create a new logo or identity only when explicitly requested.
2. **Read state.** Run:

   ```bash
   python3 "$SKILL_ROOT/scripts/brandkit.py" state \
     --state-file "$BRANDKIT_STATE" --action get_status
   ```

   Local state is durable. Never paste, hand-edit, or recreate approvals when the state file exists.

3. **Run intake and asset analysis.** Read [intake](references/intake.md), [asset analysis](references/asset-analysis.md), [state routing](references/handoff.md), and [exact state payloads](references/state-payloads.md). Lock every user-declared official logo, palette, and typography slot immediately.
4. **Create the Brand Lock.** Read [Brand Lock](references/brand-lock.md). Record exact spelling, official assets, colors, fonts, layout/shape rules, requested outputs, and forbidden treatments.
5. **Require only the slots the output uses.**
   - logo-only → palette + logo for a new mark; official logo alone for an existing mark
   - palette-only → palette
   - typography-only → typography
   - copy-free mockup/merch → logo; add palette only when color/application requires it
   - text-bearing social/packaging/poster/signage → logo + palette + typography
   - Brandbook/deck → logo + palette + typography
6. **Build missing foundation slots.** Read [Design Brain](references/brandkit-design-brain.md), [concept boards](references/concept-boards.md), [inline reviews](references/inline-widgets.md), and only the needed [palette](references/palette.md), [logo](references/logo.md), or [typography](references/typography.md) module.
7. **Continue the original request** as soon as its required slots are approved. Never ask the user to choose scope again.
8. **Load only the requested production module:**
   - [mockups](references/mockups.md)
   - [social graphics](references/social-templates.md)
   - [posters/banners](references/posters-banners.md)
   - [packaging](references/packaging.md)
   - [signage](references/signage.md)
   - [merchandise](references/merchandise.md)
   - [presentation decks](references/presentation-deck.md)
   - [Brandbooks](references/brandbook.md)
9. **QA and approval.** Read [QA and iteration](references/qa-and-iteration.md). Repair only the failing output. Save a downstream element only after explicit approval with its exact foundation dependencies.

## New identity sequence

### 1. Palette

Render 2–3 exact palette options as deterministic HTML using [preview payloads](references/preview-payloads.md). Show PNG screenshots plus editable HTML files and wait. Persist the selected palette with `approve_palette` before logo generation.

### 2. SVG logo marks

Read [logo prompt enhancer](references/logo-prompt-enhancer.md). Produce exactly three distinct symbol-only mechanisms and one Recraft prompt for each. Write each long prompt to a file and submit separately:

```bash
higgsfield generate create recraft_v4_1 \
  --model_type vector \
  --colors @"${BRANDKIT_WORKDIR}/logo-colors.json" \
  --background_color '#F7F7F5' \
  --aspect_ratio 1:1 \
  --resolution 2k \
  --wait --json < "${BRANDKIT_WORKDIR}/logo-candidate-1.txt"
```

Use the returned SVG URLs directly for review. After selection, inspect the exact SVG without altering it:

```bash
python3 "$SKILL_ROOT/scripts/brandkit.py" logo-inspect \
  --source "<selected Recraft SVG URL or absolute local path>"
```

Persist the exact job ID, SVG URL, name, palette revision, and returned canonical geometry fingerprint with `approve_logo`.

### 3. Typography

Propose 2–3 unique display/body pairs using supplied fonts or verified Google Fonts. Render the real brand name and sample copy through the preview script. Persist only the selected pair with `approve_typography`.

Interactive flows always stop for palette, logo, and typography selections. Explicit no-question mode may choose and persist a palette, but it still shows all three SVG logo candidates and stops for the user's logo selection; exact brand marks are never self-approved.

## Consistency invariants

- Reuse the same approved logo source everywhere. Never redraw an official or selected SVG when deterministic placement/export is possible.
- A generated logo depends on the palette revision used to create it. Changing that palette invalidates the generated logo and its dependents; changing typography does not invalidate the symbol mark.
- Changing a foundation slot invalidates only downstream elements that list that slot in `required_slots`.
- Copy the same Brand Lock values into every related generation prompt: exact hex, font roles, shape language, placement, clear space, composition, and forbidden treatments.
- Use Recraft V4.1 vector mode only for new logo marks.
- Use Seedream as the primary photoreal mockup generator. Use GPT Image 2 only for the controlled stage that adds readable text or exact graphic details.
- Use local deterministic SVG/PPTX/HTML construction for exact copy and editable layouts. Do not ask an image model to fake editable files.
- Do not promise native Figma, Canva, PSD, AI, or EPS files.

## Deterministic scripts

Create JSON input files under `"$BRANDKIT_WORKDIR"`; never interpolate user text directly into shell arguments.

```bash
python3 "$SKILL_ROOT/scripts/brandkit.py" preview \
  --input "$BRANDKIT_WORKDIR/reviews.json" \
  --output-dir "$BRANDKIT_WORKDIR/reviews"

python3 "$SKILL_ROOT/scripts/brandkit.py" logo-export \
  --input "$BRANDKIT_WORKDIR/logo-export.json" \
  --output-dir "$BRANDKIT_WORKDIR/logo"

python3 "$SKILL_ROOT/scripts/brandkit.py" brandbook-build \
  --state-file "$BRANDKIT_STATE" \
  --input "$BRANDKIT_WORKDIR/brandbook.json" \
  --output-dir "$BRANDKIT_WORKDIR/brandbook"
```

For logo export, load [logo export payloads](references/logo-export-payloads.md). For Brandbooks, use the bundled builder only; never substitute an improvised PowerPoint or PDF generator after a deterministic contract failure.

## Failure policy

- Retry a failed Recraft or image-generation request once with the same locked concept and corrected contract. Stop after the second equivalent failure.
- If preview or logo export fails twice, report the concrete error; never replace it with ad-hoc SVG rewriting.
- If the Brandbook template, font, or conversion contract fails, stop immediately. Do not produce a visually different fallback and call it canonical.
- If exact typography or official-logo fidelity cannot be preserved, disclose the limitation instead of claiming completion.
- Never expose raw auth tokens or credentials in files, logs, or chat.

## Delivery

For Brandbooks, follow the strict response contract in [brandbook](references/brandbook.md): PPTX link/path, PDF link/path, and font-install warning only.

For other outputs return:

1. The requested visual files and previews.
2. A compact Brand Lock summary.
3. Editable versus flattened format labels.
4. Required-font/import limitations.
5. Stable variant names for targeted revisions.

## Reference index

- [Prerequisites](references/prerequisites.md) — stage-specific local dependencies and install commands.
- [Intake](references/intake.md) — minimal questions and input routing.
- [Asset analysis](references/asset-analysis.md) — official/reference classification and measurement.
- [State routing](references/handoff.md) and [state payloads](references/state-payloads.md) — persistent approvals.
- [Brand Lock](references/brand-lock.md) — canonical visual constraints.
- [Design Brain](references/brandkit-design-brain.md) — private art direction.
- [Concept boards](references/concept-boards.md), [preview payloads](references/preview-payloads.md), and [inline reviews](references/inline-widgets.md) — selection stages.
- [Logo](references/logo.md), [logo prompt enhancer](references/logo-prompt-enhancer.md), and [logo export payloads](references/logo-export-payloads.md) — SVG generation and deterministic variants.
- [Palette](references/palette.md) and [typography](references/typography.md) — foundation slots.
- [Mockups](references/mockups.md), [social graphics](references/social-templates.md), [posters/banners](references/posters-banners.md), [packaging](references/packaging.md), [signage](references/signage.md), and [merchandise](references/merchandise.md) — applications.
- [Presentation decks](references/presentation-deck.md) and [Brandbooks](references/brandbook.md) — editable documents.
- [QA and iteration](references/qa-and-iteration.md) — preflight, repair, approval, and delivery manifest.
