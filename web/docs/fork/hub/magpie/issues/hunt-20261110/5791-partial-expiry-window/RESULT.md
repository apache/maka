REFRESHED #5791
new head: 1365dc8136f2cbf95dcdfbb68fdaf399a513bbdf
old head: 8d328bf6eb3dfd36ff375c47eede45c4817f617e
base: a6e4cf763 -> 7e5cebb86 (zero conflicts)
sha256[:16]: cf2583d5cfcba997 (identical bytes)
am: clean checkout 7e5cebb86, zero-conflict
comment: https://github.com/yetone/magpie/issues/5791#issuecomment-6745964448
Tests green: TestPartialExpiryKeepsTheReset, TestWorkBuddyCreditsRunOutForRouting (regression kept), gateway expiry family (30s), internal/routes
Ablation red->restore->green: lapsingAll() guard dropped from renewing (logic hunk, no file revert)
Sibling: a6e4cf763..7e5cebb86 = 17 commits, routing.go untouched; c6331b427 (group keys) + ac4af5823 (lan.go) reviewed, no intersection
