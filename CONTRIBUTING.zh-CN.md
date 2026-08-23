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

# 为 Maka 贡献代码

[![docs](https://img.shields.io/badge/docs-English-blue?logo=googletranslate&logoColor=white)](./CONTRIBUTING.md)

## 从哪里开始

缺陷修复、模型供应商支持、测试、性能优化和文档最容易被合并。想找活干，从 [`help wanted`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22) · [`good first issue`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) · [`bug`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Abug) · [`enhancement`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement) 里挑一个，留言认领。提 issue 走 **Bug report** 或 **Feature request** 模板；安全问题走 [SECURITY.md](./SECURITY.md) 的私密流程，不要开公开 issue。提问、想法和还不成熟的提案发到 [Discussions](https://github.com/maka-agent/maka-agent/discussions)——它会自动进到大家的邮箱，比 issue 更容易被看到。

项目方向、治理和重大产品决策在实施前于开发邮件列表 [`dev@maka.apache.org`](https://lists.apache.org/list.html?dev@maka.apache.org) 上公开讨论；实现层面的技术决策可以在 PR 中讨论。

## 人类责任与 AI 归因

每项贡献都有一名 human contributor of record：审阅工作、决定提交，并对准确性、来源和许可负责。Agent 可以自由 commit 和 push；最终的审查与合并决定始终由人做出。

每个 PR 说明生成式工具是否有实质贡献，有则注明工具名称；翻译、措辞整理、自动补全和拼写修正不算。自动发送的消息必须表明身份。AI 创作了贡献中的实质部分时，在每个受影响的 commit 加上 `Generated-by: <tool>` trailer，并确保它在 squash 或 amend 后保留于最终 commit。

## 审查

向 `main` 提的每个 PR 都需要一位作者之外的 committer 给出 approval，且必需的 `test` 检查通过；[`.asf.yaml`](./.asf.yaml) 的分支保护强制执行这套机制。approval 在后续 push 后仍然有效——后续 commit 公开推送即可，改动超出已审查的范围时再请人重新看一遍。审查必须出自独立的人工判断——AI review 不算。一个改动是否重大、获得的审查是否足够，由维护者认定。

## 来源与许可

只提交你有权贡献的内容，记录第三方来源、许可和必要署名。贡献以 [Apache License 2.0](./LICENSE) 授权；AI 生成的实质内容遵循 [ASF 生成式工具指南](https://www.apache.org/legal/generative-tooling.html)。

## 快速开始

需要 Node `>=22.19.0` 和 npm `11.19.0`（见根 `package.json`）；桌面端开发需要 macOS Apple Silicon。

```sh
git clone https://github.com/maka-agent/maka-agent.git
cd maka-agent
npm install                 # 只在根目录装 —— 不要在某个 workspace 里跑
npm run build               # 按依赖顺序构建全部 workspace
npm --workspace @maka/core test
```

## 开发

```sh
npm run dev          # 带 HMR 的桌面应用
npm run cli:dev      # TUI；`npm run cli:dev -- run "…"` 非交互地跑一个 Turn
npm test             # 全部 workspace，或：npm --workspace @maka/core test
```

只有依赖都已构建好时，单独构建某个 workspace 才会成功——拿不准就从根目录构建。测试跑的是 `dist/` 里的编译产物；每个 workspace 的 `test` 脚本都会先清理、再构建，然后执行 `node --test`。务必走它。

推送前先在本地对齐 CI：

```sh
npm run lint
npm run format:check
npm run build
npm run typecheck
npx knip --workspace apps/desktop
npx knip --workspace packages/ui
```

架构说明见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)；Eval 的命令与 contract 见 [`packages/eval`](./packages/eval)。

## Pull Request

开 PR 时会自动填充 [`pull_request_template.md`](./.github/pull_request_template.md)；请在它的基础上填写，不要整段替换。

分支名和标题遵循 [Conventional Commits](https://www.conventionalcommits.org/)：分支是 `<type>/<描述>`，标题是 `<type>(<scope>): <summary>`。本仓库用 squash 合并，标题会成为落到 `main` 上的提交信息；`git log` 里能看到实际在用的 type 和 scope。

界面改动请附改动前后的截图或录屏。描述写短，用你自己的话——如果需要很多段落，多半是这个 PR 太大了。
