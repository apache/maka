# 2707 本机路B（守卫+解释面）与 hunt39-c 三点修订对齐报告

- 日期：2026-10-18；执行：F2 修复路，worktree `/private/tmp/magpie-fix-2707`（rev/e-2707 @ `d783df46`）
- 性质：纯本地对齐重定界；未 commit、未 push、未发帖、未关单
- 交付：对齐后三件套已写回 `docs/issues/2707-davsync-guard/`（旧版存 `*.pre-align.bak`）；本报告

## 一、现场核验（步骤1）

| 项 | 命令 | 结果 |
| --- | --- | --- |
| issue 评论 | `gh api repos/yetone/magpie/issues/2707/comments --paginate` | 共 2 条，末条 `6233665238`（yetone，2026-10-17T12:03:47Z）——**review 之后无新回合** |
| hunt39-c 分支 | `git fetch origin` + `git ls-remote origin hunt39-c-dsh-sync-compress` | 仍 `95c253e7ed86563b08ea5d61d76e7eb6f6c57a75`，**无新推**（三点修订未推送） |
| upstream/main | `git ls-remote yetone/magpie refs/heads/main` | 仍 `d783df46cbac9021e26a6bd71ca0b55544552eb2`，**hunt39-c 未落地**；`githubMaxUpload` 不在 main（`rg` 复核） |
| worktree | `git status --short --branch` | `rev/e-2707...upstream/main`，干净 @ d783df46 |

维护者三点修订（评论逐字）：①"Write v2 only when the v1 seal would be large (for example near the GitHub limit)"；②"Return a non-`ErrCorrupt` error when decompression fails, and read the decompressed data through a size-capped reader"；③"Word the docs and messages so they don't promise that every library fits GitHub"。尾注："ready to land with @ggbdpq as co-author. It isn't landed yet."

开工必读已读并记 SHA：AGENTS.md@`bd30b068`、LESSONS.md@`5380114d`（10-17 两条相关：runs recorded at another tree / body scan）、docs/code-standards.md@`5380114d`、docs/subsystems/sync-backup.md@`ea3dee96`（基线版）。

## 二、两稿文件面对读（步骤2）

| 文件 | 本机路B（旧稿，+84/−7） | hunt39-c @95c253e7 | 重叠判定 |
| --- | --- | --- | --- |
| `internal/davsync/github.go` | 新增 `githubMaxUpload` 守卫 + 422 "too large" 解释分支 | 仅 422 "too large" 解释分支（无守卫） | **422 分支同位置重复实现** |
| `internal/davsync/github_test.go` | `TestGitHubUploadOverTheEncodedLimit` + `TestGitHub422TooLargeExplained` | `TestGitHubFailures/file_too_large_for_GitHub's_API`（fixture `63<<20`） | 422 测试同 fixture 同断言面；守卫测试与兄弟子测试有**语义互斥**（见四） |
| `docs/subsystems/sync-backup.md` | 改 "Large files..." 句 + Verification 段 | 改同一 "Large files..." 句（"a full library stays within what GitHub takes"——正是修订③要禁的承诺） | **同句冲突** |
| `docs/reference.md` | 改 GitHub 64 MiB 句 | 未触 | 无重叠 |
| `internal/backup/backup.go(+test)` | 未触 | Seal v2 gzip 核心 | 无重叠（修订②的作用面） |
| `internal/library/carry.go` | 未触（有披露理由） | 仅注释（压缩口径） | 无行为重叠 |

关键不对称：兄弟稿**没有**预检守卫——报告者流线仍是"上传 76MB 后被拒（文案好）"；本稿守卫是"一个字节不发就拒"。

## 三、对齐裁决（步骤3，逐条）

