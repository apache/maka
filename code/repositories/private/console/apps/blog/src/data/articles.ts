import type { Article, Author, GrowthEntry, MomentInput, Series } from '@/schemas/content'

export const author: Author = {
  name: 'ggbdpq',
  slogan: '日拱一卒，功不唐捐',
  bio: '前端工程师，热爱 JavaScript / TypeScript 与一切让开发更美好的工具。在这里记录技术、阅读与成长。',
  location: '杭州',
  avatarText: 'gg',
  badges: ['前端架构', 'TypeScript 爱好者', '终身学习者'],
  stats: { articles: 12, moments: 10, series: 3 },
}

export const seriesList: Series[] = [
  {
    name: 'React 19 深入浅出',
    description: '从 Hooks 心智模型到并发特性，系统梳理 React 19 的设计哲学。',
  },
  {
    name: 'TypeScript 类型体操',
    description: '把类型系统当成一门语言来学习，从入门到写出优雅的类型。',
  },
  {
    name: 'Vite 构建原理',
    description: '拆解 Vite 的 Dev Server、插件机制与 Rolldown 的未来。',
  },
]

export const moments: MomentInput[] = [
  {
    id: 'm-2026-07-28',
    date: '2026-07-28',
    content:
      '博客终于搭起来了！技术栈选了 React 19 + TypeScript 6 + Vite 8 + TanStack 全家桶，构建快得像开了挂。接下来会慢慢把以前散落各处的笔记迁移过来。',
    views: 326,
    likes: 48,
    pinned: true,
  },
  {
    id: 'm-2026-07-15',
    date: '2026-07-15',
    content:
      '读完了《重构》第二版。最大的收获不是某个具体手法，而是「小步快走」的心法：把大问题拆成一连串安全的小改动，每一步都可验证。写代码如此，生活也如此。',
    views: 512,
    likes: 76,
  },
  {
    id: 'm-2026-06-30',
    date: '2026-06-30',
    content:
      '给团队做了一次 TypeScript 内部分享，主题是「把类型当成文档来写」。讲完后有同学说第一次觉得泛型没那么可怕了，开心😄',
    views: 389,
    likes: 55,
    location: '杭州',
  },
  {
    id: 'm-2026-06-12',
    date: '2026-06-12',
    content:
      '把项目的构建从 Webpack 迁到了 Vite 8，冷启动从 40s 降到 300ms，HMR 基本无感。工具链的进步真的能改变开发心情。',
    views: 678,
    likes: 92,
  },
  {
    id: 'm-2026-05-20',
    date: '2026-05-20',
    content:
      '坚持了 100 天每天写 500 字，今天翻回去看，前 30 天简直没法读。但这就是意义所在：量到了，质自然会来。',
    views: 445,
    likes: 88,
  },
  {
    id: 'm-2026-04-18',
    date: '2026-04-18',
    content:
      '周末用 Zustand 重写了项目里的全局状态，删掉了 600 行样板代码。状态管理的核心从来不是库，而是想清楚「什么状态真的需要共享」。',
    views: 534,
    likes: 61,
  },
  {
    id: 'm-2026-03-08',
    date: '2026-03-08',
    content:
      '「冴羽答读者问」里说：成长的最大敌人不是学不会，而是内耗。深以为然。把「我不行」换成「我还没会」，世界都不一样了。',
    views: 721,
    likes: 104,
  },
  {
    id: 'm-2026-02-14',
    date: '2026-02-14',
    content:
      '给开源项目提的第一个 PR 被合并了！虽然只是修了个文档错别字，但迈出了第一步。社区的意义就是一群人一起走得更远。',
    views: 402,
    likes: 73,
  },
  {
    id: 'm-2026-01-20',
    date: '2026-01-20',
    content:
      '2026 年的三个小目标：1. 写完「React 19 深入浅出」系列；2. 读 24 本书；3. 跑一次半马。立帖为证。',
    views: 589,
    likes: 96,
  },
  {
    id: 'm-2026-01-01',
    date: '2026-01-01',
    content: '新年快乐！愿新的一年，代码无 bug，心中有光。',
    views: 833,
    likes: 128,
  },
]

