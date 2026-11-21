---
name: discover-analytics-patterns
description: >
  Discovers how analytics tracking calls are actually written in this codebase —
  the concrete SDK calls, function signatures, and import patterns used to send
  events. Use this skill whenever you need to understand the existing analytics
  instrumentation patterns before adding new tracking, when someone asks "how do
  we track events here?", "show me the analytics setup", "what's the analytics
  pattern in this codebase?", or any time the instrument-events or
  discover-event-surfaces skills are about to run and you need to know the
  correct coding style to follow. Outputs a deduplicated list of patterns with
  generalized examples and the file paths where each pattern appears, plus the
  dominant event and property naming conventions inferred from those call sites.
  Always use this skill before writing any analytics instrumentation code.
---

# discover-analytics-patterns

Your goal is to find out **how** this codebase sends analytics events — not which
events exist, but the specific code patterns engineers use to fire a tracking
call. This output helps engineers add new events that look consistent with the
rest of the codebase. It should also tell downstream skills how event names and
property names are typically written in code here.

When determining naming conventions in this skill, use the following sources in strict order of preference:

1. Customer directives in `.amplitude/instrumentation-agent-context.md` (and any files it references), if present — explicit conventions the customer wants followed, so they override everything below.
2. Events and properties observed from the Amplitude MCP server
3. Real tracking call sites in the codebase
4. The `taxonomy` skill at `../taxonomy/SKILL.md`

---

## Step 0: Read repo instrumentation context

