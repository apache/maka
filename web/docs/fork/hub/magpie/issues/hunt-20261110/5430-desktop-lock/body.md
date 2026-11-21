@nonamelane thank you for the Windows verification of both halves — that's the real-platform leg neither patch could run itself, and it's now part of the record. On your bigger question, my read as the patch author, for @yetone's ruling:

**The pattern you describe is real, and the family table is the evidence.** Five entry points (file I/O, masking, desktop-pick, provider catalog, uploads), three platforms, one 30s kill. Our two patches each retired a *shared* root on their path — the two `logins.json` halves and `desktopPicked`/`sciencePicked` — because those had a concrete shared-cause shape (whole-verdict work inside a process-wide lock). Where a shared root exists, that lane stays worth walking: it fixes the incident *and* the siblings behind it.

**What's left after these two patches is the part I agree needs a decision rather than a third patch of the same shape.** The ratchet you point at is the honest cost of the current design: the watchdog only recognizes whitelisted wait kinds, so every new slow source starts as "no wait magpie knows of". Of the mechanisms you name:

- *Wait attribution* (each lock/I-O path reports what it held, so a 30s dump says "held: catalog rebuild" instead of "no wait known") is the smallest step that compounds: it turns every future incident into a named suspect instead of another whitelist entry, and it would have made #5430's and dongsheng123132's dumps self-explaining.
- *A per-stage budget* is a bigger contract change — it needs every stage to be able to degrade, which today most can't (a routing decision has no stale answer to give).
- *Stale-while-revalidate* fits the catalog-type reads (29 MB rebuilt per call, in the dump) but not the lock-held-across-I-O shape.

I don't think the choice between "architectural answer" and "case by case" is ours to make — the incidents you list each got a correct case fix, and the case fixes are load-bearing (yesterday's verification re-ran them red→green on today's base). But if the family grows by one entry per new agent/provider/plugin, wait attribution is the one mechanism I'd expect to pay for itself first. Happy to draft either the attribution patch or a per-site survey of the 8 remaining sibling shapes, whichever @yetone prefers.

Meanwhile the branch carries today's base: rebased onto current `upstream/main` (`803d7747e`), head `05c4b7e0b`, zero conflicts; the claude-desktop app commit (#5671) touched the area without overlapping the lock-scope hunks.

Verification on the new base: `TestDesktopPickedLockKeepsCatalogWorkOut`, `TestClaudeDesktopDefault`, `TestClaudeScienceTurn`, `TestClaudeDesktopAuxiliaryModel`, `TestClaudeDesktopClassifierKeepsItsModel`, `TestDesktopSubagentTurnKeepsSessionPick`, `TestDesktopSubagentTurnLeavesTitleOnLead`, `TestDesktopTitle` green; ablation (catalog work back inside the `desktopPicked` lock) → `TestDesktopPickedLockKeepsCatalogWorkOut` red, restored → green; fresh patch `git am`s clean at `803d7747e`, sha256[:16] `bae23bbc9b682962`. Windows/macOS real-box reproduction stays NOT-RUNNABLE here — your runs are the live evidence.

Generated-by: GLM-5.3-Flash (ZCode)
