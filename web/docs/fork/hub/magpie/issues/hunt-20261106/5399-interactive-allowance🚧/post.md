Stepping back from the take: this is already fixed on `main` — b7631300e, "claudetui: a successful interactive turn tells its account's allowance" — so no patch follows from me.

The report's baseline genuinely lacks that commit: b7631300e was authored Nov 3 and sits after 326e72f4 on `main` (first shipped in v0.1.3075; the v0.1.2925 gateway the report was seen on predates it too). Nothing wrong with the report — both the release and the baseline really had the bug.

What `main` does now is the mechanism this report asked for, with two differences from the branch, neither behavioral:

- `tap.js` puts a reply's `anthropic-ratelimit-unified-*` headers, and no others, on the stream's open line as `"h"`; `tap.go` turns them into the `rate_limit_info` a `-p` run tells (`rateLimitInfo`: `status` plus `unifiedWindows` of `five_hour`/`seven_day`/`seven_day_overage_included` from the `5h`/`7d`/`7d_oi` headers, a window left out unless both its figures parse), tells it just before `message_start`, keeps a reply whose message was told whole for the turn's end (`tap.settle`), and `transcript.go` settles the tap before an API error's own `rate_limit_info`, so the error's reading is the newest. The bridge and routing are untouched, as both the report and the commit expect: the event reaches `NoteClaudeLimits` and routing as a `-p` run's does.
- The differences: the event is told on every successful reply rather than deduped until a window's whole percent changes (`NoteClaudeLimits` keeps the last it hears, so a tool loop's extra tells cost a line each), and the branch's `untold` dedup is replaced by ordering (`toldOf`) — an older reply's kept reading is never told after a newer one's.

Evidence at `main` (12a9970d6): `TestTapTellsReplyLimits`, `TestTapLimitsOfMessageToldWhole`, `TestTapErrorLimitsLast`, `TestShimTellsTapLimits`, `TestTapKeptLimitsNotAfterNewer` all pass; with `tap.go`, `tap.js` and `transcript.go` reverted to this issue's baseline (326e72f4), all five fail — the reported symptom ("`used` moved only at a restart, when a window's reset passed, and on a 429") exactly.

Thanks @ericxk for the analysis and the offered branch — the diagnosis is what landed. The one gap the branch named that remains open on `main` too: an interactive Claude Code that doesn't load the tap still tells nothing as it answers.
