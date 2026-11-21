# 老悬单复核轮 · 车道 A · #3476（2026-11-07）

## 结论：态b 仍有效未收编 → rebase 至 tip + 同步帖（补六要素缺口：双提交 git-am 文本首次上帖）已发

- issue: https://github.com/yetone/magpie/issues/3476（open）
- 分支: `hunt80-e-3476`，rebase `fb29cd30f` → **`a8d6706cc9fcc2d40a734278133f3fd74ddff89d`**（range-diff `=` ×2，force-with-lease push + ls-remote ✓）
- patch: 2 提交 mbox（`git format-patch -2 --zero-commit` 拼接），sha256 前16 **`4b0f4b0b8ba16b59`**：
  1. `gui: key-replace allows 15s, its press and waitFor went over 5s under load`（10-31 重写版：15s 行置于上游 ce8b67de3 的 60000 nav 行旁）
  2. `gui: key-replace's scroll check reads positions, not the .holds marker`（=10-28 rework 的 bcfa02985，内容恒等）
- **同步帖**: https://github.com/yetone/magpie/issues/3476#issuecomment-6705477217（POST 2026-11-07T10:11Z；补正一次 body PATCH 10:15:31Z——内嵌块尾随换行差一，重拼为字节精确版）
- 回读（GET 全项）: author=ggbdpq ✓ 围栏成对 ✓ **内嵌块字节==本地 mbox 文件** ✓ 块 sha256 前16==帖内引用 `4b0f4b0b8ba16b59` ✓ 尾注在末 ✓ 占位符零残留 ✓ 零中文 ✓ Branch 行 ✓ Attribution ✓ → ALL-OK

## 六要素缺口（本轮动因）

10-31 同步帖（6544824960）仅载 range-diff，无内嵌 git-am patch 块——其"Patch is git-am-ready from the issue"不成立：issue 内嵌的 rework patch（10-28 帖，sha16 64c033d75428660b）只含 scroll-check 单提交，重写后的 15s 提交从未以 git-am 文本上帖。本轮补齐双提交 mbox。

## 排雷五查（tip=191f3c0af）

1. 单号 grep: 命中（643b52546/81bdca1fe/97b6a36c5/8826a15ea）皆正文交叉引用，无吸收。
2. 域词 -S/文件史: key-replace.test.cjs 自 fb29cd30f 上游**零提交**（未收编实证）；`.holds` 写入方 d74ef5e04 仍在 main（merge-base ancestor ✓），assets/app.js holds 74 处在案——病根仍在。
3. open PR: 无。
4. 末评: 我方 6544824960（10-31），其后零回合——无新证据，但六要素缺口+矩阵补跑构成同步帖事由（态b 的 PATCH 同步）。
5. 收编形态: 无。

## 验证矩阵（2026-11-07，tip 191f3c0af，GOCACHE=/tmp/mg-A-gocache，playwright 1.57）

| 项 | 结果 |
| --- | --- |
| webkit key-replace 全支，run1 | 20/20 绿 |
| webkit key-replace 全支，run2 | 20/20 绿 |
| 消融（仅退 scroll-check 提交，15s 保留） | 16/20 红——四处 420px Change-key 检查 @ :131，逐字 `changing the key scrolled` / expected `0 ebody holds:200` / actual `0 ebody:200`（=维护者 10-28 签名）；还原后绿 ✓ |
| chromium | 本轮未跑（10-28 rework 20/20，文件未动）——帖内 not run |
| key-import / inner-scroll-contain 兄弟面 | 本轮未跑（rework 时 12/12、44/44）——帖内 not run |
| `go test ./internal/gui/ -tags nogui -timeout 25m -count=1` | 仅一败=`TestProxyCheckSaysAProxyPassedBy`（本机代理 127.0.0.1:7897 预存红，裸 main 同红，照实列不充基线）；其余全绿（冻结树复跑） |
| gofmt/vet×3/build×3 | gofmt 零输出；vet×3 净；build×3 净（pipefail 真 rc） |
| targeted `-race` | 不适用（仅 .cjs）——帖内 not run |
| am 实证 | 双提交 mbox 于 fresh 191f3c0af `git am` 干净（am 出 2 提交）✓ |

- 过程事故（已在案自愈）：rebase 后一次 `git reset --hard` 误在分支 checkout 态执行，把本地 hunt80-e-3476 搬到 tip；随即从 origin 重放 rebase 恢复（range-diff `=`），远端 force-with-lease 带期望旧值校验。教训=reset 前先 `git checkout --detach`（纪律重申）。
- zsh 陷阱在案：`$NEW:refs/...` 被修饰符展开吞冒号 → 推送 refspec 必须花括号 `${NEW}:refs/...`。

## 发布链

1. push（force-with-lease 双向校验）✓ → ls-remote 一致 ✓
2. 评论查重（POST 前）✓
3. POST → GET 回读: READBACK_PENDING
4. 轻催=帖内事实行（两病根仍在 main + scroll-check 提交可单独先收），零批次、零中文。
