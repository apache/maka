# 2707 davsync 守卫与解释面 — 本地交付报告（对齐版）

- 路线 B：worktree `/private/tmp/magpie-fix-2707`，分支 `rev/e-2707`，未提交未推送
- 基线 SHA：`d783df46cbac9021e26a6bd71ca0b55544552eb2`（2026-10-18 核验 upstream/main 仍此值，hunt39-c 未落地）
- 交付物：`fix.diff`（4 文件，+51/−6）、`comment.md`（英文待发布稿，**未发布**）
- 旧版三件套保留为 `*.pre-align.bak`（2026-10-17 版，基 bad4508c，含已砍的 422 半边）
- 本版性质：与兄弟 patch `hunt39-c-dsh-sync-compress`（fork @`95c253e7`）获维护者 10-17 12:03 三点落地前修订**对齐后**的重定界稿；处置建议见 §九
- 范围（对齐后收窄）：只做**编码体积预检守卫**；422 too-large 解释面归兄弟稿（维护者已判 Good），本稿不再触碰

## 一、对齐裁决（逐条，证据见 §五/§六）

### 1. 422 措辞半边 → **砍**

- 维护者 review 原文："The 'too large' text: it matches the reporter's bytes..., and the message points to WebDAV/S3. **Good.**"——透传+解释这一行为已被判好，实现载体是兄弟稿 github.go 的 422 分支（`strings.Contains(strings.ToLower(string(body)), "too large")`）。
- 两稿在同一 422 块各加一个 "too large" 分支，属同位置重复实现；无论谁先落地，另一方必须删。留兄弟稿（已在审、已获好评），砍本稿。
- "hunt39-c 落地后透传是否仍成立"：成立——兄弟稿分支不依赖守卫，判断对象是响应 body；本稿守卫收窄其触发频率但不改变其路径。透传价值由兄弟稿承接，本稿无需重复。
- 七问#5：维护者**此刻正在审区**（同一函数 `commit`、同一 docs 段），第二套竞争文案＝在审区内制造碰撞。

### 2. 预检守卫半边 → **留，改**（收窄 + ③文案 + 集成注记）

独立价值重估（对齐修订①后）：
- **下降面**：原稿头牌案例（报告者 57.3MB v1 → 裸 422）将先被兄弟稿的压缩缓解——大库封 v2 后大概率缩到守卫线以下，48–64MiB raw 这一档变稀有。
- **上升面**：①修订①明认残余类存在——"An incompressible ~32 MiB library still gives a ~60 MB body"，此档编码后 60MB 处于已知接受点（13.33MB）与已知拒点（66.67MB）之间的未知区，兄弟稿只把它变成"传完再拒（有文案）"，守卫把它变成"一个字节不发就拒"；②③修订要求文案不承诺装得下——预检守卫正是这一诚实的代码化：magpie 明说它只尝试编码后 ≤64MiB 的请求，超线本地拒绝并给替代；③兜底 v2 不帮助的增长路径（usage 文件走 `SealData` 未压缩、`carry.go` 预算仍按 64MiB 读取口径）。
- **触发条件**：`len(data) > githubMaxUpload`（48MiB raw ⇔ 编码后恰 64MiB，base64 膨胀系数固定 4/3，对任意数据成立）——数学上就是"仅当编码后体积将超上限时"，无需改判式，注释按此表述。
- **诚实代价**（照录）：守卫会拒绝 GitHub 可能接受的文件（真实阈值未documented，已知接受数据点仅到 13.33MB 编码）；守卫用"可能的成功"换"确定性与不浪费的上传"。维护者对"压缩后仍过大"的库指向的长期答案是 git transport（报告者声明的车道），守卫自我定位为 stopgap。
- **文案按修订③改**：不再把"GitHub 拒绝编码 >64MiB"当作已证事实陈述（官方无数字），改述为"its exact threshold is undocumented, so magpie stops the commit first"；出路三条：少同步（例如关掉库）、**WebDAV or S3**（维护者首选指向）、本地 clone+push（报告者已验证）。不承诺任何库"装得下"。

### 3. 修订②（解压失败非 `ErrCorrupt` + 尺寸上限 reader）→ **不触及，不改**

修订②目标文件是 `internal/backup/backup.go`（Open/Seal 解压路径）。本稿文件面：`internal/davsync/github.go`、`internal/davsync/github_test.go`、`docs/reference.md`、`docs/subsystems/sync-backup.md`——与 internal/backup 零交集；守卫只看 `len(data)`，不读不解密封印数据；davsync 下载侧已有 `io.LimitReader(..., githubMaxFile+1)`（github.go:255），且其限额对象是压缩后的 raw 文件，解压发生在 backup.Open（davsync 之外）。无对齐动作。

## 二、根因（不变，简要）

守卫量原始字节（`len(data) > githubMaxFile`，64MiB raw），API 按 Base64 编码后的请求体积拒绝：报告者 57,333,552 字节 → 76,444,736 编码字符请求体 → 422 "Sorry, the file is too large to be processed..."。官方无单一数字上限（考证见 `.pre-align.bak` RESULT §二，仍有效）。

