# 档3 · UX / 文字 / 展示（在池正本 2026-11-12）

> 本文件即该档在池正本：交付/收编/出列直接改本文件。统计与全仓口径=[README.md](README.md)。历史：原活文档四档狩猎接单汇总.md 已删（2026-11-12 用户令），内容迁入本目录分档转正。

**patch / 背书**（git am 即进）

- #3700 #3700 macOS 上 WorkBuddy AI 重启后退出却再也不打开：孤儿 sidecar 让 bundle 一直显示「在跑」 ——已收编 v0.1.2903 (1987fe22)
- #4271 #4271 middleware 的 Plugins 行只计调用次数，看不出多少请求被真正改写过 ——在途
- #4282 [x] #5074/#4282 挪批 C（用户令，批 A 干净发） ——核查: #4282在途 #5074在途
- #4893 #4893 usageSniffer 对同一 SSE 事件重复 JSON 验证与解码，透传路径白耗 0.42 CPU-s ——在途
- #5023 #5023 /usr/sbin/zed（zfs-zed）被认成 Zed 编辑器：误报重启通知还把 Zed 列成已安装 ——在途
- #5100 #5100 Drift 误报：magpie 自己起的 Claude Code（订阅桥/额度预热）写 ~/.claude/history.jsonl 被当成用户使用，反复提示 bypassed ——在途
- #5102 #5102 OTLP export 对 System One（/v1/systemone、Jev）调用不带请求/响应体 ——在途
- #5103 #5103 自定义插件 provider 支持配置图标显示 ——在途
- #5450 #5450 Windows 上 skill sync 82s——sync 路径持 linkmemo 部分 memo，单 sync 祖先查找 56,909→6,802 次 ——在途
- #5463 #5463 gateway middleware/hooks 的 ctx 补 caller gateway key 的 id 与 name（报告者方案落地，docs 三处同步） ——在途
- #5509 #5509 OpenCode 拒答日志行只报状态和 header 名单：补上 Retry-After 折算的等待时间和 vendor 原话，判定短限流还是额度型不用再猜 ——在途
- #5627 #5627 「为你调优」对 Qoder 等永远空白且提示语说错：双层根因（gui 白名单三处+调用管线里根本没有 qoder 条目）——TuneAgents 单一来源+空态三因分述，i18n 五语种 ——在途
- #5710 #5710 Antigravity desktop 的 Usage/Sessions 行没有 TTFT 和 tok/s——报告者 @YOUYUDAWANG 自带完整 fix（读 steps.metadata field 6/8，bounds 按 Codex turn），我们 rebase 到当前 main 独立全包验证（消融+GUI 86/86 双引擎实跑）后背书，署名保留（Chaoyi Liu） ——在途
- #5711 #5711 Windows elevated 沙箱里 Codex 的 RTK 命令不留统计、RTK 页又看不到 config.toml 里的钩子——检测双源化（hooks.json 或 config.toml 任一即 on，防重复写入）+沙箱自动把 rtk 统计目录加进 writable_roots（幂等，失败落提示兜底） ——在途
