---
name: wiki-ingest
description: "Compile articles, documents, or notes into a structured wiki knowledge base. Use when user says 'ingest to wiki', 'compile to knowledge base', 'update wiki', 'wiki ingest', 'add this to wiki', or invokes /wiki-ingest. Supports single or batch ingest. Triggers: wiki, ingest, knowledge base, compile, digest, index, catalog."
---

# Wiki Ingest — Knowledge Base Compiler

Compile any text content (articles, documents, notes) into structured wiki pages with cross-references, building a searchable, interconnected knowledge network.

IRON LAW: One wiki page = one knowledge entity. Never cram multiple concepts into one page.

## Wiki Directory Structure

Wiki defaults to `wiki/` under the current project root. User may specify a different path.

```
wiki/
├── index.md              # Full table of contents
├── log.md                # Append-only operation log
├── concepts/             # Core concept pages
├── products/             # Product/tool entity pages
├── patterns/             # Engineering patterns & design decisions
└── comparisons/          # Cross-topic comparison pages
```

## Workflow

### 1. Confirm Input

Accept user-specified content source:
- Pasted text directly
- File path(s) (md, txt, pdf, etc.)
- Directory path (batch processing)

If user doesn't specify a wiki path, use `wiki/`. Create the directory if it doesn't exist.

### 2. Check Existing Wiki

Read `wiki/index.md` (if exists) to understand existing pages and avoid duplicates.

### 3. Extract Knowledge Entities

Extract from content:
- **Concepts** (`concepts/`): Abstract ideas, terminology, theories
- **Products** (`products/`): Specific products, tools, services
- **Patterns** (`patterns/`): Engineering patterns, design decisions, methodologies
- **Comparisons** (`comparisons/`): Cross-product or cross-approach analysis

Extraction threshold: An entity deserves its own page only if it would be referenced by other pages.

### 4. Create or Update Pages

Each entity maps to one wiki page.

→ Load [references/page-templates.md](references/page-templates.md) for page templates.

Rules:
- If page already exists → **update** it, append new information, don't overwrite existing content
- Keep the one-line definition stable unless the new content provides a clearly better one
- Prioritize updating "Sources" and "Related Pages" sections

### 5. Update Cross-References

Check all existing wiki pages. If new content involves concepts referenced in other pages:
- Update their Related Pages list
- Update their Sources list
- Supplement new information in their detail sections

### 6. Update index.md

Add new page entries to `wiki/index.md`, organized by category.

### 7. Append to log.md

Append to `wiki/log.md`:

```markdown
## YYYY-MM-DD: Ingest <source title>

**Source**: <file path or "user input">
**New pages**: list newly created pages
**Updated pages**: list modified pages
**New cross-references**: list newly established links
```

### 8. Report Results

Tell user: what pages were created, what pages were updated, what new cross-references were established.

## File Naming

- All lowercase, hyphen-separated: `agent-loop.md`, `kv-cache.md`
- Name by entity, not by number

## Cross-Reference Format

- Use `[[category/page-name]]` double-link format (Obsidian-compatible), e.g. `[[concepts/agent-loop]]`, `[[products/claude-code]]`
- Always include the category prefix to avoid ambiguity across directories
- List all related pages at the bottom of each page

## Guidelines

- Never create duplicate pages — always check wiki/ first
- Don't extract trivial entities — if a concept appears once and won't be referenced elsewhere, skip it
- For batch processing: extract all entities first, then create pages and update references in one pass to avoid inconsistent intermediate states
- Always update index.md and log.md after every ingest
