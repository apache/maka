# 03 · hooks 实战：水印、拖拽、暗色模式与剪贴板

> 系列导航：[README](./README.md) | [上一篇：工具函数实战](./02-utils-in-action.md) | [下一篇：零依赖设计 →](./04-zero-dependency-design.md)

读完本篇你会掌握：

1. hooks 和 utils 的使用边界：什么时候必须用 hooks
2. 五个高频 hooks 的真实用法和返回值
3. hooks 在非组件环境下的行为约定

`useECharts` 体量大、机制特殊，单独放在[第 5 篇](./05-use-echarts.md)讲，本篇覆盖其余高频 hooks。

## 先分清：这个需求该用 utils 还是 hooks

判断标准只有一条：**结果是一次性的，还是需要持续跟踪的**。

"把这串文本复制到剪贴板"是持续行为——用户之后按 Ctrl+V 用的就是剪贴板此刻的内容，而且"复制成功了吗"本身就是个会变化的状态。这类需求交给 hooks。"判断这串文本是不是 URL"是一次性计算，utils 就够。

| 持续行为 | 对应 hook |
| --- | --- |
| 页面上盖一层洗不掉的水印 | `useWatermark` |
| 跟随系统主题切换 | `useDark` |
| 弹窗头部拖动整个弹窗 | `useDraggable` |
| 复制文本并反馈成败 | `useCopyToClipboard` |
| 容器尺寸变化时执行回调 | `useResizeObserver` |
| 带缓动地滚动到指定位置 | `useScrollTo` |
| 按需加载远程 css/js | `useLoader` |

## useWatermark：平铺水印

```ts
import { ref, onMounted } from "vue";
import { useWatermark } from "@pureadmin/utils";

const appRef = ref(null);
let watermark;

onMounted(() => {
  watermark = useWatermark(appRef);
  watermark.setWatermark("内部资料", {
    color: "rgba(255, 0, 0, 0.15)",
    rotate: -22,
    font: "normal 18px Arial"
  });
});

onUnmounted(() => {
  watermark.clear();
});
```

`useWatermark` 接收两个参数：水印挂在哪个元素上（`ref` 或不传默认 `document.body`）、是否在窗口 resize 时重绘（默认 `false`，水印背景是 `repeat` 平铺，多数场景不用重绘）。

常用配置都通过 `setWatermark` 的第二个参数 `attr` 传入，按用途分组记：

| 用途 | 字段 |
| --- | --- |
| 文本外观 | `font` `color` `globalAlpha` `gradient`（渐变色，优先级高于 color） |
| 瓦片尺寸与角度 | `width`（默认 250）`height`（默认 100）`rotate`（默认 -10）`zIndex`（默认 100000） |
| 多行文本 | `wrap`（换行分隔符，默认 `、`）`lineHeight` `textAlign` |
| 图片水印 | `image` `imageWidth` `imageHeight` |
| 特殊效果 | `shadowConfig`（canvas 阴影四参数）`forever`（防删除）`verticalOffset`（偶数列下移） |

`forever: true` 会启动一个 MutationObserver 监听挂载点，水印节点被手动删掉就立刻重建，控制台里删 Element 也拦不住。

## useDark：暗色模式检测

```ts
import { useDark } from "@pureadmin/utils";

const { isDark, toggleDark } = useDark();
```

它做的事情：盯住 `html` 标签上的 `dark` class。`isDark` 是响应式布尔值，别处代码（或手动调 `toggleDark()`）改了这个 class，`isDark` 自动跟着变。内部靠 MutationObserver 监听 attribute 变化，不依赖任何状态管理库。

两个可选参数：`selector: "body"` 换成盯 body，`className` 换成盯别的 class 名。

## useDraggable：元素拖拽

```ts
import { ref, onMounted } from "vue";
import { useDraggable } from "@pureadmin/utils";

const dialogRef = ref(null);   // 被拖动的元素
const headerRef = ref(null);   // 按住哪里拖

onMounted(() => {
  const drag = useDraggable(dialogRef, headerRef);
  drag.init();
});
```

返回值里四个成员最常用：

