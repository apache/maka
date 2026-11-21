REFRESHED #5074 (W2-A)
new head: ebe587f9cd3e3dc8b0f251cc78f0f11310f354f1
old head: 34ff1f7005 (origin authoritative; stale local b28e40387 discarded)
base: 6f5d48ea0 -> 8016b9fca-neighborhood (zero conflicts after catch-up fusion; am clean on 0d99261dc)
sha256[:16]: 4eec7b648d498d04
Tests green: TestMask #5074 cases + TestModelQueryValueEndsAtAmpersand + full redact package (upstream eval additions included)
Ablation red->restore->green: fix:queryValueAt->ok:secretValue x3 + fieldAt inURLQuery early-true dropped (TestMask red)
Sibling: upstream apply() precedence + eval fixtures, no rule-chain intersection
