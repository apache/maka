REFRESHED #5029 (W2-A)
new head: c3990705acf6fe4e1697ba007589813efe8f274c
old head: 8a4725ebc4e5f7582295d726ac065cc994f7d6fb
base: d8b3749ef -> rebase-time tip (zero conflicts across 717 drift)
sha256[:16]: 79596341bbe8f29e
Tests green: TestAllowancesGoByANewerReadingInHand + TestAllowancesStaleMidRead
Ablation red->restore->green: inHand merge out of Allowances (-10)
Sibling: upstream goRead wrap + c.heard merge (background-read path), orthogonal to sync in-hand path