1. **422 措辞半边 → 砍。** 维护者已判透传 Good（原话："The 'too large' text: ... and the message points to WebDAV/S3. Good."），实现载体在兄弟稿；两稿在同一 422 块各加一个 too-large 分支是同位置重复。落地后错误路径核验：兄弟稿分支判断响应 body，不依赖守卫，守卫只收窄其触发频率——透传价值由兄弟稿承接，本稿不重复。七问#5：维护者正在审区（同一函数同一 docs 段），不投竞争文案。
2. **预检守卫半边 → 留，改。** 修订①后残余类（不可压缩大库）被维护者本人点名（"An incompressible ~32 MiB library still gives a ~60 MB body"）——守卫独立价值**上升**（残余类的失败从"传完再拒"变"先拒"，并兜底 usage 文件等 v2 无关路径）；但其头牌案例（57.3MB v1）会被压缩缓解，暴露面收窄。触发条件 `len(data) > githubMaxUpload`（48MiB raw ⇔ 编码恰 64MiB，base64 系数固定 4/3）数学上即"仅当编码后体积将超上限"，判式不变、注释按③口径改写。文案按③改：不再陈述"GitHub 拒绝编码 >64MiB"为事实（官方无数字），改述 "its exact threshold is undocumented, so magpie stops the commit first"；出路三条含 **WebDAV or S3**（维护者首选指向）与本地 clone+push（报告者已验证）。诚实代价照录：守卫会拒绝 GitHub 可能接受的文件（已知接受点止于 10MB 原始），用成功率换确定性；长期答案归 git transport（报告者车道）。
3. **修订② → 不触及，不改。** 修订②作用于 `internal/backup/backup.go`（解压失败错误分级 + 解压数据尺寸上限 reader）；本稿文件面（github.go/github_test.go/两个 docs）与其零交集，守卫只看 `len(data)`，davsync 下载侧已有 `LimitReader(..., githubMaxFile+1)` 且对象是压缩后 raw。
4. **兄弟面复核**：`githubMaxFile` 使用点 19/25/224（读取守卫，不动）/255（下载 LimitReader，不动）/276（本稿唯一行为改动）；旧文案无测试钉挂（rg exit 1）；dav.go/s3.go 无上传守卫（维持不改）；carry.go 维持不动（兄弟稿已按压缩口径改其注释）。

## 四、兄弟交互实证（处置的定音证据）

scratch worktree @兄弟头 `95c253e7`（已删），`git apply --3way` 对齐 diff：

- `github.go`、`github_test.go`、`docs/reference.md` **cleanly**；`docs/subsystems/sync-backup.md` **with conflicts**（同句双改）。
- 兄弟子测试 × 我的守卫 → **红**（exit 1）：
  ```
  --- FAIL: TestGitHubFailures/file_too_large_for_GitHub's_API (0.00s)
      github_test.go:564: GitHub's too-large refusal stayed the generic 422: the GitHub sync file is 63 MiB, over the 48 MiB magpie commits through the Contents API: ...
  ```
  兄弟 fixture `63<<20` 落在 48MiB 线内被先行拒绝，422 文案断言落空。
- 我的守卫测试 × 兄弟基 → **绿**（exit 0，`ok ... 1.024s`）。
- 结论：**任一稿先落地都会弄红对方一处**；后到方须改兄弟子测试 fixture（降到守卫线下）+ rebase 一句 docs。独立并行发布不成立。

## 五、新 scope 与验证（步骤4）

**新 patch**：4 文件 **+51/−6**（旧稿 +84/−7）：github.go（const+守卫+③文案，无 422 分支）、github_test.go（仅守卫测试，断言钉 "Base64"/"WebDAV or S3"）、reference.md、sync-backup.md（③口径、只述守卫、Verification 段只列守卫测试名）。

验证（macOS arm64，go1.26.8，全部真实 exit，`fix.diff` 与已测状态 `diff -q` 一致）：

