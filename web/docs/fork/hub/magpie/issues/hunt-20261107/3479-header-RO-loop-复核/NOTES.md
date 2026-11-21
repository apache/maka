# 老悬单复核轮 · 车道 A · #3479（2026-11-07）

## 结论：态b 仍有效未收编 → rebase 至 tip + PATCH 同步帖+轻催已发（新 head e9b1f50a2）

- issue: https://github.com/yetone/magpie/issues/3479（open）
- 分支: `hunt80-b-3479`，rebase `fa2dfc145` → **`e9b1f50a23b11d45bfa0a7e6e799a3f3f25fba95`**（range-diff `=`，显式 force-with-lease push + ls-remote 比对 ✓）
- patch（模板形态 `git format-patch -1 --zero-commit`）: "gui tests: header-centre doesn't count WebKit's ResizeObserver loop notice as a page error (#3479)"，sha256 前16 **`fcd36ad58f778305`**（历史 10-24 帖 f72b8f281792447f 为旧基 rebase 前字节，From/Date 行不同所致，diff 内容恒等）
- **同步帖**: https://github.com/yetone/magpie/issues/3479#issuecomment-6705476982（POST 2026-11-07T10:11Z；补正一次 body PATCH 10:15:30Z——内嵌块尾随换行差一，重拼为字节精确版）
- 回读（GET 全项）: author=ggbdpq ✓ 围栏成对 ✓ **内嵌块字节==本地 patch 文件** ✓ 块 sha256 前16==帖内引用 `fcd36ad58f778305` ✓ 尾注在末 ✓ 占位符零残留 ✓ 零中文 ✓ Branch 行 ✓ Attribution ✓ → ALL-OK

## 新证据（本轮驱动力）

维护者 11-02 两条新回合（均在我方 10-28 轻回帖之后）：
- 6585199920（11-02T18:37Z）: "Red at main on mote (macOS), `node --test --test-concurrency=2` of 7 files … at origin/main 5ec237568 … 'ResizeObserver loop completed with undelivered notifications.' … Not taking it."
- 6588617947（11-02T21:14Z）: "Also red alone on Linux (WSL magpie-desktop, Playwright 1.62.0, idle box) at origin/main 898c314b7, the same ResizeObserver page error"

判读：两次均为**未打补丁的裸 main**，同一消息、layout 断言全绿——即本 patch 所豁免的预期红在两台新机器复现；"Not taking it" 延续其 #2686 用法（=not acting, evidence recording）。

## 排雷五查（tip=191f3c0af）

1. 单号 grep: 命中皆正文交叉引用（d55881730/80ae904c2/54087aa43/3f2faef62/e1aec5389/4a4a90c23/97b6a36c5 等长引用列表），无吸收。
2. 域词 -S: `ResizeObserver loop completed` 上游相关仅 8c983ee7b（10-28, 四个 update-* 文件, #3942）+ bbb125016（10-31, 全部 update-* 文件）——**维护者自己把同款豁免铺到了 update-* 族，先例更硬**；header-centre.test.cjs 自分支基 fa2dfc145 起**上游零提交**（未收编实证）。boot 链域词（车道任务书指定 bootChain/warmAt/waiting）: bootChain 上游无此标识符（0 命中）；warmAt=codexWarmAt 预热域（无关）；GUI boot 链真实域=reader.cjs/nav 预算（见 3525 单，已由 ce8b67de3 收编，与本单 header-centre 无涉）。
3. open PR: 无。
4. 末评: yetone 6588617947（11-02）——维护者新回合=新证据，触发态b。
5. 收编形态: 无。

## 验证矩阵（2026-11-07，tip 191f3c0af，GOCACHE=/tmp/mg-A-gocache，playwright 1.57）

| 项 | 结果 |
| --- | --- |
| webkit header-centre + patch，run1 | 7/7 绿 |
| webkit header-centre + patch，run2 | 7/7 绿 |
| chromium header-centre + patch | 7/7 绿 |
| 消融（退豁免，裸 tip 文件） | 6/7 红，唯一败因=`'ResizeObserver loop completed with undelivered notifications.'`，同 issue/维护者签名 ✓ |
| header-zoom-fit / header-relang 兄弟面 | 本轮未跑（10-24 基线双引擎绿，文件未动）——帖内如实标 not run |
| `go test ./internal/gui/ -tags nogui -timeout 25m -count=1` | 仅一败=`TestProxyCheckSaysAProxyPassedBy`（本机代理 127.0.0.1:7897 预存红，裸 main 同红，照实列不充基线）；其余全绿（245s，冻结树 191f3c0af 复跑） |
| gofmt/vet×3/build×3 | gofmt 零输出；vet×3 净；build×3 净（pipefail 真 rc） |
| targeted `-race` | 不适用（patch 仅 .cjs）——帖内如实标 not run |
| am 实证 | `git am` 于 fresh 191f3c0af 干净 ✓；range-diff `=` ✓ |
| 改动包 nogui 25m | 同 `go test ./internal/gui/` 行 |

- 复验执行范围：rebase 为 `git rebase 191f3c0af` 单提交重放；GUI 三跑+消融一跑均为本轮实测（首跑窗负载 11-16，两 Go 套件并行仍全绿）。
- NOT-RUNNABLE 说明：维护者记录的 loaded 面（load ~25/~120-160）本机不可复现，帖内 Not verified 行如实声明（本机负载 teens 非其记录负载）。

## 发布链

1. push: `git push --force-with-lease=refs/heads/hunt80-b-3479:0825e202...` 显式 sha ✓ → ls-remote 一致 ✓
2. 评论查重（POST 前）: 末评仍 yetone 11-02，无新竞速 ✓
3. POST → GET 回读: READBACK_PENDING
4. 轻催措辞: 清单帖纪律——只说本单事实数量、帖尾谢两条新记录事实，零批次信息、零中文 ✓
