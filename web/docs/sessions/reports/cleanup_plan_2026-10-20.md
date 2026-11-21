# 清理方案（dry-run）— 2026-10-20

- C 盘当前可用 202.0 GB / 总 465.5 GB
- A 级合计 39.9 GB；B 级合计 16.0 GB；C 级合计 112.9 MB（C 级主要为了台账清晰，金额另计）
- 执行方式：direct=可直接移 _trash；post_exit=写入 post_exit_cleanup.ps1 退出 ZCode/Magpie 后跑；command=官方命令；manual=逐项等你点头

## A 级（低风险）

| 路径 | 大小 | 文件数 | 理由 | 执行方式 | 命令 |
|---|---|---|---|---|---|
| `%TEMP%\magpie-test-home-*/TestGatewayFix*（测试残留）` | 212.8 MB | 648 | 测试/安装器残留，与运行中程序无关 | direct | - |
| `%TEMP%\magpie-*-test-*（测试残留）` | 10.7 KB | 265 | 测试/安装器残留，与运行中程序无关 | direct | - |
| `%TEMP%\go-build*（Temp 内 Go 构建缓存残留）` | 1.4 GB | 709 | 测试/安装器残留，与运行中程序无关 | direct | - |
| `%TEMP%\nsu*.tmp（安装器残留）` | 216.3 MB | 1 | 测试/安装器残留，与运行中程序无关 | direct | - |
| `%TEMP%\ZCode-installer.log` | 3.0 KB | 1 | 安装日志 | direct | - |
| `%TEMP%\ZCode-uninstaller.log` | 140.7 KB | 1 | 安装日志 | direct | - |
| `%TEMP%\vscode-stable-user-x64-*` | 3.5 GB | 22 | VS Code 安装器残留，最新 2026-10-20 | direct | - |
| `%TEMP%\zcode-bash-*` | 136.8 KB | 14 | ZCode 会话临时目录；含当前运行会话，退出后删（2 天内 0MB 也在内） | post_exit | - |
| `C:\Users\802165\AppData\Local\@zcodedesktop-updater` | 364.2 MB | 5 | ZCode 更新器已装安装包缓存 | direct | - |
| `C:\Users\802165\.zcode\v2\crash` | 1.7 MB | 6 | 崩溃转储，已无分析价值可删（如需排查再留） | post_exit | - |
| `C:\Users\802165\.zcode\cli\image-cache` | 144.6 MB | 817 | ZCode 图片缓存，可再生 | post_exit | - |
| `Roaming\ZCode\session\{Cache,Code Cache,GPUCache,...}` | 17.6 MB | 85 | Electron 壳缓存，可再生；IndexedDB/Local Storage/Partitions（登录态）不动 | post_exit | - |
| `Cursor: C:\Users\802165\AppData\Roaming\Cursor\{Cache,Code Cache,GPUCache,CachedData,CachedExtensionVSIXs,Crashpad}` | 489.9 MB | 252 | Cursor 壳缓存，可再生（logs 单列 B） | direct | - |
| `VS Code: C:\Users\802165\AppData\Roaming\Code\{Cache,Code Cache,GPUCache,CachedData,CachedExtensionVSIXs,Crashpad}` | 1.7 GB | 759 | VS Code 壳缓存，可再生（logs 单列 B） | post_exit | - |
| `npm cache（C:\Users\802165\AppData\Local\npm-cache）` | 6.1 GB | 53072 | 官方命令 | command | npm cache clean --force |
| `pnpm store（C:\Users\802165\AppData\Local\pnpm\store）` | 4.1 GB | 186924 | 官方命令，只清未引用包 | command | pnpm store prune |
| `uv cache（C:\Users\802165\AppData\Local\uv）` | 981.8 MB | 32853 | 官方命令 | command | uv cache prune |
| `pip cache（C:\Users\802165\AppData\Local\pip）` | 121.0 MB | 200 | 官方命令 | command | pip cache purge |
| `bun cache（C:\Users\802165\.bun\install\cache）` | 129.0 MB | 6817 | 官方命令 | command | bun pm cache rm |
| `go build cache（C:\Users\802165\AppData\Local\go-build）` | 20.5 GB | 52941 | 官方命令，下次构建会变慢一次 | command | go clean -cache |

## B 级（中风险）

| 路径 | 大小 | 文件数 | 理由 | 执行方式 | 命令 |
|---|---|---|---|---|---|
| `%TEMP%\magpie-*.md/png 等` | 456.2 MB | 5279 | 散件资料，需人工确认 | manual | - |
| `Cursor logs` | 69.0 MB | 1108 | 编辑器日志，可清 | direct | - |
| `VS Code logs` | 9.4 MB | 475 | 编辑器日志，可清 | direct | - |
| `.zcode\v2\checkpoints\（30 天前任务）` | 1.4 GB | 61 | 旧任务检查点，代价=失去对应回滚能力；ZCode 运行中→退出后删 | post_exit | - |
| `C:\Users\802165\.zcode\cli\exec` | 255.5 MB | 818 | ZCode 执行现场，退出后清；ZCode 运行中 | post_exit | - |
| `C:\Users\802165\.zcode\cli\artifacts` | 379.3 MB | 6214 | 会话产物已提炼入 md/raw，原文件可清；ZCode 运行中 | post_exit | - |
| `C:\Users\802165\AppData\Local\pnpm-cache` | 2.9 GB | 16203 | pnpm 元数据缓存，删后按需重建 | command | rd /s /q（无官方命令） |
| `C:\Users\802165\AppData\Local\ms-playwright` | 1.5 GB | 1559 | Playwright 浏览器，项目还要用就留着（重下 1.5GB） | manual | - |
| `C:\Users\802165\go\pkg\mod` | 2.1 GB | 205913 | Go 模块缓存，go clean -modcache 可清，重下耗时 | command | go clean -modcache |
| `C:\Users\802165\.cache\codex-runtimes` | 5.9 GB | 36133 | .cache 下大户，需你逐项点头 | manual | - |
| `C:\Users\802165\.cache\go-build` | 517.2 MB | 4619 | .cache 下大户，需你逐项点头 | manual | - |
| `C:\Users\802165\.cache\chrome-devtools-mcp` | 506.3 MB | 605 | .cache 下大户，需你逐项点头 | manual | - |
| `.zcode\v2\setting.json.corrupt-*（除最新一份）` | 11.5 KB | 3 | 历史损坏备份，保留最新 | direct | - |
| `.zcode\cli\rollout\model-io-*（除最新一份）` | 44.1 MB | 2 | 已归档(raw zip)，保留最新 | direct | - |

