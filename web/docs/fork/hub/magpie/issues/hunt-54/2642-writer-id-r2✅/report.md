# #2642 writer-id 修复 rebase 到 c922225f（hunt54 R2）

日期：2026-10-20 · 工作树：/tmp/magpie-h52（分支 hunt54-r2-writer-id）· 未推送、未发帖

## 结果

- **新 head SHA**：`93cad8b996dd78a7c1ee3e784170f37dde90b5f4`（cherry-pick 自 `b134d8bc`，原 commit message 与作者 `ggbdpq <ggbdpq@gmail.com>` 原样保留，未追加）
- **patch**：`docs/issues/hunt54/2642-writer-id-r2/0001-writer-id.patch`（git format-patch -1，git am 可直接套用）
- **SHA-256 前 16**：`d5f2af07c95b0b20`
- **英文回帖草稿**：`docs/issues/hunt54/2642-writer-id-r2/comment.md`（结构按模板：首段 rebase 说明 → What changed → Verification 表 → `---` / Source / Red without the fix / Siblings / When the read fails / Not verified / Branch / Attribution / Patch；零中文——唯一 9 个中文字符在 patch 围栏内的上游 docs 上下文行「Codex 客户端请求特征无效」（#1758 上游报错引文），与原交付帖 6252622037 的 patch 一致，改掉反而破坏哈希）
- 改动规模与原提交完全一致：6 文件，175+/20-。

## 假设 ①②③ 结论

- **① writer 判定仍在原处 — 证实**。`git diff b134d8bc^ c922225f -- internal/gateway/native_compaction.go` 为空：`checkpointReaders`（候选池与 unlisted 池均按 `c.who() == who` 名字匹配）、`checkpointGone`（按 `strings.EqualFold(l.User, user)` 匹配 logins）、`wroteCheckpoint`（只写 `Who/Provider/Model/At`，无 id）在两基线间零漂移；调用点 `gateway.go` 的 serve 里 `checkpointReaders(cands, pl, cp.Who)` 也未变。
- **② codexsummary 新包未覆盖稳定 id 缺口 — 证实**。`694674cf` 把 magpie **自产摘要**（`magpie1:` 项）的读取移入 `internal/codexsummary`（Mark/Prefix/Encrypted/Message），只触及 `codex_backend.go`，提交说明自述 "The gateway's behaviour is unchanged"；包内无任何 writer/账号语义。`19901812` 纯测试（ported rollout 读法一致）、`4ae6c06d` 纯 docs（+1 行）。改名 writer 的缺口原样存在。
- **③ 修法落点同原提交 — 证实**。三产品文件落点不变：`native_compaction.go`（checkpointWriter.ID + isWriter + checkpointReaders 签名 `who string`→`cp checkpointWriter` + checkpointGone 按 id 兜底）、`gateway.go:2030` 调用点传 `cp`、`provider/logins.go`（upsertLogin 保 `l.ID = ls[i].ID`、dedupeLogins 用 `cmp.Or` 保 id）。`provider.LoginID` 与 `provider.Provider.AccountID()` 在新 main 均已存在，原代码零适配。

## 冲突解法（唯一冲突：docs/subsystems/gateway-routing.md）

- 冲突本质：上游在 Native compaction bullet **之前新增**了一条 codexsummary bullet（compaction 波 + docs 重排），行错位导致 diff3 无法对齐；三方对比证实 Native compaction bullet **本身零漂移**（parent→HEAD 在该行内 SequenceMatcher 无任何 opcode），我方改动是对该行的一处纯插入（writer-id 两句）。
- 解法：保留上游新 codexsummary bullet + 我方版 Native compaction bullet（= 上游行 + 原插入，逐字同原提交）。gateway.go 与 logins.go 自动合入，diff 与原提交逐字一致（含 `cmp` 导入）。

## RED / GREEN（base c922225f）

RED（只取原提交两测试文件，纯增量落地 +94/+36，编译通过，exit 1）：

```
--- FAIL: TestNativeCompactionWriterRenamedStillGetsItsConversation (0.11s)
    native_compaction_test.go:595: 400 tried "": {... me@example.com is no longer signed in to magpie. ...}
--- FAIL: TestNativeCompactionWriterRenamedSaysSwitchedOff (0.03s)
    native_compaction_test.go:636: no "switched off in magpie" in {... spare@example.com is no longer signed in to magpie. ...}
    native_compaction_test.go:640: signed out said of an account that is there: {... no longer signed in ...}
--- FAIL: TestLoginIDKeptThroughALiveSignIn (0.01s)
    logins_id_test.go:61: the sign-in moved the id: ""
```

（报告者原句「is no longer signed in to magpie」在新 tip 复现。）GREEN（cherry-pick 后，exit 0）：`-run 'TestNativeCompactionWriterRenamed' ./internal/gateway/` ok 1.029s；`-run 'TestLoginIDKeptThroughALiveSignIn' ./internal/provider/` ok 0.995s。

