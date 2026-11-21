# hunt27-A 交付：#2426 Claude Desktop 旧构建丢 mythos 别名模型

- issue: https://github.com/yetone/magpie/issues/2426
- claim: https://github.com/yetone/magpie/issues/2426#issuecomment-6195701529
- 交付评论: https://github.com/yetone/magpie/issues/2426#issuecomment-6196004735（发帖后 details 块 heredoc 未展开，已 PATCH 修正并拉回核验）
- 分支: https://github.com/ggbdpq/magpie/tree/hunt27-pool-desktop-mythos-oldbuild
- commit: 0db93c5b（基线 422d057d）
- patch: a-desktop-mythos-oldbuild.patch

## 根因
- `internal/gateway/desktop.go` `claudeLooking`：带 Efforts 的非 Claude 模型一律列 `mythos-magpie-<n>`；`desktopWords`/`desktopTier` 照 Desktop 2.7032 写。
- 旧构建（Store 1.6608.2，app.asar 无 mythos/fable）过滤器只认 sonnet|opus|haiku tier + claude/sonnet/opus/haiku/anthropic 词 → 整行静默丢弃。

## 修法
- `desktopKnowsMythos(ua)`：UA ` Claude/(\d+)` major>=2 才用 mythos 别名；读不出/更旧 → 退回 `anthropic/magpie-<n>`（fail-safe：最坏丢 effort picker，不丢模型）。
- `desktopModels(entries, knowsMythos)`；gateway.go models handler 传 UA。
- Code tab（Claude Code 侧 DesktopID/claudeLooking）不过滤，不动。

## 红绿证据
- 修前红（422d057d + 零行为桥接）：`opencode-go/deepseek-v4.1-flash is listed as mythos-magpie-5487751739, which the build drops`（哈希号与报告者一致）。
- 修后绿；消融（父版 desktop.go/gateway.go + 桥接）同形红。
- gateway 全包 nogui ok（310s）；gofmt 干净；三平台 vet + build 过（darwin trayimage cgo 警告、ld 重复库警告为已知环境项）。

## 没跑什么（已写进 issue）
- 无 1.6608.2 真实安装可端到端；旧构建 UA 形状是推断（fail-safe 兜底）。
- Desktop 手输模型的 "must reference an Anthropic model" 检查是 Desktop 内部行为，未动。

## 行为变更测试更新
- `TestClaudeDesktopEffortIDs` handler 请求补 ` Claude/2.7032.0` UA（原无 UA，修复后会走退化分支）。
