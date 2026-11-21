# Go 二进制逆向还原 - 学习指南

> 目标：百分百还原 `cursor-byok-windows-amd64.exe`（Go 1.26.3 + Wails v3 + Vue 3，50.88 MB）
> 版本：v0.0.35
> 日期：2026-06-25 开始

## 一、逆向工程通用流程

### 1.1 整体路线图

拿到一个二进制 → 分诊 → 符号恢复 → 架构分析 → 反编译 → 源码重建

```
阶段 0：工具链准备          （1-3小时，一次性投入）
阶段 1：符号测绘与项目地图  （1-2小时）
阶段 2：分诊定位            （2-4小时，如果符号充足可跳过）
阶段 3：按包深度还原        （主体工作，按规模决定周/月）
阶段 4：对照验证            （如果有开源蓝本，最高ROI）
阶段 5：前端还原            （桌面应用/网页应用场景）
阶段 6：报告沉淀            （固化认知，供后续接续）
```

### 1.2 工具链全景

| 类别 | 工具 | 用途 | 安装方式 |
|------|------|------|----------|
| Go 逆向 | GoReSym | Go 符号恢复（pclntab解析） | `go install github.com/mandiant/GoReSym@latest` |
| Go 逆向 | redress | Go 符号/包/类型/源文件恢复 | `go install github.com/goretk/redress@latest` |
| 静态分析 | Ghidra 12.1.2 | 免费反编译平台，Go 原生支持 | 官网下载 zip 解压 |
| 静态分析 | IDA Pro 9.3 | 商业反编译，Hex-Rays 伪代码 | 商业软件，需 license |
| Ghidra 驱动 | PyGhidra 3.1.0 | Ghidra 的 Python 绑定 | `pip install <ghidra>/Ghidra/Features/PyGhidra/pypkg/dist/pyghidra-*.whl` |
| Ghidra 驱动 | ReVa MCP | Ghidra MCP 服务器，HTTP 接口 | 从 GitHub 下载 Extension + 安装 |
| IDA 驱动 | ida-pro-mcp | IDA MCP 服务器（headless/GUI） | `pip install ida-pro-mcp` |
| Go 标准 | Go 1.26+ | `go version -m <exe>` 提取 buildinfo | 官网 go.dev |
| Python | Python 3.14 | 脚本驱动 | 官网 python.org |
| Java | JDK 21+ | Ghidra 运行依赖 | 官网 adoptium.net |

### 1.3 关键命令速查

```bash
# 拿到一个 Go 二进制，先看它的"身份证"
go version -m target.exe              # dump 完整 buildinfo（Go版本、依赖树、构建参数）

# 符号恢复（二选一，冗余保障）
GoReSym -t -d -p target.exe > symbols.json          # GoReSym 全量符号
redress info target.exe                               # redress 摘要（Go版本、包数）
redress packages target.exe                           # 列出所有包
redress source target.exe                             # 函数名 + 源文件 + 行号范围
redress types all target.exe                          # 类型列表

# 过滤业务包（去标准库和 vendor 噪声）
# redress source 默认只输出 main 包，43082 行全为 cursor 自身
# 提取 protobuf gen 包到单独文件，去 gen 后为业务函数工作底单

# Ghidra 启动（headless）
set GHIDRA_INSTALL_DIR=D:\DevTools\Web\ghidra_12.1.2_PUBLIC
set JAVA_HOME=D:\DevTools\Language\Java\jdks\jdk-21.0.7  # 必须 JDK 21+
support\analyzeHeadless.bat <project_dir> <project_name> -import target.exe -scriptPath <script_dir> -postScript <analysis_script.py>
```

---

### 1.4 环境变量速查

