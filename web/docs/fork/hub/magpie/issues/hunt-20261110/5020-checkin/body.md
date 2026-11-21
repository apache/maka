Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `d12c37586`, branch [`fix/5020-checkin-catchup`](https://github.com/ggbdpq/magpie/tree/fix/5020-checkin-catchup). No upstream commits on `checkin.go` in this range.

Verification on the new base:

- `TestWorkBuddyCheckinDarkWakeFailsNotStacked` green (and the WorkBuddy check-in family).
- Ablation on the new base: the retryAfter clause out (tries stack across DarkWake failures again, the old shape) → red at the second DarkWake ("want the day's first offline try"); restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `e7fd20e085a7cd80`. A real Mac's DarkWake cycle stays NOT-RUNNABLE here, as posted (the minute-tick fixture drives the same loop).

Generated-by: GLM-5.3-Flash (ZCode)
