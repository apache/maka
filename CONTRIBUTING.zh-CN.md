# 为 Maka 贡献代码

[![docs](https://img.shields.io/badge/docs-English-blue?logo=googletranslate&logoColor=white)](./CONTRIBUTING.md)

- [从哪里开始](#从哪里开始)
- [快速开始](#快速开始)
- [开发](#开发)
- [分支命名](#分支命名)
- [Pull Request](#pull-request)
- [许可](#许可)

## 从哪里开始

下列类型的改动最容易被合并：

- 缺陷修复
- 模型供应商支持——新增一家，或修好已有的
- 测试补强与稳定性改进
- 性能优化
- 文档
- 环境相关问题的修复

产品功能与界面改动不一样：请先开 issue 把方向谈定，再动手实现。维护者直接落地功能，是因为他们本身在设定方向；外部贡献者先确认可以避免白做。

想找活干，可以从这些标签入手：

- [`help wanted`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22help+wanted%22)
- [`good first issue`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
- [`bug`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Abug)
- [`enhancement`](https://github.com/maka-agent/maka-agent/issues?q=is%3Aissue+is%3Aopen+label%3Aenhancement)

想认领某个 issue，在下面留言，维护者可能会指派给你。

提 issue 建议走 **Bug report** 或 **Feature request** 模板——它们会问出让一个 issue 可被处理所需的上下文。安全问题请走 [SECURITY.md](./SECURITY.md) 的私密流程，不要开公开 issue。

## 快速开始

| 要求 | 值 |
| --- | --- |
| Node | `>=22.19.0`（根 `package.json` 的 `engines`） |
| npm | `11.12.1`（`packageManager`） |
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

## 许可

提交贡献即表示你同意你的贡献以 [Apache License 2.0](./LICENSE) 授权。
