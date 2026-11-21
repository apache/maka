# #2576 接单纪要（hunt35 / C 路 pr3 / macOS）

- **Issue**：[yetone/magpie#2576](https://github.com/yetone/magpie/issues/2576)（cyancity，2026-10-16，推理路由组缺省 effort 降级 + /v1/models 元数据不合 Catwalk 惯例，附别名容错第③点）
- **claim**：[issuecomment-6223761173](https://github.com/yetone/magpie/issues/2576#issuecomment-6223761173)
- **交付**：patch 评论 [issuecomment-6223960355](https://github.com/yetone/magpie/issues/2576#issuecomment-6223960355)；分支 [`hunt/2576-models-metadata`](https://github.com/ggbdpq/magpie/tree/hunt/2576-models-metadata) @ `74dde581`（基线 upstream/main a69cd070）
- **同域避让核对**：#2579（drawerObjects/videomakerObjects，gateway.go:938-980）、#2530（provider/codex_models.go）均不碰 `modelObject`（gateway.go:828-868），diff 无冲突；发帖前复查评论 1 条（仅自己 claim）、upstream 增量仅 #2622（MCP 工具形状，不同域）

## 判定

| 半 | 判定 | 形态 |
| --- | --- | --- |
| ① 缺省 effort 降级 | 声明的设计（缺省不注入、auto 分类器只在客户端显式请求推理时跑） | 定性分析，不动码 |
| ② /v1/models 元数据 | Catwalk 生态读扁平 `reasoning_levels`，magpie 只发对象数组 | TDD patch（纯增量） |
| ③ thinking/enable_thinking 别名 | 现状是剥离不解析；归一化映射目标是产品决策 | 分析，交维护者 |

## 机制链证据（半①，文件:行）

1. `internal/gateway/chat.go:80-88` `parseChat`：客户端没带 `reasoning_effort` → `Effort==""`、`Thinking==false`、`ThinkOff==false`。
2. `internal/gateway/chat.go:497-498` `chatBody`：只在 `r.Effort != ""` 时发 `reasoning_effort` 键——缺省**不注入任何键**，无主动降级；「非思考」是上游默认（DeepSeek chat 端点）。
3. `internal/gateway/rules.go:258-264` `ruleFor`：`effort := g.Effort == provider.EffortAuto && hit.Effort != "" && !req.ThinkOff`——缺省时 `hit.Effort==""`，auto 组分类器不跑；注释双声明（"a turn the agent asked to reason in"），`internal/provider/group.go:195-198` 同义（"where the agent asked for some"）。#2247 修复（`8ef14be3e`，none 不白咨询分类器）用同一道门。
4. 组 effort 取值仅 `auto`/跟随 agent（`internal/provider/group.go:1141-1147`），无「组固定档位」或网关级缺省——改「缺省=默认思考」是宽行为面产品变更（所有无 effort 客户端费用/延迟上移），交维护者。
5. 反向闭环：半②修好后 Catwalk 类客户端会保留并发送 `reasoning_effort`，报告者场景直接恢复思考，兜底不再必需。

## 对照证据（半②，外部源码）

- `charm.land/catwalk` `pkg/catwalk/provider.go:100-102`：`CanReason bool json:"can_reason"`、`ReasoningLevels []string json:"reasoning_levels"`、`DefaultReasoningEffort string json:"default_reasoning_effort"`。
- Crush `internal/config/reasoning_effort_test.go`：`ReasoningLevels` 空的模型拒绝任何 effort（"model without reasoning levels rejects any effort"）——报告者「视为空→剔除」的机制。
- Crush `internal/discover/discover.go:141` `DiscoverModels`：通用 discovery 只解析 `id/object/created/owned_by`，**不读** reasoning 字段——patch 对该通道不生效（帖中已诚实声明）；生效面是读字段的框架与手动配置校验路径。

## patch 内容

- `internal/gateway/gateway.go` `modelObject`：补 `reasoning_levels` 扁平数组（`e.Efforts` 原样含 `none`——DeepSeek 在 `reasoningOffProviders`，catalog.go:335-340，#1098 验证过接受 none），`make` 保证空档位输出 `[]` 非 null；`supported_reasoning_levels` 等既有字段零改动。`default_reasoning_effort` 不补（`provider.Entry`（models.go:2242）无默认档位数据源，编造=说谎，帖中说明）。
- `internal/gateway/gateway_test.go` `TestModelsListFlatReasoningLevels`：红→绿；断言三模型扁平序与对象序一致、对象数组保留、toggle-only 模型空数组非 null。
- 消费方安全：magpie 自家 `catalog/live.go:727 levelsOf` 本就兼容对象/扁平两形状；desktopModels 复用 modelObject 但 Desktop 忽略未知字段。

## 验证矩阵（真实结果）

| 检查 | 结果 |
| --- | --- |
| 新测试修前 | 红：4 处 `reasoning_levels <nil>` |
| 新测试修后 + TestModelsListReasoning | 绿 |
| `go test -tags nogui -p 2 -count=1 ./internal/gateway/` | ok（329s） |
| `go test -tags nogui -p 2 -count=1 ./internal/catalog/` | ok |
| `gofmt -l` 改动文件 | 干净 |
| linux/amd64 + windows/amd64 + darwin/arm64 `go vet -tags nogui` | 全过 |
| `go build -tags nogui .` + `--version` | 成功（预存 cgo 警告） |

没跑：真机 Crush/Catwalk 端到端（本机无）；`-race`（纯 JSON 组装无并发面）。macOS 本机 go 1.25 工具链 + GOTOOLCHAIN=auto。

## 本轮不自信的点

1. **patch 生效面有边界**：Crush 通用 DiscoverModels 不读 reasoning 字段，patch 只救「读字段的框架」——报告者的具体客户端读不读、读哪几个字段，只有它能证实；帖中已给对照源码与限定。
2. `default_reasoning_effort` 弃补是「无数据源不编造」的判断，若维护者认为应从 models.dev 或用户设置取默认档位，patch 需要返工加数据链。
3. toggle-only 模型（`reasoning:false`+空档位，如测试里的 thinker）在 magpie 输出里 `reasoning:false`——models.dev 未标 reasoning 的 toggle 型模型是否该算推理模型，考证中注意到但未展开（非本单诉求）。
4. upstream 发稿后又前进一个提交（72d6103e，#2622），与 patch 区域无交集，预计 git am 无冲突，但未在最新基线重跑全量（新测试与 gateway 全量在 a69cd070 基线绿）。
