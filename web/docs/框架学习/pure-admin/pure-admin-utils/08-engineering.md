# 08 · 工程化体系：构建、测试、CI 与发版

> 系列导航：[README](./README.md) | [上一篇：类型系统](./07-type-system.md) | [下一篇：实战：添加新函数 →](./09-add-your-own-function.md)

读完本篇你会掌握：

1. tsup 四个构建配置块各自的职责
2. 测试的现状、风格与盲区
3. 两条 CI 流水线加三件 git hooks 的分工
4. 这个库的发版节奏

写一个函数库，函数本身只占一半工作量；另一半是让函数以正确的形态出现在 npm 上、每次提交都被机器检查过。本篇盘点的就是这后半部分。所有配置文件都在仓库根目录，路径可对照。

## 构建：一个 tsup.config.ts，四个配置块

`tsup.config.ts` 用数组导出，一次跑出四份产物（[第 4 篇](./04-zero-dependency-design.md)讲过产物分工，这里看构建参数本身）：

| 配置块 | 入口 | 格式 | 关键参数 |
| --- | --- | --- | --- |
| 1 | `src/index.ts` | esm | `dts: true` 生成类型声明，`treeshake: true` |
| 2 | `src/cjs.ts` | cjs | 无 dts（类型统一走 index.d.mts） |
| 3 | `src/iife.ts` | iife | `platform: "browser"`，`globalName: "PureUtils"` |
| 4 | `src/alias.ts` | esm | 带 dts 的空对象占位 |

四个块共享的公共配置：`outDir: "dist"`、`clean: true`（构建前清空 dist）、`minify: true`、`sourcemap: false`、`external: ["vue", "echarts"]`。

两个值得注意的取舍：

- **`minify: true`**：npm 包默认不压缩（保留可调试性），这个库选择了压缩，产物体积优先。查产物内实现时靠 sourcemap 是没有的，回到源码看。
- **`external: ["vue", "echarts"]`**：注意 echarts 在源码里运行时根本没有 import，external 列表里它是纯保险——防未来有人顺手写上 import 时构建不炸。

本地构建验证就一条命令：

```bash
pnpm build    # 等价于 tsup，产物落在 dist/
```

## 测试：vitest + jsdom

```ts
// vitest.config.ts 完整内容
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/tests/*.test.{js,ts,tsx}"],
    environment: "jsdom"
  }
});
```

测试文件就两个：`src/tests/utils.test.ts`（264 行用例）和 `src/tests/mock.ts`（1693 行测试数据：菜单树、部门树、URL、数字数组等）。运行：

```bash
pnpm test    # vitest run，单次执行
```

**覆盖现状**要如实说：`describe.concurrent` 包裹的 19 个 `it` 覆盖了约 24 组纯函数——clone、color、date、math、array、tree、url、uuid、substring 等；**11 个 hooks 没有任何测试**。README 里"100% 测试覆盖率"指的是纯函数部分。jsdom 环境其实是具备测 hooks 的条件的（window、document、MutationObserver 都在），这是当前明显的扩展空间。

**断言风格**也值得了解。两种并存：

```ts
// 风格一：精确值断言（可靠）
expect(priceToThousands(123456789)).to.equal("123,456,789");
expect(monthDays("2022-06")).to.equal(30);

// 风格二：存在性断言（只证明不抛错，证明力弱）
expect(randomColor({ type: "hex" }));
expect(buildUUID());
```

读测试时要有意识地区分：风格一的用例挂了说明功能真坏了；风格二的用例更多是"冒烟"性质。给这个库补测试时，把存在性断言升级成精确值断言是回报很高的事。

## CI：两条流水线

`.github/workflows/` 下两个文件，都在 push/PR 到 main 时触发：

| 文件 | 跑什么 | 挡住什么 |
| --- | --- | --- |
| `test.yml` | `pnpm install --no-frozen-lockfile` + `pnpm test` | 功能回归 |
| `linter.yml` | `pnpm typecheck` + `pnpm lint` | 类型错误与风格漂移 |

