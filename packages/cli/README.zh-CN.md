<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Apache Maka（孵化中）CLI

[English](./README.md)

Maka 是一个本地优先的 Agent 工作空间。`maka-agent` npm 包包含交互式终端界面、非交互
CLI、Runtime Host 工具和 Eval 命令。

## Apache 孵化免责声明

Apache Maka 正在 Apache Software Foundation 孵化。发布到 npm 的英文 README 会直接从
release commit 中的 [DISCLAIMER-WIP](https://github.com/apache/maka/blob/main/DISCLAIMER-WIP)
注入权威的完整 work-in-progress disclaimer；当前状态另见
[Maka podling 状态页](https://incubator.apache.org/projects/maka.html)。本段仅为中文说明，
英文免责声明以随包发布的 `DISCLAIMER-WIP` 为准。

> **Beta：**CLI 仍在积极开发中，稳定版发布前，命令和本地数据格式可能发生变化。

## 环境要求

- Node.js 22.19.0 或更高版本；
- 使用 TUI 时需要支持交互输入的终端；
- 执行 Agent Turn 时需要已经配置的模型连接；首次设置目前支持使用 API Key 的供应商。

发布门禁会验证以下安装态矩阵：

| 平台 | 架构 | Node.js | TUI、CLI、Runtime Host | 真实 Harbor/Pier Eval |
| --- | --- | --- | --- | --- |
| Linux | x64 | 22.19 | 已验证 | 仅验证 preflight |
| Linux | x64 | 24 | 已验证 | 已验证 |
| macOS | arm64 | 24 | 已验证 | 仅验证 preflight |
| Windows | x64 | 24 | 已验证 | 仅验证 preflight |

满足 Node.js 最低版本的其他组合也可能可用，但不属于当前发布门禁。真实 Eval executor
目前只在 Linux x64 和 Node.js 24 上验证。

## 安装

Beta 阶段请明确从 `next` dist-tag 安装：

```sh
npm install --global maka-agent@next
maka --version
maka --help
```

公开命令只有 `maka`。一次性运行请使用 `npx --yes --package maka-agent@next maka`；npm 上与本项目
无关的 `maka` 包不是本项目。`runtime-host service install` 使用上面的持久全局安装；
`runtime-host setup` 会从 `npx` 调用的精确 package 创建自己的托管副本。

## 第一次运行

进入希望 Agent 工作的项目目录，然后启动 Maka：

```sh
cd path/to/project
maka
```

如果还没有模型连接，Maka 会自动打开供应商设置流程。选择供应商、输入 API Key、选择要
启用的模型并保存。之后可以运行 `/setup` 添加或更新供应商，使用 `/model` 切换模型。

API Key 和工作空间状态保存在本机的 `Maka` profile 中。当前 credential vault 是受操作系统
账号边界保护的本地明文文件；在 POSIX 系统上，Maka 会强制使用仅 owner 可访问的目录和文件
权限。它不是操作系统 Keychain。当前边界详见仓库的
[安全策略](https://github.com/apache/maka/blob/main/SECURITY.md)。

执行一次非交互 Turn：

```sh
maka run "总结这个项目并指出风险最高的部分"
maka run --help
```

Maka 默认会在执行高权限工具操作前询问。`maka run --yolo` 会授予该任务完整的文件和网络
权限，只应在你允许任务修改的环境中使用。

## 升级

使用预发布版本时，请继续明确指定 `next`：

```sh
npm install --global maka-agent@next
maka --version
```

Beta 升级不要使用不带 tag 的 `npm update --global maka-agent`：npm 的全局更新会跟随
`latest`，可能选中不同的发布线。稳定版发布后，使用
`npm install --global maka-agent@latest` 安装。

## 设置远程 Runtime Host

在 Linux 或 macOS 上从精确的发布 package 设置持久 remote Runtime Host：

```sh
npx --yes --package maka-agent@next maka runtime-host setup \
  --principal my-client \
  --preset terminal-client
```

重复设置会替换该 Client credential。设置成功后，service 不再依赖临时 `npx` cache。

可以在不改变当前 Host 的情况下检查 managed service 对应的发布频道：

```sh
maka runtime-host service check-update --target next --json
```

结果会把频道固定为精确版本和 package integrity，并说明 package 是否提供足够的兼容性证据，
可供未来的无人值守更新使用；该命令不会安装或切换 package。更新程序仍须以该 integrity
校验下载的 archive，并从解压后的 package manifest 中再次确认兼容性值。

## 卸载

```sh
# 仅限安装过 managed Runtime Host service 的 Linux 或 macOS
npx --yes --package maka-agent@next maka runtime-host service uninstall

# 如果曾全局安装 Maka
npm uninstall --global maka-agent
```

先删除 managed service，再卸载 npm 包，避免 OS service manager 留下指向已删除 CLI 的
service。这两个命令都不会删除模型连接、凭证、会话或 Artifact。它们仍保留在发布版 CLI 与
Desktop 共用的 profile 中：

| 平台 | Profile 目录 |
| --- | --- |
| macOS | `~/Library/Application Support/Maka` |
| Linux | `$XDG_CONFIG_HOME/Maka`；未设置时为 `~/.config/Maka` |
| Windows | `%APPDATA%\Maka` |

只有在确实要删除全部本地 Maka 数据时，才应单独备份并删除该目录。操作前先关闭 CLI 和
Desktop 应用。

## Eval

运行声明式实验：

```sh
maka eval run experiment.json --out .maka-eval/run-001
```

npm 包包含 Maka 自有的 Eval runtime、relay、wrapper 和容器策略资源，但不会安装 executor
所需的外部软件或机器本地 benchmark 数据。Eval 会在启动任何 trial 前检查 spec 声明的精确
前置条件；缺少任意一项时会在不运行 cell 的情况下失败。

运行基于 Docker 的 Harbor 或 Pier spec 时，需要提供：

- 可访问的 Docker CLI 和 daemon；
- 包含 `executor.config.frameworkVersion` 所声明精确版本的独立 Python 环境；
- 通过 `pythonPathEnv` 所命名的环境变量提供可执行的解释器；
- 通过 `trialsRootEnv` 提供可写的 trial 目录；
- Pier 还需要通过 `tasksRootEnv` 提供 task 目录；
- spec 声明的所有机器路径和 subject 凭证环境变量。

Harbor 和 Pier 必须使用不同的 Python 环境。当前验证过的版本为：

```sh
python3.12 -m venv ~/.venvs/maka-harbor-0.20.0
~/.venvs/maka-harbor-0.20.0/bin/python -m pip install 'harbor==0.20.0'

python3.12 -m venv ~/.venvs/maka-pier-0.3.0
~/.venvs/maka-pier-0.3.0/bin/python -m pip install 'datacurve-pier==0.3.0'
```

把 spec 的 `pythonPathEnv` 指向相应的 `bin/python`。不要让两个 framework 复用一个环境：
它们的依赖和 trial contract 不同。高级实验和 toolchain 说明位于
[Eval 文档](https://github.com/apache/maka/tree/main/packages/eval)。

## 故障排查

先记录实际安装版本：

```sh
node --version
npm --version
maka --version
```

- 全局安装后找不到 `maka` 时，确认 npm 的全局可执行目录已经加入 `PATH`；
- 没有可用模型时，启动 TUI 并运行 `/setup`；
- Eval 拒绝启动时，根据错误中给出的环境变量名和预期 framework 版本修复环境；Eval 不会
  自动安装或静默替换缺失的前置条件；
- 报告问题时，请提供以上三个版本、操作系统和架构、执行的命令，以及移除凭证后的完整
  错误信息。

请在 <https://github.com/apache/maka/issues> 报告问题。

## 链接

- [代码仓库](https://github.com/apache/maka)
- [发布操作手册](https://github.com/apache/maka/blob/main/docs/cli-npm-release.zh-CN.md)
- [许可证](https://github.com/apache/maka/blob/main/LICENSE)
