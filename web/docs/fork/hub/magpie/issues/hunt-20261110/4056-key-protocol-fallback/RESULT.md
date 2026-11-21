REFRESHED #4056
new head: 957287335b6373628f4c3e0ccb801e8d7b2f9c1e
old head: e1c572f69de7855d147bb1f987bcd04f20594a8f
base: f37de8cc4 -> 803d7747e (zero conflicts; siblings untouched upstream)
sha256[:16]: b28af6809ef22784 (bytes differ from 82ac074697aa2bd1: hunk line shifts)
am: clean checkout 803d7747e, zero-conflict
Tests green: TestTestAsksOnTheURLsItHas (2 subtests), TestProviderKeyProtocolPair, TestProviderShowsKeyProtocol, TestKeyForAProtocolWithNoURLIsSaid
Ablation A red: 3 no-URL fallbacks out of test.go (3+23-) -> TestTestAsksOnTheURLsItHas both subtests red
Ablation B red (2 FAIL): key.protocol case out of applyPairs