环境统一 Node 18 + pnpm（`setup-node@v2` + `pnpm/action-setup@v2`）。注意 `pnpm lint` 是个复合命令：`eslint . --fix && prettier --write "src/**" && pnpm typecheck`——lint 完顺手 typecheck，类型检查其实跑了两遍（CI 里一次、lint 内一次），对中型库来说是可接受的冗余。

## Git hooks：三件套

`.husky/` 下三件东西：

| 文件 | 时机 | 做什么 |
| --- | --- | --- |
| `pre-commit` | 每次 commit 前 | `[ -n "$CI" ] && exit 0` 先跳过 CI 环境，然后 `npm run lint:lint-staged` |
| `lintstagedrc.js` | 被 pre-commit 调用 | `*.{js,jsx,ts,tsx}` 跑 `eslint --fix` + `prettier --write`，只处理暂存文件 |
| `commit-msg` | 每次 commit 前 | commitlint 校验提交信息 |

commitlint 用 `@commitlint/config-conventional`，所以提交信息必须是 `feat: xxx`、`fix: xxx`、`perf: xxx` 这种约定式格式。翻 git log 能看到另一类裸版本号提交（`2.6.4`、`2.6.3`……），那是发版提交，和功能提交肉眼可分。

## 脚本全景

package.json 的 scripts 一览，按用途分组：

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | tsup --watch，改源码实时出产物 |
| `pnpm build` | 构建四份产物 |
| `pnpm test` | 跑 vitest |
| `pnpm typecheck` | `tsc --noEmit`，只查类型不出文件 |
| `pnpm lint` | eslint --fix + prettier + typecheck |
| `pnpm start` | esno 直接执行 src/index.ts（调试入口文件用） |
| `pnpm pub` | `@pureadmin/release` 提供的交互式发版工具 |
| `pnpm clean:cache` | 删 node_modules 和缓存重装 |

发版流程从 git 历史可还原：功能提交（feat/perf）→ 裸版本号提交触发 `@pureadmin/release` 打 tag 发 npm → 重复。版本号严格递增，2.4.x 到 2.6.4 期间没有出现破坏性变更标记。

## TypeScript 配置

`tsconfig.json` 关键项：`strict: true` + `noImplicitAny: true`（严格模式全开）、`moduleResolution: "bundler"`（面向打包器的现代解析策略）、`lib: ["ESNext", "ES6", "DOM"]`（DOM 进 lib 因为要类型检查浏览器 API）、`exclude` 里排除了 `docs`（文档目录不参与类型检查）。

一个有意思的对照：配置是全严格，但源码里有 20 多处 `@ts-expect-error`，集中在 hooks 与 DOM、echarts 的交界处。这说明维护者的取向是**对内严格、边界务实**——类型系统管得住的地方严格，管不住的 DOM 交界用显式豁免并留注释，而不是放开全局严格。

## 新手常见误解：有 CI 就不需要本地跑测试

反了。CI 的 `pnpm install --no-frozen-lockfile` 会按 package.json 的语义范围拉最新依赖（`^` 前缀），本地锁定的版本和 CI 拉到的可能不同——本地绿、CI 红的差异多半来自这里。提交前本地把三件事跑全是成本最低的防线：

```bash
pnpm test        # 功能
pnpm typecheck   # 类型
pnpm build       # 构建是否还能过
```

## 下一步

工具链全貌清楚了。[第 9 篇：实战：添加新函数](./09-add-your-own-function.md)把前面的知识串起来，从零走一遍"给库添加一个新函数"的完整流程——写实现、写类型、写测试、过四道检查。

**动手练习**：fork 或 clone 本仓库后不装依赖直接跑 `pnpm test` 会发生什么？装完依赖先跑 `pnpm build` 再翻 `dist/`，打开 `index.mjs` 搜 `priceToThousands`，确认压缩后函数还在，再搜 `useECharts` 观察 vue 的 import 是怎么被保留成外部引用的（`from"vue"`字样）。