## 三、修法（对齐后）

```go
// GitHub receives a committed file Base64-encoded inside the JSON body and
// judges the request, not the raw file; its refusal threshold is
// undocumented (issue #2707), so magpie stops a commit whose encoded form
// would pass what it reads rather than fail mid-upload.
const githubMaxUpload = githubMaxFile / 4 * 3   // 48 MiB raw，编码后恰 64 MiB
```

- `commit` 守卫：`len(data) > githubMaxUpload` → ③合规文案（报实测/允许 MiB、Base64 机制、阈值未documented、先行拒绝、三条出路）。
- 422 分支：**不动**（兄弟稿车道）。
- 测试：保留 `TestGitHubUploadOverTheEncodedLimit`（报告者字节数 57,333,552；恰 48MiB 提交成功；+1 字节拒；断言改钉 "Base64" 与 "WebDAV or S3"）；`TestGitHub422TooLargeExplained` **删除**（兄弟稿 `TestGitHubFailures/file_too_large_for_GitHub's_API` 同 fixture 同断言面）。
- docs：`reference.md` GitHub 句、`sync-backup.md` Large-files 句均改③口径（无数字承诺、WebDAV/S3 指向、只述守卫不述 422 面）；Verification 段只列守卫测试名。
- 未动 `carry.go`：兄弟稿已改其注释（压缩口径）；本稿不对另一子系统的收集预算按未documented的上传阈值重推导（同旧版理由）；大库不可压缩残余由守卫的拒绝文案自解释。

## 四、兄弟面 rg 记录（对齐复核）

- `rg -n "githubMaxFile" internal/davsync/github.go`：19（const）、25（新 const 引用）、224（读取侧 `content()` 守卫，**不动**——blob GET 官方 ≤100MB，64MiB raw 读取契约）、255（下载 `LimitReader`，不动）、276（上传守卫，本稿唯一行为改动点）。
- `rg -n "exceeds 64 MiB|the GitHub sync file" --glob '*_test.go' internal/` → 无命中（exit 1）：旧守卫文案无钉挂。
- dav.go / s3.go：无上传守卫无 422 特判（同旧版结论，不改）；usage.go 经 `g.write`→`commit` 自动被守卫覆盖。
- 与兄弟稿文件重叠：`github.go`（不同 hunk，3way 干净合并）、`github_test.go`（同文件不同位置，干净）、`sync-backup.md`（**同句冲突**，落地顺序后到方需 rebase，见 §六）。

## 五、RED / GREEN / 消融 / 门禁（本机 macOS arm64，go1.26.8，全部真实 exit）

| 步骤 | 命令（均在 /private/tmp/magpie-fix-2707） | exit | 关键输出 |
| --- | --- | --- | --- |
| RED（消融合一） | `cp internal/davsync/github.go /tmp/github.go.aligned && git checkout -- internal/davsync/github.go` 后 `go test -tags nogui -count=1 -run 'TestGitHubUploadOverTheEncodedLimit' ./internal/davsync` | 1 | `--- FAIL: TestGitHubUploadOverTheEncodedLimit (0.37s) ... a backup GitHub would refuse must be stopped before upload: <nil>, writes 1`——基线 64MiB 原始守卫放行报告者字节，写发生在拒绝前 |
| GREEN | `cp /tmp/github.go.aligned internal/davsync/github.go` 后同上 | 0 | `ok github.com/yetone/magpie/internal/davsync 1.959s` |
| davsync 全包 | `go test -tags nogui -count=1 ./internal/davsync` | 0 | `ok ... 30.529s`（输出中 `internal/gui/trayimage_darwin.go` cgo -Wenum-conversion warning 为构建期预存噪音，非本包失败） |
| CLI 层 | `go test -tags nogui -count=1 ./internal/cli -run 'TestGitHubCmd\|TestWebdavCmd\|TestS3Cmd'` | 0 | `ok ... 2.011s` |
| gofmt | `gofmt -l internal/davsync/github.go internal/davsync/github_test.go` | 0 | 无输出 |
| vet | `go vet -tags nogui ./internal/davsync`；`GOOS=linux go vet -tags nogui ./internal/davsync`；`GOOS=windows go vet ./internal/davsync` | 全 0 | — |
| 消融说明 | 产品面仅 github.go 一个文件：RED 步即"显式摘产品文件回红"（cp 出仓库外→checkout 还原→红），GREEN 步即"恢复复绿"；docs/测试保留。全部相关产品文件已消融 | — | — |

首次 RED 曾经管道 `| tail` 致 exit 显示为 0，重跑改输出重定向留档真实 exit=1（教训照 LESSONS：`set -o pipefail`，验证记录必须留真实退出码）。

## 六、兄弟分支交互实证（决定处置的关键证据）

scratch worktree `/private/tmp/magpie-sibling-check`（已删），`git worktree add --detach` 到兄弟头 `95c253e7`，`git apply --3way /tmp/f2-aligned.diff`：