| 步骤 | 命令 | exit | 逐字关键输出 |
| --- | --- | --- | --- |
| RED（消融） | 摘 github.go（cp 出仓库外 + `git checkout --`），`go test -tags nogui -count=1 -run 'TestGitHubUploadOverTheEncodedLimit' ./internal/davsync` | 1 | `--- FAIL: TestGitHubUploadOverTheEncodedLimit (0.37s)` / `github_test.go:577: a backup GitHub would refuse must be stopped before upload: <nil>, writes 1` |
| GREEN | 恢复 github.go 后同上 | 0 | `ok github.com/yetone/magpie/internal/davsync 1.959s` |
| davsync 全包 | `go test -tags nogui -count=1 ./internal/davsync` | 0 | `ok ... 30.529s` |
| CLI 门禁 | `go test -tags nogui -count=1 ./internal/cli -run 'TestGitHubCmd\|TestWebdavCmd\|TestS3Cmd'` | 0 | `ok ... 2.011s` |
| gofmt | `gofmt -l` 两 Go 文件 | 0 | 无输出 |
| vet 三平台 | darwin nogui / GOOS=linux nogui / GOOS=windows | 全 0 | — |

首次 RED 经 `| tail` 致 exit 显示 0，已重跑用重定向留档 exit=1（LESSONS "runs recorded" 教训的活用）。未跑全量套件（同机另有并行路），GUI 不适用（无 assets 改动）。

## 六、处置建议：**b) 等 hunt39-c 三点修订落地后，作为 #2707 帖内 follow-up 评论交付**

1. **七问#5（必须进裁决）**：维护者 10-17 起正在逐行审 `commit` 与同一 docs 段并明示 "ready to land"——审区内投第二套独立 patch＝双头实现；§四实证两稿互斥，独立发布（a）会强迫维护者仲裁落地顺序与测试归属。
2. 守卫的价值叙事**依赖兄弟稿落地态**（压缩收窄暴露面→守卫兜不可压缩残余；③最终文案决定本稿措辞；①的 v2 阈值常量可能需与 48MiB 合并成一个数）。
3. 两稿同属 ggbdpq fork，协同成本≈0：先按三点修订 hunt39-c（优先），落地后本稿 rebase、带上 §四的两处集成调整，以 follow-up 进同一帖。
4. 不是 c)：残余类真实存在（维护者 review 自己点名 ~60MB body），兄弟稿不阻止无谓大上传，守卫是残余的目前唯一代码化答案——撤稿等于丢掉维护者亲手指认的问题的一个解。

## 七、不自信清单

1. **48 MiB 数值**：社区 50MB 拒点若按十进制读，48MiB（≈50.33 十进制 MB）略高于它，"低于全部已知拒点"依赖 MiB 口径；漏拦窗口靠兄弟稿 422 面兜底——兜底存在以兄弟稿落地为前提。
2. **守卫取舍本身**：拒绝 GitHub 可能接受的文件（成功率换确定性），维护者可能偏好"发出去了被 422 再解释"——若如此守卫半边会被否，本稿转 c) 归档。
3. 修订版未推送：本稿对齐的是兄弟稿**当前头**；修订落地（尤其①的阈值常量与③的最终文案）后需再对齐一次，两处阈值可能合一。
4. 交互实证用的兄弟基是修订前状态；修订③将再改兄弟稿文案与 docs，届时同句冲突内容会变。
5. 未验真仓库（沿用 issue 约束）；48MiB 在 GitHub 端接受性构造上不可验。

## 八、落盘清单

- `docs/issues/2707-davsync-guard/fix.diff`（对齐版，115 行）+ `fix.diff.pre-align.bak`
- `docs/issues/2707-davsync-guard/RESULT.md`（对齐版）+ `RESULT.md.pre-align.bak`
- `docs/issues/2707-davsync-guard/comment.md`（对齐版，按处置 b 定位为落地后 follow-up）+ `comment.md.pre-align.bak`
- 台账 `journal/README.md` #2707 两行未改（超出本次范围；建议实际发布/归档动作发生时更新）
- worktree `/private/tmp/magpie-fix-2707`：改动未提交，`git diff` 即 fix.diff；临时文件均在 /tmp；scratch worktree 已删
