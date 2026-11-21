# hunt79-j-3498 笔记（A6）

## 开场
- 基线：upstream/main = e57e785633a7976d9ad31771979a6ed5b2e8e99a（2026-10-25 fetch，与任务书一致）
- worktree：/tmp/magpie-hunt79-j，分支 hunt79-j-3498
- 占坑：take 评论 https://github.com/yetone/magpie/issues/3498#issuecomment-6387177246（发前核实 issue 0 评论、无 open PR 引用）
- playwright：npx 缓存 1.57.0 在 ~/.npm/_npx/e41f203b7505f1fb/node_modules，chromium-1200 在 ~/Library/Caches/ms-playwright

## 定性
- issue 猜 b00c82acf/f21dd99f5 —— 不是真凶（两提交是 Settings › Privacy 工作，未动 nav）
- 真凶：e698a688（2026-10-24，维护者）"gui: Insights › Masking shows each request as sent..."：masking 移出 Settings › Privacy 成独立页，index.html 加 `<button data-view="masking" data-feature="redact">`（git log -S 仅此一改）
- nav 有意加 tab：提交说明明说 "a page of its own under Insights"；DOM 顺序 agents, sessions, library, providers, routing, gateway, usage, masking, plugins；masking 显示由 featuresOff 控（redact 开则显示；测试 fixture redact 开）
- 63c0c354a（issue 报红处）在 e698a688 之后；基线 e57e7856 含两者
- 结论：nav 对、测试期望过期 → 修测试

## RED（基线树，双引擎）
- builtins.test.cjs：chromium/webkit 主测同断言同 diff（`+ 'masking'`），broken 子测绿 —— RED.log
- sidebar.test.cjs：16 测试 12 红，全 `+ 'masking'` —— SIBLING-sidebar.log
- gateway-mode.test.cjs：6 测试 2 红（"gateway mode" 双引擎），actual 含 masking —— SIBLING-gateway-mode.log

## 修改（5 数组 + 1 注释）
- builtins KEPT 补 masking（+注释一行：列表依赖预设 masking on）
- sidebar:63 DOM 全列表补 masking
- gateway-mode KEPT + 两处全列表补 masking

## 兄弟面判定
- 改：sidebar / gateway-mode（精确列表断言，实测红，同根因 e698a688）
- 不改：page-width:13 / view-no-sideways:77 / mobile-web:52（列表仅用于逐页遍历查横向滚动，无精确断言，不红；补 masking 属覆盖扩展超本单）
- 无其它漏网（rg '"gateway", "usage|"usage", "plugins' 全扫，余下命中均为遍历行或已含 masking 的新 spec）

## Watched 三查
- 消融回红：还原 3 文件 → builtins 红（exit 1，同断言）；重放 → 绿（exit 0）。兄弟同理（SIBLING-*.log 即消融基线证据）
- 兄弟面 rg：如上
- 失败读取语义：N/A（test-only，不触读取路径）
- i18n 键守卫：N/A（只动 tests/*.cjs，i18n-keys 扫 assets）

## 矩阵
- builtins 4/4 绿（主测全矩阵 5 语言 × 3 宽度 × 双引擎）GREEN-builtins.log
- sidebar 16/16 绿 GREEN-sidebar.log；gateway-mode 6/6 绿 GREEN-gateway-mode.log
- 预存红对照：34xx 族（基线 3b10a403d）与本单无关，未触碰

## 环境
- zsh profile 噪声（setValueForKeyFakeAssocArray _encode/_decode）与命令无关，exit code 可信
