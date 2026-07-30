# Skill catalog policy

Maka keeps skill bodies out of the always-on system prompt. The prompt contains
only a bounded catalog; the read-only `Skill` tool loads full instructions when
a task matches a skill.

Discovery produces both a complete inventory and a winner catalog. Every valid
copy has a scope-aware `ref` (for example `project:maka:writer` or
`user:agents:writer`). Duplicate ids remain in the inventory for inspection,
but only the highest-precedence copy is eligible for the runtime catalog.

The catalog is selected deterministically in this order:

1. Discover skill directories in source precedence order. Project-level paths
   precede workspace compatibility paths, which precede user-level paths.
   Duplicate ids use first-found wins. Skills within one directory are ordered
   by display name.
2. Exclude disabled skills.
3. When the host supplies capabilities, exclude skills whose explicit
   `required-tools` or `required-capabilities` are unavailable. `allowed-tools`
   remains informational and never grants permission.
4. Put user-pinned skills first, then preserve source precedence and stable
   display-name/ref ordering.
5. Add catalog entries in the resulting order until the selected model's
   catalog budget is reached. The budget is 2% of its context window, clamped
   to 4,000–8,000 estimated tokens and converted at four characters per token.
   If the context window is unavailable, use the backward-compatible
   `MAX_SKILLS_PROMPT_CHARS = 18000` character budget.

The lower bound keeps useful catalogs available on small-context models. The
upper bound prevents large-context models from turning the catalog into an
unbounded always-on cost. Because changing models can change the selected
catalog, the model context window is an explicit prompt input rather than an
implicit provider lookup inside the skill scanner.

When the budget omits entries, the prompt contains only a constant-size count,
not an unbounded list of ids. Omission affects only catalog advertisement: an
enabled, host-compatible omitted skill remains discoverable through the bounded
metadata-only `SkillSearch` tool and loadable by exact ref, id, or name through
the `Skill` tool. Skill instructions remain subject to their separate lazy-load
body limit.

`selectSkillsForContext` returns a `SkillSelectionReport` alongside the selected
catalog. It records one decision for every inventory item (`advertised`,
`budget`, `disabled`, `invalid`, `host_incompatible`, or `shadowed`) and the
advertised rank. Desktop caches the last prompt-build report per project for
its Context Inspector; before a prompt has been built, it displays a
deterministic preview.

Runtime preferences use `.maka/skills-state.json` schema v2:

```json
{
  "schemaVersion": 2,
  "skills": {
    "workspace:legacy:writer": {
      "enabled": true,
      "pinned": true,
      "updatedAt": "2026-07-22T00:00:00.000Z"
    }
  }
}
```

The reader remains compatible with schema v1 id keys. Desktop migrates an id
automatically only when it resolves to one inventory entry. If the id exists in
multiple scopes, schema v2 preserves the legacy default under
`migration.needsReview` until the user makes explicit ref-level choices; it
never guesses which copy the old preference meant. The Skills Context Inspector
shows every affected copy as `Needs review`; toggling or pinning acts on its
exact ref, and the marker clears only after every ambiguous copy has an explicit
preference.

Configured discovery roots are also part of the diagnostic contract. A missing
optional root is normal and produces no warning. A symlink/non-directory root,
containment escape, or unreadable root produces a bounded
`SkillDiscoveryDiagnostic` (`blocked_path` or `read_failed`) and appears in the
Desktop inventory. It must not be collapsed into an indistinguishable empty
catalog.

## Explicit invocation contract

New Desktop selections store and submit the stable `ref` returned by
`listInvocableSkills`. The legacy `skillIds` wire-field name remains accepted
and may contain either an exact ref or a legacy id; `/skill:<id>` remains
supported for typed CLI/Desktop input. Send-time resolution is authoritative
and deterministic: exact ref, then id, then name.

Desktop and CLI both use `prepareSkillInvocationMessage`:

- successful requests inject the bounded Skill body and remove invocation
  markers before provider handoff;
- partial failures keep the successful skills and report each failure;
- if every explicit request fails, no provider turn is created;
- if the combined structured and text inputs exceed 50 distinct requests,
  preparation fails closed with one bounded `too_many_requests` diagnostic;
  Runtime resolves no partial request set and creates no provider turn;
- within the limit, each distinct request returns one bounded
  `SkillInvocationReceipt` with
  `invocation`, success/failure, exact ref/scope/source for successful loads,
  truncation, and a failure reason. Receipts contain no user prompt, search
  query, or Skill instructions.

Model `Skill` tool loads use the same receipt projection for run-trace data with
`invocation: model_tool`; these projections are durable AgentRun trace events.
Explicit client receipts use `invocation: explicit` and are intentionally
client-local, ephemeral preparation diagnostics: they are returned to the
submitting client, but are not restored with the session or correlated with a
durable run. Failed trace projections retain only request length, not the
requested text. This makes the outcome shapes comparable without creating a
new content-collection channel or implying that pre-turn diagnostics are a
durable audit trail.

Prompt construction, `SkillSearch`, and `Skill` emit diagnostic run-trace
events. Search telemetry stores counts and query length rather than raw query
text. The shadow evaluator retains at most the top 20 refs for the current turn;
when a searched skill is subsequently loaded, the load event records its rank
and Top-1/Top-5/Top-20 hit flags. This measures ranking quality without
collecting skill instructions or user query content.

## Governance closeout boundary

This policy closes the local Skill governance work when Runtime, Desktop, and
CLI contract tests cover duplicate/shadowed ids, invalid metadata, disabled and
host-incompatible skills, prompt-budget omission, stable-ref explicit
invocation, all-failed no-turn behavior, migration review, and discovery-source
diagnostics.

Remote marketplaces and automatic updates, self-modifying/evolving Skills, a
full-screen TUI manager, embedding-based ranking, and analytics dashboards are
separate product initiatives. They are not prerequisites for a safe,
deterministic local Skill lifecycle.