## 消融与变异（保测试）

- 三产品文件 checkout 回 `c922225f`：三测试全红（gateway exit 1：同一 reporter 句；provider exit 1：id 变 ""）；恢复 HEAD 后复绿。
- 变异 1（isWriter 去掉 id 兜底，签名不动）：`TestNativeCompactionWriterRenamedStillGetsItsConversation` 回红（exit 1）；还原复绿。
- 变异 2（checkpointGone 去掉 id 兜底）：`TestNativeCompactionWriterRenamedSaysSwitchedOff` 回红——又是 "no longer signed in"（exit 1）；还原复绿。

## Watched 三查

- **(a) 打破稳定 id 判定→回红**：即上两变异，均回红、还原复绿。
- **(b) 兄弟面**（rg 'writer|Writer' 收窄到 checkpoint/sealedCompact 语义面）：
  - `checkpointReaders`/`isWriter`/`wroteCheckpoint`/`checkpointGone`（native_compaction.go）— 本单已改。
  - `checkpointHeld`（native_compaction.go:339）— **不改**：完全不按名匹配，只从 `checkpointReaders` 收窄后的 `pl.capped/pl.held` 行里挑，改名 writer 被找向后自然正确。
  - `compactionWho`（:381）、`checkpointCappedError`（fallback.go:683）— **不改**：只打印记录里的 `cp.Who`（展示文案）。
  - `sealedCompact`（codex_backend.go:759）— gone 判定走 `checkpointGone`（已 id-aware）；其对**健康** writer 的匹配按账号 user/email 是**有意设计**（两个 Team seat 同邮箱视为一体，docs 明言），不改。
  - `compactSigninHeld`/`sealedCompactHeldError` — 读请求的 key 身份，非 writer 记录，不改。
  - `internal/codexsummary` — 全包 rg 零 writer 语义（上游 one-owner 路径只管 magpie 自产摘要的读取），不改。
  - `provider/logins.go` 的 `upsertLogin`/`dedupeLogins` — 随本单改（id 保持是记录 id 可信的前提）。
- **(c) 失败/未知写入者**：改前旧记录无 `id` → `cp.ID==""`，两处匹配都退回纯名字，与现在逐字相同（向后兼容）；名与 id 都匹配不到 login → 照旧 "no longer signed in"；compactions.json 读不出来 → `checkpointOf` ok=false → 不 pin，正常路由；id 找到改名 login 而账号确实不可用 → 拒绝语改为该新名下设置实况（switched off / paused / Names & levels），不再是 "no longer signed in"。

## 验证矩阵逐项

| 项 | 命令 | 结果 |
| --- | --- | --- |
| RED | 基线 c922225f 只带测试定向 | exit 1，断言级 FAIL（见上） |
| GREEN 定向 | `-run TestNativeCompactionWriterRenamed` gw / `TestLoginIDKeptThroughALiveSignIn` prov | 双 exit 0 |
| gateway 全包 | `-tags nogui -count=1 -p 1 -timeout 30m ./internal/gateway/` | ok 336.222s（未超时，exit 0；日志 tee 到产物目录 gateway-full.log） |
| provider 全包 | `-tags nogui -count=1 -p 2 ./internal/provider/` | ok 68.904s |
| codexsummary 新包 | `-count=1 ./internal/codexsummary/` | ok 0.290s |
| race 定向 | `-race -tags nogui`（TestNativeCompactionWriterRenamed gw / TestLoginID prov） | 双 ok（2.1s/2.0s） |
| gofmt | `gofmt -l` gateway/provider/codexsummary | 空 |
| vet | 三平台 `GOOS={darwin,linux,windows} go vet -tags nogui` 两包 | 各 exit 0、0 字节输出 |
| build | darwin / linux / windows `go build -tags nogui` | 三平台 ok（darwin 仅已知 trayimage cgo -Wenum-conversion 警告） |

## 不确定项

- 真实 ChatGPT Team seat 会话中途改名未验证（与原轮相同，测试按 `writeLogins`/`codexName` 的产物构造改名）；报告者账号究竟是改名还是真登出，从本地无法判定——若是真登出，新报错文案语义不变。
- patch 内 9 个中文字符为上游 docs 上下文引文，随 diff 原样携带；若维护者对 patch 围栏内的引文有异议需上游自行处理，不应改动（会破坏 SHA-256 与 git am）。
- fork 分支 `hunt43-a-compaction-writer-id` 尚停在 `b134d8bc`；按禁令未推送，新 head `93cad8b9` 只在本工作树与 patch 文件中。

## 产物清单

- `0001-writer-id.patch`（sha256 前 16 `d5f2af07c95b0b20`）
- `comment.md`（英文回帖草稿）
- `gateway-full.log`（gateway 全包输出 + GWFULL_EXIT=0）
- `report.md`（本文件）
