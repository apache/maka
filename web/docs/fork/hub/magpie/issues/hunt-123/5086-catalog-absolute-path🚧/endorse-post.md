**Stepping aside — the reporter has this fix**

I had a `take` on this issue earlier; before publishing my own patch I re-checked the thread and found the reporter @Jinbu-Li has posted a complete fix branch. The fix is theirs — no patch from me. I re-based their two commits onto the current tip and verified the branch independently instead.

## What the branch contains

[Jinbu-Li/magpie `fix/codex-shared-home-catalog`](https://github.com/Jinbu-Li/magpie/tree/fix/codex-shared-home-catalog), based on upstream `e928b57f0`, two commits:

- `a6330cb54` — Dopetaiga's original path-normalization patch from #4785 (`7648493c8`), cherry-picked with authorship preserved. Same change confirmed mechanically: `git patch-id` of both diffs is identical (`552568a32a57b7c7…`), the diff text differs only in blob index lines, and the commit body carries the cherry-pick provenance with Dopetaiga as author.
- `481366220` — the shared-`CODEX_HOME` fix: new `model_catalog_json` references are written absolute in the reader's own path syntax, for both catalogs (`magpie-models.json`, `magpie-desktop-models.json`); an existing relative reference is kept while its catalog stays selected (the #816 Windows/WSL boundary); disconnect/reconnect adopts the new default; slash-spelled absolute paths are recognized for cleanup; `TestCodexCatalogAcrossHomes` pins the provider and desktop lifecycle; the shared-home boundary is documented in `docs/subsystems/agent-wiring.md`.

That covers the exact shape of this issue: a private `CODEX_HOME` sharing only `config.toml`, where Codex resolved the relative catalog name against its own home and `config/read` failed with `-32603 / os error 2`.

## Verification (darwin/arm64, Go 1.25.5, tip `c32b820a9`)

| Check | Result |
|---|---|
| `git am -3` of `e928b57f0..481366220` onto current `upstream/main` tip `c32b820a9` | Clean, no conflicts; authorship preserved (`2c4343397` Dopetaiga, `aaeb9f4dd` Jinbu Li) |
| `TestCodexCatalogAcrossHomes` (`-tags nogui -count=1`) | PASS — `provider` and `desktop` subtests |
| Ablation: the fix's `codex.go` swapped back to its parent via `go test -overlay` | Both subtests FAIL (real red): the catalog cannot be read from the private home — the `-32603 / os error 2` of this issue |
| Eight related top-level Codex tests (the `-run` regex from the reporter's notes) | PASS |
| `gofmt -l` on the changed Go files | Clean |
| `go vet ./...` and `GOOS=linux go vet -tags nogui ./...` | Clean |
| Full `go test -tags nogui -count=1 -timeout 25m ./internal/agent` | 1 FAIL: `TestMothX` — reproduces on a clean `c32b820a9` worktree, pre-existing on this machine, unrelated to the Codex catalog paths |

## Not verified here

Windows/WSL native behavior, `GOOS=windows` builds, and a live OpenResearch run — the reporter covered Windows x64 natively (including a real Codex 0.166.0 `config/read` reproducing `-32603 / os error 2` before and success after) and disclosed their own remaining limits (gateway package timeout on their full-suite run, no OpenResearch restart).

**Attribution**: Dopetaiga wrote the original path-normalization patch (#4785, preserved as `a6330cb54` with authorship); Jinbu-Li wrote the shared-home fix, the lifecycle regression tests and the compatibility docs (`481366220`), and reported and reproduced this issue. All credit to both.

Reference for maintainers: the same two commits on the current tip are at [ggbdpq/magpie `fix/5086-catalog-absolute-verify`](https://github.com/ggbdpq/magpie/tree/fix/5086-catalog-absolute-verify) (`aaeb9f4ddb0060568be5df748f6371fb086ac99e`), usable as a cherry-pick source if a tip-based branch helps.

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.
