REFRESHED #5815
new head: 0b860307a98c590cbbcfb2fec3c339eb640b6d0d
old head: a8b58ac01a034fd9155c2acaf8c611479c57ab81
base: 07a06617e -> 803d7747e (zero conflicts)
sha256[:16]: 3bce5421a1e13a2f (bytes differ from 11b6d298e973a135: hunk line shifts; semantics unchanged)
am: clean checkout 803d7747e, zero-conflict
Tests green: TestCodexCompactImageLimitAsksSmaller (chat+responses) + TestCodexCompact family
Ablation red->restore->green: image-count branch out of summaryTooLarge (1+11-)
Sibling: upstream added codexHolds (429 hold) in same file, no overlap with summaryTooLarge
comment: https://github.com/yetone/magpie/issues/5815#issuecomment-6746472461
