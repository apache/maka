# #5085(+#5079) rework 复验记录 — fix/5085-keeplast-reread

- take: #5085 issuecomment-6684985298 / #5079 issuecomment-6684985714
- spec 提取：yetone 末评 #5085（issuecomment-6670566623）+ #5079 正文预期 1–3
- 基：upstream/main 6f5d48ea0（工作始于 4ef47b3f4，rebase 一次，am 树校验一致）
- head：9766311e21591676078c78e2e9c6a8317164ecf8（origin ls-remote 比对一致）
- patch：0001-provider-a-careful-re-read-reads-a-saved-Claude-acco.patch，68943 字节，sha256 前16 ce4ada6f811ab9dd
- 帖：#5085 issuecomment-6686442603（PATCH 主帖）；#5079 issuecomment-6686446783（指路短帖）
- 回读：user=ggbdpq；```text 围栏成对；patch 提取 68943 字节与本地逐字节一致；尾注在

## RED→GREEN（miniersliu 配置：两账号、各 90 上限、A=95%、B=30% 未读、careful 开）

| 用例 | main | 修复后 | 消融（reread 子句摘除，字段保留） |
| --- | --- | --- | --- |
| TestCarefulRereadsASavedClaudeAccount（gateway，B 被选） | FAIL：429 every account at its usage cap or its usage unread，B 的 /usage 未跑 | PASS：200，B 真读并接单（claude@backup@example.com） | FAIL：同 main 429 |
| TestReadUsageNowReadsASavedClaudeAccount（provider，ask 触达保存账号） | FAIL：保存账号从未被读 | PASS：own 目录 /usage 跑过、routing 读到新读数 | FAIL：从未被读 |

## 矩阵（rebase 后树 9766311e2 @ 6f5d48ea0）

- go test -tags nogui -count=1 ./internal/gateway/ → ok 696.481s（exit 0，无失败项）
- go test -tags nogui -count=1 ./internal/provider/ → ok 119.875s（exit 0）
- 定向 -race（TestCareful/TestCapStop/TestNearCap/TestReadUsageNowReadsASavedClaudeAccount，双包）→ gateway ok 4.902s + provider ok 2.678s
- gofmt -l 干净；go vet -tags nogui provider/gateway/cli 干净（darwin/arm64 + linux/amd64）；go build -tags nogui 两平台 OK
- git am -3 到 6f5d48ea0 干净落树，tree 971c699b97… 与分支头 tree 一致

## 兄弟面（rg 全查，改/不改均记录于 patch 帖）

- ReadUsageNow 调用：cap_careful.go readCareful（本修对象）/ cap_near.go nearCapAgain（同样语义受益，floor+失败等待限频）；gateway 测试 stand-in 绕过不受影响
- claudeWindows 调用：active 路径（login_usage.go:448、subscription_usage.go:656）不动；saved 路径（login_usage.go:416）仅由 ask 放宽
- 持久化（keepLast/state()/lastAllowances/hadReading）：不动——kept reading 仍计 failed（fail-closed 不变）；ask 被答后 hand-over 窗口缩短为一次 ask
- readAsked 只被 claudeWindows 消费；其余 agent 仅记录、无行为变化

## 事故与续作

- 一次 provider 死亡中断：复活后按幂等续作（diff 回读→补缺口），未重做已完成工作
- 第一版 gateway 测试用 me/spare@example.com 且文件排序在 cap_near_test.go 之前，残留 usedCache["claude"] 使 TestNearCapClaudeAccountsTakeOneTurnEach（-race）读到 95% 而非 89%——改为独立用户名 primary/backup@example.com 并将文件重命名为 careful_saved_claude_test.go（排序在其后）；重跑 -race 与全量均绿
- readAsked 采用 take-on-sight（一次 sighting 即取走），消除对后续测试/调用方的 ask 残留

## Not verified（帖内首位）

- 真机双账号 Claude 订阅未复现现场 429（fake claude CLI 代替 Claude Code 的 prompt 与 /usage 运行）
- 路由页文案（「已用 30%，超过 90% 上限」矛盾文案与 unread 英文原因混排）按维护者指路拆出，另发补丁，不在本 patch
- #5079 预期 3（unread 429 的 Retry-After 缩至 carefulRetry）不在本 patch，帖内已注明
