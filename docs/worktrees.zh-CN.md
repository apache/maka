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

# 任务 Worktree

新任务先选择项目，再通过独立的工作目录选择器选择「主工作树」「新建工作树」，
或在「已有工作树」级联菜单中选择 Maka 创建的现有目录。外部 Git worktree 不显示在该菜单中。已有工作树达到 10 个时，子菜单顶部显示搜索框，按名称过滤；关闭菜单后清空搜索。切换工作目录不会改变项目选择器的名称；
项目首次选择时使用主工作树；再次选择同一 Host 的同一项目时保留此前的工作目录选择。普通文件夹项目和没有首次提交的仓库不显示工作树选择器。

首次发送时，消息会先保存在本地并打开会话。后台准备期间，消息下方显示准备 worktree、
检出文件、运行初始化脚本等实际阶段、已等待时间，以及分配后的目录路径。准备完成后
自动继续任务；准备状态不会被当作模型已经开始执行。

Maka 基于项目主工作树的当前 HEAD 创建 worktree，默认使用 AI 根据任务描述
生成任务 slug 和变更类型。目录使用 slug，例如 `add-search`；分支使用 `<type>/<slug>`，
例如 `feat/add-search` 或 `fix/login-redirect`。类型包括 `feat`、`fix`、`docs`、`style`、
`refactor`、`perf`、`test`、`build`、`ci`、`chore` 和 `revert`。
分支和目录各自检查重名，并独立追加递增数字后缀。例如目录 `add-search` 已占用时，
新目录可以是 `add-search-2`，分支仍为可用的 `feat/add-search`。
已删除 worktree 的目录名仍保留给原有会话，不会重新分配给新 worktree。
命名失败时使用简短随机目录名，以 detached HEAD 创建。如果已有 `feat` 等分支占据了
类型前缀、导致 Git 无法创建 `feat/...`，则保留生成的目录名，以 detached HEAD 创建。未提交改动
不会复制。创建完成后，会话固定在该目录中；重新打开或重启仍使用原目录，无法换绑。
目录被删除或失效时，任务不会自动回到项目主工作树。

从历史消息分叉时，可沿用源 worktree，或基于源 worktree 当前 HEAD 新建 worktree。
对话历史截取到所选消息；文件不会恢复成历史消息当时的版本。确认分叉时即创建和绑定，
不需要等到下一次发送。多个会话可以共用同一 worktree，其文件修改也会互相可见。

## 设置和脚本

设置中的 **Worktree** 页按 Host 展示项目。展开项目后，先展示已有 worktree 的路径、分支、
关联会话数和初始化结果；失败的脚本输出默认展开，方便重试或跳过。
点击项目旁的设置按钮，打开「项目配置」弹窗，可编辑创建／清理脚本。
Worktree 根目录统一在页面顶部按 Host 设置，不支持项目级覆盖；新任务的工作目录通过任务输入区的工作目录选择器选择。
加载、保存、初始化和清理都有可见的状态反馈；长时间操作显示耗时，后台刷新保留未保存的编辑。
所有路径、Git 操作和脚本都属于项目所在的 Host，本地与远程使用同样的流程。

默认根目录为 Host 上的 `~/.maka/worktrees`。其下优先使用项目名作为项目目录，名称中
不适合路径的字符会被替换。同名目录已被其他项目分配或被磁盘上的文件、目录占用时，
追加短后缀区分。目录名首次分配后持久化，项目改名、重启或新增同名项目都不会改变它。
项目目录下使用生成的 slug 作为 worktree 子目录名，不包含分支的类型前缀。

旧版创建的 worktree 继续使用原来的绝对路径，不迁移或重命名；后续新建的 worktree
使用新规则分配的项目目录。更改根目录只影响后续新建的 worktree，并沿用已分配的
项目目录名，不会移动已有目录。

脚本在 worktree 目录中执行，使用 Host 的 shell 和环境，并提供：

| 环境变量 | 含义 |
| --- | --- |
| `MAKA_PROJECT_PATH` | 项目主工作树 |
| `MAKA_WORKTREE_PATH` | 当前 worktree 目录 |
| `MAKA_SOURCE_WORKTREE_PATH` | 创建时使用的源 worktree 目录 |
| `MAKA_WORKTREE_BRANCH` | 创建时的分支名，游离 HEAD 时为空 |
| `MAKA_WORKTREE_BASE_COMMIT` | 创建时固定的基准提交 |

例如，创建脚本可以先复制本地配置，再安装依赖：

```sh
if [ -f "$MAKA_SOURCE_WORKTREE_PATH/.env" ]; then
  cp "$MAKA_SOURCE_WORKTREE_PATH/.env" .env
fi
npm ci
```

初始化失败后，目录、日志和原始首次消息均保留，消息尚未发送给模型。可以重试初始化，
也可以明确选择跳过并继续任务。两种恢复方式都会复用原目录；原始待发送消息可继续发送，
不需要重新输入。脚本不应假设永远只运行一次：失败后的显式重试会再次执行。

如果检出完成后准备被取消，或 Host 在初始化完成前退出，已有目录会保留并显示可恢复的
初始化失败状态。重启不会自动执行脚本；可以在设置中重试初始化或明确跳过。

同一仓库的多个 worktree 可以分别运行初始化脚本，较慢的脚本不会阻塞另一个 worktree
的命名和创建。分叉准备期间仍可操作源会话；准备完成后会重新校验源会话版本，发生变化时
提示版本冲突，避免复制过期状态。

使用已有 worktree 或沿用源目录时，不执行创建脚本。配置变更只影响后续操作；已有
worktree 不会自动重新初始化。脚本最长执行十分钟，超时或 Host 退出会终止其进程树，
输出保留有界的末尾日志。

## 清理

归档或删除会话不会清理这些 worktree。清理入口只操作 Maka 创建的 worktree。

清理前会检查工作树及其子目录中运行的会话、未提交文件，以及没有被其他分支保存的提交。
目录内若还有嵌套的 Git 工作树或仓库（包括被忽略的目录），必须先单独处理，不能通过清理父目录一并删除。通过后，使用
项目最新保存的清理脚本执行清理。脚本失败会弹窗，允许保留目录或明确继续删除；确认时
会再次检查状态，过期的确认不能用于删除。

清理默认保留 Git 分支和会话历史。历史会话仍指向原目录，并在目录不可用时阻止执行。
若在 detached HEAD 中产生提交，请先创建一个保留这些提交的分支，再清理目录。
