@stevenpisces thank you for the forensics — the sha-paired backups and the `wrote dsh's route again` attribution pinned this down. The writer was magpie, and the mechanism is a race:

**dsh's desktop rewrites `cordis.patch.yml` in place — truncate, then the body.** For that moment the file *is* its head alone, and the head carries magpie's route entries (they sit up front). magpie's rounds read the list every pass; one that read in that window saw a wired list of two, changed nothing worth a diff, wrote the read back — and the half-state became the whole list. Your 57 entries (and `ui-settings-account`'s `step: done` with them) were on the wrong side of that window, repeatedly: `!!js` had nothing to do with it (the parser is line-based and keeps unknown entries whole — verified), and the write itself is atomic; the loss happened *before* the write, at the read.

**The fix (branch [`fix/5782-dsh-patch-halfwrite`](https://github.com/ggbdpq/magpie/tree/fix/5782-dsh-patch-halfwrite), head `12c140d90`, rebased onto current `upstream/main`):** a list written this recently is reread after a beat; one that moved under us is left to the next round, which reads it whole. A writer that finishes between the two reads costs the round one beat — the rounds run seconds apart, so the route lands one round later, and lands against every entry.

Verification (darwin, `internal/agent`):

- New `TestDshRouteAgainSkipsAFileBeingWritten`: the desktop's write is played by a delayed second write (head first, body inside the settle beat) — with the fix, the round skips the half and the next round reads every entry (`user-entry-z` survives); with the reread gated off (ablation), the test fails at "the half-state was fixed as the list — the user's entries are gone", your shape exactly.
- Whole-package run green (`TestMothX` alone red, on the parent commit too — pre-existing); `TestDsh` family with `-race` green.
- Sibling scan: `dshFillNewProfiles`/`dshSetFile`/`dshSettingsAgain` write only after their own reads and keep the same exposure shape; the route round is the one your log pins (`wrote dsh's route again`), so the gate sits there. The others are noted honestly as the same race in principle, unfixed by this patch — say the word if their logs ever show it and the gate moves to cover them.
- Fresh patch `git am`s clean onto a tree at current `upstream/main` (`e3ab7f3bf`); sha256[:16] `9d487e27938e3cf0`. A real Windows dsh desktop mid-save stays NOT-RUNNABLE here; your paired backups are the live evidence of the shape.

Generated-by: GLM-5.3-Flash (ZCode)
