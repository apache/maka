**Verification of @MashiroSky's failure mode, on current main (3b8bcc36).** Your hypothesized mechanism is real, and it reproduces here without any model in the loop. But the `codexAsSent` contrast does not close through `responses.go` — that part matters, because it changes what the fix question is. (The demotion code is byte-identical in 0.1.1319 — I checked the tag diff; only the stream-error decoder changed since.)

## 1. The request shape, verbatim

A thread that began in Plan mode and switched to Default after the first reply — head developer item carries the Plan instruction, a developer item after the reply carries the Default one, then the user asks to execute — translated to a Messages upstream, goes upstream as:

```text
system: "You are Codex.\n\n<permissions instructions>mode: plan — research and plan only, do not modify files</permissions instructions>"
message[0] role=user:
  "plan a fix for the bug"
message[1] role=assistant:
  "here is the plan"
message[2] role=user:
  "<system-reminder>\n<permissions instructions>mode: default — you may edit files and run commands</permissions instructions>\n</system-reminder>"
  "execute the plan now"
```

This is captured by a deterministic test (full HTTP handler, fake Messages upstream, Codex headers, no LLM): `parseResponses` lifts the head developer item into the system prompt again on every request (the `replied` flag hasn't flipped for it), and demotes the post-reply one to a user turn (`responses.go:341-370`). The stale mode keeps the system's weight; the fresh mode arrives as the user's words, one block ahead of the user's own words. A model that resolves the conflict by authority has to pick Plan. A second assertion pins that the system field is byte-identical with a no-switch control — the #502 cache property holds exactly as designed. So this is the designed trade-off working as designed, in a scenario the design's own comment names ("Codex adds a developer message where its context changed (world state, settings, a model switch)") but didn't price.

Whether Codex's Plan/Default instructions ride exactly those items in your build is what your magpie-side capture would confirm; the shape above is synthetic but follows the same construction `#502`'s commit describes.

## 2. The codexAsSent contrast does not act on this path

`CodexAsSent` is read at exactly one site (`passthrough`, gateway.go:4213) — the relayed Responses→Responses route. Two ablations, both deterministic:

- **On the translated Messages wire (where the demotion lives)**, the upstream request is byte-identical with `codexAsSent` off and on — same handler, same body, Codex headers, only the flag flipped. The demotion happens in both; the system field keeps the stale mode in both. The flag cannot restore mode switching here.
- **On a Responses relay (the only route where the flag acts)**, both developer items keep `role: "developer"` with the flag **off as well as on**. The relay fitting (`forVendor`, tool-search and item-id rewrites) changes fields and metadata, never message roles; the demotion never runs on this wire at all.

So if `codexAsSent: true` really restored Plan↔Default switching in your setup, the change went through something other than `responses.go`'s demotion. The plausible candidate: your provider is relay-routed (the flag exists precisely because relays check Codex's shape, #1758), and the relay itself behaves differently on the fitted vs. the as-sent body — possibly re-translating upstream with demotion rules of its own. Could you capture the upstream-bound request pair at the magpie side (flag off vs. on, same turn)? If the pair is byte-identical, the recovery likely came from elsewhere (a thread or process restart in between would do it); if they differ, the diff names the real lever.

## 3. The 10-16 "declared design" verdict, re-examined

Both halves of the earlier analysis still hold: the demotion is declared and guarded (`TestCodexLaterDeveloperMessageKeepsTheSystem` pins the byte-stable system and the reminder in place), and its boundary is narrower than the issue text — head developer items keep system weight, and AGENTS.md content rides at user role (`<user_instructions>`), never entering the demote branch. What the verdict did not price: the design comment itself lists "a model switch" among the changes Codex reports by adding a mid-thread developer message, so the case where the demoted item **replaces** an earlier, still-promoted instruction is inside the design's own stated scope. There the trade is no longer "context update at lower weight" but "the superseded instruction outranks its successor" — a priority inversion. For additive context (skills diffs, environment state) that cost is invisible; for mode switches it is exactly this failure. #1378's maintainer stance was about caller-owned policy, which doesn't settle Codex's own replacement semantics.

## 4. Questions for the maintainers

- Is a mid-thread developer item that replaces the head developer item's instructions (a mode switch) worth exempting from the demotion — lifted into the system prompt so the successor outranks what it replaced? That rewrites the cached prefix once per switch, which is rare relative to turns — a different cost profile than the every-turn rewrite #502 fixed.
- Or is the right scope still the fidelity option proposed in the issue body, narrowed per @MurmuredVelpro's capture to post-reply developer items only?
- Separately: should `codexAsSent`'s documentation note that it never affects translated routes? "Turning it on fixed it" is an easy inference that this wire-level check can't support on the Claude wire.

No patch attached; the shape assertions are in a test file and can be shared if wanted.

## 5. Sibling surface (same demotion, other wires)

- The demotion lives once in `parseResponses`, so every translated route from a Responses client carries it: →Messages (above, including Claude subscriptions), →Chat (the reminder renders as a user message), →Gemini/Code Assist (same, as user content). Same-shaped cost on all three.
- The Chat-client direction is the opposite policy: `parseChat` lifts every system/developer message, wherever it stands, into the top system prompt — authority kept, prefix rewritten (the cost #502 avoided). #2322's maintainer fixed the tool-loss part only and left the placement.
- Anthropic and Gemini clients have no mid-thread system role; nothing to demote.
- Responses→Responses relays: items pass verbatim, with or without `codexAsSent`; no demotion.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
