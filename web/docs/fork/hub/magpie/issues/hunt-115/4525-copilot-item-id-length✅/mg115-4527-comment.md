Fixed by the patch on #4525: [gateway: an input item's id longer than the 64 an upstream that checks ids takes goes shorter](https://github.com/yetone/magpie/issues/4525#issuecomment-6556939927) — it covers this thread's Windows `guardian` face and #4525's macOS face alike, as both come through the same rewrite.

Your reading matches the code as it stands: `plainItemIDs` checks the characters of an input item's id but not its length, and `BoundCallID` bounds only `call_id`. The fix here is the shape you verified live — an id longer than 64 goes as its kind's prefix and the sha256 of the whole of it, cut to fit, never a plain cut; valid ids untouched; another vendor's foreign-character reasoning still dropped, while Copilot's own overlong reasoning keeps its place with its seal.

Your controlled before/after experiment (400 `invalid_request_body` on the recorded 444-character id, 200 patched) was the strongest evidence on either thread, and the deterministic-digest choice here follows it. New regressions in the patch reproduce the refusal word for word, a 444-character message id among them.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
