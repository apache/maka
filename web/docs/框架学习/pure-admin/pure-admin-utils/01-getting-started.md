# 01 · 初识 @pureadmin/utils：它是干什么的

> 系列导航：[README](./README.md) | [下一篇：工具函数实战 →](./02-utils-in-action.md)

读完本篇你会知道：

1. 这个库解决什么问题，和 lodash 这类工具库有什么不同
2. 它的三部分组成：utils、hooks、types
3. 三种安装方式，以及怎么写出第一行能跑的代码

## 一句话定义

`@pureadmin/utils` 是 pure-admin 团队维护的 TypeScript 工具库，里面装了两类东西：**能在任何 JavaScript 环境直接调用的纯函数**，和 **需要 Vue 3 才能跑起来的组合式函数（hooks）**。

当前版本 2.6.4，MIT 协议，npm 包名就是 `@pureadmin/utils`。

## 拆成三个核心要素

把它想象成一个工具间，里面有三样东西。

### 1. utils：瑞士军刀

`src/utils/` 下的 29 个文件，每个文件是一类刀。数组、对象、字符串、金额、日期、颜色、树形数据、下载、存储……全是普通函数，给参数就返回结果，不挑环境：

```ts
import { priceToThousands } from "@pureadmin/utils";

priceToThousands(123456789); // "123,456,789"
```

这段代码在浏览器、Node.js、小程序适配层里都能跑，因为它不碰 `window` 之外的浏览器专属 API。

### 2. hooks：需要插电的电动工具

`src/hooks/` 下的 11 个 `useXxx` 函数。瑞士军刀拧螺丝靠手劲，电动工具拧螺丝靠电——这里的"电"就是 Vue 3 的响应式系统。水印（`useWatermark`）、拖拽（`useDraggable`）、暗色模式检测（`useDark`）、图表（`useECharts`）都属于这类：

```ts
import { useDark } from "@pureadmin/utils";

// isDark 是响应式的：手动切换 html 上的 class，它自动更新
const { isDark, toggleDark } = useDark();
```

没有 Vue，电动工具插不上电；但库本身不会强迫你装 Vue，原因在[第 4 篇](./04-zero-dependency-design.md)展开。

### 3. types：随工具附带的说明书

`src/types.ts` 一个文件集中放了 730 行类型定义。每个函数的选项参数都有对应的 interface，写代码时有完整补全和中文注释。比如给水印传配置时的 `attr` 接口，光注释就覆盖了字体、渐变、阴影、防删除等十几个字段的含义。

## 和 lodash 的差别

| 对比项 | lodash | @pureadmin/utils |
| --- | --- | --- |
| 语言 | JavaScript（类型靠 @types 补） | TypeScript 原生编写，类型即文档 |
| Vue 支持 | 无 | 11 个响应式 hooks |
| 文档语言 | 英文为主 | 中文注释 + 中文文档站 |
| 图表场景 | 无 | useECharts 封装了 echarts 常用操作 |
| 零依赖 | 零依赖 | 零 dependencies，vue/echarts 为**可选** peer |

两者定位有重叠，选择依据很简单：项目是 Vue 3 且中文团队，`@pureadmin/utils` 的注释、文档和 hooks 会省不少事；通用 Node 脚本则两者都行。

## 安装

```bash
# npm
npm install @pureadmin/utils

# yarn
yarn add @pureadmin/utils

# pnpm
pnpm add @pureadmin/utils
```

安装完成只装包本身。`vue` 和 `echarts` 标记为 optional peer dependencies，不会自动装——package.json 里没有一条 `dependencies`，这是这个库反复强调的"零依赖"。

不想装包也可以走 CDN，所有方法挂在全局变量 `PureUtils` 上：

```html
<!-- jsdelivr -->
<script src="//cdn.jsdelivr.net/npm/@pureadmin/utils"></script>

<!-- unpkg -->
<script src="//unpkg.com/@pureadmin/utils"></script>
```

## 第一行代码：在 Node 里跑

建一个 `test.mjs`：

```js
import { getTime } from "@pureadmin/utils";

console.log(getTime(60)); // { h: 0, m: '01', s: '00' }
```

运行 `node test.mjs`，输出秒数 60 转换成的时分秒，分钟位自动补了 0。

## 第一行代码：在 Vue 组件里跑

```vue
<script setup lang="ts">
import { ref, onMounted } from "vue";
import { useWatermark } from "@pureadmin/utils";

const appRef = ref(null);

onMounted(() => {
  const { setWatermark } = useWatermark(appRef);
  setWatermark("内部资料，禁止外传");
});
</script>

<template>
  <div ref="appRef" style="width: 600px; height: 400px">正文内容</div>
</template>
```

页面渲染后，容器里会出现一层 `-10°` 倾斜的灰色平铺水印。这就是 utils 和 hooks 的典型分工：前者一行算出一个结果，后者管理一段持续存在的浏览器行为。

## 一个新手常见误解：必须先装 Vue？

不用。`vue` 是**可选**的 peer dependency，纯 Node 环境装这一个包就能用全部 29 个 utils 模块。只有当你 import 到 `useXxx` 这类 hooks 时，运行时才需要 Vue 在场。类型判断、金额格式化、树形数据处理这些高频能力，和 Vue 一点关系都没有。

反过来，误解的另一半更常见：以为"零依赖"是指运行时不占用任何东西。零依赖说的是**包管理层面**——npm 不会替你额外装任何包；hooks 一旦被使用，运行时自然还是需要 Vue 实例。

## 下一步

- 想先掌握最常用的工具函数，看[第 2 篇：工具函数实战](./02-utils-in-action.md)
- 想直接上手水印、拖拽这些交互能力，看[第 3 篇：hooks 实战](./03-hooks-in-action.md)
- 想搞懂"可选依赖"在工程上是怎么做到的，直接跳[第 4 篇：零依赖设计](./04-zero-dependency-design.md)

**动手练习**：装好包之后，用 `isUrl` 分别测试 `http://localhost:8800/doc.html`、`ftp://192.168.2.121` 和一个不带协议的 `github.com`，观察第三个为什么返回 `false`——协议在它的校验规则里是可选的，但域名必须带后缀。
