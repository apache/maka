# t1-L13 · #6301 PATCH 取证记录（2026-11-13，第 30 单）

## 单号与三查

yetone/magpie#6301「[Bug] Responses WS: interrupt accepted after response.completed loses the completed continuation anchor」（yangfengfan2011，2026-11-12，OPEN，c1：报告者自己的计时归因补充=独立面不属本单域）。

1. **末评**：take=我方 6833688929（2026-11-13）；此前 0 他人评论。
2. **fork 分支**：无 6301 相关（ls-remote grep 零命中）。
3. **收编三查**：`git log --all --grep=6301` 零命中；PR 正文零引用；`internal/gateway/responses_ws.go` 末次提交=b68218f43（报告者所指代码 tip 未动，无方向漂移）。
4. **邻域防重复**：#6163=codex_socket.go 上行 kept socket 面（ping/transport/retry，另一文件另一面）；#5252=mid-reply 断流资源清理（我方 patch 在案，另一面）；#5699=run 生命周期（journal 在案）。三者与终态 interrupt 语义无重叠。

## 处置：PATCH（状态机缺口）

### 机理（对照报告者复现）

`socketTurnWriter.event` 见 `response.completed` 时只置 writer 的 ended/completed，run（`socketTurnRun`）不知终态：`interrupt` 仍按 id 匹配接受→cancel→`turn` 在 `keep` 前因 `ctx.Err()` 返回→completed 回复未 keep→续接 `previous_response_not_found`。=报告者 completed_then_interrupt_before_eof 分支（3/3）。

### 修法（+65 行，2 文件）

`socketTurnRun` 增 `ended` 终态记忆（`finishing()`：completed/incomplete/failed/cancelled/error 五组+warmup 自身 completed 写入成功后）；`interrupt` 拒绝已终结回复（`.failed`）且不 cancel→turn 自然走到 keep→锚点保住；in-flight interrupt 语义不变。

## 验证矩阵（六要素，最终 head 上重跑）

1. **rebase/基线**：POST 鲜度门两度发现 tip 移动（9c33839de→e9e63c6d7→61be687ff；gateway 域仅 2 笔小提交，responses_ws.go/responses_ws_test.go 全程零触碰=方向无漂移）→ 两度 rebase，分支 hunt-20261112-t1-6301 @ 3eb3c0e27613cfe0；patch 字节三次 format-patch 均 fe2adf364659269c（同树不变）。
2. **RED→GREEN**：新测试 TestResponsesSocketInterruptAfterCompleted（复现形状：假上游 flush completed 后 hold 流不关）修前 FAIL（30.12s，client 收 accepted+incomplete=issue 形状），修后绿；定向族 TestResponsesSocket* 11/11 绿（最终 head 复跑 1.193s；含既有 TestResponsesSocketInterrupt=in-flight 语义不变）。
3. **包全量**：最终 head `go test ./internal/gateway -count=1 -timeout 25m` ok 869.438s EXIT=0 零失败（9c33839de 上 1004.394s、e9e63c6d7 上 927.743s 均零失败）。
4. **race**：socket 族 -race ok（最终 head 2.385s）。
5. **消融回红**：先提交再消融；只回退产品文件 responses_ws.go 到父提交、保留测试→红（accepted+incomplete，30.12s）→恢复绿。变异点=语义分叉行（interrupt 接受/拒绝）。
6. **gofmt/vet/build**：gofmt -l 空；vet 清；GOOS=linux/windows build OK（最终 head）；darwin 本机测试即证。
7. **git am 回放**：format-patch -1 --zero-commit → am 于 61be687ff（独立 verify 树，5668 判例不碰全量树）→ Applying 干净，回放树 hash=分支 tip 树 hash（TREES IDENTICAL）→ am 树已清。
8. **兄弟面 rg 全查**：`response.interrupt` 全部客户端判定点在 responses_ws.go（无在飞分支已 .failed 未动；in-turn 分支走本次改的 t.interrupt 唯一共享判定）；codex_socket.go 零 interrupt 面（Left：上行 socket 无此语义）；HTTP 路由无 interrupt 消息形态（Left：HTTP 取消=客户端断连，语义不变）。

## 发布

- push：显式 sha refspec（3eb3c0e27613cfe0:refs/heads/hunt-20261112-t1-6301，rebase 后 --force-with-lease 更新）；ls-remote 比对一致（3eb3c0e27613cfe097ddd7d2fa0f5732bcfcbd32）。
- POST：--body-file；GET 回读字节比对+关键要素 grep（分支链接/sha/sha256-16/Attribution/Generated-by/patch 围栏）。
- patch sha256-16：fe2adf364659269c（产物目录内 patch 文件同 hash）。

## Not verified

- 真实 Codex Desktop×真实 ChatGPT 账号现场（本复现=gateway 测试接缝上的报告者脚本形状，无真实上游）；现场 499 是否落此窗口（报告者自己的边界声明照录）。
- GOOS=linux/windows 仅 build 未跑测试（改动为 darwin 可测 WS 面；上游惯例三平台 build）。

## 不自信点

- `finishing()` 在 error 帧时 id 可能未 note（error 帧 response.id 不走 note）——ended 置位只影响"已 note 过的 id"的 interrupt 拒绝，error 后 run 无 in-flight 可取消语义与修复前一致，不引入新面（已核 event switch：error 分支不 note）。
- 修法未盖 "held socket 跨 turn 后 interrupt 旧 turn id"（旧 turn 终态后 kept 于 rs.turns，其 run 已随 turn 结束；下一 turn 新 run——旧 id interrupt 落"无在飞/不匹配"=failed，与修复前一致，未额外扩展）。