export const articles: Article[] = [
  {
    slug: 'react-19-hooks-mindset',
    title: 'React 19 深入浅出（一）：Hooks 的心智模型',
    series: 'React 19 深入浅出',
    date: '2026-07-10',
    excerpt:
      'Hooks 不是魔法，它只是一套「按顺序记录状态」的约定。理解这一点，90% 的 Hooks 疑惑都会消失。',
    tags: ['React', 'Hooks'],
    readingMinutes: 12,
    views: 1280,
    content: `## 为什么需要 Hooks

在 Class 组件时代，状态逻辑复用是个老大难问题：HOC 嵌套地狱、render props 类型爆炸、this 指向玄学。Hooks 的答案是：**让状态逻辑变成普通的函数调用**。

## 核心心智：按序记录

每次渲染，组件函数都会从头执行一遍。React 在幕后维护一个「单元格链表」，第 N 次调用 useState 就取第 N 个单元格。

> 这就是为什么 Hooks 不能写在条件语句里 —— 顺序一旦乱，对应关系就错了。

## 一个最小实现

用 30 行代码就能模拟 useState 的核心：

\`\`\`ts
let cells: unknown[] = []
let cursor = 0

function useState<T>(initial: T): [T, (v: T) => void] {
  const index = cursor++
  cells[index] ??= initial
  const setValue = (v: T) => {
    cells[index] = v
    render() // 触发重渲染
  }
  return [cells[index] as T, setValue]
}

function render() {
  cursor = 0
  // ...执行组件函数
}
\`\`\`

真实的 React 远比这复杂（Fiber、优先级、并发），但心智模型是一致的。

## 小结

- Hooks 是「按顺序记录状态」的约定
- 每次渲染都是一次完整的函数执行
- 闭包捕获的是当次渲染的值，这解释了大量「灵异」bug`,
  },
  {
    slug: 'react-19-use-hook',
    title: 'React 19 深入浅出（二）：use 与异步边界',
    series: 'React 19 深入浅出',
    date: '2026-07-18',
    excerpt:
      'use 是 React 19 最特别的新 Hook：它可以在条件里调用，还能直接「读」一个 Promise。',
    tags: ['React', 'Suspense'],
    readingMinutes: 10,
    views: 965,
    content: `## use 是什么

\`use\` 是 React 19 引入的新 API，可以在渲染期间读取资源：Promise 或 Context。与旧 Hooks 不同，**它可以写在条件和循环里**。

\`\`\`tsx
function UserCard({ userPromise }: { userPromise: Promise<User> }) {
  const user = use(userPromise) // 挂起直到 resolve
  return <Card>{user.name}</Card>
}
\`\`\`

## 与 Suspense 的配合

当 Promise pending 时，组件会「挂起」，最近的 Suspense 边界接管渲染 fallback。这把「加载中」从组件内部挪到了声明式的边界上。

- 以前：每个组件自己处理 loading 状态
- 现在：组件只写「拿到数据后」的逻辑

## 实战建议

1. Promise 要在事件或父级创建，避免渲染期重复创建
2. 配合 React Query 的 \`promise\` API 可以做到缓存 + 挂起两不误
3. 错误交给 Error Boundary，而不是 try/catch 包住 use

## 小结

use 把「异步」变成了一等公民，组件代码因此更接近同步的直觉。`,
  },
  {
    slug: 'react-19-compiler-thinking',
    title: 'React 19 深入浅出（三）：从手动 memo 到编译器思维',
    series: 'React 19 深入浅出',
    date: '2026-07-25',
    excerpt:
      'useMemo、useCallback、memo 三座大山终于要搬走了。聊聊 React Compiler 背后的自动记忆化。',
    tags: ['React', '性能优化'],
    readingMinutes: 14,
    views: 1521,
    content: `## 手动记忆化的成本

每个写过大型 React 项目的人都经历过：

- 为了 referential equality 包一层又一层 useMemo / useCallback
- 依赖数组漏一个，bug 找一天
- memo 包了但没完全包，性能没提升代码却丑了三倍

## 编译器的思路

React Compiler 在构建期分析组件，自动插入细粒度的缓存。它理解「哪些值依赖哪些值」，比人肉标注更精确。

> 关键转变：记忆化从「运行时 API」变成「编译期优化」。

## 对写法的启示

1. 写出符合直觉的代码即可，把优化交给工具
2. 遵守规则（纯渲染、不可变数据）比手动 memo 更重要
3. 老的 useMemo 不用急着删，编译器会跳过已手动优化的部分

## 小结

工具链的进步，最终是为了让人专注业务逻辑本身。`,
  },
  {
    slug: 'ts-type-gymnastics-basic',
    title: 'TypeScript 类型体操（一）：把类型当成一门语言',
    series: 'TypeScript 类型体操',
    date: '2026-06-05',
    excerpt:
      '类型系统是一套完整的编程语言：有变量、有函数、有条件分支。换这个视角后，体操题就变成了普通编程。',
    tags: ['TypeScript'],
    readingMinutes: 11,
    views: 890,
    content: `## 类型即语言

很多人看到类型体操就头疼，其实是视角不对。把概念一一映射：

- 泛型参数 = 函数参数
- 条件类型 = if/else
- infer = 模式匹配 + 解构赋值
- 映射类型 = for...of

## 第一个例子：MyPick

\`\`\`ts
type MyPick<T, K extends keyof T> = {
  [P in K]: T[P]
}
\`\`\`

读法：遍历 K 中的每个键 P，从新对象里取出 T[P]。

## 递归就是循环

\`\`\`ts
type Length<T extends readonly unknown[]> = T['length']

type BuildArray<
  N extends number,
  Acc extends unknown[] = []
> = Acc['length'] extends N ? Acc : BuildArray<N, [...Acc, unknown]>
\`\`\`

递归终止条件 + 累加器，和写普通递归函数一模一样。

## 小结

类型体操不是炫技，它训练的是「把约束写进类型」的能力 —— 让 bug 在编译期现形。`,
  },
  {
    slug: 'ts-template-literal-types',
    title: 'TypeScript 类型体操（二）：模板字面量类型的威力',
    series: 'TypeScript 类型体操',
    date: '2026-06-22',
    excerpt:
      '从拼字符串到解析字符串，模板字面量类型让 TS 拥有了「类型级正则」的能力。',
    tags: ['TypeScript'],
    readingMinutes: 9,
    views: 745,
    content: `## 不只是拼字符串

模板字面量类型最常见的用法是约束字符串格式：

\`\`\`ts
type Route = \`/\${string}\`
type EventName = \`on\${Capitalize<string>}\`
\`\`\`

## 真正的威力：解析

配合 infer，可以从字符串里「提取」结构：

\`\`\`ts
type ParseRoute<T extends string> =
  T extends \`\${string}/:\${infer Param}/\${infer Rest}\`
    ? { [K in Param | keyof ParseRoute<\`/\${Rest}\`>]: string }
    : T extends \`\${string}/:\${infer Param}\`
      ? { [K in Param]: string }
      : {}

type Params = ParseRoute<'/user/:id/post/:postId'>
// { id: string; postId: string }
\`\`\`

这正是 TanStack Router 类型安全路由参数的底层原理。

## 小结

当字符串有了结构，类型系统就能理解它、校验它、从中推导信息。`,
  },
  {
    slug: 'vite-dev-server-internals',
    title: 'Vite 构建原理（一）：Dev Server 为什么这么快',
    series: 'Vite 构建原理',
    date: '2026-05-12',
    excerpt:
      '冷启动 300ms 的秘密：不打包，让浏览器自己干活。拆解 Vite Dev Server 的请求管线。',
    tags: ['Vite', '工程化'],
    readingMinutes: 13,
    views: 1102,
    content: `## 传统打包器的困境

Webpack 时代，Dev Server 必须先构建完整依赖图才能服务第一个请求。项目越大，启动越慢 —— 这是 O(项目规模)。

## Vite 的答案：按需编译

浏览器原生支持 ESM 之后，「模块加载」可以交还给浏览器：

1. 浏览器请求 \`/src/main.tsx\`
2. Vite 即时编译这一个文件，改写 import 路径
3. 浏览器继续请求下一层依赖，往复进行

启动时间与项目规模解耦 —— 这是 O(当前页面用到的模块)。

## 请求管线长什么样

\`\`\`
browser → middleware 链 → transform(plugin 容器) → 缓存 → response
\`\`\`

- 预构建（esbuild/Rolldown）处理 node_modules，把 CommonJS 转 ESM、合并内部模块
- 源码走插件容器，与 Rollup 插件 API 兼容

## 小结

Vite 的快不是黑魔法，而是「少做事」：能不打包就不打包，能缓存就不重算。`,
  },
  {
    slug: 'vite-plugin-mechanism',
    title: 'Vite 构建原理（二）：写一个自己的插件',
    series: 'Vite 构建原理',
    date: '2026-05-30',
    excerpt:
      '插件是 Vite 的灵魂。从一个「Markdown 即组件」的实例出发，理解插件的钩子与执行顺序。',
    tags: ['Vite', '插件'],
    readingMinutes: 10,
    views: 856,
    content: `## 插件的三个关键钩子

- \`resolveId\`：这个 import 到底指向谁？
- \`load\`：这个模块的内容是什么？
- \`transform\`：内容要怎样加工？

## 实战：Markdown 虚拟模块

\`\`\`ts
export default function markdownPlugin(): Plugin {
  return {
    name: 'vite-plugin-md-lite',
    resolveId(id) {
      if (id.endsWith('.md')) return '\\0' + id
    },
    load(id) {
      if (id.startsWith('\\0') && id.endsWith('.md')) {
        const raw = fs.readFileSync(id.slice(1), 'utf-8')
        return \`export default \${JSON.stringify(raw)}\`
      }
    },
  }
}
\`\`\`

\`\\0\` 前缀是虚拟模块的约定，防止其他插件误处理。

## 钩子的执行顺序

Vite 插件按 \`enforce: 'pre' | 'normal' | 'post'\` 排序，与 Rollup 插件体系一脉相承 —— 学会一次，两处受用。

## 小结

理解了 resolve → load → transform 三段式，你就理解了 90% 的构建工具插件。`,
  },
  {
    slug: 'vite-rolldown-future',
    title: 'Vite 构建原理（三）：Rolldown 与构建工具的统一',
    series: 'Vite 构建原理',
    date: '2026-06-15',
    excerpt:
      'Rust 化的 Rolldown 正在统一 Vite 的开发与生产构建。聊聊这场「一次架构，两端受益」的变革。',
    tags: ['Vite', 'Rust'],
    readingMinutes: 8,
    views: 699,
    content: `## 分裂的过去

Vite 长期存在「双引擎」问题：开发用 esbuild 预构建，生产用 Rollup 打包。两端行为不一致是诡异地 bug 的温床。

## Rolldown 的野心

Rolldown 用 Rust 重写 Rollup 兼容的打包器，同时接管预构建与生产构建：

- 一套解析逻辑，两端一致
- 原生性能，构建提速数倍
- 插件 API 保持 Rollup 兼容，生态平滑迁移

## 对使用者的意义

1. 升级基本无感，配置不变
2. 大型项目的构建时间将显著下降
3. 「开发快、生产慢」的体验断层被抹平

## 小结

前端工具链的 Rust 化不是终点，而是把「等待」还给创造的开始。`,
  },
]

