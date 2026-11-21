# hunt24 B 路：嵌套组的 Affinity 从未被读（#2259 交付）

- **接单**：B 路（gateway 与昨夜新报告兄弟面）独立挖到「嵌套组 Affinity 无消费点」，与 #2246（firstToken，91c4705e）/ #2255（Sink，7a3fed6b）同族。发帖前查重发现 **#2259 已存在**——维护者 yetone 自己于 2026-10-14 立的兄弟单（To do：语义裁决 / apply or hide / 修前红测试），0 评论无人接。按占坑家族规则不另开新 issue，转为**在 #2259 评论交付**已验证的 patch。
- **根因**：`internal/gateway/gateway.go` 的 scope/mode 只从点名组取（`group/<gid>` + `g.Affinity`）；`internal/provider/group.go` 的 `Group.Affinity` 对嵌套组在 `provider.go:1050` 校验、GUI 组卡可设（client.js:3484/4582），但 gateway 侧零消费点。`strictKeep`（affinity.go:270）的门只看点名组 mode，内层 strict 的会话被 cap 撇下时也不带回。
- **修法**：candidate 携带 `innerAffinity(m)`（m.Via 链最内层设置 Affinity 的组，同构 #2246 的 `innerFirstToken`）；`affine` 在找到上次回答者 `at` 后以其携带值为 mode（回落点名组）；`strictKeep` 的门扩为「点名组 strict，或被撇下的回答者自己的内层组 strict」。scope 保持点名组（跨入口粘性共享；「its own scope」方案会把同一会话经外/内两个入口的 sticky 断成两键）。
- **TDD**：`TestNestedGroupStrictAffinity`——修前（37fec124）`200 …from k2… tried k1,k2`（漂移）；修后 `429 tried k1`，`Affinity.Why=strict`。消融（stash 两个产品文件）回红同形。
- **验证矩阵**：定向回归 ok；`go test -tags nogui -count=1 -p 2 ./internal/gateway` ok（301s，sandbox HOME）；gofmt 干净；darwin/linux/windows 三平台 `go vet -tags nogui` 干净；三平台 `go build -tags nogui` 过。没跑：全仓 `go test ./...`（改动仅在 gateway+docs）；off/session/turn 内层值未逐个端到端；内层 turn × 外层 rotate 组合未测。
- **交付**：commit `7112fe69`（作者 ggbdpq），fork 分支 `hunt24-b-nested-group-affinity`，patch 在 `magpie-hunt-issues/hunt24/b-nested-group-affinity.patch`，评论 https://github.com/yetone/magpie/issues/2259#issuecomment-6192487741（远程渲染核验：details 1/1、围栏配对、表格无行间断裂）。
- **结局**：（事后追加）
