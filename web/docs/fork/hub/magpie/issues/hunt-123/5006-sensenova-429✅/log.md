# 5006-sensenova-429 发布记录（Lane B，2026-11-04）

## 结局：完成发布

- issue: yetone/magpie#5006（hzyqn，OPEN，0 评论/0 竞品 PR/0 先行修复，让位闸通过）
- take: https://github.com/yetone/magpie/issues/5006#issuecomment-6616233581
- 发布帖: https://github.com/yetone/magpie/issues/5006#issuecomment-6616562606（GET 回读八要素全中，10250 字节未截断）
- 分支: fix/5006-sensenova-429（基于 upstream/main tip d8b3749ef），fork=origin 已 push，ls-remote 核对一致
- head: a2b76e64f281dff3797d0f6234c066321fb1b4b1
- patch SHA-256 前 16: 4efce5a8945bba00（git am 格式副本在本目录）

## 根因（已证）

同一文案两判定的分叉点 = 分类输入不同：
1. 原始 body 路径（restAfterMarked 全系）：商汤 token-plan 网关 429 body 是 OpenAI 形状 `code=insufficient_quota` + `type=rate_limit_error` + message `inference exceeds tpm/rpm limit`。failure() 的 `bytes.Contains(body,"insufficient_quota")` 无状态门槛直判 credit（credit case 在 minuteLimit 之前），rest=creditRest 30min by=credit——与 24 条 glm-5.2 记录逐项吻合（until−触发 1800.3~1804.8s）。
2. 文案路径（gateway.go:4720 最后一候选 booking 用 call.Error 归一化文案，无 code/type 字段）→ minuteWords 命中 → failRate。
3. per-model 分布（deepseek 910/0，glm 123/24）= glm 上游池网关才写该 code；此条靠公开信源+计数推断，报告者无原始 body 无法钉死（帖中 Not verified 已声明）。

## 修法（routing.go 两触点）

- credit case 第三操作数加 `&& !minuteRate(body)`：insufficient_quota 串遇词面明说每分钟限流时让位。
- 429 minute case 改用 minuteRate（= 原 minuteLimit 去掉其不可达的 insufficient_quota bar），两条输入路径判定归一。
- 保真面：OpenAI 真 credit（消息无 rate 词）/商汤 1113 余额不足/WorkBuddy credits exhausted 保持 credit；Gemini/Azure 每分钟配额体保持 rate。

## 验证证据

- RED：TestRateLimitIsNotQuota 新行（原始 body 形状）`credit, want rate`；消融（routing.go 回退父提交留测试）复红；恢复复绿。
- 全量 `go test -tags nogui -timeout 25m ./internal/gateway/...` ok（623.115s，机器上有并行车道路载测试占 CPU，仍零失败；lane 预存红清单全部未出现）。
- race（定向四族）ok；gofmt 净（测试文件曾不合格式已 -w）；vet 净；`go build ./...` ok（仅 internal/gui 预存 darwin cgo 警告）。
- 兄弟面 rg 全查：树上 18 处 insufficient_quota 夹具消息全无 minuteWords，判定零翻转；minuteRate 对无 code 的 body 是 minuteLimit 严格超集。
- 热路径：仅失败 body 分类路径多一次正则求值，成功路径零触碰。

## 外部信源（帖内已引）

- https://deepshplugins.com/plugins/dsh-autoresume（429 形状 code=insufficient_quota/type=rate_limit_error）
- https://github.com/Phoeky/st-rotator/blob/main/README.md（token.sensenova.cn 429 body 统一格式）
- https://blog.csdn.net/user_admin_god/article/details/166370632（网关 OpenAI 兼容）

## 后续线索

- gateway.go:4720 用归一化文案做最后候选 booking、与原始 body 路径输入不同源——本单通过词表归一双路径一致，但"OpenAI 真 credit 经文案路径判成 quota"类的其它交叉形状仍在（与本单不同族可再开单）。
- DashScope 的 insufficient_quota 形 TPS 限流（消息无 rate 词）目前仅 dashScopeRate 按 provider 豁免，provider 无关的通用修法未做。
