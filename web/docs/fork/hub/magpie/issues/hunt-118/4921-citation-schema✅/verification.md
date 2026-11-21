# #4921 验证留档（车道 B，2026-11-02）

分支 `fix/4921-citation-schema`（基 a3768cdd1，head 57dc7b420），worktree /tmp/mg118-b（发布后已删）。

## RED（修前，基线树）

```
go test -tags nogui -count=1 -run 'TestWholeAsStreamDropsCitationsWithoutOffsets|TestCodexOwnModelDropsCitationsWithoutOffsets|TestCodexInputScanSeesCitationsWithoutOffsets' ./internal/gateway/
--- FAIL: TestCodexOwnModelDropsCitationsWithoutOffsets — the citation without its offsets went to the backend
--- FAIL: TestCodexInputScanSeesCitationsWithoutOffsets — the scan missed a citation without its offsets
--- FAIL: TestWholeAsStreamDropsCitationsWithoutOffsets — the citation without its offsets went out（annotation.added/content_part.done/output_item.done/response.completed 四出口全带 site_name/publish_time）
```

## 消融回红（先提交，产品文件回退基线，测试保持，树可编译）

```
git checkout a3768cdd1 -- internal/gateway/codex_backend.go internal/gateway/whole_stream.go internal/gateway/codex_rewrite_scan_test.go
（codex_rewrite_scan_test.go 的 wasCodexInputAs 耦合新 helper，须一并回退才可编译）
→ 三红同上；git checkout HEAD -- 恢复
```

## GREEN + 定向家族

```
go test -tags nogui -count=1 -run 'TestWholeAsStreamDropsCitationsWithoutOffsets|TestCodexOwnModelDropsCitationsWithoutOffsets|TestCodexInputScanSeesCitationsWithoutOffsets|TestWholeAsStreamResponsesCitations|TestCodexRewritesAsBefore|TestCodexRewritesLeaveTurnUndecoded|TestQuietWhole' ./internal/gateway/
ok  github.com/yetone/magpie/internal/gateway  2.350s
```

## gateway 全量

| 树 | 命令 | 结果 |
|---|---|---|
| fixed (57dc7b420) | `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/` | FAIL×1：TestCodexPoolSaysTheClientsVersion（591.322s，无超时 panic） |
| 基线 a3768cdd1（一次性 worktree） | 同上 | FAIL×1：同一测试同一断言（UA 0.161.0 被改写成 0.165.0）——**预存实锤** |
| 两树单跑该测试 | `-run 'TestCodexPoolSaysTheClientsVersion'` | 均 ok |

定性：`provider/codex_models.go codexVersion()` 读本机 codex CLI + models_cache.json（10 分钟缓存 codexVersionCache），全量跑时被其它测试预热缓存→钉死 0.161.0 的断言读到宿主机 0.165.0。handbook C3/C5 宿主环境病，与本次 diff（annotations 面）零交集。首跑 600.569s 另有 `panic: test timed out after 10m0s`（默认超时，非 25m，掐死在 TestDSMLBlockClosedWithCalls）。

## vet / build / format

```
go vet ./internal/gateway/ && GOOS=linux go vet ./internal/gateway/ && GOOS=windows go vet ./internal/gateway/   # 三平台 clean
go vet ./...   # darwin：预存 gui cgo enum-conversion 警告；linux：wails v3 模块 undefined: pointer（上游依赖）；均不在本 diff
go build -tags nogui .           # darwin ok 94M
GOOS=linux go build -tags nogui .    # ok 80M
GOOS=windows go build -tags nogui .  # ok 80M exe
gofmt -l internal/gateway/*.go   # 空
```

race：未跑——本次无并发改动（无新 goroutine/共享态），不相称。

## git am 实证

```
一次性 worktree @ a3768cdd1 → git am 0001-*.patch → Applying ok
am tree  4629d7629c7afb17e1ce8be2766cc49d7fa147d9
main tree 4629d7629c7afb17e1ce8be2766cc49d7fa147d9 （一致）
```

## 发布

- patch: 0001-fix-gateway-drop-a-relayed-citation-whose-offsets-th.patch，SHA-256 前 16 = 88463b3c761673a2
- push origin fix/4921-citation-schema → ls-remote = 57dc7b42051954a9801ed4846357e715dbf10e25 ✓
- 帖: https://github.com/yetone/magpie/issues/4921#issuecomment-6580736075 （take: #issuecomment-6579595765）
- 回读: len=23481（与本地一致），SHA/AI-written/Co-authored/branch/head/patch From 全命中，author=ggbdpq ✓
- POST 前门禁: fetch upstream（a3768cdd1..upstream/main 空，无新提交）、log grep 4921/citation/annotation/start_index 无、评论区仅本车道 take，无撞车 ✓