export const growthEntries: GrowthEntry[] = [
  {
    id: 'g-2026-h1',
    date: '2026-07-01',
    title: '2026 上半年复盘',
    content:
      '写了 8 篇技术文章，读完了 9 本书，跑步 300 公里。最大的变化是开始用「作品」而不是「工时」来衡量自己的产出。下半年继续把「React 19 深入浅出」写完。',
    tags: ['复盘'],
  },
  {
    id: 'g-2025-summary',
    date: '2025-12-31',
    title: '2025 年度总结',
    content:
      '这一年完成了三件大事：从业务开发转向前端基建、养成了每天写作的习惯、跑完了人生第一个 10 公里。学到的最重要一课：长期主义的本质是「不下牌桌」。',
    tags: ['年度总结'],
  },
  {
    id: 'g-2025-habit',
    date: '2025-09-10',
    title: '习惯养成实验 100 天',
    content:
      '用「微习惯」策略实践了 100 天：每天写 100 字、读 10 页书、做 1 个俯卧撑。结论：小到不可能失败的开始，才能骗过惰性，滚出雪球。',
    tags: ['习惯', '方法论'],
  },
  {
    id: 'g-2025-reading',
    date: '2025-06-18',
    title: '我的阅读方法论',
    content:
      '不再追求「读完」，而是追求「带走一个能用的观点」。主题阅读 + 卡片笔记，让每本书都在知识体系里留下接口。',
    tags: ['阅读'],
  },
]
