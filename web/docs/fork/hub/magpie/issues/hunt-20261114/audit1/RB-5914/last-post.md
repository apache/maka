@qiqll refreshed and re-verified on today's main — the lock is intact, authorship yours; the rebase needed four adaptations, all listed.

**Branch:** [`hunt-20261111-rf-5914`](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5914) @ `02d76378f5ef147c` — your commit rebased onto current `upstream/main` (`0d0a1a567`), author kept. Patch: `470b273c43f6b200` (sha256[:16]).

**Rebase adaptations (disclosed):**

1. Upstream's express mode (`696556e26`, after your base) gives Vertex AI one API key of its own and a base URL — your `errVertexKey` "no key on Vertex" stance (in `checkMerged`, the edit closures, and `TestVertexAddKeyRefused`) predates it. Those refusals are dropped and `checkMerged` now mirrors what Save refuses (a keys *list*, a base URL with no key), with `TestVertexAddKeyRefused` rewritten as `TestVertexAddKeyKept` pinning the key being kept.
2. Your `prepare` seam kept; the two Vertex checks inside it re-homed to upstream's newer express-mode wording (both `Save`'s messages verbatim).
3. Upstream's `ReplaceKey` learned three more keyRef-carrying maps after your base (`AccountCaps`, `AccountWindowCaps`, `AccountWindowAmounts`) — the moveKeyed list in your locked edit now carries all of them; without it `TestKeyTakesUsageCap` fails (a cap lost on key replacement — caught by the run, fixed, re-run green).
4. The `providers_cli.go`/`keys.go` tails keep your locked-edit shape; upstream's duplicated direct `Save` calls are dropped in favor of it.

**Evidence** (darwin/arm64, upstream/main `0d0a1a567` + this commit):

- Named tests: the whole interleave family — `TestProvidersTwoCapsBothKept`, `TestProvidersAddKeptWhileCapWritten`, `TestProvidersMoveKeepsACapSetMeanwhile`, `TestProvidersRPMKeepsAQueueAndACapSetMeanwhile`, `TestProvidersKeyWeightKeepsAKeyAddedMeanwhile`, `TestProvidersChangeRefusedWhileAnotherMagpieHolds`, `TestTUIProviderKeysKeepWhatWasSetMeanwhile`, `TestProviderCommandsKeepWhatWasSetMeanwhile`, `TestFailSaysFileBusy` — green. `internal/provider` whole package green (165s), `-race` green on the family (19s), `internal/filelock` green, gofmt/vet clean.
- Ablation: the strict lock passthrough'd (`Take`→nil, `Unlock`→no-op) → `TestProvidersTwoCapsBothKept` and `TestProvidersChangeRefusedWhileAnotherMagpieHolds` red; restored → green.
- `git am`: the patch replays cleanly on `0d0a1a567`; the replayed tree is byte-identical to the branch tip (empty diff).
- NOT-RUNNABLE here: two real magpies on one providers.json across machines (`TestProvidersLockHolder` SKIPs for the same reason — the cross-process hold is fixture-simulated; the filelock primitive itself is tested in `internal/filelock`).

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`yjqi`/qiqll) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)

