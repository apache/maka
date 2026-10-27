---
title: 编码指南
description: "构建可维护的 Native Shell 应用与组件库的架构、代码风格与命名规范，均附 Rust 与 TSX 示例。"
order: 29.5
group: ui
---

# 编码指南

本指南总结 Native Shell 应用中经过实践验证的应用架构与代码模式，面向工程师和编码智能体：NSH 应用的开发者（TSX 模块、
Rust 组件、嵌入 NSH 的原生应用），以及在 `nsh/base` 之上构建组件库的作者。请先阅读设计指南：代码结构的职责是保存产品意图，
而不是替代产品设计。

本文是一份规范性指南：**必须**表示生命周期、正确性或生态约束；**应该**表示默认架构，偏离时需要有具体理由。精确签名以当前
源码、参考页面和 `.nsh/types` 中的声明为准。

## 让常见用法自然低成本

**设计原则：框架类型与所有权安排，应让组件的常见用法默认就低成本。** 开发者应能构建、复用界面，而不必在每个调用处手写缓存。
只运行一次的组件、在使用处读取的 [signal](./reactivity.md)，都是这种设计的例子：组件只构建一次它那部分的树，之后只有读取了
变化的 signal 的绑定会再次运行，常见路径因此避免重复工作。响应式图、渲染器、布局和列表都是原生的，应用代码的一轮执行变成
一批原生操作。微小成本仍会随元素数和更新次数放大，在自身代码运行于解释器中的 TSX 里尤其如此；只有测到特殊热点后才添加缓存
（[性能](./performance.md)）。这两种选择都不承诺零成本。具体机制见下文的[状态所有权](#状态所有权)与渲染章节。

## 架构总览

<img class="diagram diagram-light" src="/diagrams/application-layers-light.svg" alt="NSH 应用架构层次：App Shell、页面和应用组件位于组件库、nsh/base 与 nsh 之上；依赖只向下。">
<img class="diagram diagram-dark" src="/diagrams/application-layers-dark.svg" alt="NSH 应用架构层次：App Shell、页面和应用组件位于组件库、nsh/base 与 nsh 之上；依赖只向下。">

依赖只向下。上层负责领域语义与流程协调，下层负责可复用的表现和行为。通用组件不能依赖具体应用页面；组件库不能依赖某个应用的
主题（[三层结构](./architecture.md#三层结构)）。

边界定义如下：

- **app shell：** 入口（`App.tsx`，或 `nsh.json` 的 `"root"`）组合根视图与导航栈，不承载页面逻辑；
- **页面：** 一个 `NavPage`，包括它的内容、对话框和它发起的工作；
- **应用组件：** 跨页面复用且带有领域语义的模式；
- **组件库：** 带样式的通用界面，应用自己的或社区的，构建在 `nsh/base` 之上；
- **`nsh/base`：** 不带产品表现的可复用行为：导航、对话框、弹出框、菜单、面板、按压目标；
- **`nsh`：** 原语、样式、布局、响应式与环境。

### 应用文件的布局

应用的文件遵循 NSH 的约定，因此无需任何配置：`App.tsx` 是入口，`nsh.json` 在它旁边，两者都按约定找到。

```text
App.tsx            # 入口，按约定：mount(App)
nsh.json
Cargo.toml         # 应用的 crate，包含 Rust 组件（"rust": "."）
src/
  lib.rs
pages/
  Inbox.tsx
  Compose.tsx
  Settings.tsx
components/
  Card.tsx
store.ts
```

- `pages/` 中每个 `NavPage` 一个文件。页面只在需要时才拆成更多文件。
- `components/` 存放应用的可复用组件，即多个页面都用到的组件。
- `store.ts` 存放应用的状态：它的 signal 以及修改它们的函数。页面读取这些 signal 并调用这些函数。
- 测试是放在被测代码旁边的 `*.test.tsx` 文件（`App.test.tsx`、`pages/Inbox.test.tsx`）。
- `Cargo.toml` 和 `src/lib.rs` 是应用自己的 crate，包含它的 Rust 组件（`nsh.json` 的 `"rust": "."`）；`src/lib.rs` 中的
  `#[native_module]` 声明 TSX 可以导入的内容。只用 Rust 编写的应用也是同样的 Cargo 项目，根组件位于 `src/lib.rs`
  （[项目结构](./project-structure.md)）。

App Shell 只组合页面，尽量不承载页面逻辑。页面读取 store 的 signal 并调用它的函数，从不写入另一个页面的状态。store 的 signal
保持私有，只导出读取和修改它们的函数，让可变状态留在公开函数之后：

```rust tabs
/// The app's workspace: its state stays behind these functions.
#[derive(Clone, Copy)]
pub struct Workspace {
    name: Signal<SharedString>,
}

impl Workspace {
    /// A workspace named "Untitled".
    pub fn new() -> Self {
        Self { name: signal(SharedString::from("Untitled")) }
    }

    /// Its name (tracked where it is read).
    pub fn name(&self) -> SharedString {
        self.name.get()
    }

    /// Renames it.
    pub fn rename(&self, name: impl Into<SharedString>) {
        self.name.set(name.into());
    }
}
```

```tsx tabs
// store.ts
import { signal } from "nsh";

const name = signal("Untitled");

/** The workspace's name (tracked where it is read). */
export const workspaceName = () => name();

/** Renames the workspace. */
export function renameWorkspace(next: string) {
  name.set(next);
}
```

页面可以持有工作区并把它的 id 传给搜索；搜索无须拿到工作区的整个集合或它的私有 signal。一个简单的无环依赖关系是：

```text
App.tsx ──▶ pages/ ──▶ store.ts
              └──────▶ components/ ──▶ nsh/base, nsh
```

页面可以依赖 store 和组件，但不能反向依赖 App Shell，也不能访问另一个页面的私有部分。一个页面需要改变另一个页面显示的内容
时，通过 store 完成。这些边界让不同工程师或多个 AI 智能体可以并行处理不同页面，减少文件冲突与共享状态耦合；store 仍需要
协调。

## 初始化与根视图所有权

应用只挂载一次，并让根视图占据整个界面：TSX 入口调用 `mount(App)`，Rust 应用在 `nsh.json` 中指定根组件
（`"root": "App"`）。根视图用 `flex: 1` 和来自主题的背景色填满界面：

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    provide_context(Workspace::new());
    view()
        .flex_1()
        .bg(move || theme().background)
        .child(inbox())
}
```

```tsx tabs
import { mount, View } from "nsh";

mount(() => (
  <View class="flex-1 bg-background">
    <App />
  </View>
));
```

根视图协调属于整个界面的东西：导航栈，显示在所有内容之上的对话框、弹出框、菜单、面板和工具提示，以及安全区域。不要在同一个
界面里为每个页面再挂载一个根视图。一个界面对应一个引擎：原生应用嵌入的每个 `NshAppView`、`NshView` 或 `AppView` 都运行
自己的 VM、自己的模块状态和自己的响应式图，因此同一宿主应用中的多个界面不会意外共享状态。

## 理解什么只运行一次，什么会再次运行

NSH 使用持久状态与声明式构建，采用 Solid 的模型（[响应式](./reactivity.md)）。signal 跨更新存活；组件函数体在创建时只
描述一次它那部分的树。必须始终区分两者：

| 你写的 | 运行 | 再次运行的时机 |
| --- | --- | --- |
| 组件函数体 | 创建时运行一次 | 从不 |
| 绑定：放在值的位置上的闭包（Rust），或调用函数、读取属性的表达式（TSX） | 一次 | 它读取的 signal 变化时；只更新那一个 prop 或子元素 |
| `computed(fn)` | 创建时 | 它读取的 signal 变化时 |
| `effect(fn)` | 本轮的元素创建之后 | 它读取的 signal 变化时 |
| `each` / `<Each>` 的一行 | 它的 key 第一次出现时 | 从不；变化的是它的 item 和 index signal |
| `virtual_list` / `<List>` 的一个单元格 | 每个单元格一次 | 从不；单元格会被分配给其他行 |

- 正在运行的组件是**归属者**：它运行期间创建的 effect、computed 值、任务、定时器、按键绑定和 cleanup 都属于它，随它一起
  释放；
- **context**（`provide_context` / `use_context`，`context()` 与 `<Ctx.Provider>`）把一个值提供给子树，并不表示读取它的
  元素拥有它；
- Rust 组件的 **`Scope`**（`cx`）发出它的事件，读取它得到的 inset；
- **ref**（`element_ref()`、`ref`）为命令式调用命名一个宿主元素（`focus()`、`scroll_to()`、`measure()`）；
- 布局和测量属于后续的原生阶段，只有需要解析后的几何尺寸时才使用 `onLayout` 和 `measure()`。

不要在事件处理函数或定时器中读取 context，那里没有可以查找它的组件：在函数体中读取，保留它给出的值。保留类型化的 handle
（signal、resource、ref、领域 id），它们在 Rust 中是 `Copy` 的，归属者消失后就不再做任何事。

## 选择正确的组成单元

### 值类型界面使用普通函数

**默认优先用普通函数构造轻量、可复用的界面片段。** 调用者传入当前 props 和处理函数，函数返回元素，之后只剩下它建立的绑定。
它的参数就是它的 props；显示的标签、值与回调来自调用者当前持有的状态。它和任何组件一样只运行一次：之后变化的是它的绑定。

```rust tabs
fn empty_state(title: impl Into<SharedString>) -> impl IntoElement {
    view()
        .gap_2()
        .items_center()
        .child(text(title.into()).text_color(move || theme().muted_foreground))
}
```

```tsx tabs
function EmptyState(props: { title: string }) {
  return (
    <View class="items-center gap-2">
      <Text class="text-muted-foreground">{props.title}</Text>
    </View>
  );
}
```

### 持久行为使用组件

当一块界面拥有持久状态或独立生命周期，例如 signal、effect、异步工作、定时器、按键绑定时，使用 `#[component]`（或创建
signal 的 TSX 组件）。这些状态在组件函数体中创建一次，不能在绑定里创建。

```rust tabs
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SearchProps {
    /// Shown while the field is empty.
    pub placeholder: Prop<SharedString>,
}

#[component]
pub fn Search(props: SearchProps) -> impl IntoElement {
    let query = signal(String::new());
    input()
        .value(move || query.get())
        .on_change(move |text: &str| query.set(text.to_owned()))
        .placeholder(move || props.placeholder.get().to_string())
}
```

```tsx tabs
function Search(props: { placeholder: string }) {
  const query = signal("");
  return <Input value={query()} onChange={(text) => query.set(text)} placeholder={props.placeholder} />;
}
```

`#[component]` 有类型化的 props（`#[derive(Props)]`）和事件（`#[derive(Event)]`）；TSX 导入它时，使用由它们生成的声明。
TSX 用 `new` 创建的持久状态（账本、解析器、会话）是 `#[class]`，函数是 `#[module]`
（[用 Rust 构建](./rust.md#用-tsx-扩展-rust-应用)）。应用最常用的部分、组件库和繁重的逻辑用 Rust 编写，它从头到尾都是原生
代码；经常变化或在运行时下发的部分用 TSX。

不要把每个视觉片段都做成组件；组件边界有生命周期和协调成本，只有持久标识确实重要时才建立组件边界。

### 元素、视图与行为系统各有职责

生态中的公开单元并非一种模板：

- `Button`、`Switch`、`MenuItem` 等语义元素；
- `Dialog`、`Popover`、`Menu`、`ContextMenu`、`Sheet`、`NavStack` 等复合行为根；
- `Input`、`List`、`TextView` 以及导航栈状态等有状态系统；
- 浮层及其定位、虚拟化、滚动、安全区域、键盘与动画等基础设施。

元素内部可以很复杂，但对调用者仍是值。有状态系统可以通过渲染函数让应用拥有表现，同时不重做行为。公开接口应由行为决定，而不是
由输出中有多少个视图决定。

## 状态所有权

### 用 `SharedString` 保存持久化界面文本

**在 Rust 中，跨更新或回调闭包保存的界面文本必须优先使用 `SharedString`**，包括组件的标签、标题和占位文本：props 接收它
（`Prop<SharedString>`），把它 clone 进绑定不会复制文本。可变编辑缓冲、格式化构建阶段使用 `String`，完成后再转换；单次调用内
临时只读则使用 `&str`。在 TSX 中，字符串就是应用自己的值；由状态计算出的文本放进 `computed` 或闭包，而不是在多处重复构建。

对于界面会长期持有的不可变响应文本，保留收到的原值；派生或格式化后的展示文本放在单独的领域值中，不要改写响应。

状态应放在能够保持其正确性的最窄归属者中：

- 领域状态属于 store（`store.ts`）或应用的 crate；
- 临时视图状态属于渲染它的组件，是一个 signal；
- 可复用的行为状态属于为该行为设计的组件（不传 `open` 的 `Menu` 或 `Popover` 自己保存它）；
- 子树共享的状态是通过 [context](./reactivity.md#context) 提供的 signal；
- 跨越一次运行的数据放在[存储](../modules/nsh.md#storage)或服务器上。

普通的选择和开关优先采用受控值：传入当前值，接收请求的变化，由归属者更新，绑定随之更新。回调表达意图，不能建立第二份隐藏
真相。

```rust tabs
switch()
    .checked(show_hidden)
    .on_change(move |next: &bool| show_hidden.set(*next))
    .child(text("Show hidden files"))
```

```tsx tabs
<Switch checked={showHidden()} onChange={(next) => showHidden.set(next)}>
  <Text>Show hidden files</Text>
</Switch>
```

不需要任何通知：写入 signal 会精确更新读取它的绑定。Rust 组件用 `cx.emit(..)` 发出归属者需要处理的语义事件；effect 在其
归属者存活期间跟随 signal。形成同一不变量的多个字段在一个 [`batch`](./reactivity.md#batch) 中写入，effect 和 computed
值会同时看到它们。

应用自己的受控组件遵循同一份契约。下面是一个数量步进器，一个领域控件，用 Rust 编写一次，从 Rust 和 TSX 放置：

```rust tabs
use nsh_base::{button, theme};
use nsh_core::prelude::*;

/// The props of [`QuantityStepper`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct QuantityStepperProps {
    /// The quantity: the app owns the value.
    #[prop(default)]
    pub value: Prop<u32>,
    /// The smallest quantity (0 when left out).
    #[prop(default)]
    pub min: Prop<u32>,
    /// The largest quantity (99 when left out).
    #[prop(default = 99)]
    pub max: Prop<u32>,
    /// What screen readers say for the button that takes one away.
    pub decrement_label: Prop<SharedString>,
    /// What screen readers say for the button that adds one.
    pub increment_label: Prop<SharedString>,
}

/// What a [`QuantityStepper`] reports.
#[derive(Debug, Clone, PartialEq, Event)]
pub enum QuantityStepperEvent {
    /// The user asked for another quantity; the owner sets `value`.
    Change(u32),
}

/// A quantity with a button to take one away and one to add one.
#[component]
pub fn QuantityStepper(props: QuantityStepperProps, cx: Scope<QuantityStepperEvent>) -> impl IntoElement {
    // Read untracked: the user's act, measured against the owner's current value.
    let step = move |delta: i64| {
        let value = props.value.get_untracked();
        let (min, max) = (props.min.get_untracked(), props.max.get_untracked());
        let next = (i64::from(value) + delta).clamp(i64::from(min), i64::from(max)) as u32;
        if next != value {
            cx.emit(QuantityStepperEvent::Change(next));
        }
    };
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .child(step_button(
            "−",
            move || props.decrement_label.get(),
            move || props.value.get() <= props.min.get(),
            move || step(-1),
        ))
        .child(text(move || props.value.get().to_string()).text_color(move || theme().foreground))
        .child(step_button(
            "+",
            move || props.increment_label.get(),
            move || props.value.get() >= props.max.get(),
            move || step(1),
        ))
}

fn step_button(
    symbol: &'static str,
    label: impl Fn() -> SharedString + 'static,
    disabled: impl Fn() -> bool + 'static,
    on_press: impl Fn() + 'static,
) -> impl IntoElement {
    button()
        .disabled(disabled)
        .accessibility_label(move || Some(label()))
        .on_press(on_press)
        .w(px(32.0))
        .h(px(32.0))
        .items_center()
        .justify_center()
        .rounded(move || theme().radius)
        .bg(move || theme().muted)
        .active(|s| s.opacity(0.6))
        .disabled_style(|s| s.opacity(0.4))
        .child(text(symbol).text_color(move || theme().foreground))
}

// 归属者：
let quantity = signal(1_u32);
quantity_stepper()
    .value(quantity)
    .min(1)
    .max(10)
    .decrement_label("Fewer")
    .increment_label("More")
    .on_change(move |next: &u32| quantity.set(*next))
```

```tsx tabs
import { signal } from "nsh";
import { QuantityStepper } from "my-app";   // Rust 组件：src/lib.rs 中有 #[native_module("my-app")]

function CartRow() {
  const quantity = signal(1);
  return (
    <QuantityStepper
      value={quantity()}
      min={1}
      max={10}
      decrementLabel="Fewer"
      incrementLabel="More"
      onChange={(next) => quantity.set(next)}
    />
  );
}
```

同一份契约的 TSX 写法，作为 `components/` 中的一个组件：

```tsx
import { Text, View } from "nsh";
import { Button } from "nsh/base";

export interface QuantityStepperProps {
  /** The quantity: the app owns the value. */
  value: number;
  /** The smallest quantity (0 when left out). */
  min?: number;
  /** The largest quantity (99 when left out). */
  max?: number;
  /** What screen readers say for the button that takes one away. */
  decrementLabel: string;
  /** What screen readers say for the button that adds one. */
  incrementLabel: string;
  /** The user asked for another quantity; the owner sets `value`. */
  onChange?: (next: number) => void;
}

export function QuantityStepper(props: QuantityStepperProps) {
  const min = () => props.min ?? 0;
  const max = () => props.max ?? 99;
  const step = (delta: number) => {
    const next = Math.min(max(), Math.max(min(), props.value + delta));
    if (next !== props.value) props.onChange?.(next);
  };
  const buttonClass = "size-8 items-center justify-center rounded-(--radius) bg-muted active:opacity-60 disabled:opacity-40";
  return (
    <View class="flex-row items-center gap-3">
      <Button disabled={props.value <= min()} accessibilityLabel={props.decrementLabel} onPress={() => step(-1)} class={buttonClass}>
        <Text class="text-foreground">−</Text>
      </Button>
      <Text class="text-foreground">{props.value}</Text>
      <Button disabled={props.value >= max()} accessibilityLabel={props.incrementLabel} onPress={() => step(1)} class={buttonClass}>
        <Text class="text-foreground">+</Text>
      </Button>
    </View>
  );
}
```

### 限定所有权关系与订阅生命周期

组件拥有它创建的东西，它创建的一切都随它消失：它的 `<If>` 分支隐藏、它的行被移除或它的页面被弹出时。在 Rust 中，任务、
定时器和间隔（`spawn`、`set_timeout`、`set_interval`）以及按键绑定（`on_key`）随创建它们时的归属者结束；在 TSX 中，用
[`cleanup`](./reactivity.md#cleanup) 注册停止操作，或从 effect 中返回它。开始监听的函数返回一个停止监听的函数
（`() => void`），组件渲染期间注册的内容随组件一起移除，`keymap.bind` 就是如此。

某个东西意外地一直在运行时，先检查在组件之外创建的 effect 和 computed 值（在事件处理函数或定时器回调中创建的没有归属者，会
一直存在）、注册时没有保留停止操作的监听，以及从没有组件归属的 store 启动的工作。被丢弃的 `resource` 加载会中止（TSX 中的
`info.signal`），它本身不会让组件继续存活。这些是优先排查点，并非全部原因。

读取或派生值不能触发写入。不要在读取某个 signal 的绑定或 effect 中无条件地写入它：它会不断地再次运行自己，直到 NSH 以错误
终止它。由其他状态计算出的值是 `computed`，而不是写入第二个 signal 的 effect。

### 防止状态反馈环

文本输入、选择、筛选和受控弹出层常有两条路径：外部归属者设置值，以及用户请求新值。同步外部值时不能再次通过用户回调回传。
处理用户操作时以不跟踪的方式读取归属者的当前值（Rust 中如上所示的 `props.value.get_untracked()`；TSX 的事件处理函数本身
不跟踪），并与新值比较，确保一次逻辑变化只报告一次。回调可能同步关闭、替换或更新当前组件时，调用路径必须可重入。

## 稳定标识

key 是行为契约的一部分。它为行、页面或重复控件提供稳定标识，并在数据变化时决定由哪一个保留自己的状态、焦点和测量结果。

- 行、标签页、页面和重复控件使用稳定的领域 id：`each(projects, |p| p.id, ..)`、
  `<Each of={projects()} key={(p) => p.id}>`、列表的 `keyExtractor`；
- 同一控件重复出现时，用所属对象为测试 id 加命名空间（`delete-${project.id}`）；
- 可插入或重排的数据不能使用翻译后的文案或可变索引作为标识；
- 渲染时不能生成新的随机 key 或 id。

```rust tabs
each(projects, |p| p.id, move |project, _index| {
    let id = project.get_untracked().id;
    button()
        .on_press(move || delete(id))
        .child(text("Delete").test_id(&format!("delete-{id}")))
})
```

```tsx tabs
<Each of={projects()} key={(p) => p.id}>
  {(project) => (
    <Button onPress={() => remove(project().id)}>
      <Text testID={`delete-${project().id}`}>Delete</Text>
    </Button>
  )}
</Each>
```

key 改变表示界面标识改变，其状态重置必须是有意行为。导航路由、列表 key、存储键和测试 id 也遵循相同规则：在 `setRoutes` 中
保留下来的路由保留它的页面和状态；两个独立保存的行为共享一个 key 会相互覆盖，每次更新都换 key 则永远无法累积状态。

## 渲染与组合

组件函数体保持声明式：读取当前状态、派生展示值、组合元素。领域操作、解析与复杂修改放入 store 或应用 crate 的具名函数。

```rust tabs
#[component]
pub fn ProjectPage() -> impl IntoElement {
    view()
        .flex_1()
        .child(toolbar())
        .child(content())
}
```

```tsx tabs
function ProjectPage() {
  return (
    <View class="flex-1">
      <Toolbar />
      <Content />
    </View>
  );
}
```

当辅助函数能命名有意义的区域并减少读者需要同时记住的状态时，就提取它。只有该区域有可复用契约或持久生命周期时才提取新组件；
构建器链或 JSX 块很长本身不是理由。

在 Rust 中一致使用类型化的样式方法和组件的构建器，在 TSX 中使用类名。小的条件修饰使用 `.when(..)` / `.when_some(..)`
（Rust）和 `classList`（TSX）；分支代表明显不同的界面时使用 `when` / `<If>`，因为闭包中的三元表达式在它读取的任何内容变化
时都会重新构建分支。

构造自定义界面前先使用标准语义组件。不能为了匹配一张截图就用普通视图重做菜单、弹出框、面板或对话框：`nsh/base` 的 `Menu`、
`ContextMenu`、`Popover`、`Sheet`、`Tooltip` 和 `Dialog` 保留了定位、焦点转移、键盘导航、选择、禁用状态、按 Escape 和返回
关闭以及无障碍契约。如果标准组件无法表达可重复的合理模式，应改进它的显式 API，而不是在每个调用处给任意后代设置样式。

应用提供的渲染函数必须无副作用。列表的行、`TextView` 的 `renderCodeBlock` 或菜单的条目，可能在归属者需要单元格、部件或
打开菜单时运行，不能执行业务操作、追加数据或开始无界的订阅。

## 行为与表现的边界

Base 的长期规则是：

> Base 拥有可复用行为，以及实现行为所必需的结构；表现层拥有产品视觉语言。

“无样式”不表示“只有一个空视图”。浮层定位、键盘导航、编辑、虚拟化、返回导航、关闭与安全区域都需要内部结构与状态。把它们推给
调用者不是灵活，而是复制脆弱行为。

反过来，Base 不能选择品牌色、字体、密度、最终图标、变体、文案或应用组合。表现能力通过主部件上的 `class` / `style`、其他
每个部件的 `<part>Class` / `<part>Style`、类型化的状态样式（`active`、`hover`、`focus`、`selected`、`checked`、
`disabled`）、命名插槽（`trigger`、`header`、`footer`）和渲染函数暴露。不能遍历任意后代去猜标题、描述或关闭按钮，必须提供
语义部件，并且每个标签都通过 prop 或子元素传入。

## 主题与样式

从主题读取语义值，在 Rust 中用类型化的样式方法、在 TSX 中用 Tailwind 类名布局（[Tailwind](./tailwind.md)、
[主题 token](./tailwind.md#主题-token)）：

```rust tabs
view()
    .bg(move || theme().background)
    .text_color(move || theme().foreground)
    .border_1()
    .border_color(move || theme().border)
    .rounded(move || theme().radius)
```

```tsx tabs
<View class="rounded-(--radius) border border-border bg-background text-foreground" />
```

规则：

- 不写死产品颜色、圆角、间距或控件几何尺寸；
- 应用代码不得引入原始的十六进制、`rgb` / `rgba` 或 `hsla` 值；颜色从 `theme()` 或 token 类名（`bg-primary`）读取，缺少
  语义角色时补入应用的主题文件；
- 应用布局使用间距和字号刻度（`p-2`、`gap-3`、`w-64`、`text-sm`；`.p_2()`、`.gap_3()`、`.w_64()`、`.text_sm()`），而不是
  任意值（`p-[13px]`、`px(13.0)`）；
- 类名的含义与 Tailwind CSS v4 完全相同，CSS 值的含义与浏览器中相同；`unknown class` 警告是需要修复的问题；
- token 按语义而不是调色板位置使用；
- 与状态无关的几何放在普通的构建器链或类名字符串中；
- 运行时交互状态使用 `active:`、`hover:` 和 `focus:`（`.active(..)`、`.hover(..)`、`.focus(..)`），它们原生生效，不需要往返
  应用代码；
- checked、selected、pressed、disabled 外观使用组件的语义状态样式（`selected:`、`checked:`、`disabled:`）；
- 弹出层的所有权使用显式状态（`open` 与 `onOpenChange`），使触发器在关闭前持续呈现打开或按下的外观；
- 变体保持少而有意义，不为每个调用处增加一个变体；
- 主要样式绑定决策区域真正的默认提交和回车键操作，不能从操作数量、频率或工具栏位置推导；
- 徽标和提示的变体保持语义化且稀缺。普通元数据使用中性样式；不能仅因为变体存在，就把每个枚举值或分区映射成不同颜色。

有效的优先级为：元素自身的样式，然后是状态样式，后面的状态优先，`disabled` 高于一切。后一层只替换自己设置的字段。

新的应用自有表现优先使用主题的语义 token。应用主题文件中的每个名称都是 token，如同 Tailwind `@theme` 的变量（`"up": "#16a34a"`
生成 `text-up`、`bg-up/30`、TSX 中的 `token("up")` 和 Rust 中的 `theme().color("up")`），主题有浅色和深色两套值，所以 token 不用 `dark:` 类名也会跟随外观模式。以角色而不是组件命名 token，避免它成为每个控件的扩展点。

通过应用的主题文件（`nsh.json` 的 `"theme"`）修改主题，或让嵌入应用提供它自己的主题：主题变化时，引用 token 的类名和读取
`theme()` 的 Rust 绑定都会原生地重新设置样式，无需运行任何 JavaScript。把 token 的值复制到自己的 signal 中的代码就不再跟随它。

向外绘制的焦点环需要空间，带 `overflow: hidden`（`overflow-hidden`）的祖先会裁掉它。优先让布局留出空间；产品确实需要大量
裁剪时，在控件内部绘制获得焦点的状态，不能悄悄消除键盘焦点。

### 用户的字号就是应用的缩放

文本跟随用户的字号设置（动态字体、Android 的字体缩放、桌面系统的设置）：TSX 中的 `fontScale()`、Rust 中的
`font_scale()`，两者都是响应式的。字号刻度（`text-sm`、`text-base`：16 点，即正文字号）设定基准，用户的设置在此之上缩放。这有意沿用 Tailwind 模型中有价值的部分：具名的字号、间距和尺寸
档位，而不是互不相关的点数常量。

让文本容器随文本增高：给它们最小高度和内边距，而不是固定高度。自定义组件如果把缩放的文本与周围固定的几何尺寸混合，必须记录
为什么该部分不应增长。

应用界面中每个任意的点数值和原始颜色构造都应视为评审问题。只有有文档说明的物理或平台边界、运行时测得的几何尺寸、图像或数据
颜色，或主题定义本身可以例外。方便或“匹配截图”都不是有效理由。

从解析后的布局得到的缓存必须把字体缩放纳入失效条件，或者依赖随它变化的版本号：告诉列表的行高、文本测量、弹出层几何、由文本
推导的图标尺寸和自定义画布的度量都是如此。

## 事件、命令与焦点

激活使用按压：`onPress`、`onLongPress`、`onPressDown` 和 `onPressUp` 对手指、笔、鼠标和键盘含义相同。触摸处理函数和手势只
用于跟随手指的操作（平移、拖动）。需要按键绑定、菜单或多种输入来源的命令使用键盘快捷键（`keymap.bind`、`on_key`）和菜单项。
处理函数靠近拥有命令的页面。

一个逻辑命令只建模一次。`Button`、`Menu` 条目、`ContextMenu` 条目、`nsh/desktop` 的应用菜单项与键盘快捷键应调用 store 的
同一个函数，不能复制五份修改。条件允许时，标签、图标、快捷键与禁用状态来自同一命令策略（`key_label("mod+s")` 按平台的方式
写出快捷键），避免不同入口互相矛盾。菜单拥有导航与关闭；页面仍然拥有命令是否允许以及实际执行内容。

```rust tabs
on_key("mod+s", move |_| save());
view()
    .child(button().on_press(save).child(text("Save")))
    .child(
        menu()
            .trigger(view().px_3().py_2().child(text("File")))
            .child(menu_item().on_select(save).child(text(format!("Save  {}", key_label("mod+s"))))),
    )
```

```tsx tabs
keymap.bind("mod+s", save);

<View>
  <Button onPress={save}><Text>Save</Text></Button>
  <Menu trigger={<View class="px-3 py-2"><Text>File</Text></View>}>
    <MenuItem onSelect={save}><Text>Save  {keymap.label("mod+s")}</Text></MenuItem>
  </Menu>
</View>
```

控件选择必须符合语义。命令即使需要降低强调，也应使用 `Button` 并给它低调的样式，不能换成链接。NSH 应用约定：`link` 角色
只用于在应用之外打开的目标，例如 URL 或电子邮件地址；应用内目标使用导航，命令使用 `Button`。

只有嵌套交互确实必须阻止父级处理同一次触摸时，才在触摸事件上调用 `stopPropagation()`。无差别阻止会破坏滚动、按压与手势，
而且很难诊断。

**主线程从不等待应用代码。** 当系统需要立即得到答案（这个页面能否弹出、这个面板或弹出框能否关闭、这段文本能否修改）时，NSH
根据事先挂载的 props 原生作答，事后再用事件告诉应用。所以决定是一个 prop，一旦知道就设置，而不是返回 true 或 false 的回调：
`popOnBack={!dirty()}` 配合 `onBackPress` 进行确认（[popOnBack](./navigation.md#把用户留在当前页面poponback)），
`closeOnEscape` 和 `closeOnBackdropPress` 配合 `onCancel` 获知用户的尝试，输入框上的 `maxLength`，按钮上的 `disabled`。

菜单项的 `shortcut`（`nsh/desktop`）在菜单设置期间绑定它的按键，菜单按平台的样式显示它；同一按键的 `keymap` 绑定优先于它。
每个按键只有一个归属者；菜单项或快捷键变化时，重新设置应用菜单。

焦点归属必须明确：

- `Button`、`Switch` 和菜单项在桌面和 Web 上是键盘焦点的停靠点；在它们之上构建控件，而不是在裸视图上；
- 在事件中，或在跟随状态变化的 effect 中，用 ref 的 `focus()` 移动焦点，用 `set_accessibility_focus()`（Rust）或
  `nsh` 的 `setAccessibilityFocus`（TSX）移动屏幕阅读器的焦点；
- 绘制清楚的 `focus:` 状态；
- 禁止在渲染时无条件设置焦点。

复合控件应完成整个导航模型：方向键、适用时的 Home / End 或翻页、确认、取消与 Tab，而不是几个孤立的快捷键。

浮层从最上层关闭：Escape 和 Android 返回键交给最上层正在监听的浮层（`onCancel`）。快速关闭、打开时，不能作用到正在关闭的
中间界面上。

## 异步任务与副作用

异步工作从事件、effect 或 [`resource`](./reactivity.md#resource) 启动，不能作为组件函数体的无条件副作用。effect 只跟踪
同步读取的内容：先读取 signal，再启动工作。工作完成后通过 signal 更新状态，接受组件可能已经消失，并一起写入一致的修改。

重复运行的工作放在归属者之下，使归属者消失时工作取消：Rust 的任务和定时器随归属者结束，TSX 的定时器在 `cleanup` 中停止。
确实必须独立完成的一次性任务可以从 store 启动，但会放弃这种取消。错误与失败的请求都需要明确处理。

用明确的状态表示异步操作：resource 的 `state()` 为 `unresolved`、`pending`、`ready`、`refreshing` 或 `errored`。刷新时
保留可用的旧数据：resource 在重新加载时保留它的值。防止重复的破坏性提交；可恢复的错误要显示在界面中，而不是只写日志。

```rust tabs
let results = resource(
    move || {
        let q = query.get();
        (!q.is_empty()).then_some(q)
    },
    |q, _info| async move {
        let response = fetch(format!("https://api.example.com/search?q={q}")).await?;
        if !response.ok() {
            return Err(format!("HTTP {}", response.status()));
        }
        Ok(response.text())
    },
);
```

```tsx tabs
const results = resource(
  () => query() || undefined,
  async (q, { signal }) => {
    const response = await fetch(`https://api.example.com/search?q=${encodeURIComponent(q)}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as SearchHit[];
  },
);
```

把昂贵的解析或计算移出 TSX 的处理函数：放进 `computed`、移出交互路径，或改用 Rust。结果可能晚于查询、页面或选择的变化：
resource 会丢弃被取代的加载，你自己的工作要附带版本号或标识，拒绝过期的结果，而不是把它应用到新状态上。

## 布局、测量与滚动

视图把子元素排成一列，子元素默认在交叉轴上拉伸；`class="flex"`（`.flex_row()`）是一行，与 CSS 相同。一排控件需要居中
（`items-center`），这要写出来。一排等高的列保持默认的拉伸，这样列会填满行的高度，它的标题也留在顶部：

```rust tabs
view()
    .flex_row()
    .flex_1()
    .child(sidebar())
    .child(content())
```

```tsx tabs
<View class="flex flex-1">
  <Sidebar />
  <Content />
</View>
```

大多数界面使用布局，不应自行测量（[布局](./layout.md)）。测量（`onLayout`、`measure()`）是浮层、虚拟化、编辑器、图表等
依赖解析后几何尺寸的行为的深层工具。

- 测量与几何放在拥有行为的层；
- 只有普通布局无法表达关系时才观察布局；
- 不能在每次布局事件中写入无关的应用状态；
- 测得的数据只在某个版本内有效；字号、宽度、主题或内容改变后可能过期；
- 弹出层交给 `nsh/base` 的浮层定位：它们的定位、翻转和安全区域边距遵循同一套规则。

对齐不变量应通过构造保证，而不是事后校正：相邻区域使用同一个间距 token 或共享的缩进，不能重复看似等价的字面量。关键的重复边缘、
列与间距应增加几何检查，或在真实平台上截图（`nsh test --target`）。验证不能只有默认窗口；较大的字号与显示缩放会把小数坐标
变成一个像素的漂移，即使默认截图看起来整齐。

精度评审要测量解析后的结果，但不能把测得的差值写成任意值去微调。应继续追踪到重复的内边距、嵌套的缩进、边框归属、字体度量或
取整，并修复结构上的归属者。

每个可滚动区域只有一个归属者。避免同一轴向上意外的嵌套滚动。把滚动视图放在拥有完整页面、面板或列表的元素上，使滚动指示器
解析到区域边缘；内容的内边距放在它内部（`contentClass` / `contentStyle`），不能用带内边距的容器包住滚动视图。指示器悬在
内容与页面边界中间，通常说明滚动归属者错误或内边距放错了层。在内边距和外边距中用 `env(safe-area-inset-*)` 和 `env(keyboard-inset-height)` 避开
安全区域和键盘（用对应的访问器读取数值），它们原生地跟随旋转和键盘。

## 列表、表格与大数据集

数据可能超过小型有界集合时，使用 [`List`](./lists.md)（Rust 中的 `virtual_list`）。行的标识与可见位置分开，不要在每次
更新时复制全量数据。让列表拥有复用、滚动协调与可见范围，行函数拥有行的表现。

分离以下状态：

- 源数据与领域 id；
- 筛选与排序；
- 选择；
- 滚动；
- 行渲染。

这样更新保持局部，也不会把视图树变成数据模型。

虚拟化是行为契约，不只是性能开关。行函数每个单元格只运行一次，单元格会复用给其他行：

- **必须把每个条目的状态放在以 id 为键的数据中**，而不是行内创建的 signal 中，后者会随单元格移动到下一个条目；
- **必须在使用处、在绑定中读取条目**：在行函数开头复制出来的值属于这个单元格显示的第一行；
- 在 TSX 中以不可变的方式更新（新的数组，复用未变的条目，变化的条目是新对象），并给一个接近典型行高的
  `estimatedItemSize`；
- 即使多数行当前不存在，滚动到条目（`scrollToIndex`）仍在数据坐标上工作。

```rust tabs
let liked = signal(HashSet::<u32>::new());

virtual_list(move || posts.with(Vec::len), move |at| {
    let post = computed(move || posts.with(|p| p[at.index()].clone()));
    view()
        .flex_row()
        .p_4()
        .child(text(move || post.with(|p| p.title.clone())).flex_1())
        .child(
            text(move || if liked.with(|s| s.contains(&post.with(|p| p.id))) { "♥" } else { "♡" })
                .on_press(move || toggle(post.with(|p| p.id))),
        )
})
.estimated_item_size(px(64.0))
```

```tsx tabs
const liked = signal<Set<number>>(new Set());

<List each={posts()} estimatedItemSize={64} class="flex-1">
  {(post) => (
    <View class="flex-row p-4">
      <Text class="flex-1">{post().title}</Text>
      <Text onPress={() => toggle(post().id)}>{liked().has(post().id) ? "♥" : "♡"}</Text>
    </View>
  )}
</List>
```

## 公共 API 设计

可复用组件应遵守：

- props 建立合法的默认值：Rust 中用 `#[prop(default)]` 或 `#[prop(default = …)]`，TSX 中在读取 prop 的地方用 `??`；
- 每个 prop、事件和导出都有文档注释；在 Rust 中，它会成为 TSX 看到的 TypeScript 声明；
- 回调描述请求的变化；只有指针细节有意义时才带上它们；
- 显式的部件、插槽和渲染函数优于检查任意后代；
- 可复用行为不能强制产品层面的视觉选择。

应用以签名包的形式下发到宿主应用中，可能再也不会重新构建：NSH 之后的每个版本都原样运行它们。对应用或组件库暴露给他人的内容
（组件的 props 和事件、crate 的导出、宿主应用的原生组件和模块接收的函数）采用同样的纪律：

- 输入只增加可选成员；类型只放宽；默认值和行为保持不变（新行为需要主动开启）；
- 选项是一个对象（`scrollTo({ x, y, animated })`），而不是第三个位置参数；
- 模式是可以增加取值的字符串联合类型，而不是以后需要第三种状态的布尔值；
- 一个值只有一种类型：`version: string`，而不是 `string | number`；
- 函数返回一个可以增加字段的对象，而不是元组或单独的值；
- 重命名时保留旧名称，作为同一实现的 `@deprecated` 别名。

在 Rust 中，需要持续演进的行为状态默认使用私有字段。有意设计成记录的配置和序列化数据可以暴露字段，但所有包含公开字段的
`pub struct` 必须标注 `#[non_exhaustive]` 并实现 `Default`，避免调用方依赖穷举结构体字面量，后续增加字段也无需破坏调用方。

内部重组时保持公开的导入路径：crate 的 `#[native_module]` 标识符及其导出、TSX 模块的导出，都是其他代码导入的内容。命名优先
使用平台控件术语和 NSH 的既有词汇，不使用偶然的 Web 框架词汇。

## 平台与能力边界

不能假设每个平台支持相同的能力。标题栏和窗口控件、无障碍、剪贴板、触感反馈、滚动物理、字体和时序都可能不同。一个包在每个
平台上运行（[平台特定代码](./platform-specific.md)）；平台特定的代码放在 NSH 为它准备的位置，并定义回退行为：

- 两个平台都有的 prop 是顶层 prop；只有一个平台有的 prop 放进 `ios={{…}}`、`android={{…}}`、`desktop={{…}}` 或
  `web={{…}}`（Rust 中是构建器方法），只有当前平台的对象会生效；
- 移动平台的 API 来自 `nsh/mobile`，桌面的 API 来自 `nsh/desktop`；
- 按平台设置的样式使用 `ios:`、`android:` 和 `web:` 类名。

平台分支即使表现不同，也必须保留语义契约。例如对话框在 iOS 上是面板，在桌面上是覆盖窗口的一层，但应用仍需要一致的打开状态。
共享的行为在无界面环境中测试，平台的部分用 `nsh test --target` 测试。

应用在 `nsh.json` 的 `"capabilities"` 中声明它在 VM 之外能访问的内容：可以请求的主机、Web 视图显示的页面、剪贴板、状态栏
（[沙箱与权限](./sandbox-and-capabilities.md)）。将被下发到其他应用中的应用，准确列出它用到的内容，并像处理失败的请求那样
处理被拒绝的请求：宿主应用授予的权限可能少于应用声明的。

## 文件、代码与命名风格

- 页面和组件以产品概念命名：`ProjectList`、`ProjectEditor`、`SettingsPage`；
- 处理函数以意图命名：`confirmDelete`、`openProject`、`onQueryChange`；
- 每个模块一个主要职责；必须读无关行为才能理解状态或生命周期时就应拆分；
- 组件的模块、props、事件与针对性的测试在共同变化时放在一起；
- 注释记录不变量和意外的生命周期约束，不复述显而易见的构建器调用；
- Rust 使用 `rustfmt` 并满足 Clippy，TSX 通过 `nsh check`，不能用宽泛的 `allow` 隐藏无关警告。

### 词汇是 API 的一部分

在各个组件中，同一概念使用同一个词。在给 prop 或事件命名之前，先在 NSH 自己的 API 中寻找这个术语，然后是 GPUI Kit 的
`gpui-base`、GPUI 和 `gpui-component`，再然后是各平台的控件。原语所显示的内容和全局 API 的名称取自 HTML、DOM 和 CSS
（`src`、`html`、`placeholder`）。Rust 名称是 `snake_case`，在 TSX 中转换为 `camelCase`（`on_open_change` 即
`onOpenChange`）；一个词保持一个词（`readonly`、`multiline`）。

| 概念 | 命名模式 | 示例 |
| --- | --- | --- |
| 组件 | 名词，`PascalCase` | `Button`、`Dialog`、`QuantityStepper` |
| 它的 props 和事件（Rust） | `<Component>Props`、`<Component>Event` | `ButtonProps`、`ButtonEvent::Press` → `onPress` |
| 行为的状态对象 | `<Control>State`，由 `create<Control>` 创建 | `NavStackState`、`createNavStack` |
| 值变化的原因 | `<Control>ChangeReason`，字符串联合类型 | `DialogChangeReason`：`"cancel"`、`"backdropPress"` |
| 状态 | 形容词，正向，不带 `is` 前缀 | `open`、`hidden`、`disabled`、`selected`、`checked`、`readonly` |
| 用户可以做什么 | 对应的形容词 | `scrollable`、`zoomable`、`selectable`、`resizable` |
| 没有形容词的功能 | `<feature>Enabled` | `pagingEnabled` |
| 部件是否显示 | 以部件命名的布尔值，默认 `true` | `scrollbar`、`caret`（`scrollbar={false}`） |
| 插槽是否显示 | `<slot>Visible`，默认 `true` | `headerVisible`（`header` 是页面的插槽） |
| 部件的样式 | `<part>Class`、`<part>Style` | `backdropClass`、`contentStyle` |
| 状态的样式 | `<state>Style`、`<state>:` 类名 | `activeStyle`、`disabled:` |
| 插槽 | 它是什么 | `header`、`footer`、`trigger`、`content`、`empty` |
| 应用提供的内容 | `render<Part>` | `renderCodeBlock` |
| 关闭开关 | `closeOn<Trigger>`，默认 `true` | `closeOnEscape`、`closeOnBackdropPress` |
| 值的变化 | `on<Value>Change(next, details?)` | `onChange(text)`、`onOpenChange(open, reason)` |
| 其他事件 | `on<Event>`，现在时，一个对象 | `onPress()`、`onSubmit({ text })` |
| 阶段 | `<act>Start`、`<act>End` | `onPanStart`、`onLoadStart` |
| 指针位于视图上方 | `In` / `Out` | `onHoverIn`、`onHoverOut` |
| 开始监听 | 返回 `() => void` | `keymap.bind(..)` |
| 环境中的值 | 访问器，旁边是 `set<Value>` | `colorScheme()`、`setColorScheme` |
| 只读的布尔值 | `is<Adjective>`、`has<Noun>` | `isAvailable` |

props 从不使用 `is<Adjective>`：这种形式只用于只读的布尔值（常量、事件数据的字段）。显示的部件以部件本身命名，从不用
`<part>Shown`、`<part>Hidden` 或 `shows<Part>`。

Rust 构建器消费并返回 `Self`，以它设置的 prop 命名，不加 `set_`（`.disabled(..)`、`.checked(..)`、`.on_change(..)`）；
原地修改使用 `set_<field>`（`setRoutes`、`setColorScheme`）。布尔读取只有两种：值持有某物时用 `has<Noun>`，描述状态或许可时
用 `is<Adjective>`。只要动作有对应的形容词形式就用形容词：`isClosable` 而非 `canClose`，`isZoomable` 而非 `canZoom`。动作是
没有形容词形式的动词短语时，改为命名它所需要的东西：用 `hasDefinition`，不用 `canGoToDefinition`。不再新增 `can` 读取。

### 让外层名称承载上下文

名称总是在某个上下文中被阅读：prop 在它的组件中，字段在它的类型中。两者都不重复外层已经说明的内容（`contentStyle`，而不是
`contentContainerStyle`；`Dialog` 的 `backdropClass`，而不是 `dialogBackdropClass`）。同一类型的字段保持相同的缩写程度。

### 使用精确的领域词汇

- **selected** 是成员关系或当前条目；**checked** 和 **pressed** 是复选框或开关的值；**focused** 是键盘的目标；
  **hovered** 是指针的停留。永远不要混用。
- **open / close** 是浮层的状态；**show / hide** 是临时的请求；**expand / collapse** 是结构。
- **disabled** 阻止交互；**readonly** 允许选择和导航但不允许编辑；**loading** 在操作进行时防止重复工作。
- **press** 是任何输入方式的激活，NSH 的事件都用 press（`onPress`）；**click** 是鼠标的。
- **index** 是位置；**id** 是标识。不要按索引持久化可重排的数据，也不要用索引作它的键。
- **value** 是受控的领域数据；**state** 是保留下来的行为。
- **src** 是元素显示的资源（图片、视频、页面）；其他地址都是 **url**。
- **role** 说明一个选项的含义（`"cancel"`、`"destructive"`）；外观属于应用。

当存在更窄的领域术语时，避免 `data`、`item2`、`handleAction`、`updateUi`、`process`、`manager` 或 `config` 这类含糊的
名称。

### 类型与模块命名

- Rust 类型使用 `UpperCamelCase`；模块、函数、方法、字段和局部变量使用 `snake_case`；常量使用 `SCREAMING_SNAKE_CASE`。上下文
  绑定命名为 `cx`；
- TSX 组件及其标签使用 `PascalCase`；props、函数和局部变量使用 `camelCase`。原语从 `nsh` 导入，基础组件从 `nsh/base` 导入；
- 以组件命名的模块拥有它的公开接口；可以把它的状态、部件和测试拆到多个文件中，而不改变别人导入的内容；
- 单一组件概念使用单数模块名，组件族使用既有名称（`menu` 包含 `Menu`、`MenuItem` 和 `Submenu`）；
- 标识符后缀 `Id`，集合使用有意义的复数；同一子系统不混用 `idx`、`index`、`ix`；
- 谓词尽量正向命名；正向的状态比多重否定更容易组合，但与控件语义一致的既有术语（如 `disabled`）应保持不变。

### 回调与事件的措辞

- 值的变化先传值，其他内容放在后面：`onChange(next)`、`onOpenChange(open, reason)`。其他每个事件都传一个对象，即使只有一个
  字段（`onLinkPress({ url })`），这样以后增加字段只是一次添加；没有内容可报告的事件不传参数。
- 以动作命名，不用过去时，也不用请求：`onPress`、`onClose`、`onCancel`、`onBackPress`。
- 当动作有名字时，以意图而不是几何位置命名：`onLoadMore`，而不是“到达了末尾”。
- 生命周期成对使用 `onOpen` / `onClose`；阶段用 `Start` / `End`，从不用 `Begin`；指针位于视图上方是 `onHoverIn` /
  `onHoverOut`，文件拖过视图是 `Enter` / `Leave`。
- 在文档中说明回调是在组件自身状态变化之前还是之后运行，以及它是否可能重入组件。

### 文档与界面文案

公开文档先说明组件做什么、谁拥有它的状态。示例必须使用当前的 API 和稳定的 id。记录默认值、平台差异、焦点行为、回调顺序，以及
主线程原生读取哪些 props。

标签、命令、确认对话框、大小写和省略号遵循设计指南中的界面用词规范。每个领域对象、命令和状态使用一个固定术语。翻译键描述稳定
意图（`dialog.deleteProject.title`），不照抄源语言句子，也不包含屏幕上的位置。不要用翻译片段拼句子，也不能因为两个含义碰巧
有相同的英文就复用同一个键。

本地化的是意图，不是句法。每种语言可以独立决定语序、复数、标点与所需的上下文。测试应发现缺失的键和不一致的固定术语；上下文
中的重复是否必要仍需人工判断。所有字符串都要放回真实组件，在代表性的内容、文本扩展和较大的字号下验证。

## 测试策略

使用能够证明行为的最低层（[测试](./testing-and-trace.md)）：

1. 纯测试：状态转换、格式化、解析、排序（对 crate 中函数的 `cargo test`，或针对 store 函数的测试文件）；
2. 无界面的应用测试：组件、事件与生命周期，使用真实的引擎、渲染器、布局和列表，以 60 Hz 的显示帧运行，在 `nsh test`
   （`nsh/test`）或 `cargo test`（`nsh_testing::Headless`）中；
3. 交互测试：焦点、键盘、指针、布局与渲染状态，执行用户的操作（`press`、`type`、`scroll`、`drag`、`keyboard.press`），
   在无界面环境和真实平台上（`nsh test --target macos`、`ios`、`android`、`web` 等）；
4. 示例或应用的冒烟测试：完整流程；`nsh test --trace` 用于了解一次交互的开销。

```rust tabs
#[test]
fn a_tap_counts() {
    let mut app = Headless::start(EngineConfig::new(Root::of::<my_app::App>())).unwrap();
    app.wait_for("Count: 0").unwrap();
    app.press("Tap").unwrap();
    app.wait_for("Count: 1").unwrap();
}
```

```tsx tabs
import { expect, open, test } from "nsh/test";

test("a tap counts", async () => {
  const app = await open("./App.tsx");
  await app.press("role:button[Tap]");
  expect(app.texts()).toContain("Count: 1");
});
```

交互组件测试语义契约，而非实现细节：按压与键盘激活、受控值的变化、禁用、焦点移动、事件的数量和顺序、稳定标识、关键的空状态和
失败状态。模拟网络（`network` 路由）并控制时间（手动时钟），而不是等待真实的网络和时间。缺陷可稳定复现时，修复前先加回归测试。

像用户那样查找视图：按角色和名称、标签或文本（`role:button[Save]`、`label:Close`），在没有其他名称时使用稳定的 `testID`。
选择器在每一步都重新读取，所以一步操作永远不会作用在过期的快照上。截图（`app.screenshot`，在真实平台上）只验证选择器无法表达的
视觉事实；坐标是最后手段。自动化证据与人工证据分开报告。

## 性能规则

- 不能在读取某个状态的绑定或 effect 中无条件写入它；
- 不要在绑定或行函数中创建 signal、effect、按键绑定和昂贵的数据结构；
- 在绑定中读取 signal，让一次一致的修改只更新树中最窄的部分；
- 长集合使用 `List`，只渲染可见范围；
- 不为满足闭包而 clone 大的字符串或集合，捕获 `Copy` 的 handle 或共享数据（`SharedString`、`Rc`）；
- 保持 TSX 的处理函数和 computed 值轻量；把重活移出交互路径或改用 Rust；
- 加缓存前先用 `nsh test --trace` 测量，缓存必须有明确的失效归属者；
- 动画工作有界：用在 UI 线程上运行的动画值而不是每帧写入的 signal，用 `scrollValue` 而不是滚动监听
  （[动画](./animation.md)），并遵守减少动态效果的设置（`reduceMotion()`）。

## 常见失败模式

避免以下模式：

- 一个 signal 保存应用互不相关的状态；
- 很长的组件函数体中混入业务逻辑和网络请求；
- 可重排的内容使用随机或基于索引的 key；
- 每行的状态放在 `List` 行内创建的 signal 中；
- 在组件函数体中读取 prop 或 signal，却期望它会更新；
- 字面量颜色和圆角破坏自定义主题和深色模式；
- 已有语义组件时仍用可按压的自定义视图重做焦点、键盘、禁用和无障碍；
- 与受控值漂移的重复本地状态；
- 把一个 signal 复制到另一个 signal 的 effect，以及通过绑定循环的写入；
- 系统需要立即回答的决定交给回调，而不是事先设置的 prop；
- 没有归属者的嵌套滚动；
- 为一次性的页面新增组件变体；
- 可逆、低风险的操作也弹确认对话框；
- 测试只调用内部函数，从不按压、输入或滚动。

## 编码代理规则

修改前必须阅读与改动最相关的实现、测试、模块的公开导出和参考页面。必须在当前源码和 `.nsh/types` 中搜索签名，不能从
React、React Native、CSS 或 GPUI 的示例类比翻译：NSH 的组件只运行一次，绑定跟随它们读取的 signal。

每项改动都应能回答：

1. 行为归属者与表现归属者是谁；
2. 持久标识与状态生命周期是什么；
3. 按压、键盘、焦点、无障碍契约是什么；
4. 布局与滚动的归属者是谁；
5. 使用哪些主题 token，例外为何存在；
6. 哪个测试会在行为退化时失败。

生成代码必须经过人工评审与测试。“能编译”不是界面质量的标准；为了让生成代码看起来整洁而进行的大范围重构，也不能替代对应用
架构的匹配。

## 实现检查表

提交评审前，确认：

- 状态与副作用的归属是否明确；
- 普通函数与组件是否有意选择，props 和 signal 是否在使用处读取；
- 重复元素是否使用稳定的、基于领域的 key 和测试 id；
- 主题 token 与 Tailwind 刻度是否替代孤立的视觉字面量；
- 按压、键盘快捷键、焦点、禁用状态与浮层是否共同工作；
- 系统需要立即回答的决定是否是事先设置的 prop；
- 加载、空、错误、取消路径是否存在；
- 长数据是否使用 `List`，每个条目的状态是否放在数据中；
- 公开 API 的新增是否只做放宽，并保持依赖方向与封装；
- 测试是否在适当的层证明行为，既在无界面环境中，也在改动涉及的平台上；
- 格式化、Clippy、`nsh check`、针对性的测试与相关示例是否通过。

应用初始化请阅读[快速开始](./getting-started.md)，具体 API 以[元素](../elements/index.md)和[API](../modules/index.md)
参考页面为准。
