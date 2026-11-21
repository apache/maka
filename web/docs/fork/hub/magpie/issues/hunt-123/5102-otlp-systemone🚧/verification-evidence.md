# hunt-122 / 5102 OTLP systemone bodies — 测试证据（Lane C, darwin/arm64）

分支 fix/5102-otlp-systemone-bodies，基线 = upstream/main tip 1e1068c86
commit 9593fad231a4bd73a1517ba1ae1428a665adffd0
take: https://github.com/yetone/magpie/issues/5102#issuecomment-6609157268
帖:  https://github.com/yetone/magpie/issues/5102#issuecomment-6609689680

## RED（修复前，测试先写）

```
=== RUN   TestOTelExportsSystemOneBodiesWhenOn
=== RUN   TestOTelExportsSystemOneBodiesWhenOn/off
=== RUN   TestOTelExportsSystemOneBodiesWhenOn/on
    otel_test.go:525: System One bodies missing: client in=false out=false, router in=false out=false
--- FAIL: TestOTelExportsSystemOneBodiesWhenOn (0.13s)
    --- PASS: TestOTelExportsSystemOneBodiesWhenOn/off (0.12s)
    --- FAIL: TestOTelExportsSystemOneBodiesWhenOn/on (0.02s)
FAIL
FAIL	github.com/yetone/magpie/internal/gateway	1.146s
```

## GREEN（修复后）

```
=== RUN   TestOTelExportsSystemOneBodiesWhenOn
=== RUN   TestOTelExportsSystemOneBodiesWhenOn/off
=== RUN   TestOTelExportsSystemOneBodiesWhenOn/on
--- PASS: TestOTelExportsSystemOneBodiesWhenOn (0.45s)
    --- PASS: TestOTelExportsSystemOneBodiesWhenOn/off (0.44s)
    --- PASS: TestOTelExportsSystemOneBodiesWhenOn/on (0.01s)
PASS
ok  	github.com/yetone/magpie/internal/gateway	1.277s
```

## 消融（commit 后回退产品文件 decide.go/decide_group.go 到父提交，测试保留）

```
--- FAIL: TestOTelExportsSystemOneBodiesWhenOn (0.12s)
    --- FAIL: TestOTelExportsSystemOneBodiesWhenOn/on (0.01s)
        otel_test.go:525: System One bodies missing: client in=false out=false, router in=false out=false
FAIL
```
恢复 HEAD 后重跑 → ok（同 GREEN）。

## 矩阵

- `go test -tags nogui -count=1 ./internal/gateway/...` 全量: ok 640.7s（gateway-full-suite.log，EXIT=0）
- `go test -tags nogui ./internal/otlp/... ./internal/usage/...`: ok（11.7s / 26.9s）
- `go test -race -tags nogui -run 'TestOTelExportsSystemOneBodiesWhenOn|TestSystemOne|TestJevPicksTheIntent|TestMixedDecisionGateway'`: ok 2.8s
- 定向预检 `TestSystemOne*|TestJev*|TestMixedDecisionGateway|TestOTelExports*|TestOTelWhole*|TestOTelBatch*`: ok 6.9s
- `gofmt -l`（3 个改动文件）: 空
- `go vet -tags nogui ./internal/gateway/ ./internal/otlp/ ./internal/usage/`: 干净（internal/gui darwin cgo 警告为平台预存，与本单无关）
- `go build ./...`: 成功（ld duplicate-lib 警告为平台预存）
- 已知预存红清单中的用例均不在本次改动面/运行集内，未遇到。

## 排雷记录

- issue c=0、无维护者表态、无 landed（git log -S withBodies 于 decide.go/decide_group.go 无命中）
- open PR #1074（redact/scrub 规则）文件列表不含 decide 路径，无冲突
