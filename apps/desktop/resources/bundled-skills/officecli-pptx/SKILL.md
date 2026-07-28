---
name: OfficeCLI PPTX
description: Use when a .pptx, slide deck, presentation, pitch deck, speaker notes, layout, chart, template, or slides file is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI PPTX

Use this skill for presentation work. Route deck inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use `OfficeDocument` for read-only inspection: `help`, `view`, `get`, `query`, and `validate`.
- Use `OfficeDocumentEdit` only for supported writes: `create`, `add`, `set`, and `remove`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw `officecli` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer `OfficeDocument` `help` with `topic: "pptx"` before guessing selectors or properties. Installed help is authoritative.
- Quote paths such as `"/slide[1]"` and `"/slide[1]/shape[2]"`.
- Single-quote text containing `$`: `--prop text='$15M ARR'`.
- Unsupported paths stay unsupported: no resident `open`/`close`, `html` view, `raw`, `watch`, or `batch`.

## Workflow

1. Orient with `OfficeDocument` `view` `outline`, `view` `text`, and targeted `get` calls.
2. For generated decks, use one idea per slide. Dense multi-topic slides should be split.
3. Set explicit type hierarchy: titles at least 36pt, body text at least 18pt, captions 10-12pt.
4. Use two fonts max and one coherent palette. Every content slide should carry a non-text visual: chart, shape, icon, screenshot, or image region.
5. Add speaker notes to content slides.
6. Check layout math. For 16:9 slides, keep shapes inside 33.87cm x 19.05cm and maintain edge margins.
7. Final QA: `OfficeDocument` `validate` plus `view` `outline`, `stats`, `issues`, or `annotated`. Fix placeholders, overflow, clipped text, low contrast, bullet-only slides, and missing notes before reporting done.
