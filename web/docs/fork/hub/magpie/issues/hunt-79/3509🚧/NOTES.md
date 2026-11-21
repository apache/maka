# hunt79-l-3509 NOTES

- issue: yetone/magpie#3509 gui tests: usage-card-refresh reads the row's text position before it is laid out
- baseline: e57e785633a7976d9ad31771979a6ed5b2e8e99a (upstream/main, 2026-10-25 00:59 +0800)
- worktree: /tmp/magpie-hunt79-l branch hunt79-l-3509
- take comment: https://github.com/yetone/magpie/issues/3509#issuecomment-6387202746
- env: node v24.21.0, playwright 1.57.0 at /Users/ggbdpq/.npm/_npx/e41f203b7505f1fb/node_modules
- baseline run: BROWSER=chromium node --test internal/gui/tests/usage-card-refresh.test.cjs -> 23/23 pass (32.7s)

## 兄弟面 rg（textAt）
- 定义+调用仅 internal/gui/tests/usage-card-refresh.test.cjs（:143 定义，:150/:156 showRefresh 内两处）
- 其它 spec 的 getClientRects 用法（settings-sections/group-editor-align/... 各自独立）不经 textAt，语义不同，不改
- showRefresh 调用方：目标测试 :208、alignment 组 :265（20 子测）——同函数受益，无需各自改
- 最后组 :318/:334 用 assertRefreshAligned（不经 textAt），无关

## 假设
1. was=await textAt(row) 在行文本未布局时 getClientRects 无有宽度项 -> [0]=undefined -> 断言红 +<数> - undefined
2. 纯时序窗口：行元素已挂（hover 过 actionability）但文本 layout 未完成
3. 修法：等 textAt 有数且连续两次读数相同再取基线；:156 断言不动
4. 注入=textAt 首调 mock undefined 形态（任务书许可）；修复（轮询到有数且稳定）可穿透注入

## 进度
- [x] 占坑 comment-6387202746
- [x] 基线 23/23 绿
- [x] 注入 RED：RED-injection.log 22/23，目标子测 `+ 578.75 - undefined`（showRefresh :159:10）
- [x] 修复 + 注入下 GREEN：GREEN-injection.log 23/23
- [x] commit bca96e9227e2efc885bf2b63f9f43caddc2fe166（+8/-1，1 文件）
- [x] 消融回红：checkout HEAD~1 测试文件 + 同注入 → RED-ablation.log 22/23 同字样；checkout HEAD 恢复
- [x] 去注入连跑 10 次：10 × 23/23（chromium）
- [x] 双引擎 46/46；webkit 23/23；相邻 quota-read-at/usage-quota-head/quota-reads chromium 15/15
- [x] patch 0001-…patch sha256 前16 9cdd00cd0ad49f60；push origin=本地 bca96e92
- [x] 交付帖 https://github.com/yetone/magpie/issues/3509#issuecomment-6387393097（GET 回读逐字节一致）
- 注：upstream/main 在作业期间前进至 3a47e377（他人提交），基线 e57e7856 不受影响；worktree 保留未清
