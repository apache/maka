# Maka CLI

[English](./README.md)

Maka 是一个本地优先的 Agent 工作空间。`maka-agent` npm 包包含交互式终端界面、非交互
CLI、Runtime Host 工具和 Eval 命令。

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

`maka-agent` 是 `maka` 的别名。一次性运行请使用 `npx --yes maka-agent@next`；npm 上与本项目
无关的 `maka` 包不是本项目。

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
[安全策略](https://github.com/maka-agent/maka-agent/blob/main/SECURITY.md)。

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

## 卸载

```sh
npm uninstall --global maka-agent
```

卸载 npm 包不会删除模型连接、凭证、会话或 Artifact。它们仍保留在发布版 CLI 与 Desktop
共用的 profile 中：

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
[Eval 文档](https://github.com/maka-agent/maka-agent/tree/main/packages/eval)。

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

请在 <https://github.com/maka-agent/maka-agent/issues> 报告问题。

## 链接

- [代码仓库](https://github.com/maka-agent/maka-agent)
- [发布操作手册](https://github.com/maka-agent/maka-agent/blob/main/docs/cli-npm-release.zh-CN.md)
- [许可证](https://github.com/maka-agent/maka-agent/blob/main/LICENSE)