| 变量 | 值 | 用途 |
|------|-----|------|
| `JAVA_HOME` | `D:\DevTools\Language\Java\jdk-21.0.11.10-hotspot` | Ghidra 12.1.2 要求 JDK 21+ |
| `GHIDRA_INSTALL_DIR` | `D:\DevTools\Web\ghidra_12.1.2_PUBLIC` | Ghidra 安装目录 |
| `PYTHON` | `D:\DevTools\Language\Python\python.exe`（Python 3.12.10） | PyGhidra 驱动 |
| `GOPATH\bin` | `D:\DevTools\Language\GoPath\bin` | GoReSym.exe / redress.exe 位置 |

### 1.5 本次安装的工具链（完整清单）

| 工具 | 版本 | 路径 | 安装命令 |
|------|------|------|----------|
| Go | 1.26.4 | `D:\DevTools\Language\Go\bin\go.exe` | go.dev 下载 |
| Python | 3.12.10 | `D:\DevTools\Language\Python\python.exe` | python.org 下载（**不要 3.14**，JPype 没有 wheel） |
| JDK | 21.0.11 (Temurin) | `D:\DevTools\Language\Java\jdk-21.0.11.10-hotspot` | adoptium.net 下载 |
| Ghidra | 12.1.2 PUBLIC | `D:\DevTools\Web\ghidra_12.1.2_PUBLIC` | GitHub Release 下载 zip 解压 |
| GoReSym | 1.7.1 | `D:\DevTools\Language\GoPath\bin\GoReSym.exe` | `go install github.com/mandiant/GoReSym@latest` |
| redress | 1.2.77 | `D:\DevTools\Language\GoPath\bin\redress.exe` | `go install github.com/goretk/redress@latest` |
| PyGhidra | 3.1.0 | `D:\DevTools\Language\Python\Lib\site-packages\pyghidra` | `pip install <ghidra>/Ghidra/Features/PyGhidra/pypkg/dist/pyghidra-3.1.0-py3-none-any.whl` |
| JPype1 | 1.5.2 | `D:\DevTools\Language\Python\Lib\site-packages\jpype1` | 随 PyGhidra 自动安装 |
| ReVa MCP | 待安装 | — | 从 GitHub 下载 Ghidra Extension |
| IDA Pro | 9.3 | `D:\DevTools\Web\IDA Professional 9.3` | 商业软件（**idalib headless 受 license 限制**，不能用） |

### 1.6 Ghidra 对超大 Go 二进制的内存要求

50 MB Go 二进制有 4 万多个函数，Ghidra 自动分析需要大量 Java 堆内存。

**默认 `-Xmx2G` 不够！** 实测会 JVM 崩溃（GC 线程 EXCEPTION_ACCESS_VIOLATION）。

**修复**：
```cmd
set _JAVA_OPTIONS=-Xmx8G
```
或在 `analyzeHeadless.bat` 的启动参数里传 `-maxmemory 8G`。

## 二、本次实战记录

### 2.1 阶段 0：工具链准备

**使用的 skill**：无，基础工具链搭建

**安装的工具**：

1. GoReSym v1.7.1
   ```bash
   export GOPROXY=https://goproxy.cn,direct
   go install github.com/mandiant/GoReSym@latest
   # 产出：D:\DevTools\Language\GoPath\bin\GoReSym.exe
   ```

2. redress v1.2.77
   ```bash
   go install github.com/goretk/redress@latest
   # 产出：D:\DevTools\Language\GoPath\bin\redress.exe
   ```

3. ida-pro-mcp 1.4.0（后续发现与 IDA license 不兼容）
   ```bash
   python -m pip install ida-pro-mcp -i https://pypi.tuna.tsinghua.edu.cn/simple
   ```

4. idapro wheel（IDA idalib 绑定）
   ```bash
   python -m pip install "D:\DevTools\Web\IDA Professional 9.3\idalib\python\idapro-0.0.7-py3-none-any.whl"
   ```

5. IDADIR 环境变量
   ```cmd
   setx IDADIR "D:\DevTools\Web\IDA Professional 9.3"
   ```

