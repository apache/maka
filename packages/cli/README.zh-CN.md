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
CLI、Runtime Host 工具和 Eval 命令。该包发布在 `nightly` dist-tag 上；`latest` 指向一个
早期 alpha stub（见[安装](#安装)）。

## Apache 孵化免责声明

Apache Maka 正在 Apache Software Foundation 孵化。发布到 npm 的英文 README 会直接从
release commit 中的 [DISCLAIMER-WIP](https://github.com/apache/maka/blob/main/DISCLAIMER-WIP)
注入权威的完整 work-in-progress disclaimer；当前状态另见
[Maka podling 状态页](https://incubator.apache.org/projects/maka.html)。本段仅为中文说明，
英文免责声明以随包发布的 `DISCLAIMER-WIP` 为准。

> **Beta**：CLI 仍在积极开发中，稳定版发布前，命令和本地数据格式可能发生变化。

## 环境要求

- Node.js 22.19.0 或更高的 22.x 版本，或 24.0.0 及以上版本（不支持 Node 23）；
- 使用 TUI 时需要支持交互输入的终端；
- 执行 Agent Turn 时需要已经配置的模型连接；首次设置目前支持使用 API Key 的供应商。

发布门禁会验证以下安装态矩阵：

| 平台 | 架构 | Node.js | TUI、CLI、Runtime Host | 真实 Harbor/Pier Eval |
| --- | --- | --- | --- | --- |
| Linux | x64 | 22.19 | 已验证 | 仅验证 preflight |
| Linux | x64 | 24 | 已验证 | 已验证 |
| Linux | arm64 | 24 | 已验证 | 仅验证 preflight |
| macOS | arm64 | 24 | 已验证 | 仅验证 preflight |
| Windows | x64 | 24 | 已验证 | 仅验证 preflight |

满足 Node.js 最低版本的其他组合也可能可用，但不属于当前发布门禁。真实 Eval executor
目前只在 Linux x64 和 Node.js 24 上验证。

## 安装

npm 上有两条 dist-tag，且二者不可互换：

- `nightly` 承载完整的 CLI。该发布线每日推进——请解析 tag 本身（或查询其当前版本），不要誊写任何文档里的版本号：

  ```sh
  npm install --global maka-agent@nightly
  maka --version
  maka --help
  ```

- `latest` 指向一个早期 alpha（`0.0.0-alpha.0`），命令面只有 `doctor`、帮助与版本命令。
  因此不要使用裸的 `npm update --global maka-agent`：它跟随 `latest`，可能把安装切换到
  另一条发布线。

公开命令只有 `maka`。一次性运行请使用 `npx --yes --package maka-agent@nightly maka`；npm 上与本项目
无关的 `maka` 包不是本项目。`runtime-host service install` 使用上面的持久全局安装；
`runtime-host setup` 会从 `npx` 调用的精确 package 创建自己的托管副本。

## 容器

从精确的已发布 npm 版本构建和运行本地 glibc CLI 镜像，并持久化配置，见
[容器指南](https://github.com/apache/maka/blob/main/packages/cli/container/README.md)。

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


主代理可以请求结构化结果，或显式提交后返回：

```sh
maka run "检查这个项目" --json
maka run "检查这个项目" --no-wait
```

这两种调用的 JSON 结果都包含 `sessionId`。普通调用仍默认等待并输出最终答案。
`--no-wait` 在提交被接收后返回；使用会话 ID 查询后续结果。假设返回的会话 ID 保存在
`$session` 中：

```sh
maka run --session "$session" --status
maka run --session "$session" --wait --json
maka run --session "$session" --answer '["是",null]' --wait --json
maka run --session "$session" "接下来检查测试" --queue --wait --json
maka run --session "$session" "重点检查参数解析" --steer --no-wait
maka run --session "$session" --result --json
maka run --session "$session" --resume --wait --json
```

会话控制（`--session`）与继承模型、工作目录一样，继承 Host 已保存的权限。续跑、queue、
steer 和回答问题不需要重复 `--yolo`，也不会改变执行边界；只有要显式授予完整权限时才加
`--yolo`。`--status` 会报告 `executionBoundary`：受管 `read_only`/`writable`、bypass 或 external。
只读任务描述不等于强制只读沙箱，继承 bypass 的会话依然是完整权限。旧阻塞选择器
`--resume <id>` 对 bypass 会话仍保留显式 `--yolo` 要求。

内置 AskUser 是普通阻塞运行的例外：它会输出问题 JSON 而不是最终答案。脚本应使用 `--json`
并检查 `status`，不能仅凭退出码 0 判断任务完成。普通内置 AskUser 会以退出码 0 返回
`needs_input`、问题及选项，Host 保留等待中的 Turn。
`--answer` 使用 JSON 数组，为每个问题提供一个字符串或 `null`，回答后原工具调用和原 Turn
继续执行，无需 `--resume`。答案提交失败或结果不确定时不会自动重发；先重新读取当前问题，
再决定下一步。存在多批待回答问题时会如实报告，无法唯一选择当前批次时拒绝提交答案。

对于 Host 持有的会话执行，`--wait` 和 `--status` 遇到沙箱扩展请求会返回 `needs_approval`，
并在 `approvalRequests` 中列出 `kind`、扩展范围 `expansion` 和理由 `justification`；内部请求
ID 不暴露。查看范围后，选择批准或拒绝：

```sh
maka run --session "$session" --approve --wait --json
maka run --session "$session" --deny --wait --json
```

上面两条命令是二选一，不能顺序执行。它们都继续原 Turn，要求会话中恰好有一个待处理沙箱
请求；没有请求或存在多个请求时拒绝提交决定。它们无需 `--yolo`，也不能与之混用。批准通过
Host 扩展受管沙箱边界，并保存供该会话后续执行使用，不会将会话切换为 bypass。命令针对
本次连接时待处理的请求；结果
不确定时不要自动重试，应先读取当前请求，再决定下一步。普通阻塞运行仍保留原有的沙箱
边界自动拒绝行为。

协调线程推荐先后台入队，再处理会话交互：

```sh
maka run --session "$session" "接下来检查测试" --queue --no-wait --json
maka run --session "$session" --wait --json
```

提交回执中的 `submission` 为 `started`、`queued` 或 `steering`，只表示接收方式；`status`
描述当前观察到的会话，不表示刚提交的消息已完成。排队回执可同时带有 `needs_input` 和当前
Turn 的问题，或 `needs_approval` 和沙箱请求；先回答交互，后续消息才能执行。`queued` 是观察到
的后续消息与 steer 总数，不是精确排队位置；回执快照未追上接收结果时省略该计数，
可用 status 读取新状态。Host 发布重试状态时，status 还会带上
`providerRetry`，不会根据静默时间猜测活动。

默认使用 queue，每条显式排队消息对应一个独立后续 Turn。steer 沿用 Host 当前 Turn 的追加
机制，错过最后处理边界时可能进入后续 Turn。提交排队消息时的 `--wait` 跟踪该消息对应的执行，不会返回前一 Turn 阻塞队列的问题；
这类问题要通过独立的会话 wait/answer 处理，或采用上面的协调流程。steer 配合 `--wait` 观察连接时选定的
Turn，不保证追加消息一定在该 Turn 结束前消费。
单独 `--wait` 在连接时固定目标，空闲时读取最近结果。`--result` 不等待仍在执行的 Turn。
状态和结果查询不准备模型、不启动 MCP。用 Ctrl+C 退出会话观察会让 Host 继续执行；旧阻塞
run 的取消行为保持原样。显式停止 Host 执行可用 `maka run --session "$session" --stop --json`。
停止操作针对连接时观察到的当前 Turn，不需要 `--yolo`，请求成功退出 0。显式或隐式的 status
查询成功时也退出 0，即使它报告的 Turn 已失败或取消；result/wait 仍以任务失败返回非零退出码。
停止或查询成功不代表分配的任务已完成。

权限请求、MCP 表单等会话 CLI 无法回答的交互会留在 Host 中等待。wait 会报告实际交互类型和恢复
命令：使用同一 Host 的交互式客户端处理，或显式停止该 Turn。后台提交成功不保证后续执行
不会请求交互。

会话控制使用已保存的配置。需要指定配置、cwd、timeout 或 Graph 选项的阻塞运行，继续使用
兼容入口 `--resume <session-id>` 选择会话并提供新 prompt。`--session <id> --resume` 则表示
安全恢复已停止的执行。空闲会话的新 prompt 可以使用 `--max-steps`，排队或 steer 消息不能
给已有 Turn 附加步数上限。

当前不支持客户端 MCP 交互返回后由另一个 CLI 进程续接。阻塞 MCP 运行保留现有行为；
`--no-wait` 会拒绝脱离本次调用持有的 MCP servers。Graph 交互交接也暂缓。执行本地会话控制
及后台提交时使用持久 CLI 安装；临时 npx 调用可能持有 Host 生命周期，继续使用旧阻塞路径。

仓库的 `maka-cli` skill 提供主/子代理 CLI 协作指引；待其进入所选分支后可安装。
skill 本身不安装 Maka CLI：

```sh
npx skills add apache/maka --skill maka-cli
```

## 升级

在 nightly 线内更新时固定精确版本（`--target` 只接受 `latest`、`next` 或精确的 Maka
版本号——不存在 `nightly` 这个 channel 名）。先解析当前 nightly 版本再传入精确值：
updater 拒绝降级，nightly 前进之后誊写的旧版本号会被直接拒绝。

```sh
version="$(npm view maka-agent@nightly version --registry=https://registry.npmjs.org)"
maka update --target "$version"
maka --version
```

不要使用裸的 `npm update --global maka-agent` 来升级：它跟随 `latest`（早期 alpha stub），
可能把安装切换到另一条发布线。

更新流程会先 stage 并验证精确 release，再替换本地 Runtime Host 与 npm-global package；
默认不会中断 active 或 durable work。只有在你确认可以安全中断后，才使用
`--allow-interrupt-active-tasks`。`npm install --global maka-agent@nightly` 仍可用于修复安装。

## 设置远程 Runtime Host

在 Linux 或 macOS 上从精确的发布 package 设置持久 remote Runtime Host：

```sh
npx --yes --package maka-agent@nightly maka runtime-host setup \
  --principal my-client \
  --preset terminal-client
```

重复设置会替换该 Client credential。设置成功后，service 不再依赖临时 `npx` cache。

检查 managed service 应跟随的 nightly 发布，且不改变当前运行中的 Host——传入上面解析出的
精确版本，而不是指向早期 alpha 的 `latest`：

```sh
maka runtime-host service check-update --target "$version" --json
```

结果会把频道固定为精确版本和 package integrity，并说明 package 是否提供足够的兼容性证据，
可供无人值守流程使用；该命令不会安装或切换 package。安装管理方可以把同一
selector 传给 `service update --target`。该路径会先校验 archive 与解包后的 manifest，再委托给
现有的精确 package 更新事务；需要人工审查的候选不会改变当前 Host。

Installation owner 可以持久化一个更新目标，并通过同一套已验证事务执行 reconciliation。持久化
上面解析出的精确 nightly 版本：不存在 `nightly` 这个 target 名，而 `latest` 指向早期 alpha，
reconciliation 会把对一个 nightly 安装而言更旧的候选判为降级。因此要跟随每日推进的 nightly，
就需要重新解析当前版本，并用新值再次运行 `update-policy`：

```sh
maka runtime-host service update-policy --target "$version" \
  --expected-service-id <service-id> \
  --expected-root-path <state-root> \
  --expected-root-id <root-id>
maka runtime-host service reconcile-update --json
```

使用 `update-policy --target manual` 关闭自动 reconciliation。Reconciliation 是有界的单次命令：
它不会中断 active work，也不会安装 scheduler。

## 卸载

```sh
# 仅限安装过 managed Runtime Host service 的 Linux 或 macOS
npx --yes --package maka-agent@nightly maka runtime-host service uninstall

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
