release: v0.1.1255 仍挂着 Latest——更晚发布的旧版盖过了 v0.1.1256，`/releases/latest` 与下载页都在发旧构建

## 现象

仓库 `/releases/latest`（GitHub 的 Latest 徽章、releases/latest API、网站下载入口跟着它走）现在指向 **v0.1.1255**，而 **v0.1.1256** 才是最新的发布：它早 25 分钟发布，且 v0.1.1255 的 tag（a1f7b8c1）是 v0.1.1256 的 tag（37fec124）的祖先。跟着 Latest 走的用户拿到的是旧一版构建。

这正是 LESSONS.md 422d057d（10-15 夜审）记下的第三条病——当时记录「the Latest mark was moved to v0.1.1256 with gh release edit --latest」——但当前活状态是标记又回到了（或从未离开过）v0.1.1255，是同款病的残留实例。

## 复现（只读 API，当前实况）

```
$ gh release list -R yetone/magpie --limit 3
magpie v0.1.1256     v0.1.1256  2026-10-15T12:20:52Z
magpie v0.1.1255  Latest  v0.1.1255  2026-10-15T12:45:37Z   ← Latest 在旧版上
magpie v0.1.1254     v0.1.1254  2026-10-15T10:14:59Z

$ gh api repos/yetone/magpie/releases/latest --jq '.tag_name'
v0.1.1255
```

时间线（UTC）：

| 事件 | 时间 |
| --- | --- |
| v0.1.1256 发布（37fec124） | 10-15 12:20:52 |
| v0.1.1255 发布（a1f7b8c1，晚 25 分钟） | 10-15 12:45:37 → GitHub 把 Latest 判给后发布的它 |
| LESSONS 422d057d 记录「已把 Latest 移到 v0.1.1256」 | 10-15 23:15 +0800（15:15 UTC） |
| 现在（10-16 查） | Latest 在 v0.1.1255 上 |

## 根因

发布顺序病，LESSONS 已有定论：v0.1.1255 在 v0.1.1256 之后发布，GitHub 自动把「最后发布」的当 Latest。当晚的 `gh release edit --latest` 若已执行过，其后再无任何 release 发布动作（两版的 published_at 均未再变），标记不该回到 1255——所以要么这条 edit 没有真正落上，要么被某次 release 编辑（重存草稿再发布之类）顶了回去。无论哪种，当前状态就是旧的 1255 占着 Latest。

## 修法

一条维护者命令（无需改代码）：

```
gh release edit v0.1.1256 -R yetone/magpie --latest
```

顺手可核对 1254 及更早没有别的 Latest 错挂（当前查询看没有）。

## 验证

| 检查 | 结果 |
| --- | --- |
| `gh release list` Latest 徽章位置 | v0.1.1255（旧版） |
| `GET /releases/latest` | v0.1.1255 |
| tag 祖先关系 | `git merge-base --is-ancestor a1f7b8c1 37fec124` 成立：1255 ⊂ 1256，1256 是新代码 |
| 修复验证 | 本帖无法替维护者执行 edit；执行后 `releases/latest` 应回 v0.1.1256 |

没跑的：网站前端对「Latest」的实际取数路径（跟着 `/releases/latest` 走是推断，未抓站点页面核实）；除 1255/1256 外其它 release 的完整 Latest 审计（当前列表里只有 1255 挂徽章）。

Generated-by: GLM-5.3-Flash (ZCode)
