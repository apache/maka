**VERDICT: PASS** — independent verification of @sky-stroller's fix ([27f55d4](https://github.com/sky-stroller/magpie/commit/27f55d41281a9ca5e30b482a3a2f08bd64e10962)) is done: the fix is semantically correct and its tests genuinely pin it. Credit for the fix and its authorship is entirely theirs; we only verified and carried it across a rebase.

**Not verified:** native Linux/Windows execution, real private SSH authentication, and the live Gitea `skills/gt` URL — the reporter ran those; we verified with local fixtures only, so cross-platform vet/build here does not establish native runtime behavior.

**What we did independently (not taking the reporter's self-description as given):**

1. **Red on upstream/main.** With two probe tests of our own against a local SHA-256 fixture repository, upstream/main (12a9970d6) fails exactly as reported: `fetchGit` dies with `fatal: mismatched algorithms: client sha1; server sha256`, and `gitRemoteHead` rejects a 64-digit pinned commit with `has no branch or tag <oid> any more`.

2. **Rebase.** Rebased 27f55d4 onto upstream/main. One conflict, in `docs/subsystems/library.md` (upstream 25b201eb6 rewrote the same Skills table row): merged section-wise, keeping upstream's new content and the reporter's rewritten fetch-flow description. The current tip dbaeaec12 (two later claude-desktop commits) touches none of the fix's files. Rebased carrier: [f78c61625 on our fork](https://github.com/ggbdpq/magpie/commit/f78c616250674bd63a03cfab9ae2e278743be7a7) (branch `verify/5362-sha256-rebase`, raw patch at [f78c61625.patch](https://github.com/ggbdpq/magpie/commit/f78c616250674bd63a03cfab9ae2e278743be7a7.patch), author kept as Gerry Hu). **This commit is only a rebase carrier, not our work:** of its 4 `.go` files, `skillgit.go`, `skillgit_format_test.go` and `skillgit_legacy_test.go` are byte-identical (sha256) to 27f55d4; the only edit we made is a 3-line gofmt alignment fix in `skillgit_test.go`, which the original commit leaves non-gofmt-clean (the map literal in `TestGitErrorsSaid`).

3. **Green on the rebased fix.** All targeted tests pass, including our two probes: TestFetchGitObjectFormats (sha1+sha256 × default/branch/tag/commit/unborn-head), TestGitRemoteRefsValidation, TestFetchGitEmptyRemote, TestFetchGitProbeTimeout, TestGitHexNamedRefsFollowRemote, TestGitRemoteHeadSHA256, TestFetchGitDumbHTTP, TestFetchGitLegacySHA1, TestInstallFromGitRepo (sha1+sha256), and the existing TestGit* regression set (TestGitSourceReads, TestGitTreeURLInstallsFolder, TestGitMissingSaysSo, TestGitSignInRefusedSaysSo, TestGitRefusesOptionsAndTransports, TestGitErrorsSaid). Package-wide: `go test -tags nogui -count=1 ./internal/library` ok (141 s, Go 1.26.8).

4. **Ablation (fix removed, tests kept).** With `skillgit.go` reverted to upstream/main and the tests kept, 8 fix-specific tests fail again: TestFetchGitObjectFormats, TestFetchGitEmptyRemote, TestGitHexNamedRefsFollowRemote, TestGitRemoteHeadSHA256, TestFetchGitDumbHTTP, TestInstallFromGitRepo, and both of our probes. The tests bite the fix.

5. **Sibling sweep.** rg over the whole repo: `fetchGit` has exactly one production caller (`skills.go:1094`, the probe/install path); `gitRemoteHead` exactly one (`checkGitSkill`, update checks); `hexRef` has no users outside `skillgit.go`. The declared behavior change to pinned checks (they now query the remote; an unreachable host reports unknown) is confined to `checkGitSkill`'s existing unknown-status handling and is documented in the patch's own docs update.

6. **Matrix.** `go vet` and `go build` pass on darwin, GOOS=linux (`-tags nogui`) and GOOS=windows; gofmt clean after the 3-line fix above.

Generated-by: GLM-5.3-Flash (ZCode)
