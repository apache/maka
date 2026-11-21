# 5085 capCareful deferred 读数被判失败（车道 D）

- issue: https://github.com/yetone/magpie/issues/5085（take 评论 6605766257）
- 发布帖: https://github.com/yetone/magpie/issues/5085#issuecomment-6606476456（R16 rebase 后已 PATCH 更新：author ggbdpq、68531 字符、LF、patch SHA/branch/Attribution/Generated-by 全在）
- commit: rebase 后 `87407ed09`（基=冻结 tip `248853225`；原单笔 `be674dccf` 消息原样保留未 amend），分支 `fix/5085-capcareful-stale` 已 `push --force-with-lease` 回 fork（ls-remote 回读一致）
- patch: `patch-5085-capcareful-stale.patch`（新 mbox，SHA-256 full `b10acc893f612a97b899a386898200ebdcd0b7c9ee0dfce20c63bd3c08d5566e`，raw 与 LF 归一化同值——git format-patch 原生输出为 UTF-8/LF/无 BOM，无 CRLF 可归一；口径：raw=git -o 落盘字节）— `git am -3` 到 tip 干净 apply，树与分支头一致（`bcdc3113f575e834b559be005e8a89169b7f2f00`）

## 根因与判定

- 判定链：保存的非主 Claude 账号 B（`claudeWindows(ctx,user,false)` 非三种读取场景）→ 返回 `errClaudeSaved`/缓存 → `keepLast` 回退磁盘读数（`AsOf`+`ReadDeferred=true`+Error 清空）→ `loginUsageEntry.state()`（login_usage.go:51-52 旧码）把 `read.AsOf != nil` 一律判 `failed: true` → `UsageRead` → `carefulDoubt` "its usage couldn't be read" → `capHold{cap:90, used:30, unread}` 排除 → `readCareful`→`ReadUsageNow` 重读仍 deferred（claudeWindows 仍不读）→ 死循环。
- 语义判定：对「真失败」fail-closed 是有意设计（code-standards.md 读失败=unknown、守访问列表 fail closed；cap_careful.go 头注 "unknown is not spent"；08b02cf18 提交说明）。缺陷=deferred（「本次未读取」，ReadDeferred 字段文档明文与失败区分）被并入失败分支。
- 修法：`state()` 的 AsOf 分支拆分——`AsOf && !ReadDeferred`（真失败回退，如 503）保持 `failed` 且 at=AsOf（钉住 TestUsageReadAndReadAgain 语义）；`AsOf && ReadDeferred` 落到默认分支（不 failed，at=entry 时间——与内存 kept 读数现状一致，避免被 carefulOld 换理由继续排除）。

## 同族

- #5079（保守检查重启后无法重读保存账号，uiuing 有未合并补丁）：同根因链的另一半（重读够不到 Claude 层 + Retry-After 过长）。本修复只动 `state()`/GUI 显示/文档，不碰 `ReadUsageNow`/`claudeWindows`/`fallback.go`，两补丁可叠加；帖内已注明。

## 改动面（5 文件，+84/−5）

1. `internal/provider/login_usage.go` — `state()` 条件拆分 + 注释
2. `internal/provider/pool_read_test.go` — `TestUsageReadDeferredIsNotAFailedRead`（RED→GREEN，含真失败回退仍 failed 的守卫行）
3. `internal/gui/assets/plugins/routing/client.js` — `leftWhy` 与 `unlistedWord`（兄弟面同病）加 `unread` 分支
4. `internal/gui/assets/plugins/routing/i18n.js` — 2 个新键 × 4 语言（zh/zh-TW/ja/de）
5. `docs/subsystems/gateway-routing.md` — caps 行补 deferred 语义子句

## 验证矩阵