**踩坑记录**：
- GoReSym v1.7.1 不支持 Go 1.26 pclntab，转用 redress（工具链冗余）
- redress 1.2.77 改为子命令风格（`packages`/`source`/`types`），旧文档的 `-pkg/-src/-type` flag 已失效
- ida-pro-mcp 1.4.0 的 idalib-mcp 改为"启动即加载"模式（需传 input_path），start.ps1/open.ps1 两步模式不兼容
- idalib headless 的 `open_database` 受 license 限制崩溃，深度反编译转 Ghidra
- GitHub raw 国内被 reset，走 jsdelivr CDN 镜像

### 2.2 阶段 1：符号测绘

**使用的 skill**：无（直接调用 redress）

**产出**：
- `go version -m` → buildinfo.txt（Go 1.26.3，29 主包，关键依赖确认）
- `redress info` → Redis：29 主包 / 177 std / 118 vendor
- `redress packages` → packages.txt（29 包清单）
- `redress source` → sources.txt（43082 行，函数名 + 源文件 + 行号范围）
- `redress types all` → types.txt（94690 行）
- project_map.md（29 包架构图 + 还原优先级）

**关键决策**：
- GoReSym v1.7.1 失败（不兼容 Go 1.26），转用 redress 成功
- 发现 2158 个业务函数（去 protobuf gen 的 40681 个）
- forwarder 920 函数、agent/model 168 函数被标记为业务大包

### 2.3 阶段 2：分诊定位

**使用的 skill**：无（project_map.md 已超额完成分诊目标）

**产出**：
- business_funcs.txt（2158 业务函数工作底单）
- 确认 BuildCursorChecksum 在 `upstream/client.go:189-214`
- 确认 AnthropicAdapter.Stream 在 `agent/model/anthropic.go`（1176 行）
- 分层架构图：Cursor 客户端 → mitm TLS → backend 路由 → forwarder agent 引擎 → agent/model 适配 → upstream 转发

### 2.4 阶段 4：协议对照（与开源交叉验证）

**使用的 skill**：无（直接对照开源 main.go）

**开源蓝本**：`leookun/cursor-byok-server/main.go`（Apache-2.0，756 行），通过 jsdelivr CDN 获取

**产出**：
- diff_notes.md（协议函数对照表）
- 确认 BuildCursorChecksum 算法（seed=165, divisor=1e6, 6 字节大端 XOR + base64 + sha256[:32]）
- 确认 rewriteBidiAppendBody / decodeUnaryEnvelope / rewriteAgentClientMessage 等协议逻辑

### 2.5 阶段 3.1-3.4：按包还原（进行中）

**使用的 skill**：无（redress 符号 + 开源对照 + gofmt 验证）

**已完成的包**：

| 包 | 文件 | 可信度 | 方法 |
|---|---|---|---|
| backend/server/upstream | client.go | 高 | 开源对照 |
| backend/agent/protocol | inbound.go | 高/待验证 | 开源对照 + stub |
| buildinfo | buildinfo.go | 低 | 待反编译 |
| modelchannel | identity.go + resolve.go | 中 | 符号推断 |
| certs | ca.go | 中 | 符号推断 |

**待反编译**（需 Ghidra 解锁）：
- mitm（goproxy TLS 拦截）
- backend（Host 路由表）
- agent/model（Anthropic/OpenAI 适配器）
- forwarder（agent 引擎，920 函数）
- bridge/exec + bridge/interaction（工具桥）

---

## 三、学习的决策树

### 拿到一个二进制，第一步是什么？

```
1. go version -m binary         # Go 二进制专属身份证
2. GoReSym / redress            # 符号恢复
3. 如果有开源蓝本 → 对照还原（最高 ROI）
4. 如果没有 → IDA / Ghidra 反编译
5. 按包逐个还原，先简单后复杂
6. 写报告固化认知
```

### 什么时候用 IDA，什么时候用 Ghidra？

- 有 IDA Pro license 且 license 支持 headless → IDA（反编译质量最高）
- 免费 / headless 有 license 限制 / Go 二进制 → Ghidra（内置 Go 支持）
- 轻量快速侦察 → radare2 / rabin2

