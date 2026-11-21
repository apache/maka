# hunt58 Lane H — issue #3152 verification log

Branch: `hunt58-h-3152-whole-float` (worktree /tmp/magpie-r58-h, baseline f5b0157420a4491f6e707b49a8af8e87ea8050a1 = upstream/main)
Commit: `4c03aaacdf0fe0cccab5000e9bdacecc82371f3e`
Author/Committer: `ggbdpq <ggbdpq@gmail.com>` (verified via `git log -1 --format='%an <%ae> / %cn <%ce>'`)
Patch: `0001-gateway-any-model-s-2500.0-in-a-call-s-arguments-rea.patch`, SHA-256 first 16: `49c6f34623b3012f`

## RED (product files back at baseline, tests kept)

```
$ git checkout -- internal/gateway/gateway.go internal/gateway/ir.go internal/gateway/grok_integral.go
$ go test -tags nogui -run 'TestToolSearchWholeFloatLimitGivesCodexIntegers|TestOtherModelsCallsGetCodexIntegers' ./internal/gateway/
--- FAIL: TestOtherModelsCallsGetCodexIntegers (0.28s)
    grok_integral_test.go:671: deltas: yield_time_ms is 2500.0 in {"cmd":"for i in 1 2 3 4 5; do echo $i; sleep 2; done","yield_time_ms":2500.0,"max_output_tokens":4000.0}, want 2500
--- FAIL: TestToolSearchWholeFloatLimitGivesCodexIntegers (0.02s)
    grok_integral_test.go:703: deltas: limit is 8.0 in {"query":"exa web search","limit":8.0}, want 8
FAIL	github.com/yetone/magpie/internal/gateway	1.042s
```

Earlier RED (first ablation round, same assertion shape):

```
--- FAIL: TestOtherModelsCallsGetCodexIntegers (0.12s)
    grok_integral_test.go:672: deltas: yield_time_ms is 2500.0 in {...}, want 2500
--- FAIL: TestToolSearchWholeFloatLimitGivesCodexIntegers (0.03s)
    grok_integral_test.go:703: deltas: limit is 8.0 in {"query":"exa web search","limit":8.0}, want 8
```

## GREEN (change restored)

```
$ git apply --include='internal/gateway/gateway.go' --include='internal/gateway/ir.go' --include='internal/gateway/grok_integral.go' /tmp/h3152-backup.patch
$ go test -tags nogui -run 'TestToolSearchWholeFloatLimitGivesCodexIntegers|TestOtherModelsCallsGetCodexIntegers' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	1.303s
```

## Targeted set (Grok siblings + new tests), incl. plugin parity

```
$ go test -tags nogui -run 'TestWholeNumsAnyCut|TestGrokCallsGiveCodexIntegers$|TestGrokCallsGiveCodexIntegersTranslated|TestGrokCallsGiveIntegersOnEveryProtocol|TestOtherModelsCallsGetCodexIntegers|TestToolSearchWholeFloatLimitGivesCodexIntegers|TestGrokModel|TestGrokPluginCallsGiveCodexIntegers' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	4.819s
```

## Race

```
$ go test -tags nogui -race -count=2 -run '<same targeted set>' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	14.282s
```

## gofmt / vet / builds (exit codes verified via output redirect, not pipes)

```
$ gofmt -l internal/gateway/gateway.go internal/gateway/ir.go internal/gateway/grok_integral.go internal/gateway/grok_integral_test.go   -> no output, exit 0
$ go vet -tags nogui ./...                    -> /tmp/h3152 (host log empty), exit 0
  (host-only pre-existing cgo warning in internal/gui/trayimage_darwin.go:112 -Wenum-conversion, present with the change reverted too)
$ GOOS=linux go vet -tags nogui ./...         -> exit 0, empty log
$ GOOS=windows go vet -tags nogui ./...       -> exit 0, empty log
$ go build -o /tmp/... .                      -> exit 0 (darwin arm64)
$ GOOS=linux go build -tags nogui -o /tmp/... .   -> exit 0
$ GOOS=windows go build -tags nogui -o /tmp/....exe . -> exit 0
```

## Full suite (temp HOME, caches pinned, per docs/subsystems/provider-plugins.md)

```
$ HOME=$(mktemp -d) GOPATH/GOMODCACHE/GOCACHE pinned go test -tags nogui ./...
ok  	github.com/yetone/magpie/internal/gateway	558.431s
FAIL	"github.com/yetone/magpie/internal/agent"      --- FAIL: TestMothX
FAIL	"github.com/yetone/magpie/internal/gui"        --- FAIL: TestProxyCheckSaysAProxyPassedBy
```

Baseline comparison (all five changed files stashed, worktree exactly at f5b015742):

```
$ go test -tags nogui -run 'TestMothX' ./internal/agent/
--- FAIL: TestMothX (0.82s)          -> pre-existing on this machine, not from this change
$ go test -tags nogui -run 'TestProxyCheckSaysAProxyPassedBy' ./internal/gui/
--- FAIL: TestProxyCheckSaysAProxyPassedBy (0.08s)  -> pre-existing, not from this change
$ git stash pop  # change restored, working tree verified back to the 5 files
```

## git am check

```
$ git clone --no-checkout <worktree> /tmp/h3152-amcheck && git checkout -B amcheck f5b015742...
$ git am 0001-gateway-any-model-s-2500.0-in-a-call-s-arguments-rea.patch
git-am-applies: OK, head e05a66c1  (same tree as 4c03aaac; clone head hash differs by committer metadata only)
```

## Deliverable self-check

```
$ grep -c 'Attribution.*AI-written; I' 3152-comment.body.md   -> 1
$ grep -c 'SHA-256 first 16: 49c6f34623b3012f' ...            -> 1
$ grep -c 'Branch with the commit.*hunt58-h-3152-whole-float.*head' ... -> 1
$ grep -c '[一-鿿]' 3152-comment.body.md                       -> 0 (no Chinese)
$ embedded ```patch section diffed against the .patch file     -> identical
```
