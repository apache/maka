# 04 · 零依赖是怎么做到的：convert 层与多入口构建

> 系列导航：[README](./README.md) | [上一篇：hooks 实战](./03-hooks-in-action.md) | [下一篇：useECharts 深度剖析 →](./05-use-echarts.md)

读完本篇你会理解：

1. 一个"零 dependencies"的工具库如何同时服务 Node、浏览器和 Vue
2. `src/convert.ts` 这 3 行代码为什么是全库的地基
3. 四份构建产物各对应什么环境，为什么内容不一样
4. SSR 安全的三道防线

这是进阶部分的第一篇。入门篇教你"用"，从这里开始讲"为什么这样设计"。这些设计不复杂，但每一样都值得在写自己的库时抄走。

## 问题：工具库的两难

工具库作者都面对过同一道选择题。往库里面引入 Vue，非 Vue 项目就被迫拖上一坨用不到的依赖；完全不用 Vue，又没法提供响应式 hooks。更麻烦的是 SSR：库代码里只要有一行裸的 `window`，服务端一渲染就抛 `ReferenceError`。

`@pureadmin/utils` 的答案是三件套：**依赖反转层 + 多入口构建 + 环境防御常量**。npm 上它的 `dependencies` 是空的，`peerDependenciesMeta` 里 `vue` 和 `echarts` 都标了 `optional: true`。

## 核心机制：convert.ts 依赖反转层

全库 60 个源文件，没有一处直接写 `import { ref } from "vue"`。所有 Vue API 都从同一个文件转发出来：

```ts
// src/convert.ts 完整内容
import * as Vue from "vue";
export * from "vue";
export { Vue };
```

`src/hooks/` 下的文件一律这样引：

```ts
import { ref, unref, watch, onMounted } from "../convert";
```

类比：convert 层像公司前台。所有找"Vue"的来访都走前台登记，公司里没人直接和 Vue 打交道。哪天要把 Vue 换成别的响应式方案，改前台一个人就够了；哪天要在没有 Vue 的环境里构建，让前台"查无此人"即可——反正没登记过的访客等于不存在。

这个模式的实质是**依赖反转**：业务代码依赖抽象的转发层，转发层才依赖具体实现。它在三种时刻兑现价值：

1. **构建时**：`tsup.config.ts` 里 `external: ["vue", "echarts"]`，vue 的代码不会被打进产物，只保留 import 语句，交给使用方的运行时去解析。使用方项目里的 Vue 版本（3.2、3.3、3.4+）直接生效，库永远不锁版本。
2. **安装时**：因为整个包没有任何 `dependencies`，`pnpm add @pureadmin/utils` 只装这一个包。不用 Vue 的项目永远不会被拉进 vue。
3. **演进时**：想适配 Vue 4 或替换响应式内核，理论上只改 `convert.ts`。

`src/fs.ts` 用了完全相同的把戏转发 Node 的 `fs` 模块，服务于两个 Node 专属函数（后面会讲到为什么它们被隔离得这么深）。

## 四份构建产物：同一份源码，四种裁剪

`tsup.config.ts` 定义了四个入口。关键是：**四个入口的导出清单是手工维护、各不相同的**，`src/index.ts`、`src/cjs.ts`、`src/iife.ts` 三个文件就是三份导出清单。

| 入口文件 | 产物 | 环境 | 导出内容 |
| --- | --- | --- | --- |
| `src/index.ts` | `dist/index.mjs` + `index.d.mts` | 现代 ESM，浏览器优先 | 全量：29 个 utils + 11 个 hooks + types + algorithm |
| `src/cjs.ts` | `dist/cjs.js` | Node CommonJS | 只留纯函数；**剔除**全部 hooks 和 DOM 模块（`class` `device` `storage` `svg` `url` 等），**补回** Node 专属的 `packageSize` 和 `path` |
| `src/iife.ts` | `dist/iife.global.js` | 浏览器 `<script>` 引入，全局变量 `PureUtils` | 大部分 hooks 保留，剔除依赖组件实例的 `useAttrs`/`useComponent`，同样剔除 fs 相关模块 |
| `src/alias.ts` | `dist/alias.mjs` | 子路径 `@pureadmin/utils/alias` 占位 | 导出空对象，类型从 `src/alias.d.ts` 出 |

package.json 里的字段把四份产物各就各位：

