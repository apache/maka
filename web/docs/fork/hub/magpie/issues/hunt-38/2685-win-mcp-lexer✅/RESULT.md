# issue yetone/magpie#2685（Windows 路径被词法器吃掉 + MCP 检查找不到 fnm 的裸命令）本地交付结果

- 分支：`fix/2685-win-mcp-lexer`（magpie-pr1，基线 `bad4508c4fea92ec4555e4a1ee6bebd623d79785` = fetch 后的 origin/main，2026-10-17）
- 交付物：`fix.diff`（本目录，基线上的 unified diff，`git apply --check -R` 反向校验通过）、`comment.md`（英文待发布稿）、本文件
- 状态：RED/GREEN/消融证据齐全；pr1 工作树已回干净；未做任何 GitHub 写操作、未提交

## 根因（file:line，基线 bad4508c）

1. **词法半** `internal/gui/assets/plugins/library/client.js`：
   - `words()`（基线 1914–1930 行）：两处把 `\` 当转义符——无引号分支 `else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; }`（吃掉 `\U`、`\x` 等，Windows 路径的 `\` 全没）；双引号分支 `else if (c === "\\" && q === '"' && i + 1 < s.length)`（`"C:\Users\me\npx.cmd"` 同样吃 `\`）。单引号分支 `else cur += c` 原样收——**单引号路径本来就往返守恒**。
   - `quote()`（基线 1394 行）：安全字符集 `/^[\w@%+=:,./-]+$/` 不含 `\` → 反斜杠路径被套单引号展示（语义无损但与保存值字面不一致）。
   - 消费点：编辑器命令框（client.js:2084 `field2(... map(quote).join(" ") ... (v) => { const w = words(v); ... })`）与 `serverLine()`（1390 行）的 4 处展示调用。
2. **路径半**：
   - `internal/proc/nodever_other.go`（`//go:build !windows`，第 1 行）：`fnmBins`（209 行）/`nodeBins`（231 行）只在非 Windows 编译；且其布局参数 `installation/bin` 是 macOS/Linux 布局——Windows fnm 是 `node-versions/<v>/installation`（无 bin 子目录，本机 `D:\...\Fnm\node-versions\v18.20.8\installation\` 实测直接放 npx.cmd）。
   - `internal/proc/path_windows.go` `UserBinDirs()`（20–46 行）：只有 npm/`~/.local/bin`/bun/Volta/pnpm/mise shims，无 fnm、无 mise installs。
   - `internal/library/mcp_check.go` `checkStdio`（426 行）：`proc.Command(s.Command, ...)` = `exec.Command`，裸命令只查 magpie 进程 PATH（桌面进程=注册表 PATH），`UserBinDirs` 补充目录不参与。

## 对 reporter 两处断言的修正（不影响结论）

