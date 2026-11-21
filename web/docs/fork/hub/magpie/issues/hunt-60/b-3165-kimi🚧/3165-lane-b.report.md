# hunt60 Lane B — #3165 follow-up: the Kimi path (`reasoningDetailsAsContent`) vs the carried-once fix

## Verdict: (c) — neither face holds; no patch shipped

Both open questions from the #3165 delivery (comment 6320485575, branch
`hunt58-f-3165-reasoning-dup` @ `130b761b`) are answered negative. This is a
#1569-style "declared design" outcome: the keep is recorded, measured
behavior, not a slip.

1. **Collision face — no.** The Kimi lane does emit `reasoning` and
   `reasoning_content` on the same message (probe-proven, below), but the
   recorded probe of the real endpoint says Kimi passes both names through
   validation, and its observed refusal mode is a field-naming validator,
   not DeepSeek's aliasing serde. "上游会拒" has recorded counter-evidence,
   not merely absence of evidence.
2. **Semantic-conflict face — no.** F's fix is not unconditional: it only
   runs under `chatReplaysReasoning` (deepseek-named host/model). On a pure
   Kimi route it never runs — probe A's outbound bytes are identical with
   and without F applied. On the contrived overlap route (Kimi preset plus a
   deepseek-named model) F *fixes* the #3165 collision shape instead of
   breaking anything, and the Kimi lane's own conversion behavior is
   untouched (probe B, message 5). No existing test pins "keep `reasoning`"
   anywhere.

## Source & environment

- #3165 (wmfan2002-cloud) and the delivery comment 6320485575 (ggbdpq,
  2026-10-21). The fix is **not merged upstream**: baseline `b0d46ca7`
  (= upstream/main when this was written) still has the pre-fix
  `withReasoningOnToolTurns`; `TestChatToolTurnReasoningCarriedOnce` does
  not exist there. The task brief's assumption "基线已含 F patch" was wrong;
  F's commit `130b761b` was applied to the probe worktree temporarily and
  reverted after (worktree left pristine at `b0d46ca7`).
- Worktree `/tmp/magpie-r60-b`, branch `hunt60-b-3165-kimi-reasoning`,
  go1.25.x darwin/arm64, httptest fakes only, no network.

## Call graph (baseline b0d46ca7)

Chat relay, `Server.passthrough` (`internal/gateway/gateway.go:4187`),
case `provider.Chat` (`gateway.go:4251`) — sequential, **not** mutually
exclusive branches:

| step | place | what |
| --- | --- | --- |
| 1 | gateway.go:4252 | `developerAsSystem` |
| 2 | gateway.go:4255 | `silentAssistantsOut` (#2599) |
| 3 | gateway.go:4256-4260 | `if !mistral && (chatReplaysReasoning(host, model) \|\| chatReplaysReasoning(host, upstream))` → `withReasoningOnToolTurns` (`chattidy.go:423`) — the DeepSeek replay lane |
| 4 | gateway.go:4264 | `chatCallSignatures` |
| 5 | gateway.go:4265-4269 | mistral → `mistralThinking` (`chattidy.go:654`) |
| 6 | gateway.go:4270-4275 | `if isKimi(p, proto)` → `reasoningDetailsAsContent` (`chattidy.go:566`) — the Kimi lane |

- `chatReplaysReasoning` (`chat.go:264`): host contains `deepseek`, or the
  model (magpie's or the upstream's name) contains `deepseek`, or the host
  is Command Code's plan. A Kimi host never says deepseek; the only overlap
  trigger is a **deepseek-named model** on a Kimi provider.
- `isKimi` (`kimi_schema.go:66`): host ∈ {api.moonshot.ai, api.moonshot.cn,
  api.kimi.com, api.kimi.ai} or preset prefixed `moonshot`/`kimi`.
- `withReasoningOnToolTurns` (`chattidy.go:423`): tool-turn assistant
  messages (a call, or a reply after a tool result); a message with its own
  `reasoning_content` returns unchanged (pre-F: leaves an echoed
  `reasoning`/`reasoning_details` standing — the #3165 bug); otherwise
  writes `reasoning_content` from `reasoningText` (`chattidy.go:380`:
  reasoning_content → reasoning → details text) or `" "`, pre-F **keeping**
  the field the thinking rode in on. F's fix deletes `messageReasoning[1:]`
  (`reasoning`, `reasoning_details`) in both branches.
- `reasoningDetailsAsContent` (`chattidy.go:566`): only messages carrying
  `reasoning_details`; writes `reasoning_content` from `reasoningText` when
  the message has none, deletes `reasoning_details`, **keeps `reasoning`**.
- Adaptive retry: `refusedInMessages` (`gateway.go:5671`) reads Kimi's
  wording via `fieldAtPosition` (`gateway.go:5714`,
  `\bthe (reasoning_details|reasoning_content|reasoning) at position \d+\b`)
  and OpenAI-style `extra_forbidden` locs; the retry loop
  (`gateway.go:4559`) and `withoutRefused` (`gateway.go:5639`) call
  `withoutMessageReasoning` (`chattidy.go:585`), which drops exactly the
  refused fields (converting details→content first when only details was
  refused) and remembers them per provider (`s.fits`).

## Why the collision face fails

The double-field emission is real. Probe A (pure Kimi route), a message
carrying `reasoning` + `reasoning_details` leaves as
`reasoning` + `reasoning_content` with the same text (details dropped) —
both on tool turns and plain turns, since on a pure Kimi route the
injection lane never runs and only the conversion touches such messages.

But the upstream half of "双字段同现且上游会拒" is answered by the Kimi
lane's own introducing commit, f2400f67 (#1765), probed against the real
api.kimi.com/coding/v1 on 2026-10-12:

> Kimi refuses reasoning_details in every shape tried (…), and **passes
> reasoning_content, reasoning and an empty list through validation**.

Kimi's recorded refusal mode names the offending field at a message
position (a validator for `reasoning_details` specifically) — nothing like
#3165's engine, whose serde maps `reasoning_content` onto `reasoning` as an
alias and dies on `duplicate field \`reasoning\`` (the reporter's A/B
table: either alone 200, both 400). Both names individually pass Kimi's
validation; no probe of Kimi has ever shown aliasing. If some Kimi-fronting
relay did reject the pair, magpie already self-heals: the first 400 naming
`reasoning` "at position N" is read by `refusedInMessages`, the request is
retried without the field, and the provider remembers to pre-drop it
(`s.fits`). The residual risk stays exactly where the F comment left it:
"conceivable if a Kimi upstream aliases the names; unchecked" — and the
recorded checks say it doesn't.

## Why the semantic-conflict face fails

- F's deletion is **conditional**, not provider-unconditional: gated on
  `chatReplaysReasoning` at gateway.go:4256. A pure Kimi route
  (Kimi host/preset, no deepseek in any model name) never reaches it.
  Probe A ran byte-identical with and without F applied — the strongest
  available form of "F doesn't touch the Kimi path".
- The lanes' predicates are disjoint in practice. The overlap needs a user
  to point a Kimi-hosted/preset provider at a model whose name contains
  `deepseek`. On that route the two branches run in order 3 → 6, and:
  - pre-F, a tool turn with `reasoning` got `reasoning_content` written
    **beside** it — the exact #3165 collision shape, on a route whose model
    name claims DeepSeek semantics. Probe B (baseline) shows it.
  - with F, the same messages leave carried-once (`reasoning_content`
    alone). Probe B (F applied) shows it, and F's own
    `TestChatToolTurnReasoningCarriedOnce` passes. On this route F is the
    cure, not the disease.
  - messages the injection lane never sees (plain turns after a user
    message) keep the Kimi lane's keep-`reasoning` conversion unchanged
    (probe B message 5, identical pre/post F).
- "reasoningDetailsAsContent 刻意保留的字段" is not pinned by any test: the
  two Kimi tests (`TestKimiGetsReasoningDetailsAsContent`,
  `TestReasoningDetailsRefusedAtPosition`,
  `internal/gateway/kimi_reasoning_details_test.go`) contain no `reasoning`
  field at all — their pinned shapes are details→content and
  own-content-keeps. What *is* declared is the endpoint contract in
  f2400f67's message (reasoning passes validation), which the keep is
  consistent with.

## Probe evidence

Probes lived in `internal/gateway/zzz_hunt60b_probe_test.go` (temporary,
deleted afterwards; worktree pristine at b0d46ca7). Full command outputs in
`verification.log`. Outbound shapes asserted with `sameJSON` against the
httptest fake (Kimi preset `kimi-code-cn`, `refuse: kimiRefuseDetails`):

- **Probe A — pure Kimi route** (`kimipure/k3`): PASS on baseline; PASS
  unchanged with F applied. m1 (tool turn, `reasoning`+details) →
  `reasoning:"R1."` + `reasoning_content:"R1."`; m3 (own
  `reasoning_content` + `reasoning`) → both kept as sent; m5 (plain,
  `reasoning`+details) → `reasoning:"R3."` + `reasoning_content:"R3."`;
  m7 (tool turn, `reasoning` only) → untouched, `reasoning` alone, no
  injection.
- **Probe B — Kimi preset + model `deepseek-v4.1-flash`**:
  - baseline: m1/m3/m5 all leave as `reasoning`+`reasoning_content`
    (double-field, the #3165 shape) — PASS.
  - F applied: m1 → `reasoning_content:"R1."` alone; m3 →
    `reasoning_content:"Own."` alone; m5 → still
    `reasoning:"R3."`+`reasoning_content:"R3."` (the Kimi lane's own
    residual) — PASS after expectations flipped; F's own test passes.
  - F reverted (F expectations kept): RED again — m1 back to
    `reasoning:"R1."`+`reasoning_content:"R1."`, m3 back to
    `reasoning_content:"Own."`+`reasoning:"R2."` (ablation-direction
    confirmation).

## Sibling survey (request-side reasoning decisions, baseline)

| place | decision | carried once? |
| --- | --- | --- |
| `withReasoningOnToolTurns` (chattidy.go:423) | DeepSeek replay lane; pre-F copies beside, F moves | pre-F no → F yes |
| `reasoningDetailsAsContent` (chattidy.go:566) | Kimi lane; details move into content, `reasoning` kept | partial (details move, `reasoning` stays) |
| `mistralThinking` (chattidy.go:654) | Mistral; all three fields deleted, thinking rides in the typed part | yes (precedent for move-not-copy) |
| `buildChat` replay (chat.go:268+) | translated requests; messages built by magpie | n/a, no client field to collide |
| `withReasoningText` (responses.go) | Responses replay; fills content, no second name | yes (checked in F's survey) |
| `withoutMessageReasoning` (chattidy.go:585) | adaptive retry; drops exactly what was refused | n/a |

The Kimi lane's keep-`reasoning` is the only remaining keep-both shape, it
predates F, is consistent with the endpoint contract recorded in f2400f67,
and nothing guards or depends on removing it.

## Recommendation

No patch from this lane. If a real Kimi upstream is ever shown to reject
`reasoning` beside `reasoning_content` (or at all), the fix is one deletion
in `reasoningDetailsAsContent` — drop `reasoning` (`messageReasoning[1]`)
when `reasoning_content` is written, F's carried-once semantics, with
`mistralThinking` as precedent — plus the flip of probe A into a test.
Owner: whoever can probe the real endpoint (the #1765 prober's
subscription has lapsed per f2400f67's "Not verified", so that is not this
lane today). The adaptive retry already bounds the blast radius of any such
rejection to one 400.

## Not verified

- Nothing was sent to any real endpoint; Kimi's tolerance rests on the
  2026-10-12 probe recorded in f2400f67, not a fresh check.
- The overlap route (Kimi preset + deepseek-named model) is constructed for
  the probe; no report of anyone running it was found.
- F's patch is unchanged and unmerged; its own verification matrix lives in
  comment 6320485575 and is not re-run here beyond the probe flips.