```json
{
  "main": "dist/cjs.js",
  "module": "dist/index.mjs",
  "jsdelivr": "dist/iife.global.js",
  "unpkg": "dist/iife.global.js",
  "types": "dist/index.d.mts",
  "exports": {
    ".": {
      "types": "./dist/index.d.mts",
      "import": "./dist/index.mjs",
      "require": "./dist/cjs.js"
    }
  }
}
```

打包器和 Node 会根据 `import` 还是 `require` 自动选 ESM 或 CJS，CDN 服务读 `jsdelivr` 字段。使用者无感，这正是 exports map 的价值。

这里藏着一个容易踩的事实：**`getPackageSize` 和 `getAbsolutePath` 不在主入口里**。它们依赖 Node `fs`，所以只从 CJS 入口导出。在浏览器项目里 `import { getPackageSize } from "@pureadmin/utils"` 拿到的是 `undefined`——不是 bug，是刻意的环境隔离。

## Tree-shaking：摇得动的前提

package.json 里 `"sideEffects": false` 是摇树的开关。它向打包器保证：这个包的任何模块被引入时没有副作用，没被用到的模块可以整体删掉。

要兑现这个承诺，库内部也得守规矩。看 `src/utils/is.ts` 的结尾：

```ts
export const isServer = typeof window === "undefined";
export const isClient = !isServer;
export const isBrowser = typeof document !== "undefined";
```

模块级执行 `typeof window` 算副作用吗？不算。`typeof` 对未声明变量是安全的惰性求值，不触发浏览器 API，求出的常量会被打包器内联。这就是为什么这三个环境常量敢放在模块顶层——它们是整个库唯一一批"模块加载时执行的逻辑"，而且写得足够干净。

使用方的打包器据此可以做模块级裁剪：只 import `priceToThousands`，最终产物里不会有 `useECharts`，更不会出现 vue 的 import。

## SSR 安全的三道防线

同一个函数要同时活在前端和 Node 里，库内约定俗成了三种防御写法，随手就能在源码里对上号。

**第一道：环境常量短路。** 所有碰 DOM 的函数第一行都是：

```ts
if (!isBrowser) return;   // 或 reject()，视函数返回类型
```

`openLink`、`banMouseEvent`、`deviceDetection`、`getSvgInfo`……三十多处，姿势完全一致。SSR 里调用它们等于调用空函数，静默不作为，而不是抛异常。

**第二道：生命周期兜底。** `src/helps.ts`（内部工具，不导出）：

```ts
export function tryOnUnmounted(fn: Fn) {
  if (getCurrentInstance()) onUnmounted(fn);
}
```

不在组件里调 `useWatermark()`，`onUnmounted` 的注册会被跳过而不是抛 "onUnmounted is called when there is no active component instance"。这是 hooks 能在组件外安全调用（[第 3 篇](./03-hooks-in-action.md)讲过的行为约定）的实现基础。

**第三道：引用归一化。** `unrefElement` 把 `ref`、`$el`、裸元素三种形态统一成一个元素对象，hooks 内部不再关心使用者传进来的是什么。

三道防线各管一层：常量管环境，tryOn 管上下文，unref 管参数形态。

## 一个常见误解：零依赖等于零前提

不是。零依赖是**安装时**的概念——npm 不会替你装任何东西。运行时该有的前提一个没少：

| 你 import 了 | 运行时必须有 |
| --- | --- |
| 任意 utils 函数 | 什么都没有 |
| `getPackageSize` | Node 环境（有 fs） |
| 任意 `useXxx` | 项目里装了 vue 并在 Vue 上下文中使用 |
| `useECharts` | vue + echarts，且 echarts 已注册到 globalProperties（下一篇讲） |

把"零依赖"理解为"没有任何前提条件"，是读完 npm 首页描述后最容易产生的误读。

## 下一步

依赖反转和入口裁剪是基础设施，`useECharts` 是这套基础设施上最复杂的一个应用：它连 echarts 本体都不引，靠运行时注入。[第 5 篇：useECharts 深度剖析](./05-use-echarts.md)把这套注入机制和它的 resize 双路径讲透。

**动手练习**：打开 `src/cjs.ts` 和 `src/index.ts`，把两份导出清单并排 diff，把差异模块分成两类：一类是"需要浏览器/DOM，所以从 Node 入口剔除"（如 `class`、`storage`），一类是"需要 Node fs，所以只在 CJS 提供"（如 `packageSize`）。`install.ts` 提供的 `withInstall` 给 Vue 组件挂 `app.use` 需要的 install 方法，思考它该归入哪一类，为什么。