- 「`: 和 \ 全被删除`」：实测 `:` 保留，只有 `\` 被折叠（`C:UsersxxxAppData...` 冒号在）。保存的命令照样坏（`C:` 开头的伪驱动器相对路径无法解析）。
- 「quote()/words() 往返也不守恒」「单引号也坏」：reporter 的复现脚本被 shell 转义压坏。真实文件代码提取跑 node：`words("'C:\Users\me\npx.cmd'")` → `["C:\Users\me\npx.cmd"]` 原样；`quote+words` 对反斜杠路径往返守恒。坏的是**无引号**和**双引号**两种输入。真实坏的入口场景（用户按提示语直接粘 `C:\...` 不加引号）成立。

## 断言①②核实（reporter 的两个前提）

- ① `fnmBins` 确实 `!windows`：`nodever_other.go` 第 1 行构建标签确认。✔
- ② 裸 npx 的 MCP 检查 notfound：本机（Windows + fnm，FNM_DIR=D:/DevTools/Languages/Frontend/Fnm，5 个 node-versions）用仓库 proc 包真实代码探针（`go run`，基线 SHA）取证：
  - `proc.UserBinDirs()` = [APPDATA\npm, ~/.local/bin, ~/.bun/bin, LOCALAPPDATA\Volta\bin, LOCALAPPDATA\pnpm]——**无任何 fnm 目录**；
  - 当前 shell `exec.LookPath("npx")` 命中 `AppData\Local\fnm_multishells\...\npx.cmd`（仅 shell 进程环境有）；
  - 受控裸 PATH（`C:\Windows\system32;C:\Windows`，即 reporter 注册表 PATH 无 node 目录的形态）下 `LookPath("npx")` → `exec: "npx": executable file not found in %PATH%`——notfound 机制证实。
  - 本机特有偏差：注册表 Machine PATH 有独立 NodeJS 安装（`D:\DevTools\Languages\Frontend\NodeJS`），基线 `FindTool("npx")` 经 `SystemDirs(LoginPath())` 兜底找到它——reporter 机器没有这层兜底，所以他是 notfound。已如实记录，不影响修复方向。
  - 修复后探针：`UserBinDirs()` 含 5 个 `Fnm\node-versions\vX\installation`；裸 PATH `FindTool("npx")` = `Fnm\node-versions\v26.10.0\installation\npx.cmd`。✔

## 公开接缝（为什么是公开接缝）

- **JS**：`words()` 是模块内私有函数、无既有纯函数测试。其公开行为面 = Library 页 MCP 编辑器的命令框：用户输入 → `oninput` → `words` 切分 → 保存时 `d.command/d.args` 发到 `POST /api/library/servers/save`；重开编辑器时 `quote()` 序列化回输入框。测试走真实页面（Playwright 起 Chromium/WebKit + fake API），断言保存请求体与输入框回显——用户可观察的行为，非实现细节。
- **Go proc**：`UserBinDirs()` 是导出函数（FindTool/agent 目录发现的数据源），沙箱内构造 FNM_DIR 假 fnm 目录断言其输出。
- **Go library**：`CheckServer`（导出）对 stdio server 的 `Why/Code` 结果——`notfound` 消失、改为真的启动（`exited(3)`），用户在 Library 页看到的状态。

## RED / GREEN / 消融记录（命令与退出码）

环境：本机 go 1.26.5（PATH）不满足 magpie go.mod 要求的 1.26.8，全部用缓存工具链
`TC=$(go env GOMODCACHE)/golang.org/toolchain@v0.0.1-go1.26.8.windows-amd64` + `GOROOT= GOTOOLCHAIN=local GOCACHE=/tmp/go268-cache`（1.26.8 独立构建缓存）。

### RED（基线 bad4508c 上，仅加测试）

| 测试 | 命令 | 结果 | 退出码 | 输出留档 |
| --- | --- | --- | --- | --- |
| proc | `go test -tags nogui ./internal/proc -run TestUserBinDirsHasFnmsNode -count=1` | FAIL：`UserBinDirs = []`，want 两个 installation | 1（消融阶段同命令干净记录 ABL_PW_PROC_EXIT=1） | /tmp/abl-pw-proc.out |
| library | `go test -tags nogui ./internal/library -run 'TestCheckStdio/bare_tool_off_PATH' -count=1` | FAIL：`{State:error Why:notfound Code:0 Detail:npx}` | **1**（独立记录） | /tmp/red-library.out |
| JS | `BROWSER=chromium node --test internal/gui/tests/mcp-command-lexer.test.cjs`（NODE_PATH=/tmp/pw-dep/node_modules） | FAIL：回显 `'C:\...\npx.cmd'`（带单引号） | **1** | /tmp/red-js.out |

### GREEN（加修复后）

| 测试 | 命令 | 结果 | 退出码 | 输出留档 |
| --- | --- | --- | --- | --- |
| proc 定向 | 同上 -run TestUserBinDirsHasFnmsNode | ok 0.5s | 0 | /tmp/green-proc.out |
| library 定向 | `go test -tags nogui ./internal/library -run TestCheckStdio -count=1`（全部子测试） | ok 3.1s | 0 | /tmp/green-lib.out |
| JS chromium | 同 RED 命令 | pass 1 fail 0 | 0 | /tmp/green-js.out |
| JS webkit | `BROWSER=webkit node --test ...mcp-command-lexer.test.cjs` | pass 1 fail 0 | 0 | /tmp/green-jsw.out |

### 消融（还原产品文件到基线、保留测试 → 回红；恢复修复 → 复绿）

修复文件先备份到 /tmp/fix-backup/（git checkout 无法恢复未提交修复）。

| 步骤 | 命令 | 结果 | 退出码 |
| --- | --- | --- | --- |
| A：`git checkout -- internal/gui/assets/plugins/library/client.js` | JS 测试 | FAIL：回显回到带单引号 | **1**（/tmp/abl-js.out） |
| A 恢复：cp 备份回 | JS 测试 | pass | 0 |
| B：`git checkout -- internal/library/mcp_check.go` | library 测试 | FAIL：notfound | **1**（/tmp/abl-mcp.out） |
| B 正交性：同状态下 proc 测试 | proc | ok（checkStdio 消融不触及 UserBinDirs 行为） | 0 |
| B 恢复 | — | — | — |
| C：`git checkout -- internal/proc/path_windows.go` | proc + library | 双 FAIL（UserBinDirs 无 fnm → 检查也找不到） | **1**/**1**（/tmp/abl-pw-proc.out、/tmp/abl-pw-lib.out） |
| C 恢复：cp 备份回 | proc 全包 | ok 9.1s | 0（/tmp/gate-proc.out） |
| C 恢复后 JS 复绿 | chromium 测试 | pass 1 | 0（/tmp/regreen-js.out） |

### library 全包跑的预存红定性（与改动无关）

`go test -tags nogui ./internal/library -count=1`（365s）两红：
- `TestRemoveFoundSkill`：`symlink ...: A required privilege is not held by the client`——本机账号无 symlink 特权，错误自证环境性；
- `TestGoneAgentListedToTakeOut`：`hermes wasn't given the skills`——**基线 worktree**（`git worktree add /tmp/magpie-base2685 bad4508c` 后同命令）**同红**（1.28s FAIL，同样 `hermes wasn't given the skills`），预存确认。worktree 已删。
我改动的测试在全包跑中全绿（无 --- FAIL 记录 TestCheckStdio/相关）。

## 门禁

| 项 | 命令 | 结果 |
| --- | --- | --- |
| gofmt（本机 CRLF：`tr -d '\r' < f > tmp && gofmt -l tmp`） | 7 个 Go 改动文件逐个 | 全 OK（nodever_other.go 首查多一个尾空行，已修，复查 OK） |
| go vet（windows） | `go vet -tags nogui ./internal/proc ./internal/library` | 退出 0 |
| go vet（GOOS=linux） | 同上 GOOS=linux | 退出 0（POSIX 侧 `fnmBins(d, "bin")` 编译确认） |
| go vet（GOOS=darwin） | 同上 GOOS=darwin | 退出 0 |
| JS 既有套件 | library.md Verification 的 23 个 library/mcp 相关 .test.cjs + 新测试，`BROWSER=chromium node --test --test-concurrency=2` | **161 tests, 161 pass, 0 fail**（退出 0） |
| JS webkit 抽测 | mcp-editor-cancel / library-mcp-health / library-servers-bulk / mcp-command-lexer | 20 tests 全绿（退出 0） |
| diff 校验 | `git apply --check -R fix.diff` | OK（diff 与基线↔修复态完全对应；diff 无 CR） |

Playwright npm 包：本机无仓库级依赖（CI 也不跑 GUI 套件），装在 /tmp/pw-dep（playwright@1.62.0，对应本机已缓存的 chromium-1234/webkit-2336；仓库 ui-preview 钉的 1.61.1 要 chromium-1228 本机没有）。

## Siblings rg 记录（改/不改理由）

- `rg "words\(|quote\(" internal/gui/assets/`：client.js（本次修）；app.css:4117 / app.js:11178 / usage/page.js:216 均为英文注释里的单词，非函数。
- `routing/client.js:3465 words()`：语言切换时重译标签的 UI 函数，与命令行切分无关——不改。
- `serversIn()`（粘贴 JSON 入口）：JSON.parse 语义，反斜杠走 JSON 转义规则，不受影响——不改。
- TUI `internal/tui/library.go:397`：`strings.Fields(line)` 纯空白切分，不吃 `\`，与 CLI argv 同语义（与 issue 描述一致）——不改。
- TUI `library.go:504`：`$VISUAL/$EDITOR` 编辑器启动（环境变量 + Fields），非 MCP 命令面——不改。
- library 包其它 `proc.Command` 调用（rtk.go:655/768、rtk_upgrade.go:206/426/505）：参数已是解析过的 bin/绝对路径/winget 固定名，无"用户裸名"场景——不改。
- `internal/agent/agent.go binAt`（379 行）：本次 checkStdio 对齐的既有先例（LookPath → Windows 上 FindTool）。
- i18n.js:413 提示语「就像在终端里输入的那样」：**不改**——词法修复后该提示对 `C:\...` 输入变为真实，issue 建议 3 的诉求被根因修复消解；改字符串需 5 语言翻译与全语言测试，无行为收益。

## 修法与范围

- client.js：words() 平台分支（`/^Win/.test(navigator.platform)`，文件内既有先例 97/1150/2724 行）+ 双引号转义集精确化（`"`、`\`、`$`、`` ` ``，POSIX 双引号规则核心——顺带修了 POSIX 下 `"a\nb"` 被过度折叠为 `anb` 的老偏差，测试钉住）；quote() Windows 安全集加 `\\`。
- proc：fnmBins/nodeBins/nodeVersions/parseNodeVersion/nodeVersionLess/isDir 移到无标签的 `nodever.go` 共享，`fnmBins(dir, bin string)` 参数化版本内布局（POSIX 传 `"bin"`，Windows 传 `""`，`filepath.Join(x, "") == x` 使两平台共用同一 default 别名解析逻辑）；nvm 四函数留 `nodever_other.go`；path_windows.go 的 UserBinDirs 加 FNM_DIR/%APPDATA%\fnm 的 fnmBins + mise installs/node 的 nodeBins。
- mcp_check.go：checkStdio 前置 `proc.LookPath` →（Windows 失败时）`proc.FindTool`，解析结果只用于启动检查，**不改写** server 的 command；找不到保持原名（notfound 的 Detail 仍报用户输入的名字，TestCheckStdio/not found 子测试不改也绿）。

