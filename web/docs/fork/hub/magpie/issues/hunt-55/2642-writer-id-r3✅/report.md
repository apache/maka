# 2642 writer-id r3 rebase 报告（基 0f044e94）

日期：2026-10-21。工作树 `/tmp/magpie-h62`（分支 `hunt55-r2-writer-id`）。未推送、未发帖、主 clone 未动。

## 结果

- 新 head：`ea43d94e1f15a91fc954b1bc73bc7ab60fd83116`（前 9：`ea43d94e1`），基 `0f044e94` = upstream/main。
- cherry-pick `93cad8b9`（r2 patch），commit message/作者/日期逐字节不变（`diff <(git log -1 --format=%B 93cad8b9) <(git log -1 --format=%B HEAD)` 为空，author `ggbdpq <ggbdpq@gmail.com>`，AuthorDate Mon Oct 19 00:35:11 2026 +0800）。
- patch：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt55/2642-writer-id-r3/2642-writer-id-stable-id-r3.patch`，40396 字节，6 文件（+175 −20）。SHA-256 前 16：`60277305e623cba3`（完整 `60277305e623cba32d0b9f26740ef6127558e9a82787874c8fe5566fe243c402`）。
- 英文回帖草稿：同目录 `comment.md`（Verification 表 + 尾部模板 + patch 围栏，全英文）。

## 步骤 1 核对

- `git show a3ebed20 --stat`：只触及 `docs/subsystems/gateway-routing.md`（+1 bullet）、`internal/gateway/codex_backend.go`（+7）、`internal/gateway/reasoning_text_test.go`（新文件 +149）。不触及 native_compaction/logins，writer 判定零漂移。
- `git log --grep '#2642' upstream/main`：`bf931f82`（上游已并的 #2642 前半）与 `45b8c725`（#2727，正文提及 #2642）。`git log c922225f..0f044e94` 只有 3 个提交（a3ebed20、f21dd99f、0f044e94），45b8c725 在 r2 基线内，无需重核。
- `git merge-tree --write-tree 0f044e94 93cad8b9`：行级冲突仅 `docs/subsystems/gateway-routing.md`；`gateway.go` 自动合并干净。与"预计轻冲突"一致。

## 步骤 2 RED（原文落 red-gateway.txt / red-logins.txt）

方式：`0f044e94` 工作区 + 仅取 commit 内三个测试文件（`git checkout 93cad8b9 -- internal/gateway/native_compaction_test.go internal/provider/logins_id_test.go`），跑后还原再 cherry-pick。

- `go test -run 'TestNativeCompactionWriterRenamedStillGetsItsConversation|TestNativeCompactionWriterRenamedSaysSwitchedOff' ./internal/gateway` → EXIT=1：
  - `--- FAIL: TestNativeCompactionWriterRenamedStillGetsItsConversation`：`400 tried "": ... me@example.com is no longer signed in to magpie. ... To go on with this conversation, sign in to me@example.com again in magpie ...`
  - `--- FAIL: TestNativeCompactionWriterRenamedSaysSwitchedOff`：`no "switched off in magpie" in ...` + `signed out said of an account that is there`
- `go test -run 'TestLoginIDKeptThroughALiveSignIn' ./internal/provider` → EXIT=1：`logins_id_test.go:61: the sign-in moved the id: ""`
- 说明：任务简报里的 `TestNativeCompactionWriterSaysSwitchedOff` 实际名为 `TestNativeCompactionWriterRenamedSaysSwitchedOff`（native_compaction_test.go:606）。上游 main 上三个测试名均不存在（无让位情形）。

## 步骤 3 cherry-pick 与 docs 冲突

- 冲突结构：上游 `a3ebed20` 的新 reasoning bullet 插在 "A translated Responses reply" 与 "Native compaction" bullet 之间；git 对齐错位，冲突区 HEAD 侧 = 新 bullet + 上游旧版 Native bullet，我方版 Native bullet 被放在冲突区外且落在 answers-itself bullet 之后。
- 解法（Python 按行号重排，字节级校验后写入）：删冲突标记与上游旧版 Native bullet，保留新 bullet，把我方版 Native bullet 移回 answers-itself 之前。终序：A translated Responses reply → A reasoning item with its text in it（上游新）→ Native compaction（我方版，含 checkpointWriter.ID/isWriter）→ A compaction magpie answers itself → A Responses request Codex sends。
- 验证：`diff <(git show 93cad8b9:docs/...) docs/...` 相对 patch 版仅 +上游新 bullet 一行与 81 行区上游 f21dd99f 的 masking 演进（与本 patch 无关）。
- `GIT_EDITOR=true git cherry-pick --continue` → `ea43d94e`，工作树干净。

## GREEN（green-targeted.txt）

- gateway 定向 EXIT=0 `ok ... 1.194s`；provider 定向 EXIT=0 `ok ... 1.041s`。

## 步骤 4 消融（ablation-native-compaction.txt / green-restored.txt）

- 整文件还原 `native_compaction.go` 到 upstream/main 会 build failed（`gateway.go:2032: cannot use cp (checkpointWriter) as string` —— patch 改了 `checkpointReaders` 签名），遂做最小消融：剥 `isWriter` 的 id 分支（296 行）与 `checkpointGone` 的 id 分支（452 行），签名保留，即回到 main 的纯按名匹配语义。
- 剥离后：EXIT=1，两 gateway 测试红，失败模式与裸 main RED 一致（"no longer signed in" 误报）。
- `git checkout HEAD -- internal/gateway/native_compaction.go` 恢复：EXIT=0 `ok ... (cached)`（与 GREEN 同内容，缓存复用）。

## 步骤 5 矩阵

| 项 | 命令/范围 | 结果 |
|---|---|---|
| 定向 | 三测试 -run 两包 | 绿（见上） |
| race | `go test -race -run '...' ./internal/gateway ./internal/provider` | EXIT=0，`ok` ×2（race.txt） |
| gofmt | `gofmt -l` 五个 Go 文件 | 空，干净（.md 不适用 gofmt） |
| vet | `go vet ./internal/gateway ./internal/provider` | 干净 |
| build darwin | `go build ./...` | ok（仅预存 ld 警告：objc/CGImageAlphaInfo，与本改动无关） |
| build linux | `GOOS=linux go build ./...` 默认 tags：失败于 `wails/v3` 依赖内部 `undefined: pointer`（错误全在 GOMODCACHE 的 wails 源码，预存，与本改动无关）→ 按上游先例 `GOOS=linux go build -tags nogui ./...` | ok |
| build windows | `GOOS=windows go build ./...` | ok |
| gateway 全包 | `go test -p 1 -timeout 30m ./internal/gateway`（后台 tee gateway-full.txt） | exit 0，`ok ... 321.120s`，无超时无 flaky 记录 |

## 产物清单（/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt55/2642-writer-id-r3/）

- `2642-writer-id-stable-id-r3.patch`（git am 即用；From ggbdpq；Generated-by 尾注原样保留）
- `comment.md`（英文回帖草稿）
- `red-gateway.txt`、`red-logins.txt`、`green-targeted.txt`、`green-restored.txt`、`ablation-native-compaction.txt`、`race.txt`、`gateway-full.txt`

## 不确定项 / 如实说明

1. `TestNativeCompactionWriterSaysSwitchedOff`（任务简报名）实为 `TestNativeCompactionWriterRenamedSaysSwitchedOff`，验证按实际名执行。
2. 整文件还原式消融不可行（签名耦合），改用最小 id 匹配剥离消融；两处剥离点即 patch 在该文件的判定核心。
3. linux 默认 tags build 失败为 wails 依赖预存问题，未在裸 main 上复跑对照（错误位置在第三方依赖源码内，与 6 文件改动无交集）；上游自身验证也走 `-tags nogui`。
4. gateway 全包 321s 显著快于上游记录（1011-1253s），归因于本机已热的 build cache 与机器差异；输出无 FAIL/panic，exit 0。
5. darwin build 的 ld 警告（macOS 版本不匹配、-lobjc 重复）为链接器预存噪音。
