# cbmini 复刻与 WSL 重建经验

> 会话实录时间 2026-09-26/27（langbooks P04 卡 → cbmini），本文归档于 2026-11-19。

## 一句话结论

从项目卡复刻 800 行 TS 编译器并全绿验收的过程，沉淀出三件可复用资产：WSL 环境失效的探测与重建命令组、wsl.exe 输出陷阱的两个规避写法、"运行环境缺失时把验收拆成语法门/语义门/运行门"的分层验收法；三部曲内容搬运 langalgo 的三档分析待用户决策。

## Skill 增量建议（2026-11-19 用户确认后两条均已执行；当时为待确认）

1. **gua-dev-tools**｜位置：主 SKILL.md 通用铁律（或独立环境小节）｜缺口：入口路由表 16 个模块与通用铁律均无 WSL/宿主环境脚本规则（依据已读入口判定；归档当日 shell 故障未能全目录 grep 复核）｜建议文本：「脚本化调用 wsl.exe：先 `wsl.exe -l -v 2>&1 | tr -d '\0'` 探测发行版存在；捕获输出一律 `WSL_UTF8=1` 且 stderr 分流（`2>/dev/null`），否则 UTF-16 本地化横幅（如 localhost 代理警告）会进入命令替换污染判定」｜证据：check.sh 五用例程序输出全对却判 FAIL，根因即横幅混入 `$(… 2>&1)`（会话 2026-09-27 实录）；`wsl -l -v` 直接输出乱码实录｜检验场景：`got=$(wsl.exe --cd … ./x 2>&1)` 与 `got=$(WSL_UTF8=1 wsl.exe --cd … ./x 2>/dev/null)` 对比，前者含横幅判不等，后者干净。
2. **gua-writer**｜位置：输出要求 §可执行步骤｜缺口：无恢复/安装指令的排版约束｜建议文本：「给用户的多步恢复或安装命令逐条独立成代码块行，不用 `+`、`、` 等文字连接符串接——用户可能整行粘贴进终端」｜证据：本轮 `wsl --install -d Ubuntu-26.04 + apt install gcc-multilib` 被 wsl.exe 整行解析报 `Wsl/E_INVALIDARG`，返工一轮（用户截图实录）｜检验场景：两步命令整行粘贴到 cmd，不再报"无效的命令行参数"。
3. **已覆盖，不新增**：「环境基线文档会失效」（langbooks README"本机环境 2026-09-19 实测"一周后 WSL 实为零发行版、无残留 vhdx、无 Docker）——全局 AGENTS.md「运行状态用代码/脚本/探针核验，文档与实测冲突时报告差异」与 gua-pr-patch 铁律「证据先于结论」已覆盖原则，此处只留实例。

## 可复用经验与案例

- **分层验收法（运行环境缺失时不中断交付）**：把编译器验收拆成三层，逐层用替代 oracle——①语法门：MSYS2 `as --32` 交叉汇编（COFF 下 `.size name,.-name` 报 ignored/junk 噪声属预期，过滤后看其余错误）；②语义门：临时 IR 解释器跑用例对 expected（用完即删不入库，不当第二真值源留存）；③运行门：环境恢复后 check.sh 全量。cbmini 五用例最终三层全过。适用边界：语义门依赖"可解释子集"，IR 含临时量/优化序后解释器本身腐化风险上升。
- **三部曲搬运三档判断（待用户决策，非已执行）**：把外核内容搬进自研语言前分三档——langalgo 已覆盖（树解释器/字节码演进/闭包/静态类型叠加）不搬；与架构决策冲突（crowbar 手写 GC vs"GC 委托宿主"spec、setjmp 异常 vs result、Diksam 类分派 vs struct/enum/match、GluonJ 无对应物）不搬；真空白三件按成本排序：常量折叠 pass（天级）→ Diksam 字节码三件套（周级，等性能需求真出现）→ 原生后端整链 = 第六轴（月级，新立项），cbmini 即第三项的种子。
- **node ≥23.6 直跑 TS 的约束**：`package.json` 设 `"type":"module"`、导入带 `.ts` 后缀、仅可擦除语法（禁 enum/namespace/构造器参数属性，类字段显式赋值替代）——省掉整个构建步；cbmini 用此把"Java+构建"槽位换成零依赖。
- **环境 drift 的两次亲历**：①langbooks README 环境基线一周失效；②本会话收尾时 harness 的 Git Bash 路径 `D:\DevTools\DevOpts\Git\bin\bash.exe` 由可用转 ENOENT。共同教训：同会话早些时候能跑不等于现在能跑，环境类前提每轮重验。

## 常用命令

- 场景：探测 WSL 发行版与在线列表（Git Bash）｜`wsl.exe -l -v 2>&1 | tr -d '\0'` 与 `wsl.exe --list --online 2>&1 | tr -d '\0'`｜前提：WSL 框架已启用｜成功信号：发行版名列表；无发行版时输出"没有已安装的分发"｜副作用：无。`tr -d '\0'` 去除 wsl.exe 的 UTF-16 空字节。
- 场景：无交互安装发行版｜`wsl.exe --install -d <Distro> --no-launch`｜前提：`--list --online` 中存在该名｜成功信号：提示可用 `wsl.exe -d <Distro>` 启动｜副作用：下载数百 MB；默认用户未设置，后续以 `-u root` 进。
- ⚠️ 场景：发行版内非交互装包（root 级系统写入，按需执行）｜`wsl.exe -d <Distro> -u root -- sh -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update -qq && apt-get install -y -qq <pkg>'`｜成功信号：`<pkg> --version` 出版本｜实测：Ubuntu-26.04 + gcc-multilib → gcc 15.2.0。
- 场景：以 Windows 工作目录跑 WSL 命令且脚本捕获干净｜`WSL_UTF8=1 wsl.exe --cd "$(pwd -W)" -- <cmd> 2>/dev/null`｜前提：Git Bash（`pwd -W` 给 Windows 路径）｜成功信号：stdout 仅命令自身输出。
- 场景：32 位 Linux ELF 链接（有 libc 依赖）｜`gcc -m32 -no-pie -o <out> <out>.s`｜前提：gcc-multilib｜说明：`as --32` + 裸 `ld -m elf_i386 -dynamic-linker /lib/ld-linux.so.2 -lc` 缺 crt1.o 会丢入口，gcc 等价且产物同为 `ELF 32-bit LSB executable … dynamically linked`；`-no-pie` 匹配非 PIC 教学模型。
- 场景：Windows 侧交叉验证 AT&T 32 位汇编语法｜`C:/msys64/usr/bin/as --32 -o x.o x.s`｜说明：产出 COFF 非 ELF，仅验语法；`.size` 指令报 ignored/junk 为 COFF 噪声，Linux ELF 合法。

## 待验证与不适用边界

- 两条 Skill 增量已于 2026-11-19 经用户确认执行（gua-dev-tools 通用铁律追加 wsl.exe 条目、gua-writer 输出要求 §4 追加命令排版约束）；gua-dev-tools 的 `scripts/check-skills.mjs` 因 shell 故障未跑，但改动为无链接纯文本 bullet，不触静态检查风险面。
- 分层验收法的成本前提：替代 oracle 只服务于"环境恢复前的信心"，不改变卡面验收标准；环境恢复后必须补跑运行门，不得以语法门/语义门冒充终验。
- 三档搬运分析中的"天/周/月"为估计，未排期未立项。
- cbmini（E:\ggbdpq\gh\cbmini）与 lang-rs 代码均未提交；shell 故障（Git Bash ENOENT）会话结束时尚未修复，后续命令类工作需先恢复。
