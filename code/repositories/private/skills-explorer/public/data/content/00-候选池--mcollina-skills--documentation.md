---
name: documentation
description: "Creates, structures, and reviews technical documentation following the Diátaxis framework (tutorials, how-to guides, reference, and explanation pages). Use when a user needs to write or reorganize docs, structure a tutorial vs. a how-to guide, build reference docs or API documentation, create explanation pages, choose between Diátaxis documentation types, or improve existing documentation structure. Trigger terms include: documentation structure, Diátaxis, tutorials vs how-to guides, organize docs, user guide, reference docs, technical writing."
metadata:
  tags: documentation, technical-writing, tutorials, guides, reference, diataxis
---

## When to use

Use this skill when you need to create, review, or improve technical documentation following the Diátaxis framework. Examples include:

- Creating user guides
- API documentation
- Tutorial content
- Restructuring existing documentation to better serve different user needs and contexts

## Instructions

Organize documentation into four distinct types — tutorials, how-to guides, reference material, and explanations — each serving different user needs and contexts.

Always ask clarifying questions about the user's context, audience, and goals **before** creating documentation.

---

### Step 1 — Identify the documentation type

Use the following decision checklist based on user signals:

| User signal                                             | Documentation type |
| ------------------------------------------------------- | ------------------ |
| "I'm new to X and want to learn it" / "walk me through" | **Tutorial**       |
| "How do I…?" / "I need to accomplish X"                 | **How-to guide**   |
| "What are the parameters/options/syntax for X?"         | **Reference**      |
| "Why does X work this way?" / "Help me understand X"    | **Explanation**    |

Quick decision tree:

- Is the user **learning by doing** for the first time? → Tutorial
- Do they need to **solve a specific problem** they already understand? → How-to guide
- Do they need **technical facts** to look up? → Reference
- Do they want **conceptual background**? → Explanation

---

### Step 2 — Apply type-specific patterns

#### Tutorials (learning-oriented)

- **Title pattern:** Start with a verb — _"Build your first X"_, _"Create a Y from scratch"_
- Structure: Goal → Prerequisites → Numbered steps → Immediate verifiable result at each step → Final outcome
- Minimise explanation; maximise doing
- Every step must produce a visible, testable result
- **Validation:** A beginner must be able to complete the tutorial without external help

**Example intro:**

> _"In this tutorial, you will build a simple REST API using Express. By the end, you will have a running server that responds to GET requests. No prior Express experience is needed."_

---

#### How-to guides (problem-oriented)

- **Title pattern:** Frame as a task — _"How to configure X"_, _"How to deploy Y to Z"_
- Structure: Goal statement → Assumptions/prerequisites → Numbered steps → Expected result
- Assume baseline knowledge; skip conceptual explanations
- Allow for variation; note alternatives where they exist
- **Validation:** An experienced user can complete the task without confusion or backtracking

**Example intro:**

> _"This guide shows how to add JWT authentication to an existing Express app. It assumes you have a working Express server and basic familiarity with middleware."_

---

#### Reference (information-oriented)

- **Title pattern:** Name the thing — _"Configuration options"_, _"API endpoints"_, _"CLI flags"_
- Structure: Consistent repeatable format per entry (name → type → default → description → example)
- State facts; avoid instruction beyond minimal usage examples
- Keep current; version-stamp if needed
- **Validation:** A user can look up a specific fact in under 30 seconds without reading surrounding content

**Example entry:**

> **`timeout`** _(integer, default: `5000`)_
> Maximum time in milliseconds to wait for a response before the request fails.
> _Example:_ `{ timeout: 3000 }`

---

#### Explanations (understanding-oriented)

- **Title pattern:** Frame as a concept — _"How X works"_, _"Understanding Y"_, _"Why Z is designed this way"_
- Structure: Context → Core concept → Alternatives/trade-offs → Higher-level perspective
- Avoid step-by-step instruction or technical specification
- **Validation:** After reading, the user can explain the concept in their own words and understands the rationale behind design decisions

**Example intro:**

> _"Authentication and authorisation are often confused. This page explains the distinction, why both matter, and how common patterns (sessions, tokens, OAuth) approach each concern differently."_

---

### Step 3 — Maintain separation and integration

- Keep each document a single type — don't mix tutorial steps with reference tables or conceptual digressions
- Cross-link between types: a tutorial can link to the relevant reference page; a how-to guide can link to an explanation for background
- Use consistent headings and terminology across all types so users can navigate the full documentation system

---

### Step 4 — Validate before delivering

| Type         | Validation check                                             |
| ------------ | ------------------------------------------------------------ |
| Tutorial     | Can a beginner complete it end-to-end without external help? |
| How-to guide | Does it solve the stated problem for an experienced user?    |
| Reference    | Can the user find a specific fact in under 30 seconds?       |
| Explanation  | Does the user understand the _why_, not just the _what_?     |