## 未验项（诚实）

- macOS/Linux/WSL 上未跑任何 Go 测试（本机 Windows）；POSIX fnm 布局靠既有 nodever_other_test.go（未动）+ GOOS=linux/darwin vet 编译通过兜底。
- words() 的 POSIX 分支行为只有 Playwright 的 navigator.platform stub 一层覆盖（stub 到 MacIntel 断言转义/折叠不变），真实 macOS 浏览器未跑。
- reporter 机器的注册表 PATH 形态未 1:1 复现（本机 Machine PATH 恰有独立 NodeJS，FindTool 基线就能兜底找到）；notfound 形态用裸 PATH 探针 + 沙箱测试复现。
- JS 套件只跑了 library 相关 24 文件（chromium 全绿）+ 4 文件 webkit 抽测；GUI 全套件未跑（无字符串/选择器/布局改动，i18n 键零变化）。
- Windows 上 fnmBins 的 `aliases/default` 优先排序逻辑依赖 symlink，本机测试账号无特权（测试以 `os.Symlink` 失败容忍 + 版本号排序断言覆盖；真实 fnm 的 junction 在探针中走通了 EvalSymlinks 路径——v26.10.0 排首位既是最高版本也与 default 一致，无法区分是哪条逻辑生效）。

## 本轮不自信的点

