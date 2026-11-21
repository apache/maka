Rebased onto `764a032f6` (current `main`). One conflict, in `internal/plugin/store.go`: upstream #3622 added `mendDist(ctx, bun)` at the same spot this branch adds the git-cache refresh. Both kept, refresh first — the clone's refs are fetched before bun resolves, then dist is mended, then the add runs.

Verification:

| Check | Result |
|---|---|
| `go test ./internal/plugin/ -run '^(TestGitUpdateInstallsTheBranchsCommitNow\|TestGitUpdateSaysWhenItDidnt\|TestGitUpdateKeepsACommitPin\|TestRefFixed\|TestSameRepoAndCloneOrigin)$' -count=1` | PASS — the end-to-end (local git, bare repo, git+file://, real bun) included |
| Ablation (`store.go` reverted to parent, so `install` fetches nothing) | RED — end-to-end: "the update said it is done, the plugin is still at 1.0.0, want 2.0.0" |
| Sibling faces: `TestGitPlugin`, `TestIsGit` | PASS |
| `gofmt` (CRLF-stripped copies), `go vet` local / `GOOS=linux -tags nogui ./internal/...` / darwin | clean |
| `go build ./...` local / `CGO_ENABLED=0 GOOS=linux -tags nogui` / `GOOS=windows -tags nogui` | ok |
| `go test -race` | not run — no gcc on this machine |

Branch with the commit: [hunt50-c-git-plugin-lock](https://github.com/ggbdpq/magpie/tree/hunt50-c-git-plugin-lock) (head `0fd727168197da040ba677f12e1572650d738ec0`).

written with GLM-5.3-Flash (ZCode)
