# 05 · useECharts 深度剖析：不捆绑 echarts 的图表 hook

> 系列导航：[README](./README.md) | [上一篇：零依赖设计](./04-zero-dependency-design.md) | [下一篇：useWatermark 深度剖析 →](./06-use-watermark.md)

读完本篇你会理解：

1. 为什么 `useECharts` 的依赖是一个都不装的 echarts
2. `globalProperties` 注入与特征嗅探的工作方式
3. 主题切换、resize 自适应、轴标签 tooltip 三个内部机制
4. 生产可用的完整示例

`src/hooks/useEcharts.ts` 是全库最大的文件（318 行），也是设计上最"拧巴"又最自洽的一个：它关于图表的能力封了一层又一层，却对 echarts 本体零引用。理解它是理解这个库工程品味的最佳样本。

## 先看用法，再看为什么

```ts
// main.ts —— 全局注册一次
import * as echarts from "echarts";
import { withInstallFunction } from "@pureadmin/utils";

// 最直接的方式：
app.config.globalProperties.$echarts = echarts;
```

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useECharts } from "@pureadmin/utils";

const elRef = ref(null);
const { setOptions } = useECharts(elRef);

setOptions({
  tooltip: { trigger: "axis" },
  xAxis: { type: "category", data: ["周一", "周二", "周三", "周四", "周五"] },
  yAxis: { type: "value" },
  series: [{ data: [150, 230, 224, 218, 135], type: "line" }]
});
</script>

<template>
  <div ref="elRef" style="width: 100%; height: 400px" />
</template>
```

返回对象有 16 个成员，前缀 `get` 的一组（`getDom`/`getWidth`/`getHeight`/`getOption`/`getInstance`/`getDataURL`/`getConnectedDataURL`/`getGlobalProperties`）基本是对 echarts 实例方法的透传，这里不逐一列。真正有独立逻辑的是四块：实例获取、主题切换、resize 自适应、addTooltip。

## 机制一：不 import echarts，靠注入

`useEcharts.ts` 里搜不到 `from "echarts"`——echarts 只出现在 `types.ts` 的类型声明里。运行时的 echarts 从哪来？看源码第 36 行附近：

```ts
let echarts = useGlobal<GlobalUtilsPropertiesApi>().$echarts;

if (!echarts) {
  // 兜底：遍历 globalProperties，找出同时具有
  // Axis 和 ChartView 属性的对象——那是 echarts 本体
  Object.keys(useGlobal()).forEach(g => {
    if (useGlobal()?.[g]?.Axis && useGlobal()?.[g]?.ChartView) {
      echarts = useGlobal()?.[g];
    }
  });
}
```

`useGlobal`（`src/hooks/useGlobal.ts`，19 行）从当前组件实例取 `appContext.config.globalProperties`。如果上面没有 `$echarts`，就遍历所有全局属性，用"同时有 `Axis` 和 `ChartView`"这个特征把 echarts 从一堆杂乱的全局属性里嗅探出来——因为 echarts 模块顶层恰好导出这两个类，其他库几乎不会同时具备。

为什么不直接 `import * as echarts from "echarts"`？

1. echarts 全量包很大，直接 import 意味着不用图表的项目只要碰了这个 hook 就会打进 echarts；
2. echarts 支持高度定制引入（只装折线图和柱状图能砍掉大半体积），库锁死全量引入等于没收了这项优化权；
3. 版本决策权留给使用方。

代价是**多了一步注册**，以及忘了注册时的报错很直白：`useECharts: echarts未绑定到globalProperties`。特征嗅探是给"注册了但属性名不叫 $echarts"的场景准备的，比如使用者按需引入后挂了个自定义名字。

## 机制二：主题是响应式的

```ts
const theme = options?.theme
  ? isProxy(options.theme) || isRef(options.theme)
    ? options.theme          // 已是响应式，直接用
    : ref(options.theme)     // 普通值，包成 ref
  : ref("default");
