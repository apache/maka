Verified https://github.com/skygunner/magpie/commit/1805ff94340887ce329ca5ec2d198c3e80e50671 by cherry-picking it onto upstream/main `63be4771` and ablating the product change on Windows (Go with pinned GOPATH/GOMODCACHE/GOCACHE).

The commit adapts the proposed fix faithfully and extends it where the proposal was weak. `setArrayElem`, `arrayIndex` and the `nest` rework are carried over as-is (same spec: replace at an existing index, append at the length, refuse past-end and non-numeric array paths without writing, missing numeric parents start at index 0, numeric keys under an existing object stay keys, exact-path whole-array replacement untouched). The one rewritten piece is `insertElem`: the proposal located the closing bracket itself, which corrupts appends into JSONC arrays (a comment inside an empty array, a trailing comma, a line comment after the last element — all five of those rows fail against the proposal's code); this version appends at the parsed last element's offset and reuses `nextToken`, keeping comments, trailing commas and CRLF, with no second indexer. Preview consistency holds structurally: `SetJSON` and `PatchJSON` both funnel into the one `setJSONBytes`, and the new `TestJSONSetArrayComments` asserts `bytes.Equal(preview, saved)` per case.

Ablation, `go test -tags nogui -count=1 -run TestJSONSetArray ./internal/edit`, with `internal/edit/json.go` reverted to `63be4771` and the tests kept — the maintainer's repro is the `append_at_the_length` row (`customModels.1` on a one-element array):

```
--- FAIL: TestJSONSetArrayIndex/append_at_the_length (0.01s)
    json_array_set_test.go:127: got:
        {
          "customModels": {
            "1": {
              "model": "other"
            }
          }
        }
```

13 failures: the same 8 of 12 `TestJSONSetArrayIndex` rows the proposal's ablation had (3 append, missing-key, 3 refusals, compact), all 5 `TestJSONSetArrayComments` rows (JSONC), and `TestJSONSetArrayRefusalKeepsAllKeys`. With the fix restored: `ok github.com/yetone/magpie/internal/edit 5.834s` (whole package, `-count=1`).

Attribution, checked in the commit itself: Author `vincent <webmaster@palmit.com.au>`, and the message carries exactly `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Drift and landing: the commit's parent (`b7726551`, the #3020 commit of the same branch) is 486 commits ahead of `63be4771`, but none of them touch `internal/edit/json.go` — its base blob equals the tip's, and the cherry-pick applied cleanly in all three files (docs line auto-merged). Landing needs nothing. Today's main (`e00fbdbb`) still lacks the fix and takes the commit's whole diff clean (`apply --3way --check`).

Siblings: unchanged from the analysis on this issue — no in-repo caller writes numeric keys under arrays today (`droid.go` writes the whole `customModels` array under its exact path, still a wholesale replace); the reader side (`sessions/droid.go` `gjson.ForEach`) is what breaks when the array is mangled, and this fix removes that hazard for both write and preview paths.

Ran here: the RED/GREEN above; `./internal/settings` ok; `gofmt -l` clean on both files; `go vet -tags nogui ./internal/edit` clean. Not run here: `-race` (author ran `-race -count=5` on Linux; this box has no C compiler for cgo), cross-OS vet/build, and real Tuanjie Cowork or any installed agent config. One caveat for reviewers on Windows: `go test ./internal/provider` has 9 failures here, but they are pre-existing on clean `63be4771` (Codex keychain tests needing macOS credential storage, and one test reading the host's git environment); they are unrelated to `internal/edit`.

Thanks for the adaptation, the JSONC hardening, and the co-author credit.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
