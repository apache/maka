---
name: skill-from-github
description: Create skills by learning from high-quality GitHub projects
model: sonnet
---

# Skill from GitHub

When users want to accomplish something, search GitHub for quality projects that solve the problem, understand them deeply, then create a skill based on that knowledge.

## When to Use

When users describe a task and you want to find existing tools/projects to learn from:

- "I want to be able to convert markdown to PDF"
- "Help me analyze sentiment in customer reviews"
- "I need to generate API documentation from code"

## Workflow

### Step 1: Understand User Intent

Clarify what the user wants to achieve:

- What is the input?
- What is the expected output?
- Any constraints (language, framework, etc.)?

### Step 2: Search GitHub

Search for projects that solve this problem:

```
{task keywords} language:{preferred} stars:>100 sort:stars
```

**Search tips:**

- Start broad, then narrow down
- Try different keyword combinations
- Include "cli", "tool", "library" if relevant

**Quality filters (must meet ALL):**

- Stars > 100 (community validated)
- Updated within last 12 months (actively maintained)
- Has README with clear documentation
- Has actual code (not just awesome-list)

### Step 3: Present Options to User

Show top 3-5 candidates:

```markdown
## Found X projects that can help

### Option 1: [project-name](github-url)

- Stars: xxx | Last updated: xxx
- What it does: one-line description
- Why it's good: specific strength

### Option 2: ...

Which one should I dive into? Or should I search differently?
```

**Wait for user confirmation before proceeding.**

### Step 4: Deep Dive into Selected Project

Once user selects a project, thoroughly understand it:

1. **Read README** - Understand purpose, features, usage
2. **Read core source files** - Understand how it works
3. **Check examples** - See real usage patterns
4. **Note dependencies** - What it relies on
5. **Identify key concepts** - The mental model behind it

Extract:

- Core algorithm/approach
- Input/output formats
- Error handling patterns
- Best practices encoded in the code

### Step 5: Summarize Understanding

Present what you learned to user:

```markdown
## Understanding [project-name]

### Core Approach

How it solves the problem...

### Key Techniques

1. ...
2. ...

### Limitations

- ...

### What I'll encode in the skill

- ...

Does this look right? Should I proceed to create the skill?
```

**Wait for user confirmation.**

### Step 6: Create Skill via skill-creator

Hand off to skill-creator with:

1. **Clear purpose** - What the skill does
2. **Methodology** - The approach learned from the project
3. **Step-by-step process** - Concrete instructions
4. **Quality criteria** - What good output looks like
5. **Common pitfalls** - What to avoid (learned from project issues/docs)

**Important:** The skill should encode the _knowledge_ from the project, not just wrap the tool. The skill should work even without the original project installed.

## Example

**User:** "I want to write better commit messages"

**Step 2 - Search:**

```
commit message convention stars:>100 sort:stars
```

**Step 3 - Present:**

```
## Found 4 projects

### Option 1: conventional-commits/conventionalcommits.org (4.2k ⭐)
- Specification for human and machine readable commit messages
- Why: Industry standard, used by Angular, Vue, etc.

### Option 2: commitizen/cz-cli (15k ⭐)
- CLI tool for creating conventional commits
- Why: Battle-tested, lots of adapters

### Option 3: carloscuesta/gitmoji (14k ⭐)
- Emoji guide for commit messages
- Why: Visual, fun approach

Which one interests you?
```

**User:** "Let's go with conventional commits"

**Step 4 - Deep dive:**

- Read the specification
- Understand types (feat, fix, docs, etc.)
- Learn about scopes, breaking changes
- Study real-world examples

**Step 5 - Summarize:**

```
## Understanding Conventional Commits

### Core Approach
Structured format: <type>(<scope>): <description>

### Key Types
- feat: new feature
- fix: bug fix
- docs: documentation
- ...

### Benefits Learned
- Automated changelog generation
- Semantic versioning
- Clear history

Ready to create a commit message skill based on this?
```

**Step 6 - Create skill with these principles encoded**

## Important Notes

1. **Always get user confirmation** - At step 3 (project selection) and step 5 (before creating)
2. **Prefer learning over wrapping** - Encode the knowledge, not just "run this tool"
3. **Check license** - Mention if project has restrictive license
4. **Credit the source** - Include attribution in generated skill
5. **Quality over speed** - Take time to truly understand the project

## What This Skill is NOT

- NOT a package installer
- NOT a tool wrapper
- It's about **learning from the best projects** and encoding that knowledge into a reusable skill
