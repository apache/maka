# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目目标

百分百逆向还原 `cursor-byok-windows-amd64.exe`（v0.0.35，来自 leookun/cursor-byok）。

- 目标文件：`cursor-byok-windows-amd64.exe`（50.88 MB，Go 1.26.3 + Wails v3 + Vue 3）
- 开源对照蓝本：`work/04_crosscheck/cursor-byok-server-main.go`（Apache-2.0，756 行）
- 学习指南：`REVERSE_GUIDE.md`（记录每一步的工具安装、skill 调用、决策逻辑）

## 环境变量

| 变量 | 值 | 用途 |
|------|-----|------|
| `JAVA_HOME` | `D:\DevTools\Language\Java\jdk-21.0.11.10-hotspot` | Ghidra 12.1.2 必须 JDK 21+ |
| `GHIDRA_INSTALL_DIR` | `D:\DevTools\Web\ghidra_12.1.2_PUBLIC` | Ghidra 安装目录 |
| `IDADIR` | `D:\DevTools\Web\IDA Professional 9.3` | IDA Pro（headless 受 license 限制） |
| `_JAVA_OPTIONS` | `-Xmx8G` | Ghidra 分析超大 Go 二进制需要 8GB 堆 |

## 工具链路径

| 工具 | 路径 | 版本 |
|------|------|------|
| Go | `D:\DevTools\Language\Go\bin\go.exe` | 1.26.4 |
| Python | `D:\DevTools\Language\Python\python.exe` | 3.12.10 |
| JDK | `D:\DevTools\Language\Java\jdk-21.0.11.10-hotspot\bin\java.exe` | 21.0.11 |
| Ghidra headless | `D:\DevTools\Web\ghidra_12.1.2_PUBLIC\support\analyzeHeadless.bat` | 12.1.2 |
| PyGhidra | Python `import pyghidra` | 3.1.0 |
| GoReSym | `D:\DevTools\Language\GoPath\bin\GoReSym.exe` | 1.7.1 |
| redress | `D:\DevTools\Language\GoPath\bin\redress.exe` | 1.2.77 |
| ReVa MCP | `mcp-reva`（装后） | via pip |
| gofmt | `D:\DevTools\Language\Go\bin\gofmt.exe` | 1.26.4 |

## 工作区结构

```
work/
├── 00_triage/              buildinfo, symbols, project_map, 工具链报告
│   ├── toolchain_check.md  阶段 0 交付物
│   ├── project_map.md      阶段 1 核心交付物（29 包 + 架构 + 还原路线）
│   ├── business_funcs.txt  2158 业务函数工作底单（去 protobuf gen）
│   └── ...
├── 01_ida/                  Ghidra 工程（.gpr）+ 脚本
│   └── scripts/ghidra_smoke.py   Ghidra 烟雾测试
├── 02_reconstructed_src/    按包还原的 Go 源码（核心交付物）
│   └── cursor/internal/
│       ├── backend/server/upstream/   client.go（BuildCursorChecksum + 转发链）
│       ├── backend/agent/protocol/    inbound.go（DecodeAgentClientMessage）
│       ├── buildinfo/                 buildinfo.go
│       ├── modelchannel/              identity.go + resolve.go
│       └── certs/                     ca.go
├── 03_frontend/             前端资源（待提取）
├── 04_crosscheck/           与开源对照
│   ├── cursor-byok-server-main.go   开源蓝本
│   └── diff_notes.md                协议函数对照表
└── REVERSE_REPORT.md        阶段报告
```

## 当前进度

**已完成：**
- 阶段 0：工具链全部就绪
- 阶段 1：redress 符号测绘 + project_map（29 包，2158 业务函数）
- M3 协议核心：upstream/client.go + protocol/inbound.go（开源对照高可信）
- M1/M2 部分简单包：buildinfo + modelchannel + certs（符号推断中可信骨架）
- REVERSE_REPORT.md + REVERSE_GUIDE.md

**进行中：**
- Ghidra headless 分析 cursor-byok exe（后台 task，8GB 堆）
- 装 ReVa MCP（cyberkaida/reverse-engineering-assistant）

**待做：**
- M3 剩余：mitm 层 TLS 拦截（需反编译）
- M4：backend 路由表 + agent/model 适配器（168 函数）
- M5：forwarder agent 引擎（920 函数）+ bridge 工具桥
- M1/M2 剩余：appdata/logger/cursor/main/app
- 前端 Vue 资源提取
- 所有 stub 函数验证（ReadAppendRequestID、ResolveAdapterIndex 等）

## 常用命令

```bash
# Ghidra headless 加载 exe 分析（必须设 _JAVA_OPTIONS=-Xmx8G）
export JAVA_HOME='D:\DevTools\Language\Java\jdk-21.0.11.10-hotspot'
export GHIDRA_INSTALL_DIR='D:\DevTools\Web\ghidra_12.1.2_PUBLIC'
export _JAVA_OPTIONS='-Xmx8G'
"$GHIDRA_INSTALL_DIR/support/analyzeHeadless.bat" \
  "E:/agents-product/_archives/learn-reverse/work/01_ida" cursor_byok_project \
  -import "E:/agents-product/_archives/learn-reverse/cursor-byok-windows-amd64.exe" -overwrite

# redress 符号恢复（GoReSym 不兼容 Go 1.26，用 redress）
redress info <exe>
redress packages <exe>
redress source <exe>
redress types all <exe>

# go version -m dump buildinfo（第一步黄金命令）
go version -m <exe>

# 还原代码 gofmt 验证
gofmt -w <file.go>

# 提取 cursor 业务包函数清单
python extract_business.py

# ReVa MCP 启动（装后）
mcp-reva
```

## 关键踩坑

- GoReSym v1.7.1 **不支持 Go 1.26 pclntab**，用 redress 替代
- redress 1.2.77 改**子命令风格**（`packages`/`source`/`types`），非旧 `-pkg/-src/-type` flag
- idalib headless **受 license 限制**，`open_database` 崩溃，深度反编译转 Ghidra
- Ghidra 12.1.2 要求 **JDK 21+**，内置 Go 1.15-1.25 类型数据库
- Ghidra 分析超大 Go 二进制必须设 **-Xmx8G**，默认 2G 会 JVM 崩溃
- Python 不要用 **3.14**（JPype 缺 wheel，PyGhidra 装不上），用 3.12
- GitHub raw 被墙，**jsdelivr CDN** 走通
- precedent-reverse.md 记录**可能过时**，实测为准
