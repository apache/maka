REFRESHED #4202 (W2-A)
new head: 0eec95a2a53b6547f22199b07605ec1227d808bc
old head: 336926e944d854fb98a29ce764c29caf41e85498
base: original -> rebase-time tip (zero conflicts across 713 drift)
sha256[:16]: e094bb88b396927d
Tests green: TestRemoteMagpie429IsAskedNotReplayed (+ -race)
Ablation red->restore->green: r.there term lifted from quotaHeld guard (test-only patch, behavior fork)
Sibling: upstream timedHeld has its own r.there guard, parallel honoring; test file untouched upstream
