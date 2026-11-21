REFRESHED #4328
new head: cf5695c8831e44a3b88cada197d38f3d0610137b
old head: 30109390c (on f37de8cc4)
base: f37de8cc4 -> 803d7747e (zero conflicts; anthropic.go+migrate_kiro.go untouched upstream)
sha256[:16]: f4154e51c5e6b272 (identical bytes)
am: clean checkout 803d7747e, zero-conflict
Tests green: TestKiroCreditsReachTheLedger + cache-unknown 5-group (1.2s), -race ok (2.4s)
Ablation red->restore->green: Credit field + usage() read out of anthropic.go (-9)
Sibling: migrate_kiro.go 0.1.29 note still names #4328 (min now 0.1.35)
