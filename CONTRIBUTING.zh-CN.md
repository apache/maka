# 为 Maka 贡献代码

[![docs](https://img.shields.io/badge/docs-English-blue?logo=googletranslate&logoColor=white)](./CONTRIBUTING.md)

- [从哪里开始](#从哪里开始)
- [公开决策](#公开决策)
- [人类责任与 AI 归因](#人类责任与-ai-归因)
- [审查与 fast path](#审查与-fast-path)
- [来源与许可](#来源与许可)
- [快速开始](#快速开始)
- [开发](#开发)
- [分支命名](#分支命名)
- [Pull Request](#pull-request)

## 从哪里开始

下列类型的改动最容易被合并：

- 缺陷修复
- 模型供应商支持——新增一家，或修好已有的
- 测试补强与稳定性改进
- 性能优化
- 文档
- 环境相关问题的修复

涉及项目方向、治理或重大产品决策时，请在实现前遵循下文的公开决策流程。

想找活干，可以从这些标签入手：

- [`help wanted`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
- [`good first issue`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
- [`bug`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Abug)
- [`enhancement`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement)

想认领某个 issue，在下面留言，维护者可能会指派给你。

提 issue 建议走 **Bug report** 或 **Feature request** 模板——它们会问出让一个 issue 可被处理所需的上下文。安全问题请走 [SECURITY.md](./SECURITY.md) 的私密流程，不要开公开 issue。

## 公开决策

项目方向、治理和重大产品决策应在实施前公开讨论并记录理由。ASF 开发邮件列表可用后，项目级决策应转移到那里。实现层面的技术决策可以在 PR 中讨论，前提是相关理由公开且可供审查。

## 人类责任与 AI 归因

每项贡献都必须有一名 human contributor of record。此人负责审阅工作、决定提交，并对其准确性、来源、许可和任何适用的 ICLA 声明负责。Agent 可以准备改动，但不得使用 ASF 凭据或向 ASF 仓库 push commit。

生成式工具对代码、文档、分析或项目立场作出实质贡献时，必须披露。人类确定事实和立场后，工具仅做翻译、措辞整理、自动补全或拼写修正时，无需披露。自动发送的消息必须表明身份。

每个 PR 都必须说明生成式工具是否作出了实质贡献。如果是，应注明工具名称并简要说明其参与范围；如果不是，应明确说明没有生成式工具作出实质贡献。

AI 创作了贡献中的实质部分时，Maka 项目政策要求在目标分支的最终 commit 中记录工具名称：

```text
Generated-by: <tool>
```

每个包含 AI 实质创作内容的 PR commit 都应添加该 trailer，并确保它在 squash 或 amend 后保留于最终 commit 中。

## 审查与 fast path

对用户可见行为的重大变更、公开契约、安全、许可、发布或治理变更，必须由另一名人类进行独立审查。AI review 不算独立人工审查。这项要求不同于每项贡献都必须具备的 human contributor of record。

只有在改动影响较低、容易回退、不影响上述受保护领域且必要检查通过时，贡献才能采用 fast path，在没有独立人工审查的情况下合并。

采用 fast path 时，合并者必须留言说明 PR 的最终版本如何满足这些条件；后续如有新 commit，必须重新判断并留言。最终由维护者决定。测试、CI、文档和机械修改可能符合条件，但文件类型本身不能豁免审查。

## 来源与许可

只提交你有权贡献的内容。记录第三方来源、许可和必要署名。正确性审查不能证明内容来源。对于 AI 生成的实质内容，应检查工具的输出条款；如果输出较大或来源可疑，还应扫描是否与第三方材料匹配。遵循当前的 [ASF 生成式工具指南](https://www.apache.org/legal/generative-tooling.html)。

提交贡献即表示你同意你的贡献以 [Apache License 2.0](./LICENSE) 授权。

## 快速开始

| 要求 | 值 |
| --- | --- |
| Node | `>=22.19.0`（根 `package.json` 的 `engines`） |
| npm | `11.19.0`（`packageManager`） |
| 平台 | 桌面端开发需要 macOS Apple Silicon。发版也会产出未签名的 Windows x64 构建，CI 有非阻塞的 `windows_baseline` job，但 Windows 和 Linux 目前还不是受支持的目标平台 |

```sh
git clone https://github.com/maka-agent/maka-agent.git
cd maka-agent
npm install                 # 只在根目录装 —— 不要在某个 workspace 里跑
npm run build               # 按依赖顺序构建全部 workspace
npm --workspace @maka/core test
```

架构说明见 [ARCHITECTURE.zh-CN.md](./ARCHITECTURE.zh-CN.md)。

## 开发

### 运行

```sh
npm run dev          # 带 HMR 的桌面应用
npm run dev:full     # 完整构建后启动桌面应用

npm --workspace maka-agent exec -- maka          # TUI
npm --workspace maka-agent exec -- maka run "…"  # 非交互地跑一个 Turn
```

Eval 的命令与 contract 见 [`packages/eval`](./packages/eval)。

### 构建

`npm run build` 按依赖顺序构建各 workspace：

```
code-mode → core → storage → mcp → runtime → runtime-host
          → computer-use → eval → maka-agent → ui → desktop
```

只有依赖都已构建好时，单独构建某个 workspace 才会成功——拿过期的 `@maka/core` 去编译 `@maka/runtime`，产生的类型错误看起来会像是你刚写的代码有问题。拿不准就从根目录构建。

桌面应用有四个产物，`build:test` 覆盖前三个：

```sh
npm --workspace @maka/desktop run build:main      # 主进程
npm --workspace @maka/desktop run build:preload   # preload 桥接层
npm --workspace @maka/desktop run build:overlay   # overlay 窗口
npm --workspace @maka/desktop run build:renderer  # 渲染层
```

### 测试

测试跑的是 `dist/` 里的编译产物。每个 workspace 的 `test` 脚本都会先清理、再构建，然后执行 `node --test`。**务必走它**——在裸跑 `build:*` 之后直接 `node --test`，执行的会是旧代码留下的孤儿产物，它们会在早已不存在的 import 上失败。

```sh
npm test                                 # 全部 workspace
npm --workspace @maka/core test          # 单个 workspace
npm --workspace @maka/desktop run e2e    # Playwright
```

### 推送前

CI 会跑这些；本地先对齐可以省掉一轮漫长往返。

```sh
npm run lint            # biome lint
npm run format:check    # biome format —— 与 lint 相互独立，过了一个不代表另一个也过
npm run build
npm run typecheck       # desktop 有 4 个 tsconfig project，含 renderer 和 storybook
npx knip --workspace apps/desktop
npx knip --workspace packages/ui
```

CI 里名为 `typecheck` 的 job 会在 `bash -e` 下跑完上面全部命令，第一个失败会中止其余——要看是哪个 step 失败，别看 job 名字。

## 分支命名

```
<type>/<描述>
```

`<描述>` 用小写，单词间以短横线分隔。`<type>` 只能是下列之一：

| 前缀 | 含义 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 缺陷修复 |
| `refactor` | 不改变行为的重构 |
| `test` | 仅测试改动 |
| `chore` | 构建、依赖与杂项维护 |
| `perf` | 性能优化 |
| `docs` | 仅文档改动 |
| `ci` | CI 配置与流水线 |
| `build` | 构建系统与产物 |

## Pull Request

开 PR 时会自动填充 [`pull_request_template.md`](./.github/pull_request_template.md)，
其中已包含必填小节和检查清单。请在它的基础上填写，不要整段替换。

**标题。** 本仓库用 squash 合并，标题会成为落到 `main` 上的提交信息。遵循 [Conventional Commits](https://www.conventionalcommits.org/)：

```
<type>(<scope>): <summary>
```

`<type>` 就是[分支命名](#分支命名)那一套。`<scope>` 是改动的 workspace 或区域——`desktop`、`ui`、`runtime`、`eval`、`settings`、`runtime-host`、`storage`、`core`、`cli`、`deps`、`computer-use`、`scripts`、`release`、`windows`、`e2e`、`security` 等——`git log` 里能看到实际在用的集合。

```
fix(desktop): classify provider action errors from the unwrapped IPC message
feat(runtime): decouple Swarm with asynchronous wakeups
test(core): pin the shared validation corpus to every envelope value domain
```

**界面改动。** 请附改动前后的截图或录屏。视觉变化没法从 diff 判断。

**描述写短，用你自己的话。** 长篇的生成式说明会拖慢评审。用自己的话说清改了什么、为什么；如果这需要很多段落，多半是这个 PR 太大了。
