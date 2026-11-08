---
title: nsh
description: 核心模块：signal、effect、context、mount、设计令牌、动画、环境、手势、剪贴板、存储、宿主通道、键盘快捷键、无障碍，以及元素和样式的类型。
order: 2
---

# nsh

`nsh` 是核心模块：响应式 API（signal、computed、effect、context）、`mount`、`token`、`setTheme`、宿主元素 `View`、`Text`、`Scroll` 和 `Overlay`，[可选择的视图](#selectable-views)、[安全区域与键盘](#safe-area-and-keyboard)，[动画](#animation)、[设备与环境](#device)、[`PanResponder`](#panresponder)、[剪贴板](#clipboard)、[照片选择器](#picker)、[语音识别](#speech)、[声音](#sound)、[存储](#storage)、[宿主通道](#host)、[键盘快捷键](#keymap)、[原生组件与模块](#nativecomponent-and-nativemodule)、[无障碍](#accessibility)，以及元素、样式和事件的 TypeScript 类型。响应式图本身以 Rust 原生运行；读取一个 signal 是一次对运行时的调用，只需几纳秒，只有你自己写的闭包会在 JavaScript 解释器中执行。

```ts
import { batch, cleanup, computed, context, effect, ErrorBoundary, mount, Overlay, Scroll, signal, split, Text, token, untracked, View } from "nsh";
import { Input } from "nsh/base";
```

NSH 的响应式模型与 SolidJS 相同：组件函数只运行**一次**，界面中读取了 signal 的部分会在 signal 变化时就地更新。组件不会重新渲染，也没有虚拟 DOM。教程见[响应式](../docs/reactivity.md)。

## signal

```ts
function signal<T>(value: T, options?: SignalOptions<T>): Signal<T>;
function signal<T = undefined>(): Signal<T | undefined>;

interface Signal<T> {
  (): T;                              // 读取（会被追踪）
  set(value: T): void;                // 写入
  update(fn: (value: T) => T): void;  // 基于当前值写入
}

interface SignalOptions<T> {
  /** 新值何时算作变化（默认 `===`）；`false`：总是算作变化。 */
  equals?: false | ((previous: T, next: T) => boolean);
}
```

signal 保存一个值。调用它会读取该值；如果处在追踪作用域内（JSX 表达式、`computed`、`effect`），该作用域会订阅它。`set` 和 `update` 写入新值，所有读过它的地方随之更新。

```tsx
import { mount, signal, Text, View } from "nsh";

function Counter() {
  const count = signal(0);
  return (
    <View style={{ padding: 24, gap: 12 }}>
      <Text>Count: {count()}</Text>
      <Text onPress={() => count.update((n) => n + 1)}>Add one</Text>
    </View>
  );
}

mount(Counter);
```

默认情况下，写入与当前值 `===` 相等的值不会产生任何效果。传入 `equals: false` 可以让每次写入都通知订阅者（适合原地修改对象后再次写入同一个对象的场景），也可以传入自定义比较函数：

```ts
const items = signal<string[]>([], { equals: false });
const point = signal({ x: 0, y: 0 }, { equals: (a, b) => a.x === b.x && a.y === b.y });
```

## computed

```ts
function computed<T>(fn: (previous: T | undefined) => T, options?: SignalOptions<T>): Accessor<T>;

interface Accessor<T> {
  (): T;
}
```

由 signal 派生出的值。`fn` 读过的 signal 变化时它会重新运行；只有当结果真的变化（按 `equals` 判断，默认 `===`）时，读取它的地方才会更新。`fn` 会收到上一次的结果。

```ts
const first = signal("Ada");
const last = signal("Lovelace");
const full = computed(() => `${first()} ${last()}`);
full(); // "Ada Lovelace"
```

派生计算开销较大或在多处读取时使用 `computed`。对于简单的表达式，普通函数（`const full = () => first() + " " + last()`）同样是响应式的。

## effect

```ts
function effect(fn: () => void): void;
```

在渲染之后运行 `fn`，并在它读过的任何 signal 变化时再次运行。effect 用于副作用：打日志、定时器、调用原生模块等。effect 归属于创建它的组件（或 effect），并随之一起销毁。

```ts
const query = signal("");
effect(() => {
  console.log("query is now", query());
});
```

如需在 effect 再次运行前（或组件销毁时）撤销某些操作，在 effect 内部调用 [`cleanup`](#cleanup)。

## batch

```ts
function batch<T>(fn: () => T): T;
```

运行 `fn`，并在结束时一次性应用其中的所有写入，这样读取方只更新一次，而不是每次写入都更新一次。返回 `fn` 的返回值。

```ts
batch(() => {
  first.set("Grace");
  last.set("Hopper");
}); // `full` 只重新计算一次
```

## untracked

```ts
function untracked<T>(fn: () => T): T;
```

运行 `fn`，但当前作用域不会订阅其中读取的内容。用于在 effect 或 JSX 表达式中读取某个 signal 而不依赖它。

```ts
effect(() => {
  // `query` 变化时重新运行，`page` 变化时不会。
  search(query(), untracked(() => page()));
});
```

## cleanup

```ts
function cleanup(fn: () => void): void;
```

注册 `fn`，在当前 effect 再次运行之前，或当前组件、effect 被销毁时运行。

```tsx
function Clock() {
  const now = signal(new Date());
  const timer = setInterval(() => now.set(new Date()), 1000);
  cleanup(() => clearInterval(timer));
  return <Text>{now().toLocaleTimeString()}</Text>;
}
```

## context

```ts
function context<T>(defaultValue: T): Context<T>;

interface Context<T> extends Accessor<T> {
  Provider: (props: { value: T; children?: JSX.Element }) => JSX.Element;
}
```

组件向其渲染的所有后代（无论多深）提供的值。调用 context（`Theme()`）读取最近的 Provider 提供的值，没有 Provider 时得到 `defaultValue`。

```tsx
import { context, mount, signal, Text, View } from "nsh";

const Theme = context<"light" | "dark">("light");

function Label(props: { text: string }) {
  return <Text style={{ color: Theme() === "dark" ? "#fff" : "#000" }}>{props.text}</Text>;
}

function App() {
  const dark = signal(false);
  return (
    <Theme.Provider value={dark() ? "dark" : "light"}>
      <View style={{ flex: 1, padding: 24, backgroundColor: dark() ? "#000" : "#fff" }}>
        <Label text="Hello" />
        <Text onPress={() => dark.update((d) => !d)}>Toggle</Text>
      </View>
    </Theme.Provider>
  );
}

mount(App);
```

## mount

```ts
function mount<P extends object>(app: Component<P>, props?: P): () => void;
```

把 `app` 渲染到界面上（窗口，或嵌入应用时的 `NshAppView` / `NshView`），返回一个用于移除它的函数。每个应用的入口文件都以 `mount(App)` 结尾。

```tsx
mount(App);
```

## split

```ts
function split<T extends object, K extends readonly (keyof T)[]>(
  props: T,
  keys: K,
): [Pick<T, K[number]>, Omit<T, K[number]>];
```

把 props 对象拆成 `keys` 中列出的属性和其余属性。两部分都保持响应式：会变化的属性是 getter，`split` 会保留这些 getter。适用于组件自己处理一部分 props、把其余部分透传下去的场景。直接解构 props（`const { label } = props`）只会读取一次，之后的更新就丢失了。

```tsx
import { split, Text, View } from "nsh";
import { Input, type InputProps } from "nsh/base";

function LabeledInput(props: InputProps & { label: string }) {
  const [own, rest] = split(props, ["label"]);
  return (
    <View style={{ gap: 4 }}>
      <Text>{own.label}</Text>
      <Input {...rest} />
    </View>
  );
}
```

## ErrorBoundary

```ts
function ErrorBoundary(props: {
  fallback: JSX.Element | ((error: unknown, reset: () => void) => JSX.Element);
  children?: JSX.Element;
}): JSX.Element;
```

渲染它的子元素；子元素下的代码抛出异常后（组件函数体、绑定、effect 或事件处理函数），改为渲染 `fallback`。失败的部分被移除，fallback 显示在原处。函数形式的 `fallback` 总是以 `fallback(error, reset)` 调用，得到抛出的值和 `reset`，`reset` 重新渲染子元素，与它声明了几个参数无关；元素形式的 `fallback` 按原样显示。失败交给它上方最近的错误边界，fallback 中的失败交给再上一层的错误边界。Rust 组件使用 `catch_error`（[错误边界](../docs/reactivity.md#错误边界)）。

```tsx
import { ErrorBoundary, Text, View } from "nsh";

function Feed() {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <View>
          <Text>{error instanceof Error ? error.message : String(error)}</Text>
          <Text onPress={reset}>Try again</Text>
        </View>
      )}
    >
      <Posts />
    </ErrorBoundary>
  );
}
```

## token

```ts
function token<K extends keyof Tokens>(name: K): Tokens[K];
```

应用主题（`nsh.json` 的 `"theme"`，叠加在 shadcn/ui 的令牌之上）中名为 `name` 的设计令牌在当前外观下的值：颜色是 `#rrggbbaa`，
长度是以点为单位的数值，字体是字体族名称。名称是主题中 CSS 变量去掉 `--` 后的名称（`primary`、`muted-foreground`、`radius`、
`font-mono`，以及应用自己的令牌，如 `up`）。读取它是响应式的：读取令牌的组件、memo 或 effect 会在主题或外观变化时重新运行。
`Tokens` 列出应用的令牌及其类型；NSH 根据主题把它写入 `.nsh/types/nsh/tokens.d.ts`。在类名中直接引用令牌（`bg-primary`、
`rounded-(--radius)`）：见[主题 token](../docs/tailwind.md#主题-token)。

```tsx
import { effect, token } from "nsh";

effect(() => console.log("primary is", token("primary"), "radius", token("radius")));
```

## setTheme

```ts
function setTheme(theme: Theme | null): void;

interface Theme {
  cssVars: {
    theme?: Record<string, string | number>;
    light?: Record<string, string | number>;
    dark?: Record<string, string | number>;
  };
}
```

在应用运行时把 `theme` 设为应用的主题，取代 `nsh.json` 的 `"theme"`：格式与它相同，也和它一样叠加在 shadcn/ui 的令牌之上。
它立即生效：调用之后 `token()` 马上读到新的令牌，引用令牌的类名、`nsh/base` 和 Rust 组件的 `theme()` 在下一帧跟上，两种外观都是。
嵌入方应用的[主题覆盖](../docs/tailwind.md#主题-token)仍然优先于它。传 `null` 恢复应用构建时的主题。

主题要整个读得懂：有值读不懂时（NSH 不认识的颜色，如 `#zz` 或 `lab()`；指不到颜色的 `var()`；或一种外观下是颜色、另一种外观下却不是颜色的值），
`setTheme` 抛出 `TypeError`，逐一列出这些值，正在显示的主题保持不变。阴影这类不属于任何令牌类型的值会被略过，和 `nsh.json`
的主题一样。新主题请从应用自己的主题出发，只改不同的部分，这样类名引用的令牌都还有值（`up` 在 `nsh.json` 的主题里时的 `bg-up`）。
Rust：对 `nsh_base::Theme` 调用 `set_tokens(theme.into())`（[主题 token](../docs/tailwind.md#主题-token)）。

```tsx
import { setTheme } from "nsh";
import theme from "./theme.json"; // nsh.json 的 `"theme"` 指向的文件

// 应用的主题，换一个 primary 颜色。
function brand(color: string) {
  const { light, dark } = theme.cssVars;
  setTheme({ cssVars: { ...theme.cssVars, light: { ...light, primary: color }, dark: { ...dark, primary: color } } });
}

brand("#e11d48");
setTheme(null); // 恢复应用的主题
```

## View、Text、Scroll、Overlay

```ts
function View(props: ViewProps): JSX.Element;
function Text(props: TextProps): JSX.Element;
function Scroll(props: ScrollProps): JSX.Element;
function Overlay(props: OverlayProps): JSX.Element;
```

`nsh` 导出的宿主元素，写作标签：`<View>`、`<Text>`、`<Scroll>`、`<Overlay>`（把子元素显示在窗口之上，相对锚点放置：[Overlay](../elements/overlay.md)）。当标签通过导入（包括别名）指向它们之一时，编译器会就地创建原生视图，所以导入它们在运行时没有任何开销。它们也是普通的组件，可以作为值传递（`const Tag = inline ? Text : View`）。`nsh` 以同样的方式导出其他原语：[`List`](./nsh-list.md)、[`Image`](./nsh-image.md)、[`Canvas`](./nsh-canvas.md)、[`WebView`](./nsh-webview.md) 和 [`Video`](./nsh-video.md)，各有自己的参考页面。它们的属性见[元素](../elements/index.md)。文本输入框 `Input` 来自 [`nsh/base`](./nsh-base.md#input)。

<a id="safe-area-and-keyboard"></a>

## 安全区域与键盘

CSS 的环境变量让内容避开系统界面，可用于任何视图的内边距和外边距（`padding`、`paddingTop` 等，以及对应的 `margin` 键；Tailwind 的 `p*` / `m*` 任意值；Rust 中的 `Styled` 方法 `.p_safe_area()`、`.pt_safe_area_plus(..)`、`.pb_keyboard()` 等）。它们的值是 `EnvValue`：`env(name)`、`env(name, <length>)`、`calc(env(name) + <length>)` 和 `calc(<length> + env(name))`。

| 变量 | 值 |
|---|---|
| `safe-area-inset-top`、`-right`、`-bottom`、`-left` | 节点所在根视图的边距：最近的页面的（标题栏下方）、最近的对话框的，否则为界面的安全区。见[安全区域](../elements/safe-area.md)。 |
| `keyboard-inset-height` | 软键盘覆盖界面的高度，隐藏时为 0；变化随键盘原生动画。见[键盘](../elements/keyboard.md)。 |

```tsx
<View style={{ flex: 1, paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(keyboard-inset-height)" }}>…</View>
```

<a id="safearea-and-safeareainsets"></a>

### safeArea 与 safeAreaInsets

`safeArea()` 是界面的安全区（Rust 中为 `safe_area()`）；`safeAreaInsets()` 是组件渲染位置的边距（Rust 中为 `cx.insets()`），即 `safe-area-inset-*` 变量的值。两者都是响应式的 `Edges`（`{ top, right, bottom, left }`，单位为点）。见 [safeArea 与 safeAreaInsets](../elements/safe-area.md#safearea-与-safeareainsets)。

<a id="keyboard-and-keyboardframe"></a>

### Keyboard 与 keyboardFrame

`Keyboard.dismiss()` 隐藏软键盘（Rust 中为 `dismiss_keyboard()`），`keyboardFrame()` 告诉你它覆盖了屏幕的多少（Rust 中为 `keyboard_height()` 和 `keyboard_duration()`）。见[隐藏键盘](../elements/keyboard.md#隐藏键盘)和[键盘高度](../elements/keyboard.md#键盘高度)。

<a id="selectable-views"></a>

## 可选择的视图

`<View selectable>`（Rust 中为 `view().selectable(true)`）让其中的文字一起选择，就像网页上的文字一样：一个选区按阅读顺序跨越视图、`Text` 元素和 `TextView`。见[文本选择](../elements/text-selection.md)。

## Animation

动画 API 在 UI 线程上执行动画。你创建一个**动画值**（animated value），把它（或由它派生的值）绑定到样式属性上，然后启动动画；此后每一帧都在原生侧计算，不需要运行应用的代码。引擎线程或 JS 线程再忙也不会让动画卡顿，动画的每一帧也不消耗应用任何开销。Rust 代码使用 `nsh_core::prelude` 中的 `animated_value()`、`motion()`、`Animation`、`Spring`、`Timing`、`KeyframeTiming`、`MotionPreset` 和 `Easing`，用元素的 `.bind_*` 方法绑定动画值；TSX 从 `nsh` 导入它们。

```rust tabs
use nsh_core::{element::LayoutAnimation, prelude::*}; // animated_value、motion、Animation、Spring、Timing、Keyframe、KeyframeTiming、MotionPreset、MotionSpec、Easing、animate_layout
```

```tsx tabs
import { Animated, createAnimatedValue, createMotion, motions, Easing, LayoutAnimation, AnimatedNode, AnimatedValue } from "nsh";
```

教程见[动画](../docs/animation.md)。

### 动画值可以驱动什么

| 位置 | Rust | TSX |
|---|---|---|
| `opacity` | `.bind_opacity(&value)` | `style={{ opacity: value }}` |
| `backgroundColor` | `.bind_background(&value.interpolate_colors(&[0.0, 1.0], &[white(), black()]))` | `style={{ backgroundColor: value.interpolate({ inputRange: [0, 1], outputRange: ["#fff", "#000"] }) }}` |
| `borderColor`、`color` | `.bind_border_color(&node)`、`.bind_color(&node)` | 同上：一个颜色节点。`borderColor` 为所有边着色；`Text` 的 `color` 为整段文本着色 |
| `transform` | `.bind_translate_x(&value)`、`.bind_translate_y`、`.bind_scale`、`.bind_rotate`（角度） | `translateX`、`translateY`、`scale`、`scaleX`、`scaleY`、`rotate`、`rotateX`、`rotateY`、`rotateZ`：`transform: [{ translateX: value }]` |
| 滚动位置 | 滚动视图或列表上的 `.scroll_value(&value)` | `<Scroll scrollValue={value}>` 和 `<List scrollValue={value}>` 每帧把滚动偏移写入该值 |
| 手势 | `.pan_values(Some(&x), Some(&y))`、`.pinch_value(&scale)`、`.rotation_value(&angle)` | 任意元素上的 `pan={{ x, y }}`、`pinch={{ scale }}`、`rotation={{ angle }}`：手势直接写入这些值（见[触摸与手势](../docs/touch-and-gestures.md)） |
| 吸附位置 | `.sticky().bind_sticky_top(&value)`（横向滚动视图中为 `.bind_sticky_left`）、列表上的 `.bind_sticky_header_offset(&value)` | `style={{ position: "sticky", top: value }}`、`<List stickyHeaderOffset={value}>`：吸附视图和标题吸附在距视口起点这么远的位置，逐帧跟随该值 |
| 画布 | 绘制调用中的动画参数 | [画布](./nsh-canvas.md)绘制调用中的任意数字或颜色参数 |
| Shader | `.uniform(name, &value)` | [shader](../elements/shader.md) 的 `struct Uniforms` 成员：`uniforms={{ name: value }}`（数值，或用于 `vec3f` / `vec4f` 的颜色节点） |

其他样式属性只接受普通值；如果要为布局本身（尺寸、在布局流中的位置）添加动画，请使用 [`LayoutAnimation`](#layoutanimation)。

### createAnimatedValue

```ts
function createAnimatedValue(value?: number): AnimatedValue;
```

创建一个初始值为 `value`（默认 `0`）的动画值。Rust：`animated_value(value)`，一个由创建它的组件持有的 `Copy` 句柄。

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let x = animated_value(0.0);
    let right = stored(false);
    let toggle = move || {
        let to_right = !right.get();
        right.replace(to_right);
        let _ = x.spring(if to_right { 200.0 } else { 0.0 }, Spring::default());
    };
    view()
        .flex_1()
        .p_6()
        .pt_12()
        .gap_4()
        .child(view().size(px(60.0)).rounded(px(12.0)).bg(rgb(0x6366f1)).bind_translate_x(&x))
        .child(text("Move").on_press(toggle))
}
```

```tsx tabs
import { mount, Text, View } from "nsh";
import { createAnimatedValue } from "nsh";

function App() {
  const x = createAnimatedValue(0);
  let right = false;
  const toggle = () => {
    right = !right;
    x.spring(right ? 200 : 0);
  };
  return (
    <View style={{ flex: 1, padding: 24, paddingTop: 48, gap: 16 }}>
      <View style={{ width: 60, height: 60, borderRadius: 12, backgroundColor: "#6366f1", transform: [{ translateX: x }] }} />
      <Text onPress={toggle}>Move</Text>
    </View>
  );
}

mount(App);
```

> [!NOTE]
> 动画值存在于 UI 线程，每帧都在那里变化，所以应用异步读取它：`await value.getValue()`（或 `stop()` resolve 的 `{ value }`）给出那一刻的值，Rust 中在任务里 `value.value().await`。如果代码需要立刻知道目标值，请像上例一样用变量或 signal 自己记录。手势事件会在结束时报告这些值（`PanEvent.value`）。

### AnimatedValue

```ts
class AnimatedValue extends AnimatedNode {
  constructor(value: number);
  set(value: number): void;
  stop(): Promise<{ value: number }>;
  getValue(): Promise<number>;
  setOffset(offset: number): void;
  flattenOffset(): void;
  extractOffset(): void;
  timing(to: number, options?: { duration?: number; easing?: Easing; delay?: number }): Promise<{ finished: boolean }>;
  spring(to: number, options?: { stiffness?: number; damping?: number; mass?: number; velocity?: number }): Promise<{ finished: boolean }>;
  decay(options?: { velocity?: number; deceleration?: number; clamp?: [number, number]; bounce?: number }): Promise<{ finished: boolean }>;
  keyframes(keyframes: KeyframeValue[], options?: KeyframeTiming): Promise<{ finished: boolean }>;
}
```

| 方法 | Rust | 说明 |
|---|---|---|
| `set(value)` | `set(value)` | 直接跳到 `value`，并停止正在运行的动画。 |
| `stop()` | `stop()`，然后 `value().await` | 让正在运行的动画停在当前位置；resolve 为 `{ value }`，即停下处的值。 |
| `getValue()` | `value().await` | resolve 为当前值（含偏移），在 UI 线程上读取。 |
| `setOffset(offset)` | `set_offset(offset)` | 加到值上的偏移：绑定看到的是值 + 偏移；`set`、动画和拖动改变的是值本身。 |
| `flattenOffset()` | `flatten_offset()` | 把偏移加到值上，并把偏移归 0。 |
| `extractOffset()` | `extract_offset()` | 把值移入偏移，并把值归 0（这样下一次拖动从上一次结束的位置开始）。 |
| `timing(to, options)` | `timing(to, ms, easing)`、`timing_with(to, Timing { … })` | 沿缓动曲线动画到 `to`。`duration` 单位为毫秒（默认 300），`easing`（默认 `"easeInOut"`），`delay` 单位为毫秒（默认 0）。 |
| `spring(to, options)` | `spring(to, Spring { … })` | 以弹簧效果运动到 `to`。`stiffness`（默认 170）、`damping`（默认 26）、`mass`（默认 1）、`velocity`（初速度，单位/秒）。 |
| `decay(options)` | `decay(velocity, deceleration)`、`decay_within(velocity, deceleration, (min, max), bounce)` | 以 `velocity`（单位/秒）为初速度滑行并逐渐减速，每毫秒保留 `deceleration`（默认 0.998）的速度。适合在快速滑动后使用 `onPanEnd` 给出的速度。设置 `clamp: [min, max]` 时，它在边界处停下，或以 `bounce`（0..1，默认 0）比例的速度反弹。 |
| `keyframes(frames, options)` | `keyframes(frames, KeyframeTiming)` | 像 CSS 关键帧那样播放[关键帧](#关键帧)：每段有自己的缓动，按 `direction` 播放 `iterations` 次。 |

每个动画方法都返回一个 Promise，resolve 为 `{ finished }`：动画完成时为 `true`，被停止（`stop`、`set` 或同一个值上的另一个动画）时为 `false`。在 Rust 中返回 `AnimationEnd`，在任务中 await 它得到同样的 `bool`。

```rust tabs
let opacity = animated_value(1.0);
spawn(async move {
    if opacity.timing(0.0, 200.0, Easing::EaseInOut).await {
        visible.set(false);
    }
});
```

```tsx tabs
const opacity = createAnimatedValue(1);
const { finished } = await opacity.timing(0, { duration: 200 });
if (finished) visible.set(false);
```

### AnimatedNode

```ts
class AnimatedNode {
  interpolate(config: {
    inputRange: number[];
    outputRange: number[] | string[];
    extrapolate?: Extrapolation;
    extrapolateLeft?: Extrapolation;
    extrapolateRight?: Extrapolation;
    easing?: Easing;
  }): AnimatedNode;
  diffClamp(min: number, max: number, options?: { snap?: boolean }): AnimatedNode;
  add(b: AnimatedNode | number): AnimatedNode;
  sub(b: AnimatedNode | number): AnimatedNode;
  mul(b: AnimatedNode | number): AnimatedNode;
  div(b: AnimatedNode | number): AnimatedNode;
  mod(b: AnimatedNode | number): AnimatedNode;
}

type Extrapolation = "extend" | "clamp" | "identity";
```

原生动画图中的一个节点：一个 `AnimatedValue`，或由其他节点派生的值。派生节点在其输入变化时在 UI 线程上求值。

| 方法 | Rust | 说明 |
|---|---|---|
| `interpolate(config)` | `interpolate(&input, &output)`、`interpolate_colors(&input, &colors)`、`interpolate_with(&input, output, Interpolation { … })` | 按分段区间映射输入。`outputRange` 可以是数字、颜色（`"#ff0000"`、`"rgba(…)"`）或角度（`"45deg"`、`"1rad"`）。超出 `inputRange` 时默认钳制（clamp）；`extrapolate`（或 `extrapolateLeft` / `extrapolateRight`）可以是 `"extend"`（沿直线延伸）、`"clamp"` 或 `"identity"`（直接输出输入值）。`easing` 决定每一段的曲线。Rust 接受数字、主题颜色（跟随外观）以及供 `bind_rotate` 使用的角度（度）。 |
| `diffClamp(min, max, options?)` | `diff_clamp(min, max)`、`diff_clamp_with(min, max, DiffClamp::snapping())` | 跟随输入的变化量，但把结果限制在 `min..max` 内：内容向上滚动时隐藏、一旦向下滚动就重新出现的标题栏。`snap: true` 让它在滚动视图停下时用 200 ms 停到较近的一端；只有输入达到 `max` 后才会停在 `max`。 |
| `add`、`sub`、`mul`、`div` | `add`、`sub`、`mul`、`div` | 与另一个节点或常量做算术运算。 |
| `mod(b)` | `modulo(b)` | 取模，`b` 为正时结果不会为负（比如把角度保持在 0..360）。 |

```rust tabs
let scroll_y = animated_value(0.0);
let header = scroll_y.diff_clamp(0.0, 44.0);

view()
    .flex_1()
    .child(scroll().scroll_value(&scroll_y).flex_1() /* rows */)
    .child(view().h(px(44.0)).bind_translate_y(&header.mul(-1.0)))
```

```tsx tabs
const scroll = createAnimatedValue(0);
const header = scroll.diffClamp(0, 44);

<Scroll scrollValue={scroll} style={{ flex: 1 }}>{/* rows */}</Scroll>
<View style={{ height: 44, transform: [{ translateY: header.mul(-1) }] }} />
```

```rust tabs
let progress = animated_value(0.0);
let rotate = progress.interpolate(&[0.0, 1.0], &[0.0, 360.0]); // 角度，供 bind_rotate 使用
let color = progress.interpolate_colors(&[0.0, 0.5, 1.0], &[rgb(0x22c55e), rgb(0xeab308), rgb(0xef4444)]);
```

```tsx tabs
const progress = createAnimatedValue(0);
const rotate = progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
const color = progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: ["#22c55e", "#eab308", "#ef4444"] });
```

### 关键帧

```ts
interface Keyframe {
  offset?: number;          // 一次迭代中的位置 0..1；缺省的 offset 均匀分布
  value: number | string;   // 数字，或以度为单位的角度（"45deg"、"0.5turn"）
  easing?: Easing;          // 从这里开始的那一段
}
type KeyframeValue = number | string | Keyframe;

interface KeyframeTiming {
  duration?: number;        // 一次迭代，毫秒（300）
  delay?: number;           // 第一次迭代前，毫秒（0）
  easing?: Easing;          // 没有自带缓动的各段（CSS "ease"）
  iterations?: number | "infinite";   // 1
  direction?: "normal" | "reverse" | "alternate" | "alternate-reverse";
}
```

`value.keyframes(frames, options)` 让一个值走过一组关键帧，并以 `{ finished }`（是否播放完成）兑现；`Animated.keyframes(value, { keyframes, ...options })` 是同样的东西，作为组合动画的一步。Rust：`value.keyframes(frames, KeyframeTiming)` 和 `Animation::keyframes(&value, frames, KeyframeTiming)`，关键帧用 `Keyframe::new(value)`（均匀分布）、`Keyframe::at(offset, value)` 和 `.ease(easing)`，时间参数用 `KeyframeTiming::new(ms)` 配合 `.delay(ms)`、`.easing(e)`、`.iterations(Some(n))`、`.infinite()` 和 `.direction(PlaybackDirection::…)`。

它们的播放方式与 CSS 关键帧一致：缓动作用于一段（关键帧的缓动决定从它开始的那一段，时间参数的缓动决定其余各段）；关键帧缺省的 offset 均匀分布，第一个为 0、最后一个为 1；每次迭代先跳到它的第一个关键帧，没有 offset 为 0 的关键帧时，值从当前位置出发；在 `delay` 期间，值停在第一个关键帧上（CSS `animation-fill-mode: backwards`）；反向的迭代倒着播放各段，曲线也随之反转；值停在最后一次迭代结束的位置。

```rust tabs
let y = animated_value(0.0);
y.keyframes(
    [Keyframe::new(0.0), Keyframe::at(0.3, -20.0).ease(Easing::EaseIn), Keyframe::new(0.0)],
    KeyframeTiming::new(600.0).iterations(Some(3)),
);
```

```tsx tabs
const y = createAnimatedValue(0);
y.keyframes([0, { offset: 0.3, value: -20, easing: "easeIn" }, 0], { duration: 600, iterations: 3 });
```

### createMotion

```ts
function createMotion(options?: MotionOptions): Motion;

interface MotionOptions extends MotionPlayOptions {
  initial?: { [C in MotionChannel]?: number };   // 各通道的起始值（其余处于静止状态）
  enter?: MotionName | MotionSpec;   // 从它的起点开始并立即播放
}

interface MotionPlayOptions extends KeyframeTiming {
  ignoreReduceMotion?: boolean;      // 即使用户要求减少动态效果也照常播放
}

interface Motion {
  readonly opacity: AnimatedValue;
  readonly translateX: AnimatedValue;
  readonly translateY: AnimatedValue;
  readonly rotate: AnimatedValue;    // 度
  readonly rotateX: AnimatedValue;
  readonly rotateY: AnimatedValue;
  readonly scale: AnimatedValue;
  readonly scaleX: AnimatedValue;
  readonly scaleY: AnimatedValue;
  readonly style: { opacity: AnimatedValue; transform: MotionTransform };
  readonly transform: MotionTransform;
  play(motion: MotionName | MotionSpec, options?: MotionPlayOptions): Promise<{ finished: boolean }>;
  animation(motion: MotionName | MotionSpec, options?: MotionPlayOptions): CompositeAnimation;
  stop(): void;
  reset(): void;
}
```

创建一个动效：为视图的不透明度和变换的每个通道各建一个动画值，处于静止状态（不透明度和缩放为 1，其余为 0），并在它们上面以原生方式播放动效。用 `style={motion.style}` 绑定，或把 `motion.style`、`motion.transform` 展开到样式中；变换先应用平移，再应用旋转，最后应用缩放，其中 `scale` 合并进 `scaleX` 和 `scaleY`：占用视图 8 个变换步骤中的 7 个，留下一个给你（3D 翻转用 `[{ perspective: 600 }, ...motion.transform]`）。`initial` 设置各通道的起始值（`{ opacity: 0 }`；其余通道从静止状态开始）。带 `enter` 时，它所移动的通道从该动效的起点开始（优先于 `initial`）并立即播放它，其余选项作为它的时间参数（`delay`、`duration`……）。动效只移动不透明度和变换：展开 `motion.style` 会设置视图的 `opacity`，想保留你自己的不透明度就只绑定 `motion.transform`；颜色用动画值和 `interpolate` 来驱动。Rust：`motion()`，一个由创建它的组件持有的 `Copy` 句柄，用 `.bind_motion(&m)` 绑定；`motion().entering(spec)` 用于入场。

| 成员 | Rust（`Motion`） | 说明 |
|---|---|---|
| `opacity`、`translateX`、... `scaleY` | `value(MotionChannel::Opacity)`、... | 各通道的动画值。 |
| `style`、`transform` | 元素上的 `.bind_motion(&m)` | 绑定。 |
| `play(motion, options?)` | `play(spec)`、`play_ignoring_reduce_motion(spec)` | 在各通道上播放按名称指定的预设或一个 [`MotionSpec`](#motions)；新的动效会打断正在播放的那个。`options` 修改它的时间参数。以 `{ finished }` 兑现：播放完成时为 `true`，被打断时为 `false`（Rust 中为 `AnimationEnd`）。 |
| `animation(motion, options?)` | `animation(spec)` | 同一个动效，作为尚未启动的 [`CompositeAnimation`](#animated)，用于组合：`Animated.stagger(60, cards.map((m) => m.animation("fadeInUp")), { from: "center" })`（Rust：`Animation::stagger_from(60.0, StaggerFrom::Center, cards.iter().map(\|m\| m.animation(MotionPreset::FadeInUp)))`）。是否减少动态效果在创建时决定。 |
| `stop()` | `stop()` | 停在当前位置。 |
| `reset()` | `reset()` | 停止，并把所有通道放回静止状态。 |

当用户要求减少动态效果（`reduceMotion()`）时，`play`、`animation` 和 `enter` 会立即落在动效的终点，不产生移动，除非设置了 `ignoreReduceMotion`（在选项或动效上）。

```rust tabs
let card = motion().entering(MotionPreset::FadeInUp.spec().timing(|t| t.delay(80.0)));
view().size(px(120.0)).rounded(px(16.0)).bg(rgb(0x0969da)).bind_motion(&card).on_press(move || {
    card.play(MotionPreset::Pulse);
})
```

```tsx tabs
const card = createMotion({ enter: "fadeInUp", delay: 80 });
<View onPress={() => card.play("pulse")} style={{ width: 120, height: 120, borderRadius: 16, backgroundColor: "#0969da", ...card.style }} />
```

### motions

```ts
const motions: Readonly<Record<MotionName, MotionPreset>>;

type MotionChannel = "opacity" | "translateX" | "translateY" | "rotate" | "rotateX" | "rotateY" | "scale" | "scaleX" | "scaleY";

interface MotionSpec extends KeyframeTiming {
  keyframes: { [C in MotionChannel]?: KeyframeValue[] } | MotionFrame[];
  ignoreReduceMotion?: boolean;
}
type MotionFrame = { [C in MotionChannel]?: number | string } & { offset?: number; easing?: Easing };

interface MotionPreset extends MotionSpec {
  kind: "enter" | "exit" | "attention" | "loop";
}
```

现成的动效，以数据形式提供：`motion.play("shake")` 播放的就是 `motions.shake`。`MotionName` 是以下之一：`fadeIn`、`fadeInUp`、`fadeInDown`、`fadeInLeft`、`fadeInRight`、`zoomIn`、`popIn`、`bounceIn`、`slideInUp`、`slideInDown`、`flipInX`、`flipInY`（入场）；`fadeOut`、`fadeOutUp`、`fadeOutDown`、`fadeOutLeft`、`fadeOutRight`、`zoomOut`、`popOut`、`slideOutDown`、`slideOutUp`（退场）；`shake`、`headShake`、`wiggle`、`swing`、`pulse`、`heartbeat`、`rubberBand`、`jello`、`tada`、`jump`、`flash`（吸引注意）；`spin`、`float`、`breathe`、`sway`、`bob`、`glow`（循环）。[动画](../docs/animation.md#预设)逐一介绍了它们。展开一个预设即可修改它：`motion.play({ ...motions.fadeInUp, duration: 600 })`。

`MotionSpec` 是你自己的动效：按通道写的关键帧（`{ opacity: [0, 1], translateY: [24, 0] }`），或像 Web Animations API 那样写的一组帧（`[{ opacity: 0, translateY: 24 }, { opacity: 1, translateY: 0 }]`，没有 offset 的帧按它在列表中的位置排布），再加上[关键帧的时间参数](#关键帧)。Rust：`MotionSpec::new(KeyframeTiming)` 配合 `.values(channel, values)`（均匀分布）、`.track(channel, keyframes)` 和 `.timing(|t| …)`；`MotionPreset::FadeInUp`（或 `.spec()`）是一个预设，`MotionChannel` 命名各通道。

```rust tabs
let rise = MotionSpec::new(KeyframeTiming::new(400.0))
    .values(MotionChannel::Opacity, [0.0, 1.0])
    .track(MotionChannel::TranslateY, [Keyframe::at(0.0, 24.0).ease(Easing::EaseOut), Keyframe::at(1.0, 0.0)]);
card.play(rise);
```

```tsx tabs
card.play({ duration: 400, keyframes: [{ opacity: 0, translateY: 24, easing: "easeOut" }, { opacity: 1, translateY: 0 }] });
```

### Animated

```ts
const Animated: {
  timing(value: AnimatedValue, config: { toValue: number; duration?: number; easing?: Easing; delay?: number }): CompositeAnimation;
  spring(value: AnimatedValue, config: { toValue: number; stiffness?: number; damping?: number; mass?: number; velocity?: number }): CompositeAnimation;
  decay(value: AnimatedValue, config?: { velocity?: number; deceleration?: number; clamp?: [number, number]; bounce?: number }): CompositeAnimation;
  sequence(list: CompositeAnimation[]): CompositeAnimation;
  parallel(list: CompositeAnimation[], config?: { stopTogether?: boolean }): CompositeAnimation;
  stagger(ms: number, list: CompositeAnimation[], config?: { from?: "first" | "last" | "center" | number }): CompositeAnimation;
  delay(ms: number): CompositeAnimation;
  loop(animation: CompositeAnimation, config?: { iterations?: number; resetBeforeIteration?: boolean }): CompositeAnimation;
  keyframes(value: AnimatedValue, config: KeyframeTiming & { keyframes: KeyframeValue[] }): CompositeAnimation;
  add(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  subtract(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  multiply(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  divide(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  modulo(a: AnimatedNode, b: AnimatedNode | number): AnimatedNode;
  diffClamp(a: AnimatedNode, min: number, max: number, options?: { snap?: boolean }): AnimatedNode;
  sampleSpring(config: SpringConfig & { from?: number }, fps?: number): number[];
  sampleDecay(config: DecayConfig & { from?: number }, fps?: number): number[];
};

interface CompositeAnimation {
  start(callback?: (result: { finished: boolean }) => void): Promise<{ finished: boolean }>;
  stop(): void;
  reset(): void;
}
```

`Animated` 用一个个步骤（`timing`、`spring`、`decay`、`sequence`、`parallel` 等）组合出动画。调用 `start()` 之前什么都不会运行；启动后整棵动画树都在原生侧运行，每一步在上一步结束的那一刻于 UI 线程上开始（步骤之间没有帧间隙，也不需要回到应用的代码）。Rust 用 `Animation` 组合同样的动画树。

| 函数 | Rust | 说明 |
|---|---|---|
| `timing`、`spring`、`decay` | `Animation::timing(&value, to, Timing)`、`Animation::spring(&value, to, Spring)`、`Animation::decay(&value, velocity, deceleration)` | 单个值的单个动画；选项和默认值与 [`AnimatedValue`](#animatedvalue) 的同名方法相同，目标值写作 `toValue`。 |
| `sequence(list)` | `Animation::sequence(list)` | 依次运行这些动画。 |
| `parallel(list, { stopTogether })` | `Animation::parallel(list).stop_together(…)` | 同时运行。`stopTogether`（默认 `true`）时，停止其中一个会停止全部。 |
| `stagger(ms, list, { from })` | `Animation::stagger(ms, list)`、`Animation::stagger_from(ms, StaggerFrom::Center, list)` | 并行运行，每个比前一个晚 `ms` 毫秒开始，从 `from` 开始计数：`"first"`（默认）、`"last"`、`"center"`（中间一项立即开始，其余向两侧依次展开；数量为偶数时中间两项同时开始）或一个下标（`StaggerFrom::First`、`Last`、`Center`、`Index(i)`）。 |
| `keyframes(value, { keyframes, ...timing })` | `Animation::keyframes(&value, frames, KeyframeTiming)` | 让一个值走过一组[关键帧](#关键帧)。 |
| `delay(ms)` | `Animation::delay(ms)` | 等待；常用于 `sequence` 中。 |
| `loop(animation, { iterations, resetBeforeIteration })` | `animation.looped(iterations).reset_before_iteration(…)` | 重复 `animation` `iterations` 次（默认无限次），每次运行前把值恢复到起点，除非 `resetBeforeIteration` 为 `false`。 |
| `add`、`subtract`、`multiply`、`divide`、`modulo`、`diffClamp` | 节点的方法 | 与 [`AnimatedNode`](#animatednode) 的对应方法相同，只是写成函数形式。 |
| `sampleSpring`、`sampleDecay` | `nsh_core::element::sample_spring`、`sample_decay` | 弹簧或衰减动画逐帧的值（见 [Easing](#easing)）。 |

`CompositeAnimation`：

| 方法 | Rust（`Animation`） | 说明 |
|---|---|---|
| `start(callback?)` | `start()`，返回可 await 的 `AnimationEnd` | 运行（或再次运行）。整棵动画树只会 resolve 一次（并调用 `callback`），结果为 `{ finished }`，表示它是正常完成还是被停止。 |
| `stop()` | `stop()` | 停在当前位置。 |
| `reset()` | `reset()` | 停止，并把各个值恢复到启动时的值。 |

```rust tabs
let ys: Vec<AnimatedValue> = (0..4).map(|_| animated_value(0.0)).collect();
let hop = Animation::stagger(
    80.0,
    ys.iter().map(|y| {
        Animation::sequence([
            Animation::timing(y, -36.0, Timing::new(220.0, Easing::Curve(Curve::Quad, EaseMode::Out))),
            Animation::spring(y, 0.0, Spring { stiffness: 300.0, damping: 12.0, ..Spring::default() }),
        ])
    }),
);
let run = hop.start();
spawn(async move { log::info!("{}", if run.await { "done" } else { "stopped" }) });
```

```tsx tabs
const ys = [0, 1, 2, 3].map(() => createAnimatedValue(0));
const hop = Animated.stagger(
  80,
  ys.map((y) =>
    Animated.sequence([
      Animated.timing(y, { toValue: -36, duration: 220, easing: Easing.out(Easing.quad) }),
      Animated.spring(y, { toValue: 0, stiffness: 300, damping: 12 }),
    ]),
  ),
);
hop.start(({ finished }) => console.log(finished ? "done" : "stopped"));
```

### Easing

```ts
type Easing =
  | "linear" | "ease" | "easeIn" | "easeOut" | "easeInOut"
  | [number, number, number, number]   // 三次贝塞尔曲线 x1, y1, x2, y2
  | EasingCurve
  | EasingSteps;                     // Easing.steps(…)

const Easing: {
  linear: Easing;
  ease: Easing;
  bezier(x1: number, y1: number, x2: number, y2: number): Easing;
  steps(count: number, position?: "jump-start" | "jump-end" | "jump-none" | "jump-both" | "start" | "end"): EasingSteps;
  in(e: Easing): Easing;
  out(e: Easing): Easing;
  inOut(e: Easing): Easing;
  sample(easing: Easing, count: number): number[];
  quad: EasingCurve;
  cubic: EasingCurve;
  poly(n?: number): EasingCurve;
  sin: EasingCurve;
  circle: EasingCurve;
  exp: EasingCurve;
  elastic(bounciness?: number): EasingCurve;
  back(s?: number): EasingCurve;
  bounce: EasingCurve;
};
```

缓动是数据而不是应用的函数：运行时在原生侧对它求值。在 Rust 中它是枚举 `Easing`：`Linear`、`EaseIn`、`EaseOut`、`EaseInOut`、`Bezier(x1, y1, x2, y2)`、`Steps(count, StepPosition)` 和 `Curve(curve, mode)`，其中 `Curve` 为 `Quad`、`Cubic`、`Poly(n)`、`Sin`、`Circle`、`Exp`、`Elastic(bounciness)`、`Back(s)`、`Bounce`，`EaseMode` 为 `In`、`Out`、`InOut`。要绘制一条缓动曲线，`Easing.sample(easing, count)`（Rust：`nsh_core::element::sample_easing`）给出它在 0 到 1 之间 `count` 个等距点上的值；`Animated.sampleSpring` 和 `Animated.sampleDecay`（`sample_spring`、`sample_decay`）从 `from`（0）开始逐帧给出弹簧或衰减动画的值（按 `fps`，默认 60），直到结束。三者都来自动画实际运行的原生代码。在 TSX 中凡是接受 `Easing` 的地方，都可以传入名称（`"easeOut"`）、由四个数字表示的三次贝塞尔曲线，或 `Easing` 对象中的曲线。

| 曲线 | Rust | 形状 |
|---|---|---|
| `quad` | `Curve::Quad` | `t²` |
| `cubic` | `Curve::Cubic` | `t³` |
| `poly(n)` | `Curve::Poly(n)` | `tⁿ`（`n` 默认为 2） |
| `sin` | `Curve::Sin` | 正弦 |
| `circle` | `Curve::Circle` | 圆形 |
| `exp` | `Curve::Exp` | 指数 |
| `elastic(bounciness)` | `Curve::Elastic(bounciness)` | 弹性过冲（`bounciness` 默认为 1） |
| `back(s)` | `Curve::Back(s)` | 先回拉再前进；`s` 为过冲量（默认 1.70158） |
| `bounce` | `Curve::Bounce` | 在结尾弹跳 |

`Easing.steps(count, position)` 即 CSS 的 `steps()`：值在 `count` 个级别之间跳变而不连续移动（逐帧的精灵图、跳动的指针）。`position` 决定跳变落在哪里：`"jump-end"`（默认，也可写 `"end"`）、`"jump-start"`（`"start"`）、`"jump-none"` 或 `"jump-both"`；Rust：`Easing::Steps(count, StepPosition::JumpEnd)`、`JumpStart`、`JumpNone`、`JumpBoth`。

这些曲线都是“in”形式（开始时慢）。`Easing.out(curve)` 把它反转，`Easing.inOut(curve)` 让它对称，`Easing.in(curve)` 保持原样；在 Rust 中这就是 `Easing::Curve` 的 `EaseMode`。

```rust tabs
let _ = value.timing(1.0, 600.0, Easing::Curve(Curve::Back(1.70158), EaseMode::Out));
let _ = value.timing_with(1.0, Timing { easing: Easing::Bezier(0.2, 0.0, 0.0, 1.0), ..Timing::default() });
let _ = value.timing_with(1.0, Timing { easing: Easing::EaseOut, ..Timing::default() });
```

```tsx tabs
value.timing(1, { duration: 600, easing: Easing.out(Easing.back()) });
value.timing(1, { easing: Easing.bezier(0.2, 0, 0, 1) });
value.timing(1, { easing: "easeOut" });
```

### LayoutAnimation

```ts
const LayoutAnimation: {
  configureNext(config: LayoutAnimationConfig, onEnd?: () => void): void;
  create(duration: number, type?: LayoutAnimationType, property?: LayoutAnimationProperty): LayoutAnimationConfig;
  Types: { easeInEaseOut; spring; linear; easeIn; easeOut; keyboard };
  Properties: { opacity; scaleXY };
  Presets: { easeInEaseOut: LayoutAnimationConfig; linear: LayoutAnimationConfig; spring: LayoutAnimationConfig };
  easeInEaseOut(onEnd?: () => void): void;
  linear(onEnd?: () => void): void;
  spring(onEnd?: () => void): void;
};

interface LayoutAnimationConfig {
  duration: number;                // 毫秒
  create?: LayoutAnimationAnimation;    // 插入的视图
  update?: LayoutAnimationAnimation;    // 移动或改变尺寸的视图
  delete?: LayoutAnimationAnimation;    // 移除的视图
}

interface LayoutAnimationAnimation {
  type?: "easeInEaseOut" | "spring" | "linear" | "easeIn" | "easeOut" | "keyboard";
  property?: "opacity" | "scaleXY" | "scale";
  duration?: number;
  delay?: number;
  springDamping?: number;          // 0..1，默认 0.7
}
```

`LayoutAnimation.configureNext(config)` 在原生侧为下一次提交中的布局变化添加动画：移动或改变尺寸的视图平滑过渡到新位置，新视图出现（按 `property` 淡入或缩放进入），被移除的视图消失。在会改变布局的状态变化之前调用它。Rust：`animate_layout(LayoutAnimation)`，使用 `nsh_core::element::LayoutAnimation` 的预设或它的 `create`、`update`、`delete` 过渡。

| 成员 | Rust | 说明 |
|---|---|---|
| `configureNext(config, onEnd?)` | `animate_layout(config)` | 为下一次提交的变化添加动画；结束时调用 `onEnd`。 |
| `create(duration, type?, property?)` | `LayoutAnimation::all(LayoutTransition::new(curve, duration))` | 三个阶段使用同一条曲线的配置。 |
| `Presets.easeInEaseOut` | `LayoutAnimation::EASE_IN_EASE_OUT` | 300 毫秒，视图淡入淡出。 |
| `Presets.linear` | `LayoutAnimation::LINEAR` | 500 毫秒，匀速。 |
| `Presets.spring` | `LayoutAnimation::SPRING` | 700 毫秒；位置以弹簧效果变化（阻尼 0.4），视图线性淡入淡出。 |
| `easeInEaseOut(onEnd?)`、`linear(onEnd?)`、`spring(onEnd?)` | `animate_layout(LayoutAnimation::…)` | `configureNext(Presets.…)` 的简写。 |
| `Types`、`Properties` | `LayoutCurve`、`LayoutProperty` | 这些名称的常量形式。 |

```rust tabs
let open = signal(false);
let toggle = move || {
    animate_layout(LayoutAnimation::SPRING);
    open.update(|o| *o = !*o);
};

view()
    .child(text("Details").on_press(toggle))
    .child(when(move || open.get(), || text("Shown with a spring.")))
```

```tsx tabs
const open = signal(false);
const toggle = () => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
  open.update((o) => !o);
};

<View>
  <Text onPress={toggle}>Details</Text>
  <If when={open()}>
    <Text>Shown with a spring.</Text>
  </If>
</View>
```

## Device

设备 API 向应用提供设备及其环境的信息。Rust 代码调用 `nsh_core::prelude` 中的函数（`window()`、`dark()`、`font_scale()`、`locale()`、`locale_settings()`、`lifecycle()`、`os()`、`idiom()`、`pixel_ratio()`、`set_color_scheme()` 等）；TSX 从 `nsh` 导入它们。窗口尺寸、配色方案、字体缩放、像素密度、区域设置、语言与地区设置和应用状态是响应式的：在绑定（Rust 中传给元素的闭包，TSX 中的 JSX）、`computed` 或 `effect` 中读取它们，平台报告变化（旋转、窗口缩放、切换深色模式、修改文字大小、语言或地区设置、移到另一个时区、移到另一种像素密度的屏幕、离开应用再回来）时，读取它们的地方会随之更新。

```rust tabs
use nsh_core::{
    platform::{Appearance, HourCycle, Idiom, Lifecycle, LocaleSettings, MeasurementSystem, Os, TemperatureUnit, TimeZone, Weekday},
    prelude::*, // window、dark、font_scale、locale、locale_settings、lifecycle、os、idiom、pixel_ratio、set_color_scheme……
};
```

```tsx tabs
import { colorScheme, fontScale, lifecycle, locale, localeSettings, openUrl, pixelRatio, platform, setColorScheme, windowSize } from "nsh";
```

教程见[设备与环境](../docs/device-and-environment.md)。

### windowSize

```ts
const windowSize: Accessor<Size>;
```

界面的尺寸（点）：窗口，或嵌入时的 `NshAppView` / `NshView`。响应式。Rust：`window() -> Size<Points>`。

```rust tabs
let wide = move || window().width >= px(600.0);

view().style_when(wide, |s| s.flex_row())
```

```tsx tabs
const wide = () => windowSize().width >= 600;

<View style={{ flexDirection: wide() ? "row" : "column" }}>{/* ... */}</View>
```

### colorScheme

```ts
const colorScheme: Accessor<"light" | "dark">;
```

显示的外观：系统的外观，除非应用设置了自己的（`nsh.json` 的 `"appearance"`、[`setColorScheme`](#setcolorscheme)）。响应式。Rust：`dark() -> bool`；主题颜色（`AdaptiveColor`）和 `.dark(…)` 样式变体无需读取它就会跟随。Tailwind 的 `dark:` 变体也跟随它（见 [Tailwind](../docs/tailwind.md)）。

```rust tabs
view().flex_1().bg(move || if dark() { black() } else { white() })
```

```tsx tabs
const dark = () => colorScheme() === "dark";

<View style={{ flex: 1, backgroundColor: dark() ? "#000" : "#fff" }} />
```

### fontScale

```ts
const fontScale: Accessor<number>;
```

用户偏好的文字大小相对于默认大小的比例（`1` 为默认；iOS 上是动态字体，Android 上是字体大小设置），或嵌入它的应用设置的文字大小。响应式。Rust：`font_scale() -> f32`。除非设置了 `allowFontScaling={false}`，文本本身已经会随之缩放；当其他尺寸（例如文字旁边的图标）也需要跟随时再读取它。

### locale

```ts
const locale: Accessor<string>;
```

用户的区域设置，BCP 47 标签（`"en-US"`、`"zh-Hans-CN"`），或嵌入它的应用设置的区域设置。响应式。Rust：`locale() -> Locale`（`locale().as_str()` 即标签）。`Intl` 默认按它格式化；读取它来选择你自己的翻译文案（[设备与环境](../docs/device-and-environment.md#语言和地区)）。

### localeSettings

```ts
const localeSettings: Accessor<LocaleSettings>;

interface LocaleSettings {
  readonly languages: readonly string[];
  readonly timeZone: string;
  readonly hourCycle: "h11" | "h12" | "h23" | "h24";
  readonly firstDayOfWeek: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  readonly measurementSystem: "metric" | "us" | "uk";
  readonly temperatureUnit: "celsius" | "fahrenheit";
}
```

用户在区域设置之外的语言与地区设置：系统和语言、地区放在一起保存、一起改动的设置。响应式：其中任何一项变化时它都会变化；只想跟随其中一项时，在 `computed` 中读取它。Rust：`locale_settings() -> LocaleSettings`，字段相同，用蛇形命名（`languages`、`time_zone`、`hour_cycle`、`first_day_of_week`、`measurement_system`、`temperature_unit`）。名称和取值都是 `Intl` 的，可以直接传入它的选项（[设备与环境](../docs/device-and-environment.md#语言与地区设置)）：

- `languages`：偏好语言，BCP 47 标签，按偏好从高到低排列（`["de-DE", "en-US"]`）：系统的列表；嵌入它的应用设置了自己的语言时，那个语言排在最前。从不为空。用其中第一个有翻译的语言显示应用的文字，其余是它的后备。`locale()` 是区域格式，可以不同（英文文字、德国日期）。Rust：`Languages`（`iter()`、`first()`、`as_slice()`，每项是一个 `Locale`）。
- `timeZone`：设备的时区，即系统给它的名称：IANA 名称（`"Europe/Berlin"`、`"America/New_York"`）、`"UTC"`，或系统使用偏移量时区时的名称（Android 上的 `"GMT+01:00"`）。随系统设置变化，例如用户出行时。`Date` 的本地时间跟随系统时区，`Intl` 给出的名称与它相同（`Intl.DateTimeFormat().resolvedOptions().timeZone`）；读取这个名称来显示它、和日期一起保存，或交给时区库。Rust：`TimeZone`（`as_str()` 即名称）。
- `hourCycle`：12 小时制或 24 小时制，用 `Intl` 对小时周期的命名：`"h12"`（`12:30 PM`）、`"h23"`（`00:30`），以及较少见的 `"h11"`（`0:30 PM`）和 `"h24"`（`24:30`）。是系统的设置，否则是所在地区的。`Intl` 按区域设置自己的小时周期书写时间：把它作为 `hourCycle` 选项传入，就能按用户的习惯书写。`TimeField` 和 `DatePicker` 的 `hourCycle` 在 `"h11"` 和 `"h12"` 时用 `"h12"`，其余用 `"h23"`。Rust：`HourCycle`（`twelve_hour()` 表示有上午和下午）。
- `firstDayOfWeek`：每周从哪一天开始，按 ISO 8601（以及 `Intl.Locale` 的 `firstDay`）给星期编号：1 是星期一，7 是星期日。即日历的第一列。是系统的设置，否则是所在地区的（美国是 7，德国是 1，埃及是 6）。`Calendar` 和 `DatePicker` 的 `firstDayOfWeek` 从 0（星期日）开始计数：传入 `firstDayOfWeek % 7`。Rust：`Weekday`（`number()`）。
- `measurementSystem`：度量长度、重量和容积所用的单位：`"metric"`（公制）、`"us"`（英尺、英里、磅、加仑）或 `"uk"`（公制，但距离用英里、容量用品脱）。是系统的设置，否则是所在地区的。Rust：`MeasurementSystem`。
- `temperatureUnit`：温度单位：`"celsius"`（摄氏度）或 `"fahrenheit"`（华氏度）。是系统的设置，否则是所在地区的（美国及少数几个地区是华氏度）。Rust：`TemperatureUnit`。

除非 `open` 设置了 `localeSettings`，headless 测试中它是区域设置的（区域设置本身作为偏好语言、所在地区的偏好），时区是 UTC；测试中的本地时间仍是这台机器的。

### lifecycle

```ts
const lifecycle: Accessor<"active" | "inactive" | "background">;
```

应用是否正在使用，与 React Native 的 `AppState` 含义相同：`"active"` 表示在前台并接收输入；`"inactive"` 表示仍可见但没有焦点（焦点在另一个应用或窗口上，或系统在它上面显示了内容，例如应用切换器或来电）；`"background"` 表示不可见（在后台、已最小化、浏览器中隐藏的标签页）。显示在原生应用中的应用跟随该应用的状态。响应式。Rust：`lifecycle() -> Lifecycle`（`Lifecycle::Active`、`Inactive`、`Background`）。

在 effect 中读取它，即可暂停无人可见的工作，并在应用回来时恢复：

```rust tabs
effect(move || {
    if lifecycle() == Lifecycle::Background {
        feed.pause();
    } else {
        feed.resume();
    }
});
```

```tsx tabs
effect(() => {
  if (lifecycle() === "background") feed.pause();
  else feed.resume();
});
```

### setColorScheme

```ts
function setColorScheme(scheme: "light" | "dark" | "system"): void;
```

无论系统外观如何，立即以 `scheme` 显示应用：`colorScheme()`、`dark:` 类、组件的主题和平台控件（警告框、状态栏的默认样式）都随之变化；`"system"` 重新跟随系统。`nsh.json` 的 `"appearance"` 从启动时就设置它。Rust：`set_color_scheme(Appearance::Dark)`（`Appearance::Light`、`Appearance::System`）。

### fpsEnabled 和 setFpsEnabled

```ts
const fpsEnabled: Accessor<boolean>;
function setFpsEnabled(enabled: boolean): void;
```

`setFpsEnabled(true)` 打开性能监视器，`false` 关闭它：macOS 上是应用右上角的面板（见 [macOS](../docs/macos.md#性能监视器)），iOS、Windows、Linux 和 GPUI 上是每秒一行 `nsh::perf` 日志，终端上是一行状态（见[性能](../docs/performance.md#在屏幕上--fps)）。`fpsEnabled()` 表示监视器是否在测量，以平台报告的为准（响应式），所以开关显示的是平台实际的状态；应用用 `--fps` 或环境变量 `NSH_FPS=1` 启动时它也为开。在没有监视器的平台上（Android、Web），`fpsEnabled()` 保持为 `false`。Rust：`set_fps_enabled(true)`、`fps_enabled() -> bool`。

```tsx
<Switch checked={fpsEnabled()} onChange={({ checked }) => setFpsEnabled(checked)} />
```

### platform

```ts
const platform: Platform;

interface Platform {
  readonly os: "ios" | "android" | "macos" | "windows" | "linux" | "web";
  readonly version: string;
  readonly idiom: "phone" | "pad" | "mac" | "tv" | "desktop" | "terminal";
  readonly desktop: boolean;
  readonly catalyst: boolean;
  select<T>(spec: PlatformSelectSpec<T>): T | undefined;
}
```

应用所运行的平台，运行期间不变。

| 成员 | Rust | 说明 |
|---|---|---|
| `os` | `os() -> Os`（`os().name()` 即 TS 的字符串） | 操作系统。iOS、iOS 模拟器和 Mac Catalyst 都报告 `"ios"`，浏览器报告 `"web"`。 |
| `version` | `os_version() -> (u16, u16)` | iOS 和桌面系统：系统版本（`"17.5"`）；Android：API 级别（`"35"`）；Web：`"0.0"`。Rust 给出主版本和次版本号，在 Android 上是 API 级别和 0。 |
| `idiom` | `idiom() -> Idiom` | 设备类型：在终端里（`--target tui`）是 `"terminal"`：画在字符格子上，适用桌面行为（`desktop` 为 `true`；`os` 仍是本机的操作系统）；其他情况下 `desktop` 为 `true` 时恰好是 `"desktop"`，否则是 `"phone"`、`"pad"`（iPad、Android 平板、以 iPad 形态运行的 Mac Catalyst）、`"mac"`（以 UIKit 的 Mac 形态运行的 Mac Catalyst，属于移动端形态）或 `"tv"`（Apple TV、Android TV）。 |
| `desktop` | `is_desktop() -> bool` | 适用桌面行为：macOS、Windows、Linux、有鼠标且窗口较宽的浏览器，以及终端。`desktop={{…}}` 属性、`select({ desktop })` 和 `idiom` 的 `"desktop"`（终端除外）都以它为准。Mac Catalyst 运行 iOS 后端，属于移动端：那里适用 `ios={{…}}` 属性。[`nsh/desktop`](./nsh-desktop.md#isavailable) 的 `isAvailable` 是更窄的判断，表示它的窗口和菜单 API 可用，即 macOS、Windows 和 Linux。 |
| `catalyst` | `is_catalyst() -> bool` | 应用运行在 Mac Catalyst 下，无论是 Mac 形态还是 iPad 形态（`os` 为 `"ios"`）。 |
| `select(spec)` | `match os() { … }` | 当前平台对应的值（见下文）。 |

```rust tabs
let columns = if is_desktop() { 3 } else { 1 };
```

```tsx tabs
const columns = platform.desktop ? 3 : 1;
```

#### platform.select

```ts
interface PlatformSelectSpec<T> {
  ios?: T;
  android?: T;
  macos?: T;
  windows?: T;
  linux?: T;
  web?: T;
  mobile?: T;   // platform.desktop 为 false：iOS（包括 Mac Catalyst）、Android，以及手机和平板上的浏览器
  desktop?: T;  // platform.desktop 为 true：macOS、Windows、Linux、桌面浏览器，以及终端
  native?: T;   // 除 Web 外的所有平台
  default?: T;
}
```

依次返回当前操作系统（`ios`、`android`、`web` 等）对应的值，否则按 `platform.desktop` 取 `desktop` 或 `mobile`，否则 `native`（除 Web 外的所有平台），否则 `default`，都没有则返回 `undefined`。Rust 代码对 `os()` 做 `match`（`mobile` / `desktop` 用 `is_desktop()`）。

```rust tabs
use nsh_core::platform::Os;

let card = view().p_4();
let card = match os() {
    Os::Ios => card.shadow([BoxShadow {
        offset_y: px(2.0),
        blur: px(8.0),
        color: rgba(0x00000026).into(),
        ..BoxShadow::default()
    }]),
    Os::Android => card.elevation(px(4.0)),
    _ => card,
};
```

```tsx tabs
const shadow = platform.select({
  ios: { boxShadow: "0px 2px 8px rgb(0 0 0 / 0.15)" },
  android: { elevation: 4 },
});
```

> [!TIP]
> 对于只有某个平台才有的属性，优先使用 TSX 元素和组件的 `ios={{…}}` / `android={{…}}` 属性，而不是按 `platform` 分支（见[平台专有代码](../docs/platform-specific.md)）。

### pixelRatio

```ts
const pixelRatio: Accessor<number>;
```

每个点对应的设备像素数（大多数 iPhone 上为 `3`）。响应式：窗口移动到另一种像素密度的屏幕上时（Mac Catalyst、桌面系统或外接显示器），以及 Android 的显示大小设置改变像素密度时，它会变化。Rust：`pixel_ratio() -> f32`，取整到设备像素的长度用 `round_to_nearest_pixel(points)`；在 TSX 中这个长度是 `Math.round(x * pixelRatio()) / pixelRatio()`。

```rust tabs
let hairline = move || px(1.0 / pixel_ratio());
```

```tsx tabs
const hairline = () => 1 / pixelRatio();
```

### openUrl

```ts
function openUrl(url: string): Promise<OpenUrlResult>;

interface OpenUrlResult {
  opened: boolean;
}
```

在应用之外打开 `url`：网页在浏览器中打开，`mailto:` 链接在邮件应用中打开，`tel:` 链接在电话应用中打开，其他应用注册的 scheme（`maps:`、宿主应用自己的 `lb://` 链接）交给对应的应用。结果是 `{ opened }`，表示是否有应用打开了它：没有应用处理该 scheme 时为 `false`。Rust：`nsh_core::prelude` 的 `open_url(url)`，返回可在任务中等待（或直接丢弃）的回答，即同样的 `bool`。

```rust tabs
button()
    .child(text("联系我们"))
    .on_press(|| {
        spawn(async {
            if !open_url("mailto:help@example.com").await {
                log::warn!("no mail app");
            }
        });
    })
```

```tsx tabs
<Button
  onPress={async () => {
    const { opened } = await openUrl("mailto:help@example.com");
    if (!opened) {
      console.warn("no mail app");
    }
  }}
>
  <Text>联系我们</Text>
</Button>
```

- URL 必须是绝对地址（带 scheme）。会执行代码或访问应用自身数据的 URL，即 `javascript:`、`data:`、`blob:`、`file:`、`about:` 和 `asset:`，以及相对地址，会让 Promise 以 `TypeError` reject。`openUrl` 从不抛出：所有失败都以 reject 报告。
- 声明了能力的应用需要 `openUrl`：`"openUrl": true` 允许所有 scheme，`"openUrl": { "schemes": ["https", "mailto"] }` 只允许列出的 scheme；其他 URL 以一个 `Error` reject，其 `code` 为 `"ERR_ACCESS_DENIED"`，`permission` 为 `"openUrl"`，`resource` 为该 URL（见[沙箱与能力](../docs/sandbox-and-capabilities.md)）。在 Rust 中，`open_url` 对这些 URL 回答 `false`，并在日志中说明原因。
- 嵌入它的应用先看到这个 URL，可以改由自己的路由处理（Swift `NshAppView.onOpenURL`、Java `NshView.setOpenUrlHandler`、Rust `AppView::host().handle_open_url`；见 [iOS](../docs/ios.md#应用打开的链接) 和 [Android](../docs/android.md#应用打开的链接)），此时 `opened` 为 `true`。
- 各平台用自己的方式打开：iOS 用 `UIApplication.open`（嵌入时是宿主应用的 application），Android 用 `ACTION_VIEW` Intent，macOS 用 `NSWorkspace`，Windows 用 `ShellExecuteW`，Linux 用 `GtkUriLauncher`，GPUI 用它的 `open_url`，Web 在新标签页中打开。`nsh test` 记录这些 URL，而不真正打开。
- [`TextView`](../elements/text-view.md) 设置 `links="open"` 后，以同样的方式打开其中的链接。

### 布局方向

布局方向跟随用户的语言：在从右到左书写的语言（阿拉伯语、希伯来语等）中，应用从右到左布局，行从右侧开始排列，`left` / `right` 样式属性（`marginLeft`、`paddingRight` 等）表示起始端和结束端。修改即时生效，无需重启。

视图的 `direction` 样式（`"ltr"`、`"rtl"` 或默认的 `"inherit"`）设置其自身子树的方向；Rust 中为 `.direction(LayoutDirection::..)`。

```rust tabs
view().direction(LayoutDirection::Rtl).flex_row().gap_2().child(text("First")).child(text("Second"))
```

```tsx tabs
<View style={{ direction: "rtl", flexDirection: "row", gap: 8 }}>
  <Text>First</Text>
  <Text>Second</Text>
</View>
```

### 相关内容

- 安全区域（Rust 的 `safe_area()`；TSX 的 `safeArea()`、`safeAreaInsets()`）和软键盘（Rust 的 `keyboard_height()`；TSX 的 `keyboardFrame()`）见[安全区域与键盘](#safe-area-and-keyboard)。
- 屏幕阅读器和减弱动态效果的设置在 [`nsh` 的无障碍 API](#accessibility) 中。

## registerFont

```ts
function registerFont(source: string | Uint8Array): Promise<RegisteredFont>;

interface RegisteredFont {
  family: string;
}
```

在应用运行时注册字体，结果是 `{ family }`，即它的字体族名，供 `fontFamily` 使用：应用下载或生成的字体，即 TrueType、OpenType、WOFF 或 WOFF2 数据，或者字体文件的 URL（应用自己的文件 `asset:/...`，或网络上的文件，按 `fetch` 的方式读取：适用 `network` 权限）。此后使用该字体族的文字都会用它排版，之前已显示的文字也会重新排版。`network` 权限不允许该 URL 或它重定向到的 URL 时，以一个 `Error` 拒绝，其 `code` 为 `"ERR_ACCESS_DENIED"`，`permission` 为 `"network"`，`resource` 为被拒绝的 URL，与 `fetch` 相同；URL 无法加载或数据不是字体时以 `Error` 拒绝。Rust：`register_font(data) -> Answer<Result<String, String>>`，在任务中等待。应用发布的字体则在第一帧之前注册（[字体](../docs/fonts.md#在应用运行时注册字体)）。

## PanResponder

Pan responder 是构建在手势响应者系统之上的拖动手势：元素认领一次手势的触摸，然后独自接收这些触摸和手势状态，手势状态会帮你跟踪各触点的中心、移动距离和速度。Rust 代码用 `.claim_touches(TouchClaim::…)` 认领触摸，用 `.on_responder_*` 监听，其 `ResponderEvent` 带有 `PanGesture`，都在 `nsh_core::prelude` 中；TSX 从 `nsh` 导入 `PanResponder`，它的 `onPanResponder…` 回调接收触摸事件和手势状态。

```rust tabs
use nsh_core::prelude::*; // TouchClaim、ClaimRequest、ResponderEvent、PanGesture
```

```tsx tabs
import { PanResponder, type PanResponderGestureState } from "nsh";
```

> [!TIP]
> Pan responder 会把每一次移动都交给应用的代码，适合会改变应用状态的手势（拖动排序、判断是否滑动删除）。如果只是让视图跟随手指移动，原生手势值更快：Rust 用 `.pan_values(x, y)`、`.pinch_value(scale)` 和 `.rotation_value(angle)`，TSX 用 `pan={{ x, y }}`、`pinch` 和 `rotation` 属性。拖动在 UI 线程上直接写入[动画值](#animation)，应用只会收到开始和结束（`on_pan_start` / `on_pan_end`、`onPanStart` / `onPanEnd`）。见[触摸与手势](../docs/touch-and-gestures.md)。

### PanResponder.create

```ts
const PanResponder: { create(config: PanResponderCallbacks): PanResponderInstance };

interface PanResponderInstance {
  panHandlers: TouchProps;
}
```

创建一个 pan responder。把它的 `panHandlers` 展开到需要接收手势的视图上。在 Rust 中，由视图自己认领触摸并监听：

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let pos = signal((0.0_f32, 0.0_f32));
    let start = stored((0.0_f32, 0.0_f32));
    view().flex_1().child(
        view()
            .size(px(64.0))
            .rounded(px(32.0))
            .bg(rgb(0x6366f1))
            .style_with(move |s| {
                let (x, y) = pos.get();
                s.translate_x(px(x)).translate_y(px(y))
            })
            .claim_touches(TouchClaim::on_start())
            .on_responder_grant(move |_: &ResponderEvent| {
                start.replace(pos.get_untracked());
            })
            .on_responder_move(move |e: &ResponderEvent| {
                let (x, y) = start.get();
                pos.set((x + e.gesture.delta.x.0, y + e.gesture.delta.y.0));
            })
            .on_responder_release(move |e: &ResponderEvent| {
                log::info!("released at {:.0} pt/s", e.gesture.vx);
            }),
    )
}
```

```tsx tabs
import { mount, signal, View } from "nsh";
import { PanResponder } from "nsh";

function App() {
  const pos = signal({ x: 0, y: 0 });
  let start = { x: 0, y: 0 };
  const pan = PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => (start = pos()),
    onPanResponderMove: (_, g) => pos.set({ x: start.x + g.dx, y: start.y + g.dy }),
    onPanResponderRelease: (_, g) => console.log(`released at ${g.vx.toFixed(0)} pt/s`),
  });
  return (
    <View style={{ flex: 1 }}>
      <View
        {...pan.panHandlers}
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: "#6366f1",
          transform: [{ translateX: pos().x }, { translateY: pos().y }],
        }}
      />
    </View>
  );
}

mount(App);
```

### 回调

每个回调都会收到触摸事件（`GestureResponderEvent`，来自 [`nsh`](#类型)）和手势状态。在 Rust 中，认领用 `.ask(|request: &ClaimRequest| …)` 决定，调用 `request.claim()` 接管触摸（没有 `ask` 时总是接管），每个监听器收到一个 `ResponderEvent`，其 `gesture` 就是手势状态。

```ts
type PanHandler<R = void> = (e: GestureResponderEvent, gestureState: PanResponderGestureState) => R;
```

| 回调 | Rust | 返回值 | 调用时机 |
|---|---|---|---|
| `onStartShouldSetPanResponder` | `.claim_touches(TouchClaim::on_start())` | `boolean` | 手指按下：返回 `true` 以成为响应者。从被触摸的视图向外依次询问。 |
| `onStartShouldSetPanResponderCapture` | `TouchClaim::on_start().capture()` | `boolean` | 同上，但在冒泡询问之前从外向内询问（父视图从子视图手中接管手势）。 |
| `onMoveShouldSetPanResponder` | `TouchClaim::on_move().ask(…)` | `boolean` | 手指移动：返回 `true` 以成为响应者（例如仅当 `Math.abs(g.dx) > 10` 时）。 |
| `onMoveShouldSetPanResponderCapture` | `TouchClaim::on_move().capture()` | `boolean` | 同上，捕获阶段。 |
| `onPanResponderGrant` | `.on_responder_grant(…)` | | 该视图成为响应者：手势开始。 |
| `onPanResponderReject` | `.on_responder_reject(…)` | | 另一个视图是响应者且不肯放手。 |
| `onPanResponderStart` | `.on_responder_start(…)` | | 响应期间有手指按下。 |
| `onPanResponderMove` | `.on_responder_move(…)` | | 手指移动。 |
| `onPanResponderEnd` | `.on_responder_end(…)` | | 响应期间有手指抬起。 |
| `onPanResponderRelease` | `.on_responder_release(…)` | | 最后一根手指抬起：手势结束。 |
| `onPanResponderTerminate` | `.on_responder_terminate(…)` | | 另一个视图（或原生手势，比如滚动视图）接管了触摸。 |
| `onPanResponderTerminationRequest` | `.keep_touches(true)` 保留触摸 | `boolean` | 另一个视图想要接管触摸：返回 `false` 以保留（默认 `true`）。 |
| `onShouldBlockNativeResponder` | `TouchClaim::block_native(…)` | `boolean` | 响应期间是否阻止原生滚动视图接管触摸（默认 `true`）。 |

### PanResponderGestureState

```ts
interface PanResponderGestureState {
  stateID: number;
  moveX: number;               // 触点中心的最新位置（界面坐标，点）
  moveY: number;
  x0: number;                  // 成为响应者时触点中心的位置
  y0: number;
  dx: number;                  // 成为响应者以来移动的距离
  dy: number;
  vx: number;                  // 速度，点/秒
  vy: number;
  numberActiveTouches: number;
}
```

Rust：`PanGesture`，位置为 `Point<Points>`。

| 字段 | Rust | 说明 |
|---|---|---|
| `stateID` |  | 标识这次手势。 |
| `moveX`、`moveY` | `position` | 触点中心的最新位置，界面坐标（点）。 |
| `x0`、`y0` | `origin` | 成为响应者时触点中心的位置。 |
| `dx`、`dy` | `delta` | 成为响应者以来移动的距离。 |
| `vx`、`vy` | `vx`、`vy` | 速度，单位为点/秒。 |
| `numberActiveTouches` | `active_touches` | 按下的手指数。 |

### 在滚动视图中

当 pan responder 作为响应者时，外层的原生滚动视图不会滚动（`onShouldBlockNativeResponder` 默认为 `true`）。如果要让横向滑动与纵向滚动共存，只在横向移动时成为响应者：

```rust tabs
view()
    .claim_touches(TouchClaim::on_move().ask(|request: &ClaimRequest| {
        let d = request.event.gesture.delta;
        if d.x.0.abs() > 10.0 && d.x.0.abs() > d.y.0.abs() {
            request.claim();
        }
    }))
    .on_responder_move(move |e: &ResponderEvent| offset.set(e.gesture.delta.x.0))
    .on_responder_release(move |e: &ResponderEvent| {
        if e.gesture.delta.x.0.abs() > 120.0 { remove() } else { offset.set(0.0) }
    })
    .on_responder_terminate(move |_: &ResponderEvent| offset.set(0.0))
```

```tsx tabs
const swipe = PanResponder.create({
  onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy),
  onPanResponderMove: (_, g) => offset.set(g.dx),
  onPanResponderRelease: (_, g) => (Math.abs(g.dx) > 120 ? remove() : offset.set(0)),
  onPanResponderTerminate: () => offset.set(0),
});
```

对于由平台识别的拖动，`TouchClaim::on_pan(PanActivation::horizontal(10.0, 10.0))` 在手指移动时于主线程上决定。底层的响应者属性（`onStartShouldSetResponder`、`onResponderGrant`、`onTouchStart` 等）也可以直接用在任何元素上；见[元素](../elements/index.md)。

## Clipboard

剪贴板 API 读写系统剪贴板：各平台都能读写文本（iOS 上是 `UIPasteboard`，Android 上是 `ClipboardManager`，桌面上是 `NSPasteboard`、GDK 和 Win32 剪贴板，Web 上是 `navigator.clipboard`）；iOS、桌面和 Web 还能读写图片，桌面和 Mac Catalyst 还能读到在文件管理器里复制的文件。Rust 代码调用 `nsh_core::prelude` 中的函数（`set_clipboard`、`clipboard_string` 等）；TSX 从 `nsh` 导入 `Clipboard`。

```rust tabs
use nsh_core::prelude::*; // set_clipboard、clipboard_string、clipboard_image……
use nsh_core::element::ClipboardImage;
```

```tsx tabs
import { Clipboard } from "nsh";
```

```ts
const Clipboard: {
  writeText(text: string): Promise<void>;
  readText(): Promise<string>;
  hasText(): Promise<boolean>;
  writeImage(src: string): Promise<void>;
  readImage(): Promise<ClipboardImage | null>;
  hasImage(): Promise<boolean>;
  readFiles(): Promise<string[]>;
};

interface ClipboardImage {
  url: string; // Image 能显示、fetch 能读取的 URL
  size: PixelSize; // 像素
}
```

| TS | Rust（`nsh_core::prelude`） |
|---|---|
| `await Clipboard.writeText(text)` | `set_clipboard(text)` |
| `await Clipboard.readText()` | `clipboard_string().await -> String` |
| `await Clipboard.hasText()` | `clipboard_has_string().await -> bool` |
| `await Clipboard.writeImage(src)` | `set_clipboard_image(src)` |
| `await Clipboard.readImage()` | `clipboard_image().await -> Option<ClipboardImage>` |
| `await Clipboard.hasImage()` | `clipboard_has_image().await -> bool` |
| `await Clipboard.readFiles()` | `clipboard_files().await -> Vec<String>` |

Rust 的读取函数返回一个应答，在任务中（`spawn`，或 `async` 模块函数）await 它；`ClipboardImage` 是 `nsh_core::element::ClipboardImage`，含 `url` 和 `size`（一个 `Size<DevicePixels>`）。

iOS、桌面和 Web 上可以通过剪贴板传递图片。在 Android 上，剪贴板传递文本：`writeImage` 和 `readImage` 以 `code` 为
`"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"` 的 `Error` 拒绝，`hasImage` 返回 `false`。在 Rust 中，`set_clipboard_image`
在那里保持剪贴板不变，`clipboard_image` 返回 `None`。

用户也可以自己从[可选文本](../elements/text.md)中复制；剪贴板 API 用于在代码中复制，比如“复制”按钮。

### Clipboard.writeText

```ts
writeText(text: string): Promise<void>;
```

把 `text` 放到剪贴板上，替换原有内容。Rust：`set_clipboard(text)`。

```rust tabs
use nsh_core::prelude::*;

fn copy_button(code: Signal<String>) -> impl IntoElement {
    let copied = signal(false);
    view()
        .role(AccessibilityRole::Button)
        .on_press(move || {
            set_clipboard(code.get());
            copied.set(true);
        })
        .child(text(move || if copied.get() { "已复制" } else { "复制" }))
}
```

```tsx tabs
import { signal, Text, View } from "nsh";
import { Clipboard } from "nsh";

const copied = signal(false);

<View
  onPress={async () => {
    await Clipboard.writeText(code());
    copied.set(true);
  }}
>
  <Text>{copied() ? "已复制" : "复制"}</Text>
</View>;
```

### Clipboard.readText

```ts
readText(): Promise<string>;
```

返回剪贴板上的文本，没有文本时返回 `""`。Rust：`clipboard_string()`。在 iOS 上，读取剪贴板可能会显示系统的粘贴提示（“某应用从……粘贴”）；在 Android 10 及以上，只有前台应用才能读取。请在用户要求粘贴时再读取，而不是每进入一个页面就读。

```rust tabs
spawn(async move {
    let pasted = clipboard_string().await;
    if !pasted.is_empty() {
        code.set(pasted.trim().to_string());
    }
});
```

```tsx tabs
const pasted = await Clipboard.readText();
if (pasted) code.set(pasted.trim());
```

### Clipboard.hasText

```ts
hasText(): Promise<boolean>;
```

返回剪贴板上是否有文本，但不读取它：iOS 上不会出现粘贴提示。Rust：`clipboard_has_string()`。可以用它决定是否显示“粘贴”按钮。在 Web 上，浏览器只能通过读取来判断，因此可能会请求用户授权。

```rust tabs
let can_paste = signal(false);
spawn(async move { can_paste.set(clipboard_has_string().await) });
```

```tsx tabs
const canPaste = signal(false);
Clipboard.hasText().then((has) => canPaste.set(has));
```

### Clipboard.readImage

```ts
readImage(): Promise<ClipboardImage | null>;
```

返回剪贴板上的图片，没有时为 `null`：粘贴的截图，或在浏览器、图片编辑器里复制的图片。Rust：`clipboard_image()`，没有时为 `None`。`url` 是图片（PNG，或剪贴板自带的 JPEG、GIF、WebP、BMP）的 URL，[`Image`](../elements/image.md) 能把它作为 `src` 显示，`fetch` 能读取它：用 `fetch(url)` 拿到它的字节用于上传。`size`（`width` 和 `height`）是解码后的像素尺寸。和 `readText` 一样，在用户要求粘贴时再读。可读取的图片最大 48 MB（编码后），这样图片能放进应用的内存；更大的图片会以 `code` 为 `"ERR_NSH_QUOTA_EXCEEDED"` 的 `Error` 拒绝（消息给出图片大小和上限），此时 `hasImage` 返回 `true`。Rust：`clipboard_image()` 对它返回 `None`。

```rust tabs
use base64::Engine as _;
use nsh_core::{element::ClipboardImage, prelude::*};

fn attachments() -> impl IntoElement {
    let attachments = signal(Vec::<ClipboardImage>::new());
    let paste = move || {
        spawn(async move {
            if let Some(image) = clipboard_image().await {
                attachments.update(|list| list.push(image));
            }
        });
    };
    view()
        .flex_row()
        .gap_2()
        .child(text("粘贴").on_press(paste))
        .child(each(
            attachments,
            |shot: &ClipboardImage| shot.url.clone(),
            |shot, _| image(move || shot.with(|s| s.url.clone())).size(px(64.0)).rounded(px(8.0)),
        ))
}

async fn upload(image: &ClipboardImage) -> Result<HttpResponse, String> {
    let (_, data) = image.url.split_once(',').ok_or("not a data: URL")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| e.to_string())?;
    let request = HttpRequest::post("https://example.com/upload", bytes).header("Content-Type", "image/png");
    fetch(request).await
}
```

```tsx tabs
import { Image, signal, View } from "nsh";
import { Clipboard, type ClipboardImage } from "nsh";

const attachments = signal<ClipboardImage[]>([]);

async function paste() {
  const image = await Clipboard.readImage();
  if (image) attachments.set([...attachments(), image]);
}

async function upload(image: ClipboardImage) {
  const body = new FormData();
  body.append("file", await (await fetch(image.url)).blob(), "screenshot.png");
  await fetch("https://example.com/upload", { method: "POST", body });
}

<View class="flex-row gap-2">
  <Each of={attachments()}>
    {(image) => <Image src={image().url} style={{ width: 64, height: 64, borderRadius: 8 }} />}
  </Each>
</View>;
```

聊天类应用要让用户把截图粘贴进输入框，可以在输入框有焦点时绑定粘贴快捷键，剪贴板有图片时取图片：

```rust tabs
use nsh_core::keymap::When;

on_key_with("mod+v", KeyOptions { when: When::Always, ..KeyOptions::default() }, move |_| {
    spawn(async move {
        if clipboard_has_image().await {
            paste().await;
        } else {
            insert_text(&clipboard_string().await);
        }
    });
});
```

```tsx tabs
import { keymap } from "nsh";

keymap.bind("mod+v", async () => {
  if (await Clipboard.hasImage()) return paste();
  insertText(await Clipboard.readText());
}, { when: "always" });
```

### Clipboard.hasImage

```ts
hasImage(): Promise<boolean>;
```

返回剪贴板上是否有图片，不读取内容：iOS 上不会出现粘贴提示。Rust：`clipboard_has_image()`。Android 上返回 `false`。

### Clipboard.writeImage

```ts
writeImage(src: string): Promise<void>;
```

把 `src`（base64 `data:` URL，或 `readImage` 给的 `url`）的图片放到剪贴板上，替换原有内容。Rust：`set_clipboard_image(src)`。Windows 上接受 PNG，这是浏览器、Office 和截图工具读取的格式。Android 上以 `"ERR_FEATURE_UNAVAILABLE_ON_PLATFORM"` 拒绝。

```rust tabs
set_clipboard_image(image.url.clone());
```

```tsx tabs
await Clipboard.writeImage(image.url);
```

### Clipboard.readFiles

```ts
readFiles(): Promise<string[]>;
```

返回在文件管理器（访达、资源管理器、Files）里复制的文件和文件夹的 `file:` URL，按原顺序，没有时为 `[]`：与[文件拖放](../elements/view.md#桌面文件拖放)给出的 URL 相同。Rust：`clipboard_files()`。解析 URL 得到路径。

```rust tabs
let paths: Vec<std::path::PathBuf> = clipboard_files()
    .await
    .iter()
    .filter_map(|file| url::Url::parse(file).ok()?.to_file_path().ok())
    .collect();
```

```tsx tabs
const files = await Clipboard.readFiles();
const names = files.map((url) => decodeURIComponent(new URL(url).pathname.split("/").pop()!));
```

> [!NOTE]
> 如果应用在 `nsh.json` 中声明了 `capabilities`，必须用 `"clipboard": true` 授予剪贴板。否则 `Clipboard` 的每个函数都以一个 `Error` reject，其 `code` 为 `"ERR_ACCESS_DENIED"`，`permission` 为 `"clipboard"`，`resource` 为 `""`，系统剪贴板不会被访问。在 Rust 中，写入保持剪贴板不变，读取得到空剪贴板的回答（`""`、`None`、空列表、`false`），拒绝会记录在日志中。见[沙箱与能力](../docs/sandbox-and-capabilities.md)。
>
> ```tsx
> try {
>   await Clipboard.writeText(code());
> } catch (error) {
>   if (error.code === "ERR_ACCESS_DENIED") showHint("此应用已关闭复制");
>   else throw error;
> }
> ```

## Picker

选择器 API 显示系统的照片选择器，并把用户选中的图片交给应用：iOS 上是照片选择器（`PHPickerViewController`），Android
上是 Photo Picker，桌面上是打开面板或文件对话框，浏览器里是文件输入框。iOS 和 Android 的选择器运行在应用之外，只交出用户
选中的内容，所以不需要相册权限。每张选中的图片都是一个 `File`（TSX）或 `PickedFile`（Rust），它的字节留在原生侧：用
`URL.createObjectURL(file)` 交给 [`Image`](../elements/image.md) 显示，用 `fetch` 和 `FormData` 上传。Rust 代码调用
`nsh_core::prelude` 的 `pick_images`；TSX 从 `nsh` 导入 `Picker`。

```rust tabs
use nsh_core::picker::{PickRequest, PickedFile};
use nsh_core::prelude::*; // pick_images
```

```tsx tabs
import { Picker, type PickedImage } from "nsh";
```

```ts
const Picker: {
  pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;
  pickFiles(options?: PickFilesOptions): Promise<PickedFile[]>;
};

interface PickFilesOptions {
  multiple?: boolean; // 允许选择多个（false：一个）
  limit?: number; // multiple 时最多选几个（最多 100）
  filters?: { name: string; extensions: string[] }[]; // 提供的文件类型（不给：任意文件）
}

interface PickedFile {
  file: File; // 名称、类型、字节大小和内容，都保持原样
}

interface PickImagesOptions {
  multiple?: boolean; // 允许选多张（false：一张）
  limit?: number; // multiple 时最多几张（最多 100）
  maxDimension?: number; // 长边超过它（像素）的图片会被缩小
  quality?: number; // JPEG 质量，0 到 1（0.9）
  format?: "compatible" | "current"; // "compatible"：HEIC 等格式转为 JPEG
}

interface PickedImage {
  file: File; // 文件名、类型、字节数和字节
  size: PixelSize; // 方向已摆正
}
```

| TS | Rust |
|---|---|
| `await Picker.pickImages(options)` | `pick_images(request).await -> Vec<PickedFile>` |
| `await Picker.pickFiles(options)` | `pick_files(request).await -> Vec<PickedFile>` |
| `multiple`、`limit` | `PickRequest::new(multiple, limit)`（`limit` 为 0 表示最多 100） |
| `maxDimension` | `request.max_dimension = Some(DevicePixels(2048))` |
| `quality` | `request.quality = Some(Percentage(0.8))` |
| `format` | `request.format = PickFormat::Current` |
| `image.file.name`、`.type`、`.size` | `file.name`、`file.mime`、`file.data.len()` |
| `image.size` | `file.size`（`Size<DevicePixels>`） |

### Picker.pickImages

```ts
pickImages(options?: PickImagesOptions): Promise<PickedImage[]>;
```

显示选择器，按选中的顺序 resolve 为用户选中的图片；用户取消时 resolve 为 `[]`。Rust：`pick_images(request)`，在任务里
（`spawn`，或 `async` 模块函数）await 它的结果。`pickImages` 从不抛出：超出范围的选项（`limit: 0`、不在 0 到 1 之间的
`quality`）让 Promise 以 `RangeError` reject，应用的能力不允许的选取以 `ERR_ACCESS_DENIED` reject（见下文）。取消是用户的
回答而不是失败：resolve 为 `[]`。

图片拿到手就可以发送：

- **所有浏览器和服务器都认的格式。** JPEG、PNG、GIF 和 WebP 原样交出；以其他格式保存的照片（iPhone 的 HEIC、HEIF、
  TIFF）转为 JPEG。`format: "current"` 保留保存时的格式。
- **在原生侧缩小。** 设置 `maxDimension` 时，长边超过它的图片会摆正方向、缩小到刚好放下并重新编码：PNG 仍是 PNG，其他都是
  `quality` 质量的 JPEG。手机照片有 1200 万到 4800 万像素，上传前缩到 2048 像素，就只有几百 KB。设置 `quality` 时 JPEG
  也会重新编码。
- **按显示的样子。** `size` 是图片显示时的像素大小，已经按拍摄方向摆正。NSH 重新编码的图片不带元数据（没有位置信息）；
  原样交出的图片保留它自己的元数据。

在 Windows、Linux 和 GPUI 窗口中，对话框只提供请求接受的格式（`"compatible"` 时是 JPEG、PNG、GIF 和 WebP），文件按保存时的
样子和大小交出。

聊天输入框附加一张照片，编辑消息时显示它，发送时上传：

```rust tabs
use nsh_core::geometry::{DevicePixels, Percentage};
use nsh_core::picker::{PickRequest, PickedFile};
use nsh_core::prelude::*;

fn attach_button(attached: Signal<Option<PickedFile>>) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Button)
        .accessibility_label("Choose a photo")
        .on_press(move || {
            let mut request = PickRequest::new(false, 1);
            request.max_dimension = Some(DevicePixels(2048));
            request.quality = Some(Percentage(0.85));
            let picked = pick_images(request);
            spawn(async move {
                if let Some(file) = picked.await.into_iter().next() {
                    attached.set(Some(file));
                }
            });
        })
        .child(text("Photo"))
}

async fn upload(file: &PickedFile) -> Result<HttpResponse, String> {
    let request = HttpRequest::post("https://example.com/upload", file.data.to_vec())
        .header("Content-Type", file.mime.as_str());
    fetch(request).await
}
```

```tsx tabs
import { Image, signal, Text, View } from "nsh";
import { Picker } from "nsh";

const attached = signal<{ file: File; src: string } | null>(null);

async function choosePhoto() {
  const [picked] = await Picker.pickImages({ maxDimension: 2048, quality: 0.85 });
  if (picked) attached.set({ file: picked.file, src: URL.createObjectURL(picked.file) });
}

async function send(text: string) {
  const body = new FormData();
  body.append("text", text);
  if (attached()) body.append("photo", attached()!.file);
  await fetch("https://example.com/messages", { method: "POST", body });
  if (attached()) URL.revokeObjectURL(attached()!.src);
  attached.set(null);
}

<View class="flex-row items-center gap-2">
  <View role="button" accessibilityLabel="Choose a photo" onPress={choosePhoto}>
    <Text>Photo</Text>
  </View>
  <If when={attached()}>
    <Image src={attached()!.src} style={{ width: 48, height: 48, borderRadius: 8 }} />
  </If>
</View>;
```

一次选多张：

```rust tabs
let picked = pick_images(PickRequest::new(true, 9));
spawn(async move {
    let files = picked.await;
    photos.update(|list| list.extend(files));
});
```

```tsx tabs
const images = await Picker.pickImages({ multiple: true, limit: 9, maxDimension: 2048 });
photos.set([...photos(), ...images.map((image) => URL.createObjectURL(image.file))]);
```

### Picker.pickFiles

```ts
pickFiles(options?: PickFilesOptions): Promise<PickedFile[]>;
```

显示系统的文件选择器，可选任意类型的文件，resolve 为用户选中的文件；用户取消时 resolve 为 `[]`。拒绝的情况与
`pickImages` 相同：超出范围的选项（`limit: 0`、没有扩展名的过滤器）以 `RangeError` reject，没有 `picker` 能力时以
`ERR_ACCESS_DENIED` reject。Rust：`pick_files(request)`。

```tsx
const picked = await Picker.pickFiles({
  multiple: true,
  filters: [{ name: "文档", extensions: ["pdf", "md"] }],
});
for (const { file } of picked) {
  const form = new FormData();
  form.append("document", file);
  await fetch("https://api.example.com/documents", { method: "POST", body: form });
}
```

| 平台 | 选择器 | 过滤器 |
|---|---|---|
| macOS | `NSOpenPanel` 表单 | 所有扩展名合为一组 |
| Windows | `IFileOpenDialog` | 每个过滤器一个选项，显示其名称 |
| Linux | `GtkFileDialog`（有 portal 时用 portal 的） | 每个过滤器一个选项，显示其名称 |
| iOS | `UIDocumentPickerViewController`，以副本形式 | 所有扩展名合为一组 |
| Android | `ACTION_OPEN_DOCUMENT` | 按媒体类型；有 Android 不认识的扩展名时提供任意文件 |
| Web | `<input type=file>` | 所有扩展名合为一组 |
| GPUI | GPUI 的打开对话框，可选任意文件 | 不符合的文件在选择后被剔除 |

所有平台都不需要权限。文件保持原样：不做转换，文件名不变。文件内容会全部读入内存，因此超过 512 MiB 的文件不会出现在
结果中，并记录到日志。过滤器只决定选择器提供什么，并不保证结果：请检查拿到的文件。

### 嵌入 NSH 的应用

嵌入 NSH、并且有自己选择器（比如带有应用自己的相册）的应用可以自己回答选取：在 Rust 中，把 `PickerBackend`
（`nsh_core::picker`）交给引擎（`EngineConfig::picker`，GPUI 和 GPUI Kit 应用用 `AppView::set_picker`），它会收到每次选取的
`PickRequest` 并返回文件，系统的选择器不会出现。它返回的文件和平台给的一样会被补全：截到请求的数量上限，大小、类型和
扩展名从字节中读出。`pick_files` 以同样的方式回答 `pickFiles`；没有实现它的 backend 会取消这些选取，系统的选择器同样不会出现。

### 测试

`nsh test` 在无界面运行时回答选取：`app.onPick(handler)` 返回用户选中的文件（`{ name, type, data }`），没有 handler 时
选取会被取消。见[测试](../docs/testing-and-trace.md)。

> [!NOTE]
> 应用在 `nsh.json` 中声明了 `capabilities` 时，需要用 `"picker": true` 授予选择器。没有授予时 `pickImages` 和 `pickFiles` 什么也不显示，
> 并以一个 `Error` reject，其 `code` 为 `"ERR_ACCESS_DENIED"`，`permission` 为 `"picker"`，`resource` 为 `""`。在 Rust
> 中，`pick_images` 和 `pick_files` 回答没有文件，拒绝会记录在日志中。见[沙箱与能力](../docs/sandbox-and-capabilities.md)。

## Notifications

`Notifications` 显示系统通知并设置应用图标的角标（macOS 上是 Dock 图标）。在用户做了需要通知的操作时再请求权限，然后显示：

```tsx
import { Notifications } from "nsh";

Notifications.on("press", ({ id }) => openChat(id));

async function notifyMe() {
  if ((await Notifications.requestPermission()) !== "granted") return;
  await Notifications.show({ id: "chat:42", title: "Ada", body: "Are you coming?" });
  Notifications.setBadge(1);
}
```

Rust 代码使用 `nsh_core::prelude` 的 `request_notification_permission`、`show_notification`、`close_notification`、`set_badge` 和 `next_notification_press`。

| 平台 | 通知 | 角标 |
| --- | --- | --- |
| macOS | 通知中心，需要已签名的应用包；`nsh run` 的非应用包宿主上，以及未设置 `AppOptions::notifications` 的嵌入应用中为 `unavailable` | Dock，无需权限 |
| iOS | 通知中心 | 主屏幕，需要权限 |
| Android | 系统通知，Android 13 需要 `POST_NOTIFICATIONS`（`nsh package` 会为获得 `notifications` 能力的应用声明） | 没有可设置的数字：启动器会标记有通知显示的应用，数字随之后显示的通知一起传递 |
| Windows | Toast 通知，除非用户在设置里关闭了应用的通知（即 `denied`）。Windows 没有授权弹窗，`requestPermission` 不会询问用户。未设置 `AppOptions::notifications` 的嵌入应用为 `unavailable` | 任务栏按钮上的数字，最多显示 `99+`；任务栏使用小按钮时不显示 |
| Linux | 桌面的通知守护进程（`org.freedesktop.Notifications`）：运行时为 `granted`，不弹提示，否则为 `unavailable` | Unity launcher API，支持它的 Dock 才显示（Plasma、Ubuntu Dock、Dash to Dock），其他环境不显示 |
| Web | `Notification`，需要浏览器允许页面直接显示（Android 上不行） | Badging API，仅限已安装的应用 |
| 终端、GPUI | `unavailable` | 无 |

### Notifications.show

`show` 的结果表示系统是否接收了这条通知；没有权限时为 `false`。应用在前台时通知照常显示。用相同的 `id` 再次显示会替换旧通知，`Notifications.close(id)` 用于移除。

`silent: true` 让通知显示时不发声、不振动，与 Web 的 `Notification` 一致；默认播放系统提示音。Apple 平台显示不带声音的通知，Android 把它放进不提醒的分组（无声音、振动和弹出横幅），Windows 显示静音的 toast，Linux 附带通知服务的 `suppress-sound` 提示，Web 把 `silent` 交给浏览器。

```tsx
await Notifications.show({ id: "sync", title: "Synced", body: "12 new photos", silent: true });
```

### Notifications.on

`press` 报告用户点击的通知的 `id`。点击可能启动应用：事件会等到第一个监听器注册后送达，所以请在应用启动时监听，并把点击后要打开的内容放在 `id` 里。Android 上，嵌入方的 Activity 要在 `onCreate` 和 `onNewIntent` 里把 Intent 传给 `NshView.handleNotificationIntent`。Apple 平台上，已设置通知中心 delegate 的嵌入方保留自己的 delegate，点击也由它接收。Linux 上点击只传给运行中的应用：应用退出后留下的通知点击后没有反应。

### Notifications.permission

`permission()` 只查询不询问，`requestPermission()` 首次会显示系统提示。两者的结果都是 `"default"`（尚未询问）、`"granted"`、`"denied"`（只能在系统设置里更改）或 `"unavailable"`。

## UrlScheme

`UrlScheme` 报告打开应用的链接：应用在 `nsh.json` 中认领的 scheme 的 URL，例如网页上「在应用中打开」按钮发出的
`myapp://orders/42`，或完成登录后浏览器跳回应用的链接。应用只需认领一次，`nsh package` 会把这些 scheme 声明给系统：

```json
{ "schemes": ["myapp"] }
```

```tsx
import { UrlScheme } from "nsh";

UrlScheme.on("open", ({ url }) => {
  const link = new URL(url);
  if (link.host === "orders") openOrder(link.pathname.slice(1));
});
```

`open` 报告系统交给应用的每一个链接，启动时和运行中都会。没有监听者时到达的链接（包括启动应用的那个）会留给下一个监听者
（最多 16 个，超出时丢弃最早的），所以在应用启动时，或处理链接的界面准备好后再监听都可以。Rust 代码 await
`nsh_core::prelude` 的 `next_url_scheme_open()`；Rust 应用生成的代码会把 scheme 交给它的根组件（`Root::url_schemes`）。

链接是来自应用外部的输入：任何网页或应用都能用任意路径和参数打开 `myapp://`。在执行链接要求的操作之前，像对待其他输入一样先校验
（id 确实存在、操作经用户确认）。NSH 只放行应用自己的 scheme、长度不超过 16 KB 的链接，并且从不自行导航：链接打开什么由应用决定。

scheme 以字母开头，后面是字母、数字、`+`、`-` 或 `.`，按小写比较。Web、文件和系统应用的 scheme（`http`、`https`、`file`、
`mailto`、`tel`、`sms` 等）在构建应用时会被拒绝。

| 平台 | 应用如何认领 scheme |
| --- | --- |
| macOS | 应用 `Info.plist` 中的 `CFBundleURLTypes`；系统会打开应用，或把链接交给正在运行的那个 |
| iOS、Mac Catalyst | 应用 `Info.plist` 中的 `CFBundleURLTypes`；包括启动应用的链接和运行中到达的链接 |
| Android | `nsh package` 写入清单的 `ACTION_VIEW` intent filter；Activity 以 `singleTask` 运行，链接会交给正在运行的应用 |
| Windows | 应用每次启动时写入 `HKEY_CURRENT_USER\\Software\\Classes`；第二次启动会把 URL 交给正在运行的应用 |
| Linux | 应用启动时在 `~/.local/share/applications` 写入带 `x-scheme-handler/<scheme>` 的桌面文件并设为默认处理程序；`nsh run` 以同样方式注册开发宿主。第二次启动会把 URL 交给正在运行的应用 |

`nsh test` 可以把链接交给测试中的应用：`App.open(entry, { url })` 用一个链接启动应用，`app.openWithUrl(url)`
在运行中打开一个链接，两者都在无头模式下运行。

嵌入 NSH 的应用自己拥有 scheme，把 URL 交给视图：`AppView.open_url`（Linux、iOS）、`NshAppView.openURL`（Swift）、
`NshView.openUrl` 或 `NshView.handleUrlSchemeIntent`（Android）。

## Speech

语音 API 把用户说的话变成文字（听写）：应用开始一个会话，平台监听麦克风，转写文本随说话逐步到达。macOS 和 iOS 使用系统的
Speech 框架识别；系统会向用户请求一次麦克风和语音识别的权限。在其他平台上，会话会立即以错误 `"unavailable"` 结束，所以
显示麦克风按钮前先检查 `Speech.available()`。Rust 代码调用 `nsh_core::prelude` 的 `recognize_speech`；TSX 从 `nsh` 导入
`Speech`。

```rust tabs
use nsh_core::speech::{SpeechEvent, SpeechRequest};
```

```tsx tabs
import { Speech, type SpeechSession } from "nsh";
```

```ts
const Speech: {
  available(): Promise<boolean>;
  start(options?: SpeechOptions): SpeechSession;
};

interface SpeechOptions {
  /** The language spoken, a BCP 47 tag ("en-US", "zh-CN"); the user's when left out. */
  lang?: string;
  /** Results while the user speaks (true, the default), or only the final one. */
  interim?: boolean;
}

interface SpeechSession {
  on(event: "start", listener: () => void): () => void;
  on(event: "result", listener: (result: SpeechResult) => void): () => void;
  on(event: "end", listener: (end: SpeechEnd) => void): () => void;
  /** The whole transcript so far. */
  readonly text: string;
  readonly ended: boolean;
  stop(): void;
  abort(): void;
}

interface SpeechResult { text: string; isFinal: boolean }
interface SpeechEnd { text: string; error?: SpeechErrorCode }

type SpeechErrorCode =
  | "not-allowed" | "no-speech" | "audio-capture" | "network"
  | "language-not-supported" | "unavailable" | "failed";
```

| TSX | Rust |
|---|---|
| `await Speech.available()` | `speech_available().await -> bool` |
| `Speech.start(options)` | `recognize_speech(request) -> SpeechRecognition` |
| `session.on("result", ...)` | `recognition.next().await -> Option<SpeechEvent>` |
| `session.stop()` / `abort()` | `recognition.stop()` / `abort()` （drop 它即中止） |

### Speech.start

开始一个会话并立即返回它。会话依次报告：麦克风打开、识别器开始监听时的 `start`；每次转写变化时的 `result`（`text` 始终是
到目前为止的完整转写，应用照原样显示即可）；以及一次 `end`，之后不再有任何事件。`stop()` 停止监听，让识别器把听到的内容
识别完：最后一个 `isFinal: true` 的结果，然后是 `end`。`abort()` 立即结束会话，不带错误，并丢弃尚未报告的内容。同一时间只运行
一个会话：开始另一个会中止正在运行的会话。

`end` 带有最后的转写，会话失败时还带有 `error`，名称与 Web Speech API 一致：

| `error` | 何时 |
|---|---|
| `"not-allowed"` | 用户或系统不允许使用麦克风或语音识别。 |
| `"no-speech"` | 没有听到说话。 |
| `"audio-capture"` | 无法使用麦克风。 |
| `"network"` | 识别器需要网络但无法连接。 |
| `"language-not-supported"` | 识别器不认识 `lang`。 |
| `"unavailable"` | 这个平台不识别语音，或此刻不能识别。 |
| `"failed"` | 识别器因其他原因失败。 |

选项类型不对时 `start` 抛出 `TypeError`，`lang` 不是语言标签时抛出 `RangeError`。

```tsx
import { signal, Speech, type SpeechSession } from "nsh";

const transcript = signal("");
let session: SpeechSession | null = null;

function toggle() {
  if (session && !session.ended) {
    session.stop();
    return;
  }
  session = Speech.start({ lang: "en-US" });
  session.on("result", ({ text }) => transcript.set(text));
  session.on("end", ({ text, error }) => {
    if (error) console.warn("dictation ended:", error);
    else transcript.set(text);
  });
}
```

```rust
use nsh_core::prelude::*;
use nsh_core::speech::{SpeechEvent, SpeechRequest};

async fn dictate() -> String {
    let mut recognition = recognize_speech(SpeechRequest::default());
    let mut text = String::new();
    while let Some(event) = recognition.next().await {
        match event {
            SpeechEvent::Result { text: heard, .. } => text = heard,
            SpeechEvent::End { .. } => break,
            _ => {}
        }
    }
    text
}
```

### Speech.available

在可以运行会话的地方 resolve 为 `true`：macOS 和 iOS，以及嵌入应用自己识别语音的地方。

### Info.plist

在 macOS 和 iOS 上，系统会显示应用为什么需要麦克风和语音识别。应用可能使用语音时（它的 `capabilities` 授予了 `speech`，
或者没有声明 capabilities），`nsh package` 和 `nsh run` 会把 `NSMicrophoneUsageDescription` 和
`NSSpeechRecognitionUsageDescription` 写入应用的 Info.plist。

### 嵌入 NSH 的应用

嵌入 NSH、并且用自己的方式识别语音（自己的引擎或服务）的应用可以自己回答会话：在 Rust 中，把 `SpeechBackend`
（`nsh_core::speech`）交给引擎（`EngineConfig::speech`），它会收到每个会话的 `SpeechRequest` 和一个可以从任意线程报告事件的
`SpeechSink`，并返回 core 用来停止和中止会话的 `SpeechControl`。这时不使用平台的识别器。

### 测试

`nsh test` 在无界面运行时用一个模拟识别器运行会话：会话立即开始，`app.hear(text)` 把 `text` 报告为到目前为止的转写，
`app.endSpeech(error?)` 结束会话，`app.speechRequests()` 列出应用开始的会话。见[测试](../docs/testing-and-trace.md)。

> [!NOTE]
> 应用在 `nsh.json` 中声明了 `capabilities` 时，需要用 `"speech": true` 授予语音。没有授予时 `Speech.start` 抛出一个
> `Error`，其 `code` 为 `"ERR_ACCESS_DENIED"`，`permission` 为 `"speech"`，`resource` 为 `""`。在 Rust 中，会话以
> `not-allowed` 结束，拒绝会记录在日志中。见[沙箱与能力](../docs/sandbox-and-capabilities.md)。

## Sound

两个原语负责出声，各管一类音频。`Sound` 是短音效（点击、提示、告警）：一次解码进内存，之后可以播放任意多次、彼此叠加，调用后一帧之内开始发声——提前加载，在事件处理里播放。`AudioPlayer` 播放长音频（语音消息、音乐、录音），边播边从源读取，具备播放器的状态：位置、时长、暂停、跳转、速率和循环。macOS 和 iOS 用 AVFoundation 播放（音效用 `AVAudioEngine`，播放器用 `AVPlayer`；iOS 上音频会话为 `ambient`，与其他应用的声音混音并遵循静音开关），Windows 用 XAudio2 和 Media Foundation，Android 用 `SoundPool` 和 `MediaPlayer`，Linux 的音效用 GStreamer、播放器用 GTK 的媒体流（播放器的速率保持为 1），Web 用 Web Audio API 和音频元素（页面上用户第一次操作之后才出声）。在平台可能不出声的地方先检查 `Sound.available()`；那里 `load` 和 `play()` 以 `"unavailable"` 失败。Rust 代码调用 `nsh_core::prelude` 的 `load_sound` 和 `audio_player`；TSX 从 `nsh` 导入 `Sound` 和 `AudioPlayer`。

```rust tabs
use nsh_core::prelude::*; // load_sound, audio_player, Sound, AudioPlayer
```

```tsx tabs
import { AudioPlayer, Sound } from "nsh";
```

```ts
declare class Sound {
  static available(): Promise<boolean>;
  static load(src: string): Promise<Sound>;
  play(options?: { volume?: number; rate?: number }): void;
  stop(): void;
  readonly duration: number;
  dispose(): void;
}

declare class AudioPlayer {
  constructor(src: string, options?: { volume?: number; rate?: number; loop?: boolean });
  static available(): Promise<boolean>;
  on(event: "load", listener: (load: { duration: number }) => void): () => void;
  on(event: "progress", listener: (progress: { currentTime: number; duration: number }) => void): () => void;
  on(event: "buffer", listener: (buffer: { buffering: boolean }) => void): () => void;
  on(event: "end", listener: () => void): () => void;
  on(event: "error", listener: (error: { code: AudioErrorCode; message: string }) => void): () => void;
  play(): Promise<void>;
  preload(): void;
  pause(): void;
  seek(seconds: number): void;
  volume: number;
  rate: number;
  loop: boolean;
  readonly currentTime: number;
  readonly duration: number;
  readonly state: "idle" | "loading" | "playing" | "paused" | "ended";
  dispose(): void;
}

type AudioErrorCode =
  | "not-allowed" | "network" | "decode" | "not-supported"
  | "quota-exceeded" | "unavailable" | "failed";
```

| TSX | Rust |
|---|---|
| `await Sound.available()` | `audio_available().await -> bool` |
| `await Sound.load(src)` | `load_sound(src).await -> Result<Sound, AudioFailure>` |
| `sound.play({ volume, rate })` | `sound.play(volume, rate)` |
| `new AudioPlayer(src, options)` | `audio_player(src, settings) -> AudioPlayer` |
| `player.on("progress", ...)` | `player.next().await -> Option<AudioEvent>` |
| `player.play()` / `pause()` / `seek(s)` | `player.play()` / `pause()` / `seek(duration)`（drop 即关闭） |

### Sound.load

从导入的音频文件（`import click from "./sounds/click.wav"`：导入得到文件的 `asset:/` URL，文件随应用发布）、`file:` URL、`data:` URI 或应用 `network` capability 授权的 `http(s)` URL 加载音效，并解码进内存。引擎已加载过的源会共享：两个组件加载同一个点击音只解码一次。音效在 `dispose()` 时释放，或在加载它的一方离开时（组件卸载）释放。单个音效编码后最大 8 MB、时长最长 5 秒，一个应用同时最多持有 64 个音效、共 16 MB 解码后音频；超出时 `load` 以 `code` 为 `"ERR_NSH_QUOTA_EXCEEDED"` 拒绝。更长的音频交给 `AudioPlayer`。

### Sound.play

在正在播放的声音之上再起一路播放（同时最多 32 路，超出时最早的一路停止），音量 `volume`（0 到 1）、速率 `rate`（0.5 到 2，音高随之变化）。它没有返回值，设备静音或没有输出时也不会失败——那就是静音。超出范围的值抛出 `RangeError`。`stop()` 停止这个音效的所有播放。

```tsx
import { Sound, View } from "nsh";
import tapFile from "./sounds/tap.wav";

const tap = await Sound.load(tapFile);

function Key(props: { label: string }) {
  return <View onPress={() => tap.play({ volume: 0.6 })}>{props.label}</View>;
}
```

### AudioPlayer

播放器在 `play()` 或 `preload()` 之前什么都不加载。它的 `state` 和 `currentTime` 跟随平台的报告：知道时长后来一次 `load`（直播流为 `Infinity`），播放期间以及跳转之后约每秒四次 `progress`，等待数据时 `buffer`，播到结尾时 `end`（循环的播放器则从头再播）。`play()` 在开始播放后 resolve，出错时按 `error` 报告的原因 reject。播放器在 `dispose()` 时停止，或在创建它的一方离开时停止：播放期间请一直持有它。

```tsx
import { AudioPlayer, signal } from "nsh";

const position = signal(0);
const voice = new AudioPlayer("https://example.com/messages/42.m4a");
voice.on("progress", ({ currentTime }) => position.set(currentTime));
voice.on("end", () => position.set(0));
await voice.play();
```

```rust
use nsh_core::{audio::{AudioEvent, PlayerSettings}, prelude::*};

async fn play_message(url: &str) {
    let mut player = audio_player(url, PlayerSettings::default());
    player.play();
    while let Some(event) = player.next().await {
        if event == AudioEvent::Ended {
            break;
        }
    }
}
```

### 格式

音效和播放器播放平台能解码的格式。WAV 和 AAC（`.m4a`）在所有平台都能播放，适合音效；AAC 和 MP3 适合播放器。

### 嵌入 NSH 的应用

以自己的方式播放声音的宿主应用，给引擎一个 `AudioBackend`（`nsh_core::audio`，`EngineConfig::audio`）：它收到每条 `AudioCommand` 以及对应音效或播放器的 `AudioSink`，可以从任意线程向其报告。此时平台不播放任何声音。

### 测试

`nsh test` 在 headless 运行中把声音交给一个假扬声器：音效按 WAV 解码（时长取自文件头），播放器立即播放其源的一分钟，`app.endAudio()` 让正在播放的播放器播到结尾，`app.audio()` 列出应用发出的请求（`load`、`play`、`open`、`resume`、`seek` 等）。参见[测试](../docs/testing-and-trace.md)。

> [!NOTE]
> 应用在 `nsh.json` 中声明了 `capabilities` 时，出声需要授权 `"audio": true`。未授权时 `Sound.load` 会 reject、`new AudioPlayer` 会抛出 `Error`，其 `code` 为 `"ERR_ACCESS_DENIED"`、`permission` 为 `"audio"`、`resource` 为音源。Rust 中加载或播放器以 `not-allowed` 失败。参见[沙箱与 capability](../docs/sandbox-and-capabilities.md)。

## Storage

存储 API 把应用的数据保存在设备上：以字符串为键、字符串为值，应用下次启动时数据仍在。适合保存设置、草稿、用户上次打开的标签页、服务器返回内容的缓存——任何需要比应用进程活得更久的状态。Rust 代码使用 `nsh_core::storage::Storage`，TSX 从 `nsh` 导入 `Storage`；两者读写同一份数据，因此同时有 Rust 入口和 TSX 入口的应用看到的是同一份数据。

```rust tabs
use nsh_core::storage::Storage;
```

```tsx tabs
import { Storage } from "nsh";
```

```ts
const Storage: {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
};
```

| TS | Rust（`nsh_core::storage::Storage`） |
|---|---|
| `await Storage.getItem(key)` | `Storage::get_item(key) -> Option<String>` |
| `await Storage.setItem(key, value)` | `Storage::set_item(key, value) -> Result<(), StorageFull>` |
| `await Storage.removeItem(key)` | `Storage::remove_item(key)` |
| `await Storage.keys()` | `Storage::get_all_keys() -> Vec<String>` |
| `await Storage.clear()` | `Storage::clear()` |

Rust 函数是同步的，因为数据就在内存中：在组件运行的地方（组件函数体、事件处理函数和任务）调用它们。

每个应用有自己的存储，键和值合计最多 5 MB。调用按应用发起的顺序执行，所以在 `setItem` 之后调用 `getItem` 无需等待写入就能读到新值。读取来自内存；写入在后台成批落盘。

| 平台 | 数据保存位置 |
|---|---|
| iOS | 应用容器内的 `Library/Application Support/nsh/<app id>/storage.json` |
| Android | 应用私有目录内的 `files/nsh/<app id>/storage.json` |
| macOS | `~/Library/Application Support/<app id>/storage.json` |
| Windows | `%APPDATA%\<app id>\storage.json` |
| Linux | `$XDG_DATA_HOME/<app id>/storage.json`（`~/.local/share/…`） |
| Web | 浏览器的 `localStorage`，键以 app id 命名（`nsh:com.example.todo:…`） |

损坏的 `storage.json` 会被保留为同目录下的 `storage.json.corrupt`，应用从空存储开始；读不了的文件则让应用的改动只留在内存中，文件本身永远不会被覆盖。

app id 是 `nsh.json` 中的 `id`，它随应用一起传递：`nsh build` 和 `nsh package` 把它写在 bundle 旁边，开发服务器会发送它，签名包则带有经发布密钥证书担保的 id。因此无论应用在哪里运行，都无需任何设置就各自保存自己的数据；没有 id 的应用保存在 `default` 下。宿主应用可以另选位置（见[在 iOS 中嵌入](../docs/ios.md)和[在 Android 中嵌入](../docs/android.md)）。

### Storage.getItem

```ts
getItem(key: string): Promise<string | null>;
```

返回 `key` 的值，没有值时返回 `null`。Rust：`Storage::get_item(key)`，没有值时为 `None`。

```rust tabs
let theme = Storage::get_item("theme").unwrap_or_else(|| "system".into());
```

```tsx tabs
const theme = (await Storage.getItem("theme")) ?? "system";
```

### Storage.setItem

```ts
setItem(key: string, value: string): Promise<void>;
```

把 `key` 设为 `value`，替换原有的值。如果存储会超过 5 MB，则 Promise 以一个 `code` 为 `"ERR_NSH_QUOTA_EXCEEDED"` 的 `Error` 拒绝，值不会被保存。Rust：`Storage::set_item(key, value)`，此时返回 `Err(StorageFull)`。值都是字符串：结构化数据保存为 JSON（Rust 用 `serde_json::to_string`，TSX 用 `JSON.stringify`），再读回（`serde_json::from_str`、`JSON.parse`）。

```rust tabs
let draft = serde_json::json!({ "title": title.get(), "body": body.get() });
if let Err(full) = Storage::set_item("draft", draft.to_string()) {
    log::warn!("{full}");
}
```

```tsx tabs
Storage.setItem("draft", JSON.stringify({ title: title(), body: body() }));
```

### Storage.removeItem

```ts
removeItem(key: string): Promise<void>;
```

删除 `key` 及其值。删除一个没有值的键不做任何事。Rust：`Storage::remove_item(key)`。

### Storage.keys

```ts
keys(): Promise<string[]>;
```

按顺序返回所有键。Rust：`Storage::get_all_keys()`。

### Storage.clear

```ts
clear(): Promise<void>;
```

删除应用的所有键，例如在用户退出登录时。Rust：`Storage::clear()`。

### 把 signal 保存在设备上

应用启动时读取保存的值，之后每当 signal 变化就写回去：

```rust tabs
use nsh_core::{storage::Storage, prelude::*};

#[component]
pub fn App() -> impl IntoElement {
    let saved = Storage::get_item("count").and_then(|n| n.parse().ok());
    let count = signal(saved.unwrap_or(0_u32));
    effect(move || {
        if let Err(full) = Storage::set_item("count", count.get().to_string()) {
            log::warn!("{full}");
        }
    });
    view()
        .on_press(move || count.update(|n| *n += 1))
        .child(text(move || format!("按了 {} 次", count.get())))
}
```

```tsx tabs
import { effect, mount, signal, Text, View } from "nsh";
import { Storage } from "nsh";

const count = signal(0);
const loaded = signal(false);
Storage.getItem("count").then((saved) => {
  count.set(Number(saved ?? 0));
  loaded.set(true);
});
effect(() => {
  if (loaded()) Storage.setItem("count", String(count()));
});

mount(() => (
  <View onPress={() => count.update((n) => n + 1)}>
    <Text>按了 {count()} 次</Text>
  </View>
));
```

## host

`host` 连接嵌入 NSH 的应用：`NshAppView` / `NshView` 所在的原生应用，或在 Web 上运行播放器的页面。应用按名字调用宿主的函数（参数是 JSON），并监听宿主发来的事件。

```ts
import { host } from "nsh";
```

```ts
const host: {
  readonly params: { readonly [key: string]: unknown };
  post(name: string, data?: unknown): void;
  available(): boolean;
  call(name: string, args?: unknown, options?: { timeout?: number }): Promise<unknown>;
  on(event: string, listener: (payload: unknown) => void): () => void;
};
```

### host.available

```ts
available(): boolean;
```

平台是否有应答调用的宿主。在 Web 上，页面给播放器传入宿主时为 `true`（[Web 上的宿主](#web-上的宿主)）。

```tsx
import { Text } from "nsh";
import { host } from "nsh";

<Text>{host.available() ? "Embedded" : "Standalone"}</Text>;
```

### host.call

```ts
call(name: string, args?: unknown, options?: { timeout?: number }): Promise<unknown>;
```

以 `args`（任意 JSON 值；不传时为 `null`）调用宿主的函数 `name`，resolve 为它的返回值。`host.call` 从不抛出：每种失败都让 Promise 以一个 `Error` 拒绝，它的 `code` 说明发生了什么（消息是写给人看的，可能变化）：

| `code` | 何时 |
|---|---|
| `ERR_NSH_HOST_ERROR` | 宿主的函数失败，或宿主没有名为 `name` 的函数；消息是宿主给出的 |
| `ERR_ACCESS_DENIED` | `name` 不在应用的 [`host` 能力](#能力)中；`permission` 为 `"host"`，`resource` 为该名字 |
| `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` | 平台没有宿主：`host.available()` 为 `false` |
| `ETIMEDOUT` | 宿主没有及时应答 |
| `ERR_NSH_QUOTA_EXCEEDED` | 已有 1024 个调用在等待嵌入应用的应答 |

不是合法名字（由 `A`–`Z`、`a`–`z`、`0`–`9`、`_`、`.`、`:`、`-` 组成，长度 1 到 128，不含 `..`）的 `name` 以 `TypeError` 拒绝。

调用最多等待宿主应答 30 秒，之后以 `ETIMEDOUT` 拒绝，之后才到的应答会被丢弃。`options.timeout` 以毫秒设置等待时间，`0` 表示不限时；大到时钟永远走不到的值（约 1e22 毫秒）同样不限时，负数、`NaN` 或无穷大则以 `RangeError` 拒绝调用。计时用的是应用的时间，与它的定时器一致：在使用手动时钟的 `nsh test` 中随时钟推进。

```ts
const user = (await host.call("getUserInfo")) as { name: string };
const quote = await host.call("quote.refresh", { symbol: "AAPL" }, { timeout: 5000 }).catch((error) => {
  if (error.code === "ETIMEDOUT" || error.code === "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM") return null;
  throw error;
});
```

### host.on

```ts
on(event: string, listener: (payload: unknown) => void): () => void;
```

平台事件中，宿主每发送一次 `event`，就以它的数据调用 `listener`，直到调用 `host.on` 返回的函数；在组件渲染期间添加的监听器随组件一起停止。宿主在应用启动前发送的事件会在应用启动后送达，应用顶层注册的监听器能收到；监听器注册之前发送的事件不会补发给它。应用启动时的状态用 `host.call` 读取，之后的变化用 `host.on` 跟进。

```ts
const stop = host.on("loginChanged", (payload) => console.log(payload));
// 之后
stop();
```

### 能力

应用调用的每个函数都必须列在 `nsh.json` 的 `capabilities.host` 中：精确的名字、以 `*` 结尾的前缀，或者用 `true` 允许全部。所有应用都是如此，没有声明其他 `capabilities` 的应用也一样：宿主的函数从不默认授予。未授权的调用会以 `ERR_ACCESS_DENIED` 拒绝并记录日志，向嵌入应用 `host.post` 这样的名字会抛出同样的错误；构建从 `nsh` 导入了 `host` 却没有声明 `capabilities.host` 的应用时会给出警告。事件无需授权。参见[沙箱与能力](../docs/sandbox-and-capabilities.md#host)。

```json
{ "capabilities": { "host": ["getUserInfo", "bridge.*"] } }
```

### Web 上的宿主

在 Web 上，页面就是宿主。`createPlayer` 的 `host` 选项应答调用，`player.hostEvent(event, payload)` 发送事件：

```js
const player = await createPlayer(container, {
  wasm: "./nsh.wasm",
  host: { call: (name, args) => (name === "getUserInfo" ? { name: "Ada" } : Promise.reject(new Error(name))) },
});
player.hostEvent("loginChanged", { signedIn: true });
```

发布的应用在 `nsh.json` 中指定宿主：`web.host` 是应用目录内的一个 JS 模块（路径相对于 `nsh.json`），导出 `createHost(player)`，返回带 `call` 的对象。`nsh package --target web` 把它随站点一起发布，`nsh run --target web` 在开发页面上运行它，`nsh test` 会为测试打开的应用运行它。`web.connect` 列出宿主自己的请求访问的主机，页面的 Content-Security-Policy 在应用的 `capabilities.network` 之外允许它们。参见 [Web](../docs/web.md#宿主的函数)。

```json
{ "web": { "host": "./host.js", "connect": ["api.example.com"] } }
```

### host.params

嵌入方在启动你的应用之前设置的参数，从你的代码第一行起就可以同步读取；没有设置时是 `{}`。应用运行期间它们保持不变：之后的请求以事件的形式到来。

```tsx
const conversation = host.params.conversation as string | undefined;
mount(() => (conversation ? <Conversation id={conversation} /> : <Inbox />));
```


### 原生 SDK 通道

原生 SDK 的 `send` 会保留尚未监听的事件，最多 256 条。最后一个监听器在接收过程中停止监听时，其余事件仍按原顺序等待；重载停机期间发送的事件交给下一次加载的应用。`host.post(name, data)` 向原生 SDK 的处理函数投递数据，处理函数可用 `isPost` 区分投递与调用。

### 嵌入方的一侧

每个视图为它加载的所有应用保留一条通道。在加载之前设置参数，随时在任意线程发送事件，按名称注册处理函数。调用和投递需要在 `capabilities.host` 中授权。处理函数回答一次，可以立即回答，也可以稍后回答；始终没有到来的回答会让调用失败。

```rust tabs
// 任一平台的 AppView（GPUI、macOS、Windows、Linux、iOS）：它的 HostChannel。
use serde_json::json;

let host = view.host();
let mut params = serde_json::Map::new();
params.insert("conversation".into(), json!("42"));
host.set_params(params);
// 在引擎线程运行：立即回答，或把调用移走，稍后在任意线程回答。
host.handle("user.profile", |call| {
    let id = call.data()["id"].clone();
    call.resolve(json!({ "id": id, "name": "Ada" }));
});
host.send("conversation.open", json!({ "id": "43" })).unwrap();
```

```swift tabs
appView.params = ["conversation": "42"]
try appView.loadBundle(at: bundleURL)

// 在主线程运行；返回回答，或抛出错误让调用失败。
appView.handle("user.profile") { data in
    let id = (data as? [String: Any])?["id"]
    return ["id": id ?? NSNull(), "name": try await profiles.name(of: id)]
}
appView.handle("analytics") { data, _ in analytics.log(data) }
appView.send("conversation.open", ["id": "43"])
```

```java tabs
nsh.setParams(Map.of("conversation", "42"));
nsh.loadAssetBundle("nsh");

// 在 UI 线程运行；立即或稍后在任意线程回答。
nsh.handle("user.profile", (data, reply) -> {
    Object id = ((Map<?, ?>) data).get("id");
    profiles.load(id, profile -> reply.resolve(Map.of("id", id, "name", profile.name)),
            error -> reply.reject(error.getMessage()));
});
nsh.send("conversation.open", Map.of("id", "43"));
```

参见 [iOS 嵌入](../docs/ios.md#与应用通信)、[Android 嵌入](../docs/android.md#与应用通信) 和 [GPUI](../docs/gpui.md)。

> [!NOTE]
> 原生 SDK 的调用和投递与平台调用一样，需要 [`host` 能力](../docs/sandbox-and-capabilities.md#host)授权。Rust 应用直接通过嵌入方注册的函数调用其 Rust 代码（[`nativeModule`](#nativemodule) 和 Rust 导入）。

## keymap

快捷键 API 绑定应用的键盘快捷键：一个按键组合（如 `"mod+k"`）和它要运行的函数。Rust 代码调用 `nsh_core::prelude` 中的 `on_key`、`on_key_with` 和 `key_label`；TSX 从 `nsh` 导入 `keymap`。两者接受同样的按键组合，遵循同样的规则。

```rust tabs
use nsh_core::prelude::*; // on_key、on_key_with、KeyOptions、key_label
```

```tsx tabs
import { keymap } from "nsh";
```

```ts
const keymap: {
  bind(keystroke: string, handler: (e: { keystroke: string }) => void, options?: KeyBindingOptions): () => void;
  bind(bindings: Record<string, (e: { keystroke: string }) => void>, options?: KeyBindingOptions): () => void;
  label(keystroke: string): string;
};

interface KeyBindingOptions {
  when?: "always" | "notEditing";
  repeat?: boolean;
  passThrough?: boolean;
}
```

| TS | Rust |
|---|---|
| `keymap.bind(keystroke, handler)` | `on_key(keystroke, handler)` |
| `keymap.bind(keystroke, handler, { when, repeat, passThrough })` | `on_key_with(keystroke, KeyOptions { when, repeat, pass_through }, handler)`；`when` 是 `nsh_core::keymap::When`（`Auto`、`Always`、`NotEditing`） |
| `keymap.bind({ … })` | 每个按键组合一次 `on_key` |
| `keymap.label(keystroke)` | `key_label(keystroke)` |

Rust 绑定与创建它的组件（所有者）同生命周期；处理函数收到的是你写下的按键组合。

快捷键在 macOS、Windows、Linux 和浏览器中可用（浏览器自己的按键，比如 Ctrl+T 或 Cmd+W，不会传给页面），在接了硬件键盘的 iOS 和 Android 上也可用：iPad 的键盘、在 Mac 上运行的 iPad 应用、平板或 Chromebook 的键盘，以及模拟器的键盘。同一份代码在所有平台上运行；没有键盘时，不会有按键触发这些绑定。

### keymap.bind

```ts
bind(keystroke: string, handler: (e: { keystroke: string }) => void, options?: KeyBindingOptions): () => void;
```

按下 `keystroke` 时运行 `handler`，并返回一个移除该绑定的函数。处理函数收到 `{ keystroke }`：你写下的按键组合字符串，大小写保持原样。Rust：`on_key(keystroke, handler)`，其处理函数直接收到按键组合。

```rust tabs
use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let open = signal(false);
    on_key("mod+k", move |_| open.set(true));
    on_key("escape", move |_| open.set(false));
    text(move || if open.get() { "搜索…" } else { "按 ⌘K" })
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { keymap } from "nsh";

const open = signal(false);
keymap.bind("mod+k", () => open.set(true));
keymap.bind("escape", () => open.set(false));

mount(() => <Text>{open() ? "搜索…" : "按 ⌘K"}</Text>);
```

传入一个对象可以一次绑定多个按键组合；返回的函数会把它们全部移除。在 Rust 中，每个按键组合调用一次 `on_key`：

```rust tabs
on_key("mod+s", move |_| save());
on_key("mod+shift+p", move |_| open_palette());
on_key("f5", move |_| refresh());
```

```tsx tabs
const unbind = keymap.bind({
  "mod+s": save,
  "mod+shift+p": openPalette,
  f5: refresh,
});
```

组件渲染时创建的绑定会随组件一起移除，所以一个屏幕的快捷键与这个屏幕同生共死：

```rust tabs
#[component]
fn Editor() -> impl IntoElement {
    on_key("mod+enter", move |_| send());
    input().multiline(true)
}
```

```tsx tabs
function Editor() {
  keymap.bind("mod+enter", send);
  return <Input multiline />;
}
```

使用开发服务器时，修改一个模块会在它重新运行之前移除它顶层代码创建的绑定，因此热重载不会留下过期的快捷键。

### keymap.label

```ts
label(keystroke: string): string;
```

返回 `keystroke` 在应用所运行的平台上，菜单和提示中的显示方式：对 `"mod+shift+l"`，在 macOS 和 iOS 上（以及 Mac、iPhone、iPad 上的浏览器里）是 `"⇧⌘L"`，在 Windows、Linux 和其他浏览器里是 `"Ctrl+Shift+L"`。Rust：`key_label(keystroke)`。用它来显示应用的快捷键，显示的就是实际可用的按键：

```rust tabs
text(format!("搜索 {}", key_label("mod+k")))
```

```tsx tabs
<Text>搜索 {keymap.label("mod+k")}</Text>
```

按键组合无效时，它和 `bind` 一样抛出 `TypeError`；`key_label` 和 `on_key` 以同样的信息 panic。

### 按键组合

按键组合由修饰键和一个键用 `+` 连接而成：`"mod+k"`、`"ctrl+shift+p"`、`"alt+enter"`、`"escape"`、`"f5"`、`"cmd+-"`（Command 加减号）。

| 修饰键 | macOS | Windows | Linux |
|---|---|---|---|
| `mod`（也可写 `cmdorctrl`） | Command（⌘） | Ctrl | Ctrl |
| `cmd`（也可写 `command`、`meta`、`super`、`win`） | Command（⌘） | Windows 键 | Super |
| `ctrl`（也可写 `control`） | Control（⌃） | Ctrl | Ctrl |
| `alt`（也可写 `option`、`opt`） | Option（⌥） | Alt | Alt |
| `shift` | Shift（⇧） | Shift | Shift |

iOS 与 macOS 一致（`mod` 是 Command），Android 与 Windows、Linux 一致（`mod` 是 Ctrl，`cmd` 是 Meta 键）。在浏览器里，按键遵循浏览器所在的平台：在 Mac、iPhone 或 iPad 上 `mod` 是 Command，其他地方是 Ctrl。

应用自己的快捷键请用 `mod`：它就是各平台应用习惯使用的那个键（macOS 上是 ⌘K，Windows 和 Linux 上是 Ctrl+K），一种写法到处适用。Windows 键和 Super 基本归系统使用，所以在 macOS 以外很少该用 `cmd`。

键可以是字母、数字或标点键，写作它在美式键盘上不按 Shift 时输入的字符（`k`、`1`、`,`、`/`、`[`；`?` 写作 `"shift+/"`，Shift+K 写作 `"shift+k"`），也可以是名称：`plus`（`=` / `+` 键，也可写 `=`）、`minus`（也可写 `-`）、`space`、`enter`（`return`）、`escape`（`esc`）、`tab`、`backspace`、`delete`（`del`）、`insert`、方向键 `up`、`down`、`left`、`right`（`arrowup` 等）、`home`、`end`、`pageup`、`pagedown`、`f1` 到 `f24`。大小写不影响：`"Mod+Shift+K"` 就是 `"mod+shift+k"`，大写字母表示同一个键，并不意味着 Shift（`"mod+K"` 就是 `"mod+k"`）。推荐的写法是全小写，本页示例都这样写。`"mod-k"` 和 `"mod++"` 会报错，错误信息给出正确的写法。`nsh/desktop` 的菜单快捷键使用同样的写法。

快捷键适用于任何键盘布局：在西里尔或希腊字母布局下，`mod+k` 是美式布局中输入 K 的那个键，与菜单快捷键一致。

对于无效的按键组合，`bind` 会抛出一个说明问题所在的 `TypeError`（`keymap.bind: invalid keystroke "cmd+kk": unknown key "kk"`），并拒绝系统保留的按键组合，应用因此永远无法让它们失效：

| 平台 | 保留 |
|---|---|
| macOS、iOS | Cmd+Q（退出）、Cmd+H（隐藏）、Option+Cmd+H（隐藏其他）、Cmd+M（最小化）、Ctrl+Cmd+F（全屏） |
| Linux、Windows、Android | Ctrl+Q（退出）、Alt+F4（关闭）、F11（全屏） |
| Web | 无（浏览器保留它自己的按键） |

### 输入时

拥有键盘焦点的文本输入框需要它自己的按键：输入、移动光标、删除，以及全选、剪切、复制、粘贴、撤销和重做。因此默认情况下，当文本输入框（或网页视图）拥有焦点时，按键组合属于这些的绑定不会触发：普通键、只带 Shift 或 Option 的键、方向键、Home、End、Page Up / Down、Return、Tab、Escape、Backspace、Delete，以及 `mod+a`、`mod+c`、`mod+v`、`mod+x`、`mod+z`。其他带 Command 或 Control 的按键组合，以及功能键，无论焦点在哪里都会触发。

`when` 可以改变这一点（Rust：`KeyOptions { when: When::Always, .. }`）：

| `when` | 触发 |
|---|---|
| （默认） | 如上 |
| `"always"` | 在文本输入框中也触发，先于输入框看到按键 |
| `"notEditing"` | 文本输入框拥有焦点时从不触发 |

```rust tabs
use nsh_core::keymap::When;

// 在消息输入框中也能发送。
on_key_with("mod+enter", KeyOptions { when: When::Always, ..KeyOptions::default() }, move |_| send());
// 只在用户没有输入时。
on_key_with("mod+e", KeyOptions { when: When::NotEditing, ..KeyOptions::default() }, move |_| archive());
```

```tsx tabs
// 在消息输入框中也能发送。
keymap.bind("mod+enter", send, { when: "always" });
// 只在用户没有输入时。
keymap.bind("mod+e", archive, { when: "notEditing" });
```

在 iOS 和 Android 上，输入法正在组字时用到的按键（选候选词、上屏）仍归输入法。在 GPUI 后端上，拥有键盘焦点的原生组件按文本输入框对待，因为它可能是文本编辑器。它先看到每个按键：它自己处理的按键不会到达绑定，它放过的按键交给在编辑文本时也会触发的绑定。

### 运行哪个绑定

触发了绑定的按键会被消耗（设置了 `passThrough` 的绑定会让按键传下去，见下文）：它不会被输入，系统不会发出提示音，NSH 自己的按键处理也看不到它（Escape 返回、Tab 移动焦点、方向键滚动）。当多个绑定的按键组合相同时，运行最新的那个可以触发的绑定，所以对话框可以把 Escape 绑定在屏幕的绑定之上，对话框的绑定移除后屏幕的绑定又会生效。按下按键的那一刻，绑定就在原生代码中完成匹配；处理函数随后运行，Rust 在引擎线程上，TSX 在 JS 线程上。

按住一个键只触发一次绑定，直到松开为止；设置 `repeat: true` 后，每次自动重复都会再次触发（例如在列表中逐项移动）：

```rust tabs
on_key_with("alt+down", KeyOptions { repeat: true, ..KeyOptions::default() }, move |_| next_item());
```

```tsx tabs
keymap.bind("alt+down", nextItem, { repeat: true });
```

设置 `passThrough: true` 后，绑定照常运行，按键也照常传下去，就像没有绑定一样：Tab 仍会移动焦点，文本输入框仍会输入字符。弹出层要在 Tab 离开时关闭，就这样绑定 Tab，焦点随后移到下一个控件：

```rust tabs
on_key_with("tab", KeyOptions { pass_through: true, ..KeyOptions::default() }, move |_| close());
```

```tsx tabs
keymap.bind("tab", close, { passThrough: true });
```

菜单快捷键会让位给相同按键组合的绑定：所有桌面平台上的应用菜单（[`nsh/desktop`](./nsh-desktop)），以及 macOS 上的内置菜单（Cmd+W、Cmd+C 等）。使用 `nsh run` 开发时，即使应用绑定了 `mod+r`，Cmd+R / Ctrl+R 也总是重新加载应用；打包后的应用可以绑定它。

## nativeComponent and nativeModule

`nativeComponent` 和 `nativeModule` 在运行时按名称把你的应用与宿主应用提供的能力连接起来。嵌入了 NSH 的 iOS 或 Android 应用可以按名称注册自己的视图（地图、图表、相机预览等）；`nativeComponent` 为其中一个视图生成带类型的组件。由于 NSH 使用真正的原生视图渲染，这样的组件和其他视图一样位于视图层级中：由 NSH 布局，随父视图裁剪和滚动，层叠关系也正确。用 Rust 嵌入 NSH 的应用还可以注册函数、类和 Rust 组件；`nativeModule` 把它们作为一个带类型的对象交给你。两种方式下应用都用标准的 `nsh build` 构建：宿主在运行应用时接上它提供的内容。Rust 代码用 `nsh_core::prelude` 中的 `native(name)` 放置已注册的视图，用 `.prop(name, value)` 设置它的属性（一个 JSON 值，或给出 JSON 值的信号或闭包），或用 `.bind_prop(name, &value)` 把属性绑定到动画值，用 `.on_native_event(…)` 接收它的事件，并通过 `ElementRef` 调用它的命令；TSX 从 `nsh` 导入它们。

```rust tabs
use nsh_core::prelude::*; // native、NativeEvent、element_ref
```

```tsx tabs
import { nativeComponent, nativeModule } from "nsh";
```

原生侧的注册方法见[原生组件](../docs/native-components.md)，以及 [iOS 嵌入](../docs/ios.md) / [Android 嵌入](../docs/android.md)。

### nativeComponent

```ts
function nativeComponent<P extends object = {}, E extends object = {}>(
  name: string,
  spec: NativeComponentSpec<P, E>,
): (props: NativeComponentProps<P, E>) => JSX.Element;

interface NativeComponentSpec<P, E> {
  /** 组件自己的属性：发送给组件（任意 JSON 值），每个属性在变化时发送。 */
  props: readonly (keyof P & string)[];
  /** 组件会发出的事件。 */
  events?: readonly (keyof E & string)[];
}
```

返回一个组件，对应宿主应用以 `name` 注册的原生组件（Swift `NshAppView.register(component:)`，Java `NshView.registerComponent`）。Rust：`native(name)`，一个属性为 JSON 值（`.prop("text", json!(…))`）、事件以 `NativeEvent { name, data }` 送达的视图。

- `P` 是组件自身属性的类型。`spec.props` 中列出的每个属性变化时都会以 JSON 发送到原生侧；设为 `undefined` 会移除该属性。
- `E` 把事件名映射到事件数据。事件 `regionChange` 对应处理属性 `onRegionChange`。
- 组件还接受除 `children` 之外的所有[视图属性](../elements/view.md)：`style`、`class`、布局、无障碍、触摸处理和 `ref`。

```ts
type NativeComponentProps<P, E> = Omit<ViewProps, "children"> & P & NativeEventHandlers<E>;
type NativeEventHandlers<E> = { [K in keyof E & string as `on${Capitalize<K>}`]?: (data: E[K]) => void };
```

#### 尺寸

组件像普通视图一样布局，尺寸由样式决定。样式没有确定的维度会使用原生组件报告的尺寸（就像图片使用其原始尺寸一样）。

#### 命令

它的 `ref` 拿到一个 `NativeComponentRef`；`ref.command(name, args)` 调用原生组件的 `name` 命令，参数 `args` 为任意 JSON 值。Rust：`ElementRef::command(name, args)`。

```rust tabs
map.command("zoomTo", json!({ "level": 3 }));
```

```tsx tabs
map.command("zoomTo", { level: 3 });
```

#### 没有注册时

如果 `name` 下没有注册任何组件（换了宿主应用、开发宿主、浏览器），组件会渲染为一个空视图，并输出一次警告。请让应用在没有它时仍然可用，或在使用前确认宿主环境。

### 示例

这里的徽标是宿主应用的原生视图，注册名为 `embed.badge`。NSH 负责布局，向它发送 `text` 和 `color`，接收它的 `tap` 事件，并调用它的 `pulse` 命令：

```rust tabs
use nsh_core::prelude::*;
use serde_json::json;

#[component]
pub fn App() -> impl IntoElement {
    let taps = signal(0_u64);
    let badge = element_ref();
    view()
        .flex_1()
        .p_5()
        .gap_4()
        .child(
            native("embed.badge")
                .prop("text", json!("Tap the native badge"))
                .prop("color", json!("#8250df"))
                .element_ref(&badge)
                .on_native_event(move |e: &NativeEvent| {
                    if &*e.name == "tap" {
                        taps.set(e.data["count"].as_u64().unwrap_or(0));
                        badge.command("pulse", json!(null));
                    }
                })
                .self_start()
                .rounded(px(8.0))
                .overflow_hidden(),
        )
        .child(text(move || format!("Tapped {}×", taps.get())))
}
```

```tsx tabs
import { mount, type NativeComponentRef, signal, View } from "nsh";
import { nativeComponent } from "nsh";

const Badge = nativeComponent<{ text: string; color?: string }, { tap: { count: number } }>("embed.badge", {
  props: ["text", "color"],
  events: ["tap"],
});

function App() {
  const taps = signal(0);
  let badge: NativeComponentRef | undefined;
  return (
    <View style={{ flex: 1, padding: 20, paddingTop: "calc(env(safe-area-inset-top) + 20px)", gap: 16 }}>
      <Badge
        ref={(node) => (badge = node)}
        text={taps() === 0 ? "Tap the native badge" : `Tapped ${taps()}×`}
        color="#8250df"
        onTap={(e) => {
          taps.set(e.count);
          badge?.command("pulse");
        }}
        style={{ alignSelf: "flex-start", borderRadius: 8, overflow: "hidden" }}
      />
    </View>
  );
}

mount(App);
```

### nativeModule

```ts
function nativeModule<T extends object>(specifier: string): T;
```

返回嵌入应用以 `specifier` 注册的套件的导出：其中的模块、类、函数和 Rust 组件，合成一个对象。类型 `T` 由应用自己声明，因此构建应用时不需要了解宿主。与宿主的 crate 一起构建的 Rust 代码直接以 Rust 调用这些函数；`nativeModule` 是 TSX 访问它们的方式。

```ts
import { nativeModule, signal } from "nsh";

interface TradingApi {
  quote(symbol: string): number;
  placeOrder(symbol: string, quantity: number, side: "Buy" | "Sell"): Promise<Order>;
  on(event: "change", listener: (desk: Desk) => void): () => void;
}

const { Trading } = nativeModule<{ Trading: TradingApi }>("host/trading");

const price = Trading.quote("AAPL");

const desk = signal<Desk | null>(null);
Trading.on("change", (d) => desk.set(d));
```

- 调用方式与导入套件时相同：普通 Rust 函数立即返回结果，`async` 函数返回 Promise，传入的函数是 Rust 之后可以调用的回调。Rust 检查每个参数，参数类型不对时抛出 `TypeError`。
- 同一个 `specifier` 每次调用都返回同一个对象。
- `specifier` 下没有注册内容时，`nativeModule` 抛出注明该名称的 `ReferenceError`。请在应用能处理这种情况的地方调用它，或只在为之开发的宿主中使用。

宿主用 Rust 注册套件：在创建视图之前调用平台 crate 的 `set_ui_sets`（与 NSH 自己的套件放在一起），或使用 `EngineConfig::ui_sets`：

```rust
use std::{cell::RefCell, rc::Rc};

use nsh_core::prelude::*;

pub struct Trading;

#[module]
impl Trading {
    /// A sample price.
    pub fn quote(symbol: String) -> Result<f64, String> { /* ... */ }

    /// Calls `listener` with the desk now and after every change
    /// (`change`, the one event), until the returned function is called
    /// or what called `on` goes.
    pub fn on(event: String, listener: Callback<Desk>, cx: CallCx<'_>) -> Result<Stop, String> {
        if event != "change" {
            return Err(format!("no Trading event `{event}`"));
        }
        let listener = Rc::new(RefCell::new(Some(listener)));
        let held = listener.clone();
        cx.start(async move {
            let mut desk = DESK.subscribe(); // a tokio watch channel the host keeps
            loop {
                let Some(listener) = held.borrow().clone() else { return };
                listener.post(desk.borrow_and_update().clone());
                if desk.changed().await.is_err() {
                    return;
                }
            }
        });
        Ok(Stop::new(move || drop(listener.take())))
    }
}

let mut trading = Registry::ui_set("host/trading");
trading.module::<Trading>();
nsh_platform_gpui::set_ui_sets(vec![nsh_base::registry(), trading]);
```

`on` 让宿主的数据与每个应用保持同步：它启动的任务等待宿主的变化，并把每次变化发送给应用；因此宿主自己做出的修改，或任一应用通过其他函数做出的修改，都会到达所有在监听的应用。它返回的 `Stop` 就是 TSX 中 `Trading.on` 返回的函数：它只运行一次，在应用调用它时，或在调用 `on` 的一方（组件，或热重载下模块的这次运行）消失时；这里它丢弃监听器，任务随之结束。

> [!NOTE]
> 属性、事件和命令参数都以 JSON 形式传到原生侧。注册的组件和函数是宿主应用自己的代码：NSH 的[沙箱限制与权限](../docs/sandbox-and-capabilities.md)不约束它们的行为。

## Accessibility

无障碍 API 读取用户的无障碍设置（屏幕阅读器是否在运行、是否要求减弱动态效果），并与屏幕阅读器交互。Rust 代码调用 `nsh_core::prelude` 中的 `screen_reader()`、`reduce_motion()` 和 `announce_for_accessibility()`，用 `ElementRef` 移动焦点；TSX 从 `nsh` 导入 `screenReaderEnabled()`、`reduceMotion()`、`announce()` 和 `setAccessibilityFocus()`。这些设置是响应式的：在绑定、`computed` 或 `effect` 中读取它们，用户修改设置时，读取它们的地方会随之更新。元素的无障碍属性（`accessibilityLabel`、`role` 等）见[元素](../elements/index.md)；教程见[无障碍](../docs/accessibility.md)。

```rust tabs
use nsh_core::prelude::*; // screen_reader、reduce_motion、announce_for_accessibility、element_ref
```

```tsx tabs
import { announce, reduceMotion, screenReaderEnabled, setAccessibilityFocus } from "nsh";
```

### screenReaderEnabled

```ts
const screenReaderEnabled: Accessor<boolean>;
```

屏幕阅读器（VoiceOver、TalkBack）是否正在运行。响应式：用户开启或关闭屏幕阅读器时，读取它的地方会更新。Rust：`screen_reader() -> bool`，同样是响应式的。

```rust tabs
when(move || !screen_reader(), || text("Swipe for the next photo"))
    .otherwise(move || text("Next photo").on_press(next))
```

```tsx tabs
<If when={!screenReaderEnabled()} else={<Text onPress={next}>Next photo</Text>}>
  <Text>Swipe for the next photo</Text>
</If>
```

### reduceMotion

```ts
const reduceMotion: Accessor<boolean>;
```

用户是否要求减少动画（iOS 的“减弱动态效果”，Android 的“移除动画”）。响应式。Rust：`reduce_motion() -> bool`。Tailwind 的 `motion-reduce:` 变体也会跟随它。

```rust tabs
let open = move || {
    if reduce_motion() {
        panel.set(0.0);
    } else {
        let _ = panel.spring(0.0, Spring::default());
    }
};
```

```tsx tabs
const open = () => {
  if (reduceMotion()) panel.set(0);
  else panel.spring(0);
};
```

### announce

```ts
function announce(message: string): void;
```

让屏幕阅读器读出 `message`（VoiceOver 播报、TalkBack）。适用于焦点没有移动就出现的结果，比如“已保存”。Rust：`announce_for_accessibility(message)`。

### setAccessibilityFocus

```ts
function setAccessibilityFocus(node: ViewRef): void;
```

把屏幕阅读器的焦点移到 `node`（某个元素的 `ref`）。Rust：`ElementRef::set_accessibility_focus()`。

```rust tabs
use nsh_core::prelude::*;

#[component]
fn Saved() -> impl IntoElement {
    let note = element_ref();
    let save = move || {
        announce_for_accessibility("Saved");
        note.set_accessibility_focus();
    };
    // 设置变化时再次运行，直到组件移除。
    effect(|| log::info!("screen reader {}", screen_reader()));
    view()
        .gap_2()
        .child(text("Save").role(AccessibilityRole::Button).on_press(save))
        .child(text("Your changes are kept on this device.").element_ref(&note))
}
```

```tsx tabs
import { effect, Text, View, type ViewRef } from "nsh";
import { announce, screenReaderEnabled, setAccessibilityFocus } from "nsh";

function Saved() {
  let note!: ViewRef;
  const save = () => {
    announce("Saved");
    setAccessibilityFocus(note);
  };
  // 设置变化时再次运行，直到组件移除。
  effect(() => console.log("screen reader", screenReaderEnabled()));
  return (
    <View style={{ gap: 8 }}>
      <Text onPress={save} role="button">Save</Text>
      <Text ref={note}>Your changes are kept on this device.</Text>
    </View>
  );
}
```

## 类型

`nsh` 还导出响应式 API 和宿主元素的类型。最常用的有：

| 类型 | 说明 |
|---|---|
| `Accessor<T>` | 可读取的值：`() => T` |
| `Signal<T>` | 带有 `set` 和 `update` 的 `Accessor<T>` |
| `SignalOptions<T>` | `signal` 和 `computed` 的选项（`equals`） |
| `Context<T>` | `context` 的返回值 |
| `Component<P>` | `(props: P) => JSX.Element` |
| `JSX` | JSX 命名空间（`JSX.Element`） |
| `ViewRef`、`InputRef`、`ScrollRef`、`ListRef`、`WebViewRef`、`VideoRef`、`NativeComponentRef` | `ref` 拿到的对象，每个元素有自己的类型（`ViewRef` 及基于它的类型）：聚焦、滚动等命令。`ViewRef` 也是元素本身的类型（`JSX.Element`）。见 [ref 方法](../elements/index.md#ref-方法) |
| `ViewProps`、`TextProps`、`ImageProps`、`ScrollProps`、`CommonProps`、`TouchProps` | 宿主元素的属性 |
| `ViewStyle`、`TextStyle`、`InputStyle`、`ImageStyle`、`LayoutStyle`、`StyleProp<T>` | 样式对象；见[样式参考](./style-reference.md) |
| `ColorValue`、`DimensionValue`、`LengthValue`、`TransformStep` | 样式中的值 |
| `GestureResponderEvent`、`MouseEvent`、`MouseButton`、`ContextMenuEvent`、`PressEvent`、`ScrollEvent`、`PanEvent`、`TouchPoint` | 事件数据 |
| `Point`、`Size`、`Bounds`、`Edges`、`Modifiers` | 事件数据和属性所用的形状，字段与 GPUI 相同（`nsh_core::geometry`） |
| `PixelSize` | 图片或视频自身的像素尺寸（`onLoad`、`Image.getSize`、剪贴板和照片选择器的图片）；`Size` 的单位是点 |
| `ImageAsset` | 导入图片文件得到的对象（`{ url, size: Size, scales? }`；`scales` 列出它的[像素密度变体](../docs/images-and-assets.md#像素密度)） |
| `OS` | `"ios" \| "android" \| "macos" \| "windows" \| "linux" \| "web"` |
| `AccessibilityRole`、`AccessibilityState` | 无障碍属性 |

```tsx
import { type GestureResponderEvent, type InputRef, signal } from "nsh";

let field: InputRef | undefined;
const onPress = (e: GestureResponderEvent) => field?.focus();
```

`StyleProp<T>` 接受单个样式，或一个从左到右合并的样式列表（假值会被跳过）：

```tsx
<View style={[styles.card, selected() && styles.selected]} />
```
