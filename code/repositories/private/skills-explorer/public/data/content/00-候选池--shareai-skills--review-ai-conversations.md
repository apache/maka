---
name: review-ai-conversations
description: Recover and review local human-AI conversations from Claude Code, Codex, opencode, Grok Build, and Cursor. Use when the user wants to revisit, search, extract, summarize, or compare work across Agent session stores, time ranges, projects, or named conversations. Follow the user's requested output; question clustering, problem-space mapping, artifact review, drift analysis, and insights are optional lenses.
---

# Review AI Conversations

Recover the actual conversation bodies, then perform only the review, search,
extraction, summary, comparison, or synthesis the user requested.

```text
scope -> recover human + visible AI turns -> requested result
                     |
                     `-> optional deeper analysis only when requested
```

The user's original messages are authoritative for intent. AI replies, summaries,
and generated artifacts are useful prior work, not automatic proof that an
interpretation or factual claim is correct.

## Interpret ordinary-language scope

Infer four things when supplied: Agent or location, time range or conversation IDs,
content to find or analyze, and desired output. The user may specify any subset. Ask
only when two plausible scopes would materially change the recovered conversations or
answer. An explicit file, Store path, session ID, or named conversation does not need
time-index discovery.

## Load only the required guidance

If the user supplied conversation text directly, analyze it without Store references.

When local Stores must be read:

1. Read [`references/retrieval.md`](references/retrieval.md) completely.
2. Read only the matching product adapter completely:
   - [Claude Code](references/sources/claude-code.md)
   - [Codex](references/sources/codex.md)
   - [opencode](references/sources/opencode.md)
   - [Grok Build](references/sources/grok-build.md)
   - [Cursor](references/sources/cursor.md)
3. Read [`references/lineage-and-intent.md`](references/lineage-and-intent.md) only
   when forks, child Agents, copied history, context rollover, or intent drift matter.
4. Read [`references/analysis-lenses.md`](references/analysis-lenses.md) only when the
   user requests question clustering, problem-space mapping, artifact/conclusion
   review, brainstorming, open questions, or insights.

For several products, recover each Store independently. Combine recovered
conversation families only after applying each product's identity and lineage rules.
Do not load unrelated product adapters. Do not read
[`adapter-maintenance-evidence.md`](references/adapter-maintenance-evidence.md) during
ordinary review; read it only when maintaining or re-verifying adapters.

## Preserve the requested truth

- Keep accepted human-authored text and visible assistant replies in order.
- Preserve an exact message reference with every important extracted passage.
- Distinguish active conversation, abandoned branch, derived summary, delegated child
  task, and missing history when the distinction affects the request.
- Inspect an actual document or code artifact instead of relying only on an AI claim
  when the user requested artifact, decision, implementation, or factual verification.

## Avoid low-value behavior

- Do not stop at file discovery, session counts, or an intermediate transcript export.
- Do not merge duplicate projections, copied fork prefixes, child prompts, or
  compaction summaries into new human intent.
- Do not force clustering, diagrams, insights, open minds, or next actions when the
  user requested simple recovery, search, extraction, or summary.
- Do not hide uncertainty when the Store cannot distinguish two plausible timelines.

## Report to the requested depth

Follow the user's requested format first. For a substantial synthesis, lead with the
answer, keep the structure compact, and use Markdown box-line diagrams only when they
make relationships materially clearer. Roughly 3,000-5,000 Chinese characters may be
useful for a requested deep review, but is never a target for ordinary recovery.

The task is complete when the selected conversation text was recovered faithfully and
the requested review or extraction was answered without silently promoting derived AI
context into original human intent.
