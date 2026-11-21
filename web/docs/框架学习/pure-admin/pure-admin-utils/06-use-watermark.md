# 06 · useWatermark 深度剖析：一张画布与一个守护进程

> 系列导航：[README](./README.md) | [上一篇：useECharts 深度剖析](./05-use-echarts.md) | [下一篇：类型系统 →](./07-type-system.md)

读完本篇你会理解：

1. 平铺水印的全部视觉来自一张双倍宽的 canvas
2. `forever` 防删除靠 MutationObserver，以及它的边界
3. 奇偶双列与 `verticalOffset` 的实现（2.6.4 新增特性）
4. resize 重绘的必要条件

水印是个"看似简单"的需求：一行浅灰的重复文字盖在页面上。但把它做到"改样式、换图片、防手删、不挡点击"，背后是 canvas 绘制、背景平铺、DOM 守护三个独立机制的配合。`src/hooks/useWatermark.ts`（267 行）三层都写了，而且是 2.x 系列迭代最活跃的文件之一——最新版本 2.6.4 的唯一功能变更就是给这个 hook 加了个配置。

## 总体结构：一个 hook，两个对外方法

```ts
const { setWatermark, clear } = useWatermark(appendEl?, resizeReDraw?);
```

| 参数/返回 | 类型 | 说明 |
| --- | --- | --- |
| `appendEl` | `ElementRef<HTMLElement>` | 挂载元素，默认 `document.body` |
| `resizeReDraw` | `boolean` | 窗口 resize 时是否重绘，默认 `false` |
| `setWatermark` | `(str, attr?) => id` | 创建（或更新）水印 |
| `clear` | `() => void` | 移除水印 |

内部围绕一个 `shallowRef<HTMLElement>`（当前水印 div）和一个固定 id（`Symbol("watermark-dom").toString()`）工作。

## 机制一：水印不是 DOM 文字，是一张背景图

打开 `createBase64`：它创建一个 canvas，把文字画上去，`toDataURL` 转成 base64，最终落到水印 div 的样式上：

```ts
el.style.background = `url(${base64}) left top repeat`;
```

为什么不用一排排 DOM 元素拼水印？三个原因：

1. **性能**：`repeat` 是浏览器合成层做的纹理平铺，几千个文字 DOM 节点则实打实参与布局和重绘；
2. **`pointerEvents: "none"`**：水印 div 不拦截任何鼠标事件，页面交互完全无感；
3. **天然防文本修改**：水印是图，改文字得改图。

canvas 的尺寸是关键设计：画布宽度 = `attr.width * 2`（默认 250 的两倍 500），高度 = `attr.height + verticalOffset`。这一个画布里画**两份**内容——奇数列一份在 `(0, 0)`，偶数列一份在 `(singleWidth, verticalOffset)`。平铺之后自然形成交错效果，`verticalOffset`（默认 0）让偶数列整体下移，就是 2.6.4 更新说明里"偶数列向下偏移配置变量"的实现。

文字绘制的完整流程在 `drawTextAtPosition` 里：`translate` 到瓦片中心 → `rotate` 默认 -10° → 依次应用 `globalAlpha`、阴影、字体、对齐 → 如果配置了 `gradient` 就 `createLinearGradient` 填渐变色，否则用 `color`（默认 `rgba(128, 128, 128, 0.3)`）→ 按 `wrap` 分隔符（默认 `、`）拆行逐行 `fillText`，行高默认 20。

图片水印（`attr.image`）走同一条路：`loadImage` 加载后用 `drawImage` 画在相同位置，跨域图片自动加 `crossOrigin = "anonymous"` 和 `referrerPolicy = "no-referrer"`，加载失败则降级画文字，保证水印永不缺席。

## 机制二：forever 的守护进程

```ts
function handleObserver(str, attr) {
  const observer = new MutationObserver(val => preventDelete(val, { str, attr }));
  observer.observe(unref(appendEl), {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true
  });
}
```

`forever: true` 时启动这个观察器。回调 `preventDelete` 只关心一件事：变更记录里被移除的节点是否是水印 div，是就立刻 `createWatermark` 重建。在控制台 Elements 面板里删掉水印节点，观察器在下一次微任务里就把水印放回去。

三个边界要清楚：