```

之后内部 `watch` 盯住 `theme.value`：变化时先 `chartInstance.dispose()` 销毁旧实例，再用新主题 `echarts.init` 重建，最后用**缓存的配置**重新 `setOption` 一遍。

这就是为什么 `setOptions` 内部先把配置存进 `cacheOptions` 这个 ref 而不是直接喂给 echarts——配置被缓存下来，主题切换时才能无损重放。切主题的完整体验是：一行都不用改业务代码，图表配色整体切换。

dark 主题有个细节：`getOptions` 计算属性里，theme 为 dark 时自动给配置塞一个 `backgroundColor: "transparent"`，让图表底色跟随页面而不是顶着白底。

## 机制三：resize 的双路径

图表自适应有两种典型场景，hook 里对应两条互斥的路径：

| 路径 | 触发方式 | 防抖时长 | 适用场景 |
| --- | --- | --- | --- |
| 窗口监听 | `window.addEventListener("resize")` | 300ms（`delay` 可配） | 容器尺寸就是视口比例 |
| 容器监听 | 内部调 `useResizeObserver` | 40ms（`delay` 可配） | 容器是侧边栏折叠区、Tab 页等非固定尺寸元素 |

配置写在 `setOptions` 的配置项里（这是 `UtilsEChartsOption` 对原生 `EChartsOption` 的扩展）：

```ts
setOptions({
  // ...echarts 原生配置
  container: ".sidebar-content",  // 盯这个容器的尺寸
  delay: 40                        // 防抖 40ms
});
```

互斥规则读源码 `onMounted` 块：设置了 `container` 就走 ResizeObserver，`resize` 属性（是否监听 window）失效；但如果 `container` 数组里含 `body`/`html`/`document`，则两条路径叠加（内部用 `arrayAnyExist` 判断——还记得第 2 篇的数组工具吗，库自己吃自己的狗粮）。组件卸载时 `tryOnUnmounted` 里成对移除监听、dispose 实例、删掉 tooltip 节点。

## 机制四：addTooltip，轴标签的悬浮提示

echarts 原生 tooltip 跟随数据图形，轴标签（axisLabel）文字太长被截断时没有提示。`addTooltip` 补的就是这个：

```ts
setOptions({
  xAxis: { type: "category", data: longLabels, triggerEvent: true }, // 前提
  addTooltip: "x"   // "x" | "y" | true（xy 都要）
});
```

内部流程：在 `html` 尾部插一个 `#tooltipElement` 的 div（id 可用 `tooltipId` 改）→ 监听实例的 `mouseover`，过滤 `targetType === "axisLabel"` → 把 label 内容填进 div，`onmousemove` 让 div 跟随鼠标 → `mouseout` 时隐藏。**前提**是轴配置了 `triggerEvent: true`，否则 echarts 不派发轴标签事件——这是使用者最常漏的一步。

## 机制五：容器还没渲染好怎么办

`setOptions` 开头有个自旋等待：

```ts
if (unref(elRef)?.offsetHeight === 0) {
  delay().then(() => setOptions(unref(getOptions), ...params));  // 默认 20ms 后重试
  return;
}
```

容器高度为 0（还在 v-if、Tab 切换、动画中）时，每 20ms 重试一次直到容器有高度再初始化。这解决的是 echarts 在 0 尺寸容器上 init 出来一片空白的问题。代价是极端情况下（容器永远是 0）会无限重试，业务上要保证容器终将可见。

## 新手常见误解：把 setOptions 当成一次性赋值

`setOptions` 不是"设置一次就完"的 setter。它做四件事：缓存配置 → 等容器就绪 → 惰性 init（`getInstance` 内部判空创建）→ 按 `clear` 配置（默认 `true`）清空后重设。多次调用是"全量替换 + 重放事件"，而它第二起的可变参数是事件注册：

```ts
setOptions(option, {
  name: "click",
  callback: params => console.log(params)
}, {
  name: "globalout",          // 监听"空白处"点击要用 zrender 事件
  type: "zrender",
  callback: params => {}
});
```

事件注册走 `chartInstance.on`（echarts 事件）或 `getZr().on`（zrender 事件，且回调只在点击目标为空时触发——判断条件是 `!params.target`）。每次 setOptions 都会重新注册一遍事件，所以回调里拿到的闭包永远是最新的。

## 完整示例：主题切换 + 容器自适应

```vue
<script setup lang="ts">
import { ref } from "vue";
import { useECharts } from "@pureadmin/utils";

const elRef = ref(null);
const theme = ref("default");
const { setOptions } = useECharts(elRef, { theme });  // 传响应式主题

setOptions({
  tooltip: { trigger: "axis" },
  xAxis: { type: "category", data: ["衬衫", "羊毛衫", "雪纺衫", "裤子", "高跟鞋"], triggerEvent: true },
  yAxis: { type: "value" },
  series: [{ name: "销量", type: "bar", data: [5, 20, 36, 10, 10] }],
  addTooltip: "x",        // 轴名太长时悬浮可见
  container: ".card-box"  // 卡片容器折叠/展开时图表自动 resize
});

const toggle = () => {
  theme.value = theme.value === "default" ? "dark" : "default";
};
</script>

<template>
  <div class="card-box" style="width: 100%">
    <el-button @click="toggle">切换主题</el-button>
    <div ref="elRef" style="width: 100%; height: 400px" />
  </div>
</template>
```

点按钮整图换肤不丢数据，拖浏览器窗口或折叠侧边栏图表自动跟随，两条链路互不干扰。

## 下一步

`useECharts` 展示了"注入外部重型依赖"的模式，`useWatermark` 则展示了另一个极端：一切自绘，canvas 加 MutationObserver 实现一个"删不掉"的水印。[第 6 篇：useWatermark 深度剖析](./06-use-watermark.md)拆这张画布。

**动手练习**：故意不注册 `globalProperties`，观察报错信息；然后换个方式注册——`app.config.globalProperties.myChart = echarts`，验证特征嗅探能否把这个改了名的 echarts 找回来（答案是能，说说嗅探条件为什么恰好不会误伤 `$echo`、`$http` 这类常见全局属性）。