### 为什么工具链冗余很重要？

GoReSym 失败了 → redress 接上。idalib license 限制了 → Ghidra 接上。GitHub raw 被墙了 → jsdelivr CDN 接上。每一步都有备用方案，不因单一工具失败而阻塞。

---

## 四、当前进展（2026-06-25 更新）

### 源码重建进度

34 个 Go 源文件，覆盖全部 29 个包（100%），gofmt 全量通过。

**可信度分级**：
- **高可信**（开源对照 + 反编译验证）：upstream/client.go、protocol/inbound.go
- **中可信**（函数名 + Go 惯例 + 架构推断）：~350 函数（model、logger、updater、certs 等）
- **低可信**（骨架桩）：forwarder 深度实现、backend 路由表深度

### 工具链状态

| 工具 | 状态 | 备注 |
|------|------|------|
| Ghidra 12.1.2 | 分析成功（218s），42880 函数重命名，DecompInterface 管线 | Go 1.26 RTTI 不支持 |
| IDA Pro 9.3 | 仅 GUI，headless 受 license 限制 | — |
| GoReSym 1.7.1 | 不支持 Go 1.26 pclntab | — |
| redress 1.2.77 | **完整支持 Go 1.26**，是符号主要来源 | — |
| ReVa 7.3.0 | 已装 `.mcp.json`，待会话重载生效 | — |
| PyGhidra 3.1.0 | 已装但 JDK 探测有 PATH 问题 | — |

### 下一步

- Ghidra 升级支持 Go 1.26 ABI（或最终版 12.2+）
- 前端 Vue 资源从 .rsrc 段提取
- protobuf gen 用 Cursor 官方 .proto + protoc 重生成
- 对中低可信度函数逐函数 Ghidra 验证

### Grill 访谈决策树（19 个决策）

| # | 决策 | 结论 |
|----|------|------|
| 1 | 百分百还原定义 | B：核心逻辑完整还原，protobuf gen 用 proto 重生成 |
| 2 | Ghidra 驱动方式 | B：ReVa MCP（30+ 便捷工具，自动化批量回路） |
| 3 | 符号导入策略 | C：先 Ghidra 原生，不理想再补 redress 脚本 |
| 4 | 还原优先级 | A：从高到低验证已有成果，先打通回路 |
| 5 | ReVa 缺失去向 | D：先探测 Ghidra 环境状态 |
| 6 | JDK 21 安装 | A：我来下载安装 → 用户手动装 jdk-21.0.11.10-hotspot |
| 7 | Ghidra 驱动后续 | A：装 ReVa 拿完整 MCP 工具链 |
| 8 | JDK 21 位置 | D（探测）→ 确认只有 JDK 8，需安装 |
| 9 | Python 3.12.10 | 手动安装到 D:\DevTools\Language\Python |
| 10 | ReVa 安装通道 | B：jsdelivr CDN → 实际 pip install reverse-engineering-assistant |
| 11 | Ghidra 项目组织 | A：单项目全量分析，218 秒完成 |
| 12 | 分析等待期 | C+A：更新指南 + 下载 ReVa |
| 13 | ReVa 驱动模式 | C+A：先验证 Ghidra 项目，再启用 ReVa headless |
| 14 | Ghidra 成功后推进 | C：A+B（验证反编译 + 启动 ReVa） |
| 15 | MCP 注册方式 | A：写 .mcp.json |
| 16 | ReVa 就位后第一步 | A：BuildCursorChecksum 对照验证 |
| 17 | 等 ReVa 时的准备 | C：写对照矩阵 + grill M4/M5 |
| 18 | 巨型函数还原策略 | C：语义分区 + 逐块反编译 |
| 19 | forwarder 920 函数 | C：行数量化过滤 + 端点语义分组 |
| 20 | 验证流水线 | 分层选用（A/B/D 三级按行数深度） |
