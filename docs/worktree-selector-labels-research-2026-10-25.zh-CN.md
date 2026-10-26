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

# 工作树选择器文案调研

核对日期：2026-10-25。问题：composer 中，与「新建工作树」「已有工作树」对应的「主目录」应如何命名。以下区分官方文档明确给出的界面标签、文档解释用语和历史界面；不把文档术语冒充当前界面实测结果。

## 客户端对照

| 客户端 | 已核实表达 | 证据边界 |
| --- | --- | --- |
| Codex | `Local` / `Worktree`；文档定义原先由用户创建的检出为 `Local checkout`，应用简称 `Local` | 官方文档明确产品标签，composer 通过 `Worktree` 选择隔离目录。[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees) |
| Claude Code Desktop | `Worktree` 开关；关闭后在 `project folder` 中工作 | 官方操作文档明确开关标签，并用项目文件夹解释未隔离状态；没有证据表明存在名为 `Main directory` 的同级选项。[Desktop application](https://code.claude.com/docs/en/desktop#run-a-session-in-its-own-worktree) |
| Cursor | 当前文档用 `main checkout`、`main workspace` 描述原工作副本；旧下拉菜单为 `Local` / `Cloud` / `Worktree` | 当前术语来自官方 [Worktrees 文档](https://cursor.com/docs/configuration/worktrees)。旧标签来自官方论坛支持回复，且回复明确 Cursor 3 已移除旧 IDE 侧栏下拉菜单，不能作为当前界面标签使用。[历史界面说明](https://forum.cursor.com/t/can-i-still-start-cloud-agents-worktrees-from-the-sidebar/157427) |
| Conductor | 原目录称 `original repository checkout` / `project root`；隔离副本称 `workspace`，创建入口为 `New workspace` | 前两者是官方概念解释，后者是官方操作文档中的按钮名；没有核实到等同 Maka 的原目录选择项。[Git worktrees](https://www.conductor.build/docs/concepts/git-worktrees)、[Your first workspace](https://www.conductor.build/docs/first-workspace) |

这几个产品没有统一的原目录标签。常见两种表达：用 `Local` 与隔离环境对应；或直接说项目文件夹、原始检出位置。`Main directory` 不是本次一手来源中确认到的常见界面标签。

## Maka 的实际语义

Maka 的 `mainPath` 指向 Git 的主工作树，并不总是用户当前选中的项目路径。`worktree-git.ts` 将 `git worktree list` 首项标记为 `isMain`；`worktree-manager.ts` 从该项获取 `mainPath`，找不到时才回退到 `project.preferredPath`。参见 [Git 列表解析](../packages/runtime-host/src/server/worktree-git.ts)、[工作树管理](../packages/runtime-host/src/server/worktree-manager.ts)。

工作树操作发生在项目所属 Host，本地与远程使用相同流程，参见 [任务 Worktree](./worktrees.zh-CN.md)。因此直接采用「本地」可能被理解为「当前电脑」，而「当前目录」又容易被理解为正在使用的某个 linked worktree。

## 文案建议（产品判断）

推荐「原始目录」，英文 `Original directory`，繁体「原始目錄」。这能表达创建额外工作树之前的仓库目录，同时避开分支名 `main` 和本地/远程 Host 的歧义。需要解释时可用「直接在仓库原始目录中工作」，并展示真实路径。

菜单建议保持：

- 原始目录
- 新建工作树
- 已有工作树

技术准确性优先时可用「主工作树」；「项目目录」更常见，但在 Maka 项目原先从 linked worktree 导入的情况下，不如「原始目录」精确。「主目录」缺少 Git 上下文，也容易让人联想到 Home 目录。本次只记录调研和建议，不修改产品文案。

## 最终决定

2026-10-25：采用「主工作树」，英文 `Main worktree`，繁体「主工作樹」。上述建议保留为调研记录，以此决定为准。
