---
name: skill-from-notebook
description: Extract methodologies from documents or examples to create executable skills
model: sonnet
---

# Skill from Notebook

Extract actionable methodologies from learning materials (documents, articles, videos) or quality examples (blog posts, designs, code) to generate reusable Skills.

**Core Philosophy**: NotebookLM helps you understand. This skill helps you **do**.

## When to Use

When users want to turn knowledge into executable skills:

- "I just read this article about code review, help me create a skill from it"
- "Here's a great technical blog post, extract the writing methodology"
- "Turn this PDF guide into a skill I can reuse"
- "Learn from this example and create a skill to produce similar output"

## Supported Input Types

| Type            | How to Process                                   |
| --------------- | ------------------------------------------------ |
| Local files     | PDF, Word, Markdown - Read directly              |
| Web URL         | WebFetch to extract content                      |
| YouTube         | Use yt-dlp for subtitles, Whisper if unavailable |
| NotebookLM link | Browser automation to extract notes/summaries    |
| Example/Output  | Reverse engineer the methodology                 |

## Step 0: Identify Input Type

**Critical first step** - Determine which processing path to use:

```
User Input
    │
    ├─ Has teaching intent? ("how to", "steps", "guide")
    │   └─ YES → Path A: Methodology Document
    │
    ├─ Is a finished work? (article, design, code, proposal)
    │   └─ YES → Path B: Example (Reverse Engineering)
    │
    └─ Neither? → Tell user this content is not suitable
```

**Path A indicators** (Methodology Document):

- Contains words like "how to", "steps", "method", "guide"
- Has numbered lists or step sequences
- Written with teaching intent
- Describes "what to do"

**Path B indicators** (Example/Output):

- Is a complete work/artifact
- No teaching intent
- Is "the thing itself" rather than "how to make the thing"
- Examples: a well-written blog post, a polished proposal, a code project

---

## Path A: Extract from Methodology Document

### A1: Validate Document Suitability

Check if the document is suitable for skill generation (must meet at least 2):

- [ ] Has clear goal/outcome
- [ ] Has repeatable steps/process
- [ ] Has quality criteria
- [ ] Has context/scenario description

**If not suitable**: Tell user honestly and explain why.

### A2: Identify Skill Type

| Type          | Characteristics                       | Examples                                |
| ------------- | ------------------------------------- | --------------------------------------- |
| **How-to**    | Clear step sequence, input→output     | Deploy Docker, Configure CI/CD          |
| **Decision**  | Conditions, trade-offs, choices       | Choose database, Select framework       |
| **Framework** | Mental model, analysis dimensions     | SWOT, 5W1H, First Principles            |
| **Checklist** | Verification list, pass/fail criteria | Code review checklist, Launch checklist |

### A3: Extract Structure by Type

**For How-to:**

- Prerequisites
- Step sequence (with expected output per step)
- Final expected result
- Common errors

**For Decision:**

- Decision factors
- Options with pros/cons
- Decision tree/flowchart
- Recommended default

**For Framework:**

- Core concepts
- Analysis dimensions
- Application method
- Limitations

**For Checklist:**

- Check items with criteria
- Priority levels
- Commonly missed items

### A4: Generate Skill

Use this template:

```markdown
## Applicable Scenarios

[When to use this skill]

## Prerequisites

- [What's needed before starting]

## Steps

1. [Step 1] - [Expected outcome]
2. [Step 2] - [Expected outcome]
   ...

## Quality Checkpoints

- [ ] [Checkpoint 1]
- [ ] [Checkpoint 2]

## Common Pitfalls

- [Pitfall 1]: [How to avoid]

## Source

- Document: [name/URL]
- Extracted: [timestamp]
```

---

## Path B: Reverse Engineer from Example

When input is a finished work (not a tutorial), reverse engineer the methodology.

### B1: Identify Output Type

What kind of artifact is this?

- Technical blog post
- Product proposal/PRD
- Academic paper
- Code architecture
- Design document
- Other: [specify]

### B2: Analyze Structure

Break down the example:

```
Structure Analysis:
├── [Part 1]: [Function] - [Proportion %]
├── [Part 2]: [Function] - [Proportion %]
├── [Part 3]: [Function] - [Proportion %]
└── [Part N]: [Function] - [Proportion %]
```

Questions to answer:

- How many parts does it have?
- What's the function of each part?
- What's the order and proportion?

### B3: Extract Quality Characteristics

What makes this example **good**?

| Dimension | Questions                       |
| --------- | ------------------------------- |
| Structure | How is content organized?       |
| Style     | Tone, word choice, expression?  |
| Technique | What methods make it effective? |
| Logic     | How does information flow?      |
| Details   | Small but important touches?    |

### B4: Reverse Engineer the Process

Deduce: To create this output, what steps are needed?

```markdown
## Deduced Production Steps

1. [Step 1]: [What to do] - [Key point]
2. [Step 2]: [What to do] - [Key point]
   ...

## Key Decisions

- [Decision 1]: [Options] - [This example chose X because...]

## Reusable Techniques

- [Technique 1]: [How to apply]
- [Technique 2]: [How to apply]
```

### B5: Generate Skill

Use this template for reverse-engineered skills:

```markdown
## Output Type

[What kind of artifact this produces]

## Applicable Scenarios

[When to create this type of output]

## Structure Template

1. [Part 1]: [Function] - [~X%]
2. [Part 2]: [Function] - [~X%]
   ...

## Quality Characteristics (Learned from Example)

- [Characteristic 1]: [How it manifests]
- [Characteristic 2]: [How it manifests]

## Production Steps

1. [Step 1]: [What to do] - [Tips]
2. [Step 2]: [What to do] - [Tips]
   ...

## Checklist

- [ ] [Check item 1]
- [ ] [Check item 2]

## Reference Example

- Source: [name/URL]
- Analyzed: [timestamp]
```

---

## Example: Path A (Methodology Document)

**User**: "Extract a skill from this article about writing good commit messages"

**Process**:

1. Read the article
2. Identify: This is a **How-to** type (has steps, teaching intent)
3. Extract:
   - Goal: Write clear, useful commit messages
   - Steps: Use conventional format, separate subject/body, etc.
   - Quality criteria: Subject < 50 chars, imperative mood, etc.
4. Generate skill with steps and checklist

---

## Example: Path B (Reverse Engineering)

**User**: "Here's a great technical blog post. Learn from it and create a skill for writing similar posts."

**Process**:

1. Identify: This is an **example** (finished work, no teaching intent)
2. Analyze structure:
   ```
   ├── Hook: Real pain point (2-3 sentences)
   ├── Problem: 3 sentences on the core issue
   ├── Solution: Conclusion first, then details
   ├── Code: Each snippet < 20 lines, with comments
   ├── Pitfalls: 3 common errors
   └── Summary: One-line takeaway
   ```
3. Extract quality characteristics:
   - Title = specific tech + problem solved
   - One idea per paragraph
   - Code:text ratio ~40:60
   - Personal anecdotes for credibility
4. Reverse engineer steps:
   - Start with a real problem you solved
   - Write the solution first, then the setup
   - Add code samples progressively
   - etc.
5. Generate skill: "How to Write a Technical Blog Post"

---

## Advanced: Multi-Example Learning

When user provides multiple examples of the same type:

```
Example A ──┐
Example B ──┼──> Extract commonalities ──> Core methodology
Example C ──┘           │
                        ▼
                  Analyze differences ──> Style variants / Optional techniques
```

This produces more robust, generalizable skills.

---

## Important Notes

1. **Always validate first** - Not all content is suitable for skill extraction
2. **Identify the path early** - Methodology doc vs Example require different approaches
3. **Be specific** - Vague skills are useless; include concrete steps and criteria
4. **Preserve the source** - Always credit where the knowledge came from
5. **Ask for clarification** - If unsure about user intent, ask before proceeding
6. **Quality over speed** - Take time to truly understand the content

## What This Skill is NOT

- NOT a summarizer (that's NotebookLM's job)
- NOT a document converter
- It's about extracting **actionable methodology** that can be repeatedly executed