1. **观察的是挂载点**。水印挂 body，就盯 body。如果水印节点被移到别处而不是删除，行为取决于挂载点的 subtree 配置是否覆盖到新位置。
2. **重建用的是创建时缓存的 str 和 attr**，事后通过 `setWatermark` 更新的样式也会随重建保留（因为更新走了 `updateWatermark`，但 observer 闭包里的 attr 是首次 forever 时的那份——连续两次 `setWatermark` 且 attr 变化后，被删除重建的水印会回到第一次的配置）。
3. **observer 本身没有销毁入口**。`clear()` 移除水印 div，但守护进程还在，下一次水印被删（或 clear 后任何触碰挂载点子节点的操作导致水印缺席的判定）时仍会尝试重建。不打算要水印时，把用完的 `useWatermark` 实例整个丢弃而不是只调 `clear`，是更干净的做法。

## 机制三：resizeReDraw 与它的默认值

水印背景是 `repeat` 平铺，铺满区域由水印 div 的宽高决定。`createWatermark` 时按挂载点的 `clientWidth/clientHeight` 设定 div 尺寸，之后窗口变大，div 尺寸不变，右侧和底部露出空白——这才是 `resizeReDraw` 存在的原因：开启后注册防抖的 resize 监听（内部复用 `debounce`），回调里按新尺寸调 `updateWatermark({ width, height })`。

默认 `false` 是个合理选择：多数页面 body 本身就 100% 宽高，CSS 层面不会露白；真正的重绘需求出现在"挂在小容器里、容器会伸缩"的场景。

## 一个值得注意的时序行为

`setWatermark` 的结尾有这样几行（源码 250 行附近）：

```ts
const instance = getCurrentInstance();
if (instance) {
  clear && clear();
}
```

在组件实例上下文中同步调用 `setWatermark` 时（Vue 的 setup 和生命周期钩子内 `getCurrentInstance()` 都返回实例），函数末尾会立刻执行一次 `clear`，把刚插入的水印 div 摘掉。而 `createWatermark` 里给 div 设置背景是 `createBase64` 的异步 Promise 回调——节点已被摘除，异步回调面对的是脱离文档的节点。

这段代码的实际效果高度依赖调用位置，阅读源码时值得专门标注。使用者层面的稳妥姿势：

```ts
onMounted(() => {
  nextTick(() => {
    const { setWatermark } = useWatermark();
    setWatermark("pure-admin");
  });
});
```

放进 `nextTick` 或异步回调后再调用，避开同步实例上下文，水印稳定存在。这是用这个 hook 时最容易莫名"水印不显示"的原因。

## 配置速查

| 我想 | 传什么 |
| --- | --- |
| 换字色/透明度 | `color`、`globalAlpha` |
| 更密/更疏 | `width`、`height` 调瓦片尺寸 |
| 调角度 | `rotate`（度数，默认 -10） |
| 渐变文字 | `gradient: [{ value: 0, color }, { value: 1, color }]` |
| 文字加描边阴影 | `shadowConfig: [blur, color?, offsetX?, offsetY?]` |
| 多行 | 内容里用 `、` 分隔（或改 `wrap`），配 `lineHeight` |
| 图片水印 | `image` + `imageWidth`/`imageHeight` |
| 防手删 | `forever: true` |
| 两列错位 | `verticalOffset`（像素，2.6.4+） |
| 改层级 | `zIndex`（默认 100000） |

## 新手常见误解：水印安全是绝对安全

不是。MutationObserver 防的是"删节点"这一种攻击路径。打开控制台的人还可以：用 CSS 把水印层 `display: none`（attributes 变更虽在监听范围内，但恢复的是创建时样式快照，持续的 CSS 覆盖防不住）、拦截 canvas toDataURL、或干脆重写 `MutationObserver` 构造函数。客户端水印的定位是**溯源威慑**（截图带标记、增加删除成本），不是密码学意义上的防篡改。要求对抗有意攻击的保密场景，水印必须配合服务端渲染与权限控制。

## 下一步

到这里，库的运行时行为已经全部过完。[第 7 篇：类型系统](./07-type-system.md)转入静态层面：`types.ts` 如何用 730 行类型定义撑起全库的补全体验，以及 `DeepClean` 这类条件类型是怎么写出来的。

**动手练习**：创建两个水印做对照实验——`w1 = useWatermark()`（挂 body），`w2 = useWatermark(appRef)`（挂组件容器）。分别 `setWatermark` 后打开控制台删掉两个水印 div，观察哪个会被自动重建（答案是开启 `forever` 的那个）；再调用 `clear()`，确认守护进程是否还在工作。这个实验能帮你亲手验证"observer 生命周期独立于 clear"这个边界。