- `github.go` / `github_test.go` / `reference.md` cleanly；`sync-backup.md` **with conflicts**（同句双改，落地必撞）。
- 兄弟子测试在我守卫下：`go test -tags nogui -count=1 -run 'TestGitHubFailures/file_too_large' -v ./internal/davsync` → **exit 1**
  `--- FAIL: TestGitHubFailures/file_too_large_for_GitHub's_API` `github_test.go:564: GitHub's too-large refusal stayed the generic 422: the GitHub sync file is 63 MiB, over the 48 MiB magpie commits through the Contents API: ...`——兄弟 fixture `63<<20` 落在 48MiB 守卫线内被先行拒绝，其 422 文案断言落空。
- 我的守卫测试在兄弟基上：同 worktree `go test -tags nogui -count=1 -run 'TestGitHubUploadOverTheEncodedLimit' ./internal/davsync` → **exit 0** `ok ... 1.024s`。
- 结论：两稿**任一先落地都会弄红对方一个测试/同句 docs**；我的稿对兄弟基的适配面＝兄弟子测试 fixture 改为守卫线下（如 `githubMaxUpload-1`）+ docs rebase，改动小但**必须**由后到方完成。这坐实"独立并行发布不成立，follow-up 协同交付"的处置。

## 七、诚实未验项

- 未对真仓库做任何验证（沿用 issue 要求）；48 MiB raw 在 GitHub 端的接受性构造上不可验（已知接受数据点止于 10MB 原始）。
- 对齐版未在"兄弟稿+三点修订完成"的假想落地态上测试（修订版未推送，不存在该树）；交互实证用的是兄弟稿**当前**头 95c253e7，其修订落地后本稿需按其最终形态（尤其修订①的 v1→v2 阈值常量与③后的最终文案）再对齐一次。
- GUI Playwright 未跑：无 `internal/gui/assets` 改动，不适用。
- `magpie github now` 端到端未跑（需真 token+仓库）；错误上浮路径代码审读同旧版（`syncOnce` 原样入 `st.Error`）。

## 八、不自信的点

1. **48 MiB 这个数**：工程保守取值，位于社区 50MB 拒点之下依赖 MiB/MB 口径读法（50MB 若为十进制则 48MiB≈50.33MB 略高于它）；漏拦窗口由兄弟稿 422 面兜底，但兜底依赖兄弟稿落地。
2. **守卫 vs 让 GitHub 裁决**：守卫拒绝 GitHub 可能接受的文件——这是用确定性换成功率的取舍，维护者未必认同；若其偏好"让它发出去被 422 再解释"，守卫半边可能被整体否掉（此时本稿归档为 c 类）。
3. 兄弟稿修订①落地后 v1→v2 阈值若取与 48MiB 不同的常量，两处阈值的关系需要在新基上重述（可能合并为一个常量）。
4. 交互实证的兄弟基是修订前状态；修订②会改 backup.go（与本稿无交集），但修订③会改兄弟稿文案与 docs——届时 sync-backup.md 同句内容将再次变化。

## 九、处置建议：**b) 等 hunt39-c 三点修订落地后，作为 #2707 帖内 follow-up 评论交付**（本稿保持 rebased-ready）

理由：
1. **七问#5（维护者在审区）**：维护者 10-17 正逐行审 `commit` 函数与同一 docs 段，且给了"ready to land"预期；此刻投第二套独立 patch 等于在审区内制造双头实现（§六实证：任一先落都弄红对方）。
2. **价值依赖落地态**：守卫的残余价值叙事（压缩收窄暴露面→守卫兜住不可压缩残余）只在兄弟稿修订版落地后才成立；其最终文案（③）与 v2 阈值（①）决定本稿的文案与集成改法。
3. **同一账号持有两稿**（均为 ggbdpq fork），协同成本≈0；修订 hunt39-c 优先（维护者给了明确三点），落地后本稿以 follow-up 进同一帖：贴守卫 diff + §六集成改法（兄弟子测试 fixture 调整）+ RED/GREEN 表。
4. **不是 a)**：独立发布需维护者同时背两套对同一函数的改动，摩擦大、无增益；除非兄弟稿长期停滞或维护者明示偏好守卫单走。
5. **不是 c)**：撤稿不成立——维护者 review 自己点名 "An incompressible ~32 MiB library still gives a ~60 MB body"（残余类真实存在），兄弟稿不阻止无谓的大上传；守卫是那一残余的目前唯一代码化答案（git transport 是长期答案且属报告者车道）。

## 十、收口状态

- `/private/tmp/magpie-fix-2707`（rev/e-2707 @ d783df46）：工作树含对齐改动未提交；`git diff` 即 `fix.diff`（+51/−6，与已验证状态逐字节一致，`diff -q` 核对）。
- 临时文件：`/tmp/github.go.aligned`、`/tmp/f2-*.log`、`/tmp/f2-aligned*.diff` 留 /tmp（会话临时区，未入仓库与 docs）；scratch worktree 已 remove。
- 未 commit、未 push、未发帖、未关单；台账 `journal/README.md` 两行未改（本次任务范围外，建议发布动作发生时一并更新）。
