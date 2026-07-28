---
name: OfficeCLI DOCX
description: Use when a .docx, Word document, report, memo, proposal, letter, tracked changes, comments, header/footer, table of contents, or Word template is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI DOCX

Use this skill for Word document work. Route document inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use `OfficeDocument` for read-only inspection: `help`, `view`, `get`, `query`, and `validate`.
- Use `OfficeDocumentEdit` only for supported writes: `create`, `add`, `set`, and `remove`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw `officecli` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer `OfficeDocument` `help` with `topic: "docx"` before guessing selectors or properties. Installed help is authoritative.
- Quote semantic paths: `"/body/p[1]"`, `"/footer[1]"`.
- Unsupported paths stay unsupported: no resident `open`/`close`, `html` view, `raw`, `watch`, or `batch`.

## Workflow

1. Orient with `OfficeDocument` `view` `outline`, then `view` `text` or `get` the needed paths.
2. For edits, use `OfficeDocumentEdit` in small steps and verify each structural step with `OfficeDocument` `get` or `view`.
3. For generated documents, build hierarchy first: Title, Heading 1, Heading 2, body; then tables/images/fields; then headers/footers.
4. Use explicit typography. Body 11-12pt; H1 at least 18pt; H2 around 14pt; spacing via paragraph properties, not blank paragraphs.
5. Add live page-number fields for documents longer than one page when the installed adapter supports the needed field properties. Verify fields with `OfficeDocument` `get` on `"/footer[1]"` at bounded depth.
6. Final QA: `OfficeDocument` `validate` plus `view` `outline`, `stats`, `issues`, or `annotated`. Fix placeholder tokens, clipped tables, empty-paragraph spacing, static page numbers, and missing TOC on heading-heavy documents before reporting done.
