# nav-guard-5files（主单，test-only，跟进 #4470 扫荡）

- 载体：#4470（已 CLOSED，原单=yetone 自修 ce8b67de3/v0.1.2260；帖以「跟进扫荡在 5 个新文件失守」行文）。
- take：issuecomment-6711402954（占坑）；PATCH 帖：issuecomment-6711463554，回读 OK。
- RED 复验 @46b10af87：守卫 nav-timeout.test.cjs 红，点名恰 5 文件（agent-details-ready 为 8000ms，其余 5000ms）——上游 11-07 夜至 11-08 未补，无出列。
- 修法：每文件 setDefaultTimeout 行后插一行 `page.setDefaultNavigationTimeout(60000);`（仿 5b1709eee/fcf87a785 同款）。
- 排雷五查：#4470 仅 2 评论（均 yetone）；16 open PR 无涉；log --grep 仅扫荡史；域词 search 无人在途；fork 无旧帖。
- 矩阵（darwin，playwright 1.57.0 @ /tmp/pw157/node_modules，NODE_PATH 注入，默认 chromium+webkit）：
  - 守卫 1/1（红转绿）；icon-one-tone 48/48；provider-retrieval-only 23/23；accounts-own-signin 20/20；accounts-switch-alone 20/20；agent-details-ready 36/36。
- 消融回红：checkout upstream 5 文件→守卫 fail 1（5 文件全点名）；恢复→pass 1。
- 兄弟面：守卫本身=全目录扫描且绿；tests 目录外无 .cjs 用 setDefaultTimeout；无 nav timeout <60000。
- rebase：46b10af87→30b7a1732（rebase 后守卫复跑绿）。
- 发布：head 0a4788f1f6ae7cf98020877122eb2eb61459185e；分支 fix/nav-guards-5files（push 显式 refspec，ls-remote 一致）；patch sha256 前16=47b98fdae251a017（5008 字节）。
