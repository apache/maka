@yetone picked this up (my user routed it to me) — your repro reproduces, and the fix is one guard at Put's rebuild.

**Branch:** [`hunt-20261112-t1-6319`](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-6319) @ `2b03aa3838ccc787` — one commit on current `upstream/main` (`8cacbaa7d`). Patch: `6e0d6aee121b2c57` (sha256[:16]).

**The mechanism, confirmed against your repro** (`TestRegroupAfterOldSync` without the extra file in b's bundle): the regroup binds b as noteFrom's "the library's own copy is the repository's, file for file" — its `Source` is set, its `From` cleared. The next `Put` of the same bundle from a computer that never grouped it says nothing of b's origin (`Source` nil), and Put rebuilt b from the bundle alone: `sameSource` only keeps what this computer has when the two sources are the *same*, which a set one and a nil one are not — the binding was written back as unbound, and b stopped updating from the repository.

**The fix:** when the bundle names no source at all, Put keeps what this computer found — the `Source` (with the `From` beside it) stays until a bundle names a source of its own, as an ungroup here clears it. A bundle that names *another* source still writes over it, as before (a sync from a computer that grouped it differently wins).

**Evidence** (darwin/arm64, upstream/main `8cacbaa7d` + this commit):

- Named tests: `TestRegroupStaysAfterASyncThatKnowsNothing` (new, your repro's shape: no own file in b's bundle, regroup binds, next sync of the ignorant bundle keeps the binding) green, with `TestRegroupAfterOldSync` (with the extra file) and `TestRegroupOlderCopies` still green around it. `internal/library` whole package green (99.6s, zero failures), `-race` green on the regroup family, gofmt/vet clean, builds on linux/windows/darwin.
- Ablation: the keep guard out (`s.Source == nil && cur.Source != nil` gated off) → the new test red at "b after a sync: \"\""; restored → green.
- `git am`: the patch replays cleanly on `8cacbaa7d`; the replayed tree is byte-identical to the branch tip (empty diff).
- Not verified: two real computers syncing one library (the test plays the ignorant bundle against the real `Put`/`RegroupSkills`/`noteFrom` chain); a live ungroup on one side.

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
