---
name: windows-dev-preflight
description: Use when running any command on this Windows machine for the first time in a session — python/python3, powershell -File, go build/test, pnpm, or passing temp paths to Windows-native programs — before writing the command. Also use when a command already failed with exit 127 on a .ps1 path, exit 9009 or silent no-output failure, UnicodeEncodeError 'gbk' codec, proxy.golang.org timeout, fnm "can't find the necessary environment variables", or "Shell cwd was reset".
---

# Windows 开发环境预检（本机）

## Overview

本机（中文 Windows 11 + Git Bash）的一切环境坑共享同一个根源：**Git Bash 的 POSIX 视图与 Windows 原生程序的 Win32 视图之间的摩擦**——路径、编码、解释器、代理四类命令在这个摩擦面上稳定翻车。它们不是偶发故障，是本机固定事实。

核心原则：**修正写在命令里，不留给失败后排查。**

## When to Use

- 会话中**首次**要执行 python / `powershell -File` / go / pnpm / 任何向 Windows 原生程序传路径的命令——写命令前对照形态表
- 命令已失败且报错命中 Common Mistakes 表任一症状——按表诊断
- 同一会话第二次以后无需重复检查

不适用：纯 Git Bash 内部命令（grep/ls/sed/cat）、WSL 或远程/Linux 环境、写代码逻辑本身。

## 命令形态速查（写命令前对照）

| 意图                           | 本机正确形态                                                                         | 为什么                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 跑 python 脚本                 | `PYTHONUTF8=1 /d/DevTools/Languages/Backend/Python/python 脚本.py`                   | PATH 里的 `python`/`python3` 命中的是 Windows Store stub；控制台默认 GBK |
| 跑 .ps1 脚本                   | `powershell -NoProfile -ExecutionPolicy Bypass -File custom-addon/scripts/build.ps1` | Git Bash 把 `\` 吃成转义符，路径必须用正斜杠                             |
| go 拉依赖/构建                 | `GOPROXY=https://goproxy.cn,direct go build ./...`                                   | 默认 `proxy.golang.org` 直连超时                                         |
| 跨盘复合命令                   | `cd /e/guahub/gh/x; go build`（用 `;` 不用 `&&`）                                    | E 盘 cd 触发 fnm hook 报错并断 `&&` 链                                   |
| `/tmp` 路径传 Windows 原生程序 | `REPORT_DIR=$(cygpath -m /tmp/foo)` 再传变量                                         | Git Bash 的 `/tmp` 在 Win32 视图不存在                                   |

## 本机事实

- 真实 python 解释器：`D:\DevTools\Languages\Backend\Python\python`；`which python3` 显示的 WindowsApps 路径是 stub
- 环境变量 SSOT 是 `setup-dev-env.ps1`——改注册表必须同步改脚本
- fnm 报 `can't find the necessary environment variables` 是 shell profile 噪声，**不阻断命令**，忽略即可

## Common Mistakes（真实失败实录，2026-08 两个会话归纳）

| 报错原文                                                         | 根因                       | 修正                                |
| ---------------------------------------------------------------- | -------------------------- | ----------------------------------- |
| exit 127，PowerShell 提示「-File 格式参数后实际参数 xxx 不存在」 | 反斜杠路径被 bash 转义吃掉 | 用正斜杠重写整条路径                |
| `UnicodeEncodeError: 'gbk' codec can't encode character`         | 控制台默认 GBK 编码        | 加 `PYTHONUTF8=1` 前缀重跑          |
| 命令无任何输出、exit 9009                                        | 命中了 Store stub 静默失败 | 用绝对路径调真实 python             |
| `go: downloading ... ` 卡住后 timeout                            | proxy.golang.org 不可达    | `GOPROXY=https://goproxy.cn,direct` |
| `Shell cwd was reset` + 复合命令后半段没执行                     | 跨盘 cd 断 `&&` 链         | 复合命令改用 `;` 连接               |

## 边界

- 本表是本机快照（2026-09 校准），换机或重装工具链后须重新校准
- 探测优先于记忆：`which python3 python`、`go env GOPROXY` 一次性确认，同会话不再重复
