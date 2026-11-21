@LiAo365 — the 408 in this report is magpie's designed upload allowance working as documented, not a defect. Here is the walkthrough against the report's own numbers.

**The arithmetic** (`internal/gateway/unrouted.go`, `unmaskedLocked`/`checkMost`): a request held before routing is stopped after `unroutedMost` = 2 minutes, plus credit a progressing upload earns — 1 second per 32 KiB actually read (`unroutedUploadRate = 32 << 10`), never more than the time actually spent in body reads, capped at 8 further minutes (`unroutedUploadGrace`). The report itself says `held: 2m35s`, `known waits: in body 2m34.8s (under way)`, `body read: 1.1 MB of 6.4 MB`:

- 1.1 MB ≈ 1,153,000 bytes → 1,153,000 ÷ 32,768 ≈ **35.2 s** of credit, under the 154.8 s spent in the body wait;
- 120 s base + 35.2 s earned = **155.2 s = 2m35s** — the hold fired exactly on the designed schedule;
- the answer magpie gave says the same in its own words: "The upload exhausted its time allowance (32 KiB/s with a two-minute grace period, at most eight additional minutes)."

**Where this comes from** — #4775 ("gateway: slow request-body uploads hit pre-routing 504…"), landed by @yetone:

- df69ffe97 (@wuuli): a progressing upload earns time for the wire bytes actually read, one second per 32 KiB and never more than the time actually spent reading the body, so big requests over slow links are no longer cut off at 2 minutes;
- 19d04425c (@lengjingxu): the earned time is capped at 8 more minutes (total non-masking pre-routing wait ≤ 10 minutes), capped before the duration arithmetic so a huge byte count cannot overflow;
- yetone's closing comment there: 「30 秒的未知等待保护、60 秒的 socket 空闲超时、512 MiB 解码上限、以及对极慢涓流的 408 都保留不变」 — "…and the 408 for an extremely slow trickle stays unchanged". A body arriving slower than the 32 KiB/s earn rate running out of its allowance is the kept behavior, on purpose. #4775 is deliberately still open, waiting for the original reporter's confirmation on a released build.

**Pinned on main**: `TestUnroutedUploadTimeIsBounded`'s "below rate" case pins that 32 KiB of read bytes excuses exactly 1 s (an upload under the rate earns nothing more), and `TestUnroutedUploadAllowanceHasCeiling` pins the 8-minute cap. Between v0.1.3184 (this report) and current `main`, `internal/gateway/unrouted.go` and `internal/gateway/body_room.go` are byte-identical (`git diff` is empty) — `main` behaves exactly as this report shows. Your upload averaged ≈7.4 KB/s, well under the earn rate, so it exhausted its allowance at 2m35s while still progressing — the outcome the design keeps.

So this is not a bug. If you think the 32 KiB/s earn rate or the 8-minute ceiling should be adjusted for slow links, that is a design conversation for **#4775**, where the discussion and its authors are — please add your case there.

**Attribution**: AI-written; I've read the whole path and the tests above. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
