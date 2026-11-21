# 4282 body-size-limit — AJ2 收尾验证记录（2026-11-05）

起点：AJ 车道遗留 fbaa56239（工作树干净，未推送未发帖）。

## 探针发现与修复（amend）

静态读数发现规格第 4 条缺口：serve 循环的 413 换手块（gateway.go `withRoom(cands[i+1:], ...)`）对任意 413 生效，本地拒 413 会把同一超大 body 交给 fallback 供应商。经验复现（两 provider，`Fallback: ["fake2/m1"]` 成员路径布线；裸 ID 布线不进候选链，第一版探针无效）：

- 对照（供应商 413）：upA 1 次 → upB 1 次 → 最终 200（既有换手行为）
- 本地 body-limit 拒（修前）：upA 0 次（好）但 **upB 被问 1 次，最终 200** ← 缺口实证
- rest 无副作用：拒后小请求直出 A（upA 200），A 未被 rest

修复（`restrictedSaid` 先例：magpie 自家措辞、无 vendor 会说）：

- `body_limit.go`：消息短语提为 `bodyLimitWords` 常量（消息与匹配共用，防漂移）+ `bodyLimitSaid(body)` 匹配器
- `gateway.go` serve 413 块条件加 `!bodyLimitSaid(hw.errBody())` + 注释两句
- 新测试 `TestBodyLimitRefusalNotHandedOver`（两 provider，断言 fallback 0 次调用）

红绿证据：
- 修前（fbaa56239 + 新测试）：`answered 200` FAIL（fallback 接手）
- gate 单独摘除（消融恢复 checkout 误抹 gateway.go 后复跑）：同样 `answered 200` FAIL——gate 单独消融即红
- 修复后：8/8 绿

## 矩阵（最终树 c45499dd0，rebase 上游 7 提交后）

- 精确名 8 个：TestBodyLimitRefusedUnsent / TestBodyLimitOffByDefault / TestBodyLimitCountsTheBodyAsSent / TestBodyLimitRefusalNotHandedOver / TestBodyLimitNormalize / TestSetBodyLimit / TestBodyLimitCmd / TestSaveKeepsBodyLimit — 4 包全绿（targeted-green.log）
- `go test -tags nogui -count=1 -timeout 25m ./internal/gateway/`：ok 705.990s，0 FAIL，EXIT=0（full-gateway.log；rebase 前旧树也全量绿过一次 835.595s）
- gofmt -l（触达文件与四包目录）：干净；go vet gateway+provider+cli：干净
- 消融回红：产品文件整体撤到 fbaa56239^ → 新测试 build failed（`undefined: bodyLimitCmd` / `undefined: provider.SetBodyLimit` / `BodyLimit undefined`）→ 恢复复绿
- rebase upstream/main（c3ba2cc93→e0ee9265e，7 提交）无冲突
- push origin → ls-remote `c45499dd0ceb952b71a4a5a135bcd0c46f98c866` = 本地 HEAD

## 规格四条核对（kylefu8）

1. 可选/默认关/按 provider：`BodyLimit int json:"bodyLimit,omitempty"`，0=关；CLI `magpie provider body-limit <id>`（bytes/kb/kib/mb/mib/gib/off，上限 1 GiB）；normalize 夹取。✓
2. 检查点=插件/路由/协议转换后实际发送 body：`forwardOnce` 内、`provider.SetBody(req, body)` 正前方（发送点）；`TestBodyLimitCountsTheBodyAsSent` 证明计的是转换后变大的一方（Anthropic→Chat）。✓
3. 计量层写明：交给 transport 的原始 body 明文字节，zstd（Codex wire 压缩，SetBody 内部）之前——偏大偏安全一侧。✓
4. 超限本地拒/不发送/不截断/不重试/不切换：forwardOnce 原地合成 413 request_too_large（带 size+limit+设置处）；upstream 0 次调用有断言；body 不动；refitOverCap 被 mark 挡住；fallback 换手被 `bodyLimitSaid` 挡住（本修复）；provider 不因它 rest。✓（第 4 条切换面为本次 amend 补齐）

## 产物

- 分支 fix/4282-body-size-limit @ c45499dd0ceb952b71a4a5a135bcd0c46f98c866（ggbdpq/magpie）
- patch 存档 4282-body-size-limit.patch，sha256 前 16 = 6d61e95552e83194（30,377 字节）
- 帖子 /tmp/mg123-aj2-post.md → gh issue comment 4282
