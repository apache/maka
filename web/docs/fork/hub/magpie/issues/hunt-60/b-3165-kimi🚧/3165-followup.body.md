Following up on the two "Kimi unchecked" notes above (the siblings list and Not verified): I've since checked that path, and both questions close as no-action.

- The collision I was worried about needs a Kimi upstream that aliases `reasoning` and `reasoning_content` the way DeepSeek's serde does. The live check in f2400f67 (#1765, against api.kimi.com/coding on 2026-10-12) recorded the opposite: Kimi's validation passes `reasoning_content`, `reasoning` and an empty list through and only names `reasoning_details` for refusal — a named-field validator, not aliasing. And if some Kimi-shaped upstream ever does refuse a second name, the existing `refusedInMessages` retry strips it once and remembers, so the failure mode is one 400, not a stuck stream.
- The fix above turns out to be inert on that path anyway: its strip is gated on the DeepSeek replay check (`chatReplaysReasoning`), so a pure-Kimi routing is byte for byte unchanged with and without the patch (probed with a Kimi-routed tool turn, with and without the fix applied).

So `reasoningDetailsAsContent` stays as it is, deliberately.