| 成员 | 含义 |
| --- | --- |
| `dragging` | 正在拖动中，响应式 |
| `draggable` | 拖动功能开关状态，响应式 |
| `transform` | 当前偏移量 `{ offsetX, offsetY }` |
| `reset()` | 平滑动画回到初始位置 |

拖动范围自动限制在视口内，窗口 resize 后元素超出边界会被拉回初始位置（`args.resize` 可关闭或调整防抖时长，默认 60ms）。内部用 `requestAnimationFrame` 节流 transform 更新，拖动不掉帧。

## useCopyToClipboard：复制到剪贴板

```ts
import { useCopyToClipboard } from "@pureadmin/utils";

const { clipboardValue, copied, update } = useCopyToClipboard();

update("要复制的内容");
// copied.value 变为 true 表示成功
```

`update` 接受字符串，也接受 `ref`（自动解包）。要复制的值为空时回退到构造时传的 `defaultValue`，两个响应式值可以直接绑到模板上做"已复制"提示。内部走 `document.execCommand("copy")` 兼容路径，老浏览器也能用。

## useResizeObserver：监听元素尺寸

```ts
import { useResizeObserver } from "@pureadmin/utils";

useResizeObserver(
  ".chart-container",            // 选择器、ref、或它们的数组
  entries => { /* 尺寸变了 */ },
  { time: 40, immediate: true }  // 防抖 40ms，初始立即触发一次
);
```

比原生 `ResizeObserver` 多了两件事：内置防抖（默认 40ms），以及支持选择器和 `ref` 混传数组、一次盯多个元素。返回 `{ stop, restart }` 控制监听开关。

## useScrollTo：平滑滚动

```ts
import { useScrollTo } from "@pureadmin/utils";

const scrollTo = useScrollTo({
  el: document.querySelector(".main"),
  to: 0,
  directions: "scrollTop",
  duration: 300
});
scrollTo.start();  // 300ms 缓动滚回顶部
scrollTo.stop();   // 随时暂停
```

缓动曲线是二次方缓入缓出（easeInOutQuad），`duration` 传 0 则直接跳转不播动画。目标位置自动钳制在该方向的最大滚动范围内，不会滚过头。

## useLoader：动态加载静态资源

```ts
import { useLoader } from "@pureadmin/utils";

const { loadCss, loadScript } = useLoader();

await loadScript({ src: "https://cdn.example.com/echarts.min.js" });
await loadCss({ src: "https://cdn.example.com/style.css" });
```

返回 Promise，加载成功 resolve `{ src, message: "加载成功" }`。默认 `destroy = true`：组件卸载时自动移除本次插入的标签。已存在的同 src 标签会被克隆替换以重新触发加载，这个设计让"卸载再重载"成为可能。

## 新手常见误解：hooks 能在组件外面调吗

能调，但行为要清楚。库内部用 `tryOnUnmounted` / `tryOnScopeDispose` 包装清理逻辑：当前不在 Vue 组件或 effect 作用域里时，注册清理函数的调用被直接跳过，**不报错**。也就是说在 Pinia store、普通 ts 文件里调用 `useWatermark()` 不会崩，但组件卸载时的自动清理（比如 `useLoader` 移除 script 标签）不会发生，需要自己手动调返回的清理方法。

正确姿势就一句话：**跟着组件走的行为放组件里调，这样清理是自动的**。

## 下一步

用好 hooks 之后，值得回头看一眼库是怎么做到"同一个包，Node 和浏览器都能吃"的。[第 4 篇：零依赖设计](./04-zero-dependency-design.md)拆解 `convert.ts` 依赖反转层和多入口构建，这是整个库里最值得学习的一段工程设计。

**动手练习**：给 `useWatermark` 传 `{ gradient: [{ value: 0, color: "#ff0000" }, { value: 1, color: "#0000ff" }], width: 300, verticalOffset: 30 }`，观察两件事：文字变成从红到蓝的渐变；偶数列水印比奇数列整体下移了 30px。再翻到 `src/hooks/useWatermark.ts` 的 `createBase64` 函数，找到画布宽度被设为 `singleWidth * 2` 的那一行，理解"奇偶双列"是在一张画布里画出来的。