Before anything else, check for `.amplitude/instrumentation-agent-context.md`
(repo root, or the subdirectory you're instrumenting). If it exists, read it and
any repo-relative files it references. Any naming conventions, property
standards, or SDK/wrapper patterns it states are **customer directives** — they
take precedence over everything you infer below; record them and skip inference
for whatever they cover. If it's absent, just continue — the `instrument-events`
skill owns prompting the user to add one.

---

## Step 1: Find tracking calls

Use two approaches based on what's available.

### If the Amplitude MCP is connected

Inspect the connected catalog and use its current taxonomy reader to fetch a
sample of event names from the project. Follow only the reader's advertised
schema. When it supports caller attribution, identify this skill with the
`name` from its YAML frontmatter. Use those results to choose a few
representative non-system product events, then use its
event-property read capability to inspect real property names. This is your
primary naming reference.

Do not infer naming conventions from bracket-prefixed Amplitude system names
such as `[Amplitude], [Guides-Surveys], [Assistant], [Experiment]` for either events or properties. Exclude those from
pattern detection. If the MCP sample is dominated by Amplitude system names or otherwise does not provide enough evidence, fall back to codebase
inference for naming.

Then search the codebase for the sampled non-system event names using Grep to
locate the actual tracking call sites.

### If the Amplitude MCP is not available (fallback)

Search the codebase for these signals using Grep. Cast a wide net — you can
narrow down after:

| What to search for                                       | Why                                               |
| -------------------------------------------------------- | ------------------------------------------------- |
| `\.track\(`                                              | Generic `.track()` method calls                   |
| `ampli\.`                                                | Ampli typed SDK calls (e.g. `ampli.myEvent(...)`) |
| `amplitude\.track\|amplitude\.logEvent`                  | Direct Amplitude SDK calls                        |
| `sendEvent`                                              | Custom wrapper method names                       |
| `from.*amplitude\|import.*amplitude\|require.*amplitude` | Import statements                                 |
| `https://api2\.amplitude\.com/2/httpapi`                 | HTTP API calls                                    |

Also actively look for custom analytics wrappers — a codebase often wraps the
raw SDK in a utility like `trackEvent()`, `track()`, or a React hook like
`useAnalytics()` or `useTracking()`. Search for these by looking for functions
that call into Amplitude internally. **Treat each wrapper as its own pattern,
separate from the underlying SDK call**, even if it ultimately calls
`amplitude.track()` underneath. Engineers who encounter the wrapper will use
_it_, not the raw SDK — so it's the more important pattern to document.

To find wrappers: search for files that import the Amplitude SDK, then check
whether any of those files export a function or hook that other parts of the
codebase import and use for tracking.

Exclude test files (`.test.`, `.spec.`, `__tests__`) and mock files unless they
are the _only_ place a pattern appears.

---

## Step 2: Group by pattern

Two call sites use the **same pattern** if they share the same:

- Library/SDK/function being called
- Method name
- Argument structure (even if the event name or properties differ)

For example, these are the **same** pattern:

```ts
amplitude.track("Page Viewed", { page: "/home" });
amplitude.track("Button Clicked", { label: "signup" });
```

But these are **different** patterns — always keep them separate:

```ts
amplitude.track("Page Viewed", { page: "/home" }); // direct SDK — one pattern
ampli.pageViewed({ page: "/home" }); // Ampli typed method — different pattern
trackEvent("Page Viewed", { page: "/home" }); // custom wrapper — also a separate pattern
```

A custom wrapper is always its own pattern, even if it delegates to the SDK
underneath. When documenting a wrapper pattern, note what it wraps (e.g.,
"Custom hook wrapping `amplitude.track()`") so engineers understand the layering.

---

## Step 3: Resolve naming conventions

Resolve two conventions separately:

- `event_naming_convention` — casing, separators, word order, prefixes, and
  tense used for event names in instrumentation code. Examples: `Title Case`,
  `snake_case`, `[Prefix] Action`, object-first vs action-first.
- `property_naming_convention` — casing, separators, and common suffix/prefix
  patterns used for event properties. Examples: `snake_case`, `camelCase`,
  `*_id`, `is_*`, flat keys vs nested objects.

Use this precedence order:

1. **Repo instrumentation context first.** If
   `.amplitude/instrumentation-agent-context.md` (from Step 0) states an explicit
   event or property naming convention, it wins outright — record it and skip
   inference for whatever it specifies. Only fall through when the file is absent
   or silent on naming.
2. **Amplitude MCP second.** If the observed event names and property names
   returned by the active taxonomy reader for a few representative
   non-system events show a clear dominant convention, use that. Do not use
   bracket-prefixed Amplitude system names as naming evidence.
3. **Codebase third.** If the MCP evidence is unavailable, sparse, or
   inconsistent, infer the dominant convention from nearby, real tracking call
   sites in the repository. If the codebase shows multiple conventions, call
   out the dominant one and note meaningful local exceptions.
4. **Taxonomy fallback last.** If none of the above is
   clear enough, fall back to the `taxonomy` skill at `../taxonomy/SKILL.md`.

Do not guess. If one or both conventions remain unclear even after checking
those sources, say so explicitly.

---

## Step 4: Output

Start with a short conventions section, then list each unique pattern.

```yaml
event_naming_convention: "<from repo context file if it specifies one, else MCP if clear, else codebase, else taxonomy skill, or 'insufficient evidence'>"
property_naming_convention: "<from repo context file if it specifies one, else MCP if clear, else codebase, else taxonomy skill, or 'insufficient evidence'>"
```

Then, for each unique pattern, output a section in this format:

---

### Pattern: `<short descriptive name>`

**Description**: What this pattern does and when it's typically used in this
codebase (e.g., "Used throughout the React frontend for user action tracking").

**Example** (generalized):

```<language>
// show the import(s) needed
import { amplitude } from '@/lib/analytics'

// show a representative tracking call with placeholder names
amplitude.track('Event Name', {
  propertyOne: value,
  propertyTwo: value,
})
```

**Relevant paths**:

- `src/path/to/file.ts`
- `src/another/file.tsx`

---

List patterns from most common (most file paths) to least common.

If two patterns are always used together (e.g., an import + a call), show them
together in one example.

---

## Step 5: Handle no results

If no tracking calls are found with any search strategy, say so clearly. Suggest
that the user check whether Amplitude (or another analytics library) has been set
up in the project, and offer to search for other analytics libraries (Segment,
Mixpanel, PostHog, etc.) if relevant.