- RED（旧码）：`a kept reading no one asked for again: failed true ok true`
- provider 全量 `-tags nogui`：ok 135.9s；gateway 全量：ok 671.2s（首次 FAIL 是我给 600s -timeout 超时自伤，重跑绿）
- 定向：TestCareful*/TestCapStop*/TestUsageRead*/Claude usage/saved 全绿；gui 的 TestPageFilesRevalidate/TestPageNamesItsFilesByContent 绿；node --check 两 JS 文件绿；i18n 键平价 1+4×2 绿
- gofmt clean；vet×3（linux/darwin/windows）ok（darwin cgo 枚举警告为 gui 预存，非触及文件）；build×3 ok
- 未跑：gui 包全量（本机并发争抢 300s 超时，#5079 记录其有预存红 #4763）；race（改动=纯函数布尔分支，无并发面）——帖内均已如实标注
- Watched 三查：caps 全族消费方（UsageRead 唯一生产消费方=carefulDoubt 已核；AsOf 判定方全部是「kept≠新读」语义不受影响；ReadDeferred 判定方仅 keepLast 写/本修复读）；读失败语义已写进 state() 注释+子系统文档；热路径代价=布尔分支重排零分配

## 让位闸与门禁

- `--grep 5085`（upstream 无命中）+ capcareful/careful 关键词：无竞争提交；open PR 搜索 5085 空；issue 评论仅本车道 take
- 自检五项：密钥（仅文档正文误报）/调试残留/身份（author=ggbdpq+Generated-by）/本地路径/git am 干净 apply —— 全过

## R16 rebase（2026-11-05，冻结 tip 248853225）

- 被取代排查：tip 提交 `2488532` 本体只动 balance.go/balance_probe.go（手填 provider 的余额探测，另一根因）；`--grep 5085` 零命中；login_usage.go 近 7 天无上游提交 → 未被取代，继续 rebase。
- cherry-pick `be674dccf` 冲突仅 `docs/subsystems/gateway-routing.md`（P3/P4/P5 三行块）：P3 取补丁侧（tip 的 P3 与补丁基完全同文，纯插入 #5085 子句）；P4/P5 取 tip 侧（base→tip 间 `a1f1810e9`/`129baeca0`/`7818dc316` 的新语义 lengthWords/plainUnavailable/busyStatus-Cloudflare 全保留）——双方语义并存，零丢失；其余 4 文件自动合并，最终 stat 与原补丁一致（5 文件 +84/−5），#5079 边界保持（不碰 ReadUsageNow/claudeWindows/fallback.go）。
- 复红/复绿：只回退 login_usage.go 到 tip → `TestUsageReadDeferredIsNotAFailedRead` 复红，报错原文 `a kept reading no one asked for again: failed true ok true`（守卫行未达即止）；恢复 → 绿（含真失败回退仍 failed 守卫行）。
- 消融同上（基线=分支父提交 248853225）：回退回红 → 恢复复绿。
- 门禁：provider 全量 nogui（347.6s）= 17 个预存环境红（Codex keychain/OpenCode/git-on-disk/daemon/resolve/saved）+ `TestRestartSwitchedCodexAppReal` panic——全部在干净 tip 单跑一一定性为预存（Windows 无 keychain/ps 失败）；gateway 全量（1502.5s）= 9 个预存环境红，干净 tip 逐一复红同败；TestCareful*/TestCapStop*/TestUsageRead* 定向绿；TestPageFilesRevalidate 绿；gofmt -l（两 Go 文件）净；node --check 两 JS 净；vet nogui provider/gateway/cli 净；build nogui linux/amd64、darwin/arm64、windows/amd64 全过。
- 本机未能跑：-race（无 C 编译器，cgo 起不动——非跳过，如实记 "blocked"）；gui 包全量（口径沿原帖：只跑 assets-revalidate）。真实双账号路径未复现（原帖已在案 Not verified，未代跑未虚构）。
- 验证树：git am -3 新 mbox → AM-OK，am 树 `bcdc3113f575e834b559be005e8a89169b7f2f00` == 分支头树。
- 帖：build_post.py 改 head/SHA/verified 段后重生成 comment-draft.md（write_text 显式 encoding=utf-8, newline="\n"，避免 Windows CRLF/locale），PATCH 原帖 6606476456 成功。commit-msg.txt 与 87407ed09 实际提交消息逐字节一致（rebase 保留原消息，未改）。
