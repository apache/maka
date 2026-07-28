---
name: OfficeCLI XLSX
description: Use when a .xlsx, Excel workbook, spreadsheet, CSV/TSV import, tracker, dashboard, financial model, formula, chart, pivot table, or worksheet template is involved.
allowed-tools:
  - OfficeDocument
  - OfficeDocumentEdit
  - Read
required-tools:
  - OfficeDocument
  - OfficeDocumentEdit
---

# OfficeCLI XLSX

Use this skill for spreadsheet work. Route workbook inspection and edits through Maka's bounded Office document tools.

## Boundary

- Use `OfficeDocument` for read-only inspection: `help`, `view`, `get`, `query`, and `validate`.
- Use `OfficeDocumentEdit` only for supported writes: `create`, `add`, `set`, and `remove`. It is permission-gated and path-bound to the session cwd.
- Do not call Bash or raw `officecli` directly unless the user explicitly asks for shell-level debugging and the normal permission flow allows it.
- Prefer `OfficeDocument` `help` with `topic: "xlsx"` before guessing selectors or properties. Installed help is authoritative.
- Quote paths such as `"/Sheet1/A1"`, `"/Sheet1/col[B]"`, and `"/Sheet1/row[1]"`.
- Single-quote values containing `$`, especially number formats: `--prop numFmt='$#,##0'`.
- Unsupported paths stay unsupported: no resident `open`/`close`, `html` view, `raw`, `watch`, or `batch`.

## Workflow

1. Orient with `OfficeDocument` `view` `outline`; use `view` `text`, `get`, and `query` for targeted inspection.
2. For CSV/TSV, prefer native import, then set widths and number formats.
3. For generated workbooks, create sheets, enter assumptions, formulas, formats, charts, then validate.
4. Use formulas rather than hardcoded derived values. Put assumptions in cells and cite sources in adjacent notes or comments.
5. Set readable widths explicitly; default Excel widths often render as `###`.
6. Financial-model convention: blue font for hardcoded inputs, black for formulas, green for same-workbook links, red for external links, yellow fill for assumptions needing review.
7. Final QA: `OfficeDocument` `validate` plus `view` `outline`, `stats`, `issues`, or `annotated`. Fix formula errors, `###`, truncated headers, hidden assumptions, placeholder tokens, and chart labels before reporting done.
