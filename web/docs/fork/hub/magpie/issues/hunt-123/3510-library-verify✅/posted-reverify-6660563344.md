Re-verified against the current main (`326e72f4c`, 2210 commits past the original delivery). Upstream hasn't picked this up: no commit mentioning #3510, nothing on this face in the recent `projects.go` history, and `RemoveProject` still hands a gone folder to `syncProject`, which says "the folder is gone" and leaves the records as they were — the entry still can't come off. The rebased commit (`918906a6a`) applied cleanly (the product hunk at a 12-line offset) and the change itself is unchanged.

| Check | Result |
| --- | --- |
| Red on clean main, test only (ablation: the test kept, the product change off) | `--- FAIL: TestRemoveProjectWhoseFolderIsGone` — `the removal said: [... Error:the folder is gone]`, the entry stays with its `Placed` list (now `.agents/skills/pdf` + `.claude/skills/pdf`: the project-skills work added agents, not a way out) |
| Green with the patch | `go test -tags nogui -count=1 -run 'TestRemoveProjectWhoseFolderIsGone' ./internal/library/` — `--- PASS` |
| Same-file neighbors | all 20 `TestProject*` / `TestRemoveSkill*` in `projects_test.go` pass on the rebased tree |
| Full library package | `go test -tags nogui -count=1 ./internal/library/` — ok 75.2s |
| Format, vet, builds | `gofmt -l` clean; `go vet -tags nogui ./internal/library/` clean; `go build -tags nogui ./...` (darwin) and `GOOS=linux` / `GOOS=windows` builds of `./internal/library/` ok — the darwin cgo warnings from `internal/gui` are there before the change |

Not run: the full `./...` suite, `-race`, and a GUI round (unchanged scope from the original delivery and the last re-verification).

Branch with the commit: [hunt79-g-3510](https://github.com/ggbdpq/magpie/tree/hunt79-g-3510) (head `918906a6a`, parent = `326e72f4c`); the patch in the first comment still applies with `git am` as is.

**Attribution**: AI-written; I've reviewed the rebased diff and the tests pass.

Generated-by: GLM-5.3-Flash (ZCode)

