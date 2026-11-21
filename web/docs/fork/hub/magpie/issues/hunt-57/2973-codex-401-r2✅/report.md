# #2973 rebase onto f5b01574 — 最终报告（hunt57-r1）

日期：2026-10-21。工作树 `/tmp/magpie-h81`，分支 `hunt57-r1-codex-401`。未 push、未发帖、未碰主 clone、未动其他 /tmp/magpie-h*。

## 结果

- **新 head：`24abb504`**（单提交，父 `f5b01574`=upstream/main），commit message 原样保留（含 `Generated-by: GLM-5.3-Flash (ZCode)`），+311/-12、7 文件，与原提交同形。
- patch：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt57/2973-codex-401-r2/0001-provider-a-401-that-says-the-token-expired-refreshes.patch`，SHA-256 前 16 = `815a33209c6ba4e4`。
- 英文回帖草稿：同目录 `comment.md`（零中文正文；patch 围栏内含仓库 docs 自带中文引文 4 行，属 patch 原文必需）。
- 全量测试落盘：同目录 `full-gateway.log`、`full-provider.log`。

## 假设 ①②③ 结论

- **① 代码自动合并语义不变：成立。** `git log e4ac5e87..f5b01574 -- <我方 4 个代码/测试文件>` 为空——base 到新 main 之间没有任何提交触及我方文件；依赖符号（`savedLoginToken`/`renewSavedLogin`/`RevokedAccount`/`codexToken`/`codexMu`）未被上游改动（`1bd99194` 对 `logins.go` 的改动只新增 `SignedOut()`、`claudeStandIn`→`claudeListed`）。cherry-pick 时代码 4 文件全自动合并。
- **② `1bd99194` 不覆盖我方修法：成立。** 其改动在 Claude 已登出列表链（`claudeStandIn`/`claudeListed`/`Provider.SignedOut`，cli/tui 展示），与 401→force 刷新判定链（`noteSignIn`→`SignInRevoked`/`SignInRefreshable`→`codexToken`）无交集；`git show 1bd99194 -- <我方文件>` 输出为空；`git log --grep '#2973' upstream/main` 为空、upstream 无 `signin_expired.go` → 401 措辞仍无人处理，**不让位**（RED 实证见下）。
- **③ docs 冲突解法：同预期。** 冲突仅 `docs/subsystems/providers-accounts.md` 一处：上游把「Saved accounts」行加长（Claude signed-out 文案），我方新行「A refreshable sign-in」插在其前。解法=保留上游加长行全文 + 插入我方行（与原提交字节级一致，cmp 验证），删除我方侧旧版 Saved accounts 行。`gateway-routing.md` 自动合并，我方 bullet 落在 revoked bullet 之后（132 行），上下文核对无误。

## RED（base `f5b01574`，零行为桥接后）

桥接：`signin_expired_stub_red.go` 仅 `SignInRefreshable` 恒 false（只为编译，已删）。

- gateway：`--- FAIL: TestCodexExpired401RefreshesLogin (0.35s)` / `codex_refresh_401_test.go:104: the vendor said the token expired and asked for a refresh: the sign-in was renewed 0 times, want once`（`TestCodexOther401DoesntRefresh` 在 base 上 PASS——无修法时零刷新，符合预期）
- provider 词表：`--- FAIL: TestSignInRefreshableWords (0.00s)`，3 行 `false, want true`（两条 401 expired 措辞 + `token_expired` code）

## GREEN（`24abb504`）

- `TestSignInRefreshableWords` ok；`TestCodexExpired401RefreshesLogin`/`TestCodexOther401DoesntRefresh` 均 PASS。
- `TestRevoked` 家族双包 ok（#1793 路径未被波及；`noteSignIn` 中 revoked 仍先于 refreshable 派发）。

## 消融

短路 `noteSignIn` 的 refreshable case（`&& false`）：`TestCodexExpired401RefreshesLogin` 复红，原文同上「renewed 0 times, want once」；`TestCodexOther401DoesntRefresh` 保持 PASS。`git checkout -- internal/gateway/signin_revoked.go`（恢复到提交内版本）后定向复绿 ok。

## Watched 三查

- (a) 打破→回红→还原：消融已覆盖（见上）。
- (b) `rg -n 'force|Force|401' internal/provider/signin_expired.go internal/gateway/signin_revoked.go`：判定链上无新上游改动需调和（两文件上游零触及；命中全为我方注释/既有 revoked 代码）。`SignInRevoked` 位于 signin_revoked.go:44，词表测试绿。
- (c) 非 401 行为不变：词表 403/500/429 行 false 绿；`TestCodexOther401DoesntRefresh`（非过期 401 零刷新）绿；`TestRevoked` 家族双包绿。

## 矩阵（GOTOOLCHAIN=auto）

| 项 | 结果 |
| --- | --- |
| 定向（两 401 测试 + 词表） | ok |
| race 定向（gateway 两 401 测试、provider 词表） | ok（2.1s/2.1s） |
| gofmt -l（触达的 5 个 .go 文件） | 空（注：.md 不喂 gofmt，首轮误喂报错已纠正重跑） |
| go vet ./...（darwin） | exit 0（internal/gui 一条 cgo 预存 warning，不致非零） |
| GOOS=linux vet -tags nogui / GOOS=windows vet | 均 exit 0 |
| build darwin / windows / linux-nogui | 均 ok（darwin ld 版本 warning 为工具链噪声） |
| `go test -p 1 -timeout 30m ./internal/gateway/` 全量 | **ok 345.384s**，exit 0，未超时 |
| `go test -p 1 -timeout 30m ./internal/provider/` 全量 | **ok 85.595s**，exit 0，未超时 |

## 不确定项

- 未对真实 ChatGPT 后端复现（与原帖同，匹配词取自报告引文）；`pro`→`promax` 升级是否为令牌退役原因未验证（修法对其无关）；macOS keychain 路径仅由既有 store 测试间接覆盖（新测试走文件存储）。
- 回帖模板中的分支链接仍指 fork 上 `hunt48-c-codex-401-refresh`（head `24abb504`）——**该 head 目前只在本地，发帖前需把 `hunt57-r1-codex-401` 推到该分支名**（本次按禁令未推送）。
- shell 每条命令前的 `_encode/_decode` 报错为 zsh 配置噪声，与命令执行无关（所引命令均以实际输出与退出码判定）。
