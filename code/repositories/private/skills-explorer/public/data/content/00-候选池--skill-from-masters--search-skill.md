---
name: search-skill
description: Search and recommend Claude Code skills from trusted marketplaces
model: sonnet
---

# Search Skill

Search and recommend Claude Code Skills from trusted marketplaces based on user requirements.

## When to Use

When users describe a need and want to find an existing Skill to solve it.

Examples:

- "Is there a skill that can auto-generate changelogs?"
- "Find me a skill for frontend design"
- "I need a skill that can automate browser actions"

## Data Sources (by trust level)

### Tier 1 - Official / High Trust (show first)

| Source                           | URL                                         | Notes                            |
| -------------------------------- | ------------------------------------------- | -------------------------------- |
| anthropics/skills                | github.com/anthropics/skills                | Official examples, most reliable |
| ComposioHQ/awesome-claude-skills | github.com/ComposioHQ/awesome-claude-skills | Hand-picked, 12k+ stars          |

### Tier 2 - Community Curated (secondary)

| Source                         | URL                                       | Notes                         |
| ------------------------------ | ----------------------------------------- | ----------------------------- |
| travisvn/awesome-claude-skills | github.com/travisvn/awesome-claude-skills | Community curated, 21k+ stars |
| skills.sh                      | skills.sh                                 | Vercel's official directory   |

### Tier 2.5 - Large Community Registry

| Source  | URL        | Notes                                                                           |
| ------- | ---------- | ------------------------------------------------------------------------------- |
| ClawHub | clawhub.ai | OpenClaw official skill registry, 5000+ community skills, vector search powered |

### Tier 3 - Aggregators (use with caution)

| Source       | URL          | Notes                                  |
| ------------ | ------------ | -------------------------------------- |
| skillsmp.com | skillsmp.com | Auto-scraped, requires extra filtering |

## Search Process

### Step 1: Parse User Intent

Extract from user description:

- Core functionality keywords (e.g., changelog, browser, frontend)
- Use case (e.g., development, testing, design)
- Special requirements (e.g., language support, specific framework)

### Step 2: Multi-Source Search

**IMPORTANT: Only search these 6 sources. Do NOT search the entire internet.**

Search by priority:

```
1. Search Tier 1 (official/high trust) first
2. If fewer than 5 results, continue to Tier 2
3. If still insufficient, search Tier 2.5 (ClawHub - large volume, check quality)
4. If still insufficient, search Tier 3 with strict filtering
5. If still nothing found, tell user honestly - do NOT expand to other sources
```

Allowed search queries (use `site:` to restrict):

```
site:github.com/anthropics/skills {keywords}
site:github.com/ComposioHQ/awesome-claude-skills {keywords}
site:github.com/travisvn/awesome-claude-skills {keywords}
site:skills.sh {keywords}
site:clawhub.ai {keywords}
site:skillsmp.com {keywords}
```

Search methods:

- GitHub repos: Use `site:github.com/{repo}` to restrict search scope
- skills.sh: WebFetch to scrape search results from skills.sh only
- ClawHub: WebFetch `clawhub.ai/skills?q={keywords}` to search the registry
- skillsmp.com: WebFetch with additional verification

**Do NOT:**

- Search the entire web
- Use broad queries without `site:` restriction
- Include results from unknown sources

### Step 3: Quality Filtering (Critical)

**Must filter out the following:**

| Filter Condition                  | Reason                 |
| --------------------------------- | ---------------------- |
| GitHub stars < 10                 | Not community verified |
| Last update > 6 months ago        | Possibly abandoned     |
| No SKILL.md file                  | Non-standard format    |
| README too sparse                 | Quality concerns       |
| Contains suspicious code patterns | Security risk          |

**Security checks:**

- Requests sensitive permissions (e.g., ~/.ssh, env variables)
- External network requests to unknown domains
- Contains eval() or dynamic code execution
- Modifies system files

### Step 4: Rank Results

Scoring formula:

```
Score = Source Weight × 0.4 + Stars Weight × 0.3 + Recency Weight × 0.2 + Relevance × 0.1

Source weights:
- Tier 1: 1.0
- Tier 2: 0.7
- Tier 2.5 (ClawHub): 0.55
- Tier 3: 0.4
```

### Step 5: Format Output

Return Top 5-10 results:

```markdown
## Found X relevant Skills

### Recommended

1. **[skill-name](github-url)** - Source: anthropics/skills
   - Function: xxx
   - Stars: xxx | Last updated: xxx
   - Install: `/plugin marketplace add xxx`

### Worth considering

2. **[skill-name](github-url)** - Source: ComposioHQ
   ...

### Not recommended (for reference only)

- [skill-name](url) - Reason: low stars / not maintained
```

## Example

**User**: Is there a skill that helps write commit messages?

**Search process**:

1. Extract keywords: commit, message, git
2. Search Tier 1: Found git-commit-assistant in anthropics/skills
3. Search Tier 2: Found semantic-commit in ComposioHQ
4. Filter: Exclude results with stars < 10
5. Rank: Official sources first

**Output**:

```
## Found 3 relevant Skills

### Recommended
1. **git-commit-assistant** - Source: anthropics/skills (official)
   - Function: Generate semantic commit messages
   - Install: `/plugin marketplace add anthropics/claude-code`

2. **semantic-commit** - Source: ComposioHQ
   - Function: Follow conventional commits spec
   - Stars: 890 | Last updated: 2 weeks ago
```

## Important Notes

1. **Never recommend unverified Skills** - Better to recommend fewer than to recommend risky ones
2. **Stay cautious with Tier 3 sources** - Results from skillsmp.com must be double-checked
3. **If nothing suitable is found** - Tell the user honestly, suggest using skill-from-masters to create their own
4. **Security concerns** - Clearly inform users of risks, let them decide