## C 级（高风险）

| 路径 | 大小 | 文件数 | 理由 | 执行方式 | 命令 |
|---|---|---|---|---|---|
| `claude: C:\Users\802165\.claude\projects（30 天前部分）` | 104.0 MB | 216 | 已 sha256 归档(raw zip)+提炼(md)；删后 Magpie 历史统计减少；magpie-snapshot 已备份索引 | post_exit | - |
| `codex: C:\Users\802165\.codex\sessions（30 天前部分）` | 0 B | 0 | 已 sha256 归档(raw zip)+提炼(md)；删后 Magpie 历史统计减少；magpie-snapshot 已备份索引 | post_exit | - |
| `codex: C:\Users\802165\.codex\archived_sessions（30 天前部分）` | 0 B | 0 | 已 sha256 归档(raw zip)+提炼(md)；删后 Magpie 历史统计减少；magpie-snapshot 已备份索引 | post_exit | - |
| `factory: C:\Users\802165\.factory\sessions（30 天前部分）` | 0 B | 0 | 已 sha256 归档(raw zip)+提炼(md)；删后 Magpie 历史统计减少；magpie-snapshot 已备份索引 | post_exit | - |
| `kimi: C:\Users\802165\.kimi-code\sessions（30 天前部分）` | 3.9 MB | 35 | 已 sha256 归档(raw zip)+提炼(md)；删后 Magpie 历史统计减少；magpie-snapshot 已备份索引 | post_exit | - |
| `cursor: C:\Users\802165\.cursor\projects（30 天前部分）` | 5.0 MB | 1379 | 已 sha256 归档(raw zip)+提炼(md)；删后 Magpie 历史统计减少；magpie-snapshot 已备份索引 | post_exit | - |
| `C:\Users\802165\.zcode\cli\db\db.sqlite VACUUM` | 0 B | 0 | 永不删除；实测 free pages≈117（<1MB），VACUUM 收益极小，建议跳过 | post_exit | - |

## 保留项

| 路径 | 大小 | 文件数 | 理由 | 执行方式 | 命令 |
|---|---|---|---|---|---|
| `C:\Users\802165\.zcode\v2\logs\近 14 天` | 74.1 MB | 8 | 保留 | - | - |
| `.zcode\v2\checkpoints\（30 天内）` | 0 B | 0 | 保留 | - | - |
| `claude: 30 天内` | 66.7 MB | 178 | 保留 | - | - |
| `codex: 30 天内` | 103.5 MB | 145 | 保留 | - | - |
| `codex: 30 天内` | 0 B | 0 | 保留 | - | - |
| `factory: 30 天内` | 24.9 MB | 83 | 保留 | - | - |
| `kimi: 30 天内` | 0 B | 0 | 保留 | - | - |
| `cursor: 30 天内` | 13.7 MB | 2371 | 保留 | - | - |

## 补充发现（不在原清单，逐项等你点头）

| 路径 | 大小 | 文件数 | 说明 |
|---|---|---|---|
| `C:\Users\802165\AppData\Local\Google\Chrome\User Data\各 Profile 缓存` | 1.1 GB | 5901 | Chrome 可再生缓存，需 Chrome 退出后清 |
| `C:\Users\802165\AppData\Local\Doubao` | 1.7 GB | 15005 | 豆包数据 |
| `C:\Users\802165\.grok` | 1001.5 MB | 59 | grok CLI 数据 |
| `C:\Users\802165\.wechat-intelligence-hub` | 980.1 MB | 5 | 微信智能数据 |
| `C:\Users\802165\.workbuddy-ai` | 678.9 MB | 29989 | workbuddy 数据 |
| `C:\Users\802165\KimiData` | 536.0 MB | 15550 | Kimi 桌面数据 |
| `C:\Users\802165\.qoder` | 1.5 GB | 20394 | qoder 数据 |
| `C:\Users\802165\.rustup` | 1.3 GB | 65908 | Rust 工具链 |
| `C:\Users\802165\.cargo\registry` | 372.3 MB | 12157 | cargo 注册表缓存 |
| `C:\Users\802165\AppData\Local\Temp\multica-pg` | 296.1 MB | 3750 | 疑似 PostgreSQL 数据目录，务必确认没用再动 |
| `C:\Users\802165\AppData\Local\Temp\guahub-review` | 733.8 MB | 28326 | 此前 review 工作残留 |
| `C:\Users\802165\AppData\Local\Temp\go268-cache` | 1.3 GB | 9283 | go 相关缓存残留 |
| `C:\Users\802165\AppData\Local\Temp\DingTalkUpdate_v4_9.0.1.260920012-9.0.2.261011003` | 732.5 MB | 4275 | 钉钉更新包 |
| `C:\Users\802165\AppData\Local\Temp\workbuddy-update-x64` | 474.7 MB | 1 | workbuddy 更新包 |