- 双引号分支转义集选了 POSIX 四字符集（`"` `\` `$` `` ` ``）而不是 issue 建议的"放过 \"（任意保留）：更贴 POSIX 真实语义，但确实改变了 POSIX 下 `"a\$b"`→`a$b` 的现状为 `"a\$b"` 字面（POSIX shell 本身给 `a$b`）。若维护者认为该输入框不必完全模拟 POSIX 双引号，收窄为 `"`,`\` 两字符更小。没有守护测试钉死旧行为（tests 目录无 words 相关既有用例），不构成推翻既有取舍。
- checkStdio 对裸命令解析后，若 FindTool 找到的是 npm shim 的 wrapper（Unwrap 层），检查启动的程序与 agent 终端启动的程序一致性更高，但没有针对 wrapper 场景单独构造测试（binAt 既有逻辑信任）。
- UserBinDirs Windows 版 mise `installs/node` 的布局假设（`<v>/bin`）未在本机验证（本机无 mise 的 node 安装，目录不存在时 nodeVersions 返回空、无害），Windows mise 实际布局可能是 `installs\node\<v>\`（无 bin）——空列表不致错，但也可能漏覆盖。
- `fix.diff` 在本机 git（autocrlf=true）下生成，内容 LF 无 CR、反向应用校验通过；upstream apply 时如遇行尾告警属正常（repo 有 .gitattributes 与否未查证）。

## 发帖前七问自检（本轮不发布，comment.md 为草稿）

1. **标题/首句与 diff 是否同一件事？** 是：词法器保留 Windows 路径 + 检查走版本管理器目录，两半都在 diff 里，无夹带。
2. **diff 有无生成物/无关文件？** 无：9 个文件全部服务本单（产品 5 + 测试 3 + 共享重构 1，nodever.go/nodever_other.go/path_other.go 是同一重构的三面）。
3. **每行改动能否归因到 #2685？** 能：nodever 共享是 issue 建议 4"fnmBins/nodeBins 共享给 path_windows.go"的直接实现；POSIX 双引号四字符集是对 issue 建议 2"双引号分支放过 \""的语义化，comment.md 里显式说明了这个选择。
4. **有没有声称跑过而实际没跑的？** 无：表内每项都有退出码与留档文件；没跑的（跨 OS、全套件、reporter 机器）在 Not verified 列明。
5. **验证表是否与实际命令错位？** 已核对：RED 三条、GREEN 四条、消融 7 步、门禁 7 项与执行记录一一对应；library 全包两预存红单独定性（基线 worktree 同红），未计入本次改动账。
6. **引用是否真实？** #2685 真实存在且正文已读；`binAt`（agent.go）、`serverLine`、`fnmBins` 布局、issue 建议方向 1-4 均对照过原文/源码；无编造 PR/issue 号。
7. **是否越权写 GitHub？** 无：本轮零 API 写操作，comment.md 只落本地 docs/issues/（个人文档，绝不提交进任何仓库）。
