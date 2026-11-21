<!-- Draft follow-up for yetone/magpie#2707. NOT posted. Per the alignment review (docs/issues/review-2026-10-18/2707-guard-alignment.md), this is delivered AFTER the revised hunt39-c lands (option b): post it in this issue as a follow-up, rebased on the landed state, with the two integration adjustments below already applied. Scope: the encoded-upload pre-check only; the too-large 422 surface is hunt39-c's (reviewed as Good). -->

One more half for this issue, complementary to the compression patch: a pre-upload size check, so what compression cannot shrink is refused locally instead of failing mid-upload.

**The gap this closes.** Compression (hunt39-c) makes a typical library fit, and its revised wording won't promise that every library does. What is left over is the class your own review flagged: an incompressible ~32 MiB library still seals to about 45 MB and a ~60 MB request body, and GitHub's real threshold sits undocumented somewhere below the known rejections. Today such a body is uploaded first and refused after — tens of megabytes sent to learn the answer. A 48 MiB pre-check (encoded: exactly 64 MiB) turns that into a local refusal before any bytes are sent.

**What I changed.**

- `commit` in `internal/davsync/github.go` refuses a backup over `githubMaxUpload` (48 MiB raw; the Contents API receives the file Base64-encoded, so the encoded request stays within what magpie reads back). The refusal says the file's size, the mechanism, that GitHub's exact threshold is undocumented, and the ways out: sync less (for example without the library), keep a backup this size on WebDAV or S3, or update it in a local clone and push. Nothing promises the upload would fit — the wording follows your third revision point.
- Read side, WebDAV and S3 are untouched: `githubMaxFile` keeps governing reads (blob GET is fine at 64 MiB raw), and those backends have no documented upload limit for a guard to mirror.
- `docs/reference.md` and `docs/subsystems/sync-backup.md` state the 48 MiB commit cap with the ways out, no numbers promised beyond it.

**Integration with hunt39-c** (checked by applying this on `95c253e7`):

- `github.go` and `github_test.go` apply cleanly next to the 422 branch; the two halves don't overlap in code.
- Two adjustments are needed, and this draft already carries them: your `TestGitHubFailures` "file too large for GitHub's API" subtest feeds `63 MiB`, which the pre-check now refuses before the upload — its fixture has to drop under the cap (or the subtest keeps only the below-cap case, since the 422 text stays reachable at smaller sizes); and the "Large files..." bullet in `docs/subsystems/sync-backup.md` is edited by both patches, so whoever lands second rebases that one bullet.

**Red without the fix** (base `d783df46`, current main; with `internal/davsync/github.go` reverted and the test kept):

```
--- FAIL: TestGitHubUploadOverTheEncodedLimit (0.37s)
    github_test.go:577: a backup GitHub would refuse must be stopped before upload: <nil>, writes 1
```

(the reporter's 57,333,552-byte backup passes the raw 64 MiB guard and reaches the upload). With the fix the test passes, `go test -tags nogui -count=1 ./internal/davsync` is `ok` (30.5s), the CLI GitHub/WebDAV/S3 command tests are `ok`, gofmt is clean, and `go vet -tags nogui` passes on darwin, linux and windows. Breaking it by hand is the same revert — the guard is one file.

**Honest limits.** 48 MiB is our number, not GitHub's: no acceptance data point above 10 MB of raw file exists anywhere, so the cap trades a chance of success for determinism — a file GitHub would have taken may now be refused here, with the explanation instead. If the compression patch never lands, this guard still stands alone: the reporter's case becomes a local refusal with the ways out instead of a bare 422 after a 76 MB request. Nothing here was run against the real GitHub API (your request; the reporter's uploads are the live evidence).

**AI**: written with GLM-5.3-Flash (ZCode); I've read the whole diff and can answer questions on it myself.
