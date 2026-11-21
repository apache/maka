REFRESHED #4314 (W2-A)
new head: f93102ffe7f7fc3514fdc40ec36fd141036864d5
old head: cbd25dc21ca5ab5c6452180a29e7a169c860b52a
base: d8b3749e -> rebase-time tip (zero conflicts across 717 drift)
sha256[:16]: 935c564d1c42c6be
Tests green: TestClaudeCallersWorkDirItCannotEnterIsNotUsed (-v PASS), ElsewhereIsNotUsed
Ablation red->restore->green: canEnter guard out of clientWorkDir (-11)
Sibling: upstream passedOver->untrustedHere + first-named-dir doc; canEnter layer composes unchanged
