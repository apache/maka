---
title: JSX 与组件
description: NSH 如何用 Rust 和 TSX 描述界面：元素、组件、props、children、控制流、ref 和展开，以及 JSX 编译器和 Rust 的构建方法如何生成同样的原生元素。
order: 30
group: ui
demo: guide-components
---

# JSX 与组件

NSH 应用用元素和组件描述界面，可以用 Rust，也可以用 TSX。Rust 用函数和带类型的构建方法创建元素（`view().gap_4().child(..)`）；TSX 把它们写成 JSX，NSH 的编译器把 JSX 转成对同一个原生渲染器的直接调用，没有 React，也没有虚拟 DOM。无论哪种写法，组件都是只运行一次、用来构建自己那部分树的函数。之后让界面保持最新的是[响应式](./reactivity.md)：读取 signal 的绑定由原生代码跟踪，只有它们会重新运行。

## 元素

**宿主元素**各自对应一个原生视图。Rust 用 prelude 中的函数创建它们；TSX 把它们作为组件从 `nsh` 导入，只有 `If` 和 `Each` 是无需导入的全局组件：

| Rust | TSX | 原生视图 | 页面 |
|---|---|---|---|
| `view()` | `<View>` | `UIView` / `ViewGroup`：用于布局、样式和触摸的盒子 | [View](../elements/view.md) |
| `text(..)` | `<Text>` | 原生文本视图；嵌套的文本元素是其中的片段（span） | [Text](../elements/text.md) |
| `image(src)` | `<Image>` | 图片视图（本地资源和 URL） | [Image](../elements/image.md) |
| `scroll()` | `<Scroll>` | `UIScrollView` / `ScrollView` | [Scroll](../elements/scroll.md) |
| `input()` | `<Input>` | `UITextField` / `UITextView` / `EditText` | [Input](../elements/input.md) |
| `virtual_list(count, row)` | `<List>` | 虚拟化、可复用单元格的列表 | [List](../elements/list.md) |
| `canvas(..)`、`web_view(url)`、`video(url)` | `<Canvas>`、`<WebView>`、`<Video>` | 绘图、网页、视频播放器 | [元素](../elements/index.md) |
| `nsh_base::dialog()` | 来自 `nsh/base` 的 `<Dialog>` | 弹出层 | [元素](../elements/index.md) |
| `when(..)`、`each(..)` | `<If>`、`<Each>` | 控制流，本身不产生视图 | [控制流](../elements/control-flow.md) |

```rust tabs
use nsh_core::prelude::*;   // view, text, image, scroll, input, virtual_list, ..., when, each
```

```tsx tabs
import { Image, mount, Text, View } from "nsh";
```

在 Rust 中，样式是与 Tailwind 工具类同名的带类型方法（`.px_4()`、`.rounded_lg()`、`.bg(..)`），监听器也是方法（`.on_press(..)`）；仅限某个平台的设置有各自的方法。在 TSX 中，props 保留 camelCase 命名（`onPress`、`numberOfLines`、`backgroundColor`）；每个元素都接受 `style`、`class` / `classList`（[Tailwind](./tailwind.md)）、`ref`、触摸处理函数、无障碍属性和 `testID`，仅限某个平台的 props 放在 `ios={{…}}` 和 `android={{…}}` 中，只有当前平台的对象会被发送：

```rust tabs
view()
    .rounded(px(12.0))
    .bg(move || theme().background)
    .on_press(move || open.set(true))
    .child(text("Open").font_weight(FontWeight::SEMIBOLD))
```

```tsx tabs
<View android={{ elevation: 4, ripple: { color: "#0001" } }} style={{ borderRadius: 12 }} onPress={() => open.set(true)}>
  <Text style={{ fontWeight: "600" }}>Open</Text>
</View>
```

TSX 标签使用 PascalCase，是为了让 TypeScript 按每个标签所指的绑定来检查它：小写标签只能对照每个名称一个的全局类型来检查，于是 `List`、`Each` 这类泛型组件无法从 `each` / `of` 推断出行的类型，应用自己的组件也完全没有类型。这些导入在运行时没有任何开销：编译器通过导入（包括别名）识别原语并就地创建原生元素，所以 `<View>` 是对渲染器的直接调用，导入会从 bundle 中去掉。小写标签会导致构建错误，错误信息会告诉你应该怎么写：

```text
x lowercase tag <view>: tags are PascalCase components: write <View> and
| `import { View } from "nsh"`
```

> [!IMPORTANT]
> 文本只有放在文本元素中才会显示：Rust 中是 `text(..)`，TSX 中是 `<Text>`。直接写在 `<View>` 里的字符串不会创建原生视图，也不会显示。

## 组件

应用的外观由应用自己决定。NSH 提供两层：基础元素（上面的元素、样式、Tailwind 类）和 [`nsh/base`](../modules/nsh-base.md)（Rust 中是 `nsh_base`）中无样式的基础组件，后者负责导航、对话框、键盘、状态栏、安全区域等行为。第三层组件库属于你：按钮、卡片以及界面的其他部分，都是你在这两层之上编写的组件，写在应用的 crate 中（[用 Rust 开发](./rust.md)）或用 TSX 编写，也可以是社区提供的组件库（[三层结构](./architecture.md#三层结构)）。

Rust 组件是一个 `#[component] fn`，接收它的 props 结构体（有事件时还接收一个用来发出事件的 `Scope`），返回它的元素。`#[component]` 还会生成它的构造函数，即函数名的蛇形写法：`Badge` 用 `badge()` 放置，就像 `view()` 放置一个视图，每个 prop 一个设置方法（`.label(..)`、`.color(..)`：值、signal 或闭包）。TSX 组件是一个接收 props 对象并返回 JSX 的函数：

```rust tabs
#[derive(Debug, Clone, PartialEq, Props)]
pub struct BadgeProps {
    /// The text.
    pub label: Prop<SharedString>,
    /// The background (light blue when left out).
    #[prop(default = Hsla::from(rgb(0xddf4ff)))]
    pub color: Prop<Hsla>,
}

/// A small rounded label.
#[component]
pub fn Badge(props: BadgeProps) -> impl IntoElement {
    view()
        .rounded_full()
        .px(px(10.0))
        .py_1()
        .bg(move || props.color.get())
        .child(text(props.label).text_size(px(13.0)).font_weight(FontWeight::SEMIBOLD))
}

// Placed in another component's view:
badge()
    .label(move || format!("{} new", unread.get()))
    .color(rgb(0xfff8c5))
```

```tsx tabs
function Badge(props: { label: string; color?: string }) {
  return (
    <View style={{ borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, backgroundColor: props.color ?? "#ddf4ff" }}>
      <Text style={{ fontSize: 13, fontWeight: "600" }}>{props.label}</Text>
    </View>
  );
}

<Badge label={`${unread()} new`} color="#fff8c5" />
```

函数只在组件创建时运行**一次**，并且不跟踪它读取的内容：不存在重新渲染。函数体中的代码（创建 signal、启动 effect、计算常量）只运行一次。它返回的元素会和它们读取的 props 与 signal 保持关联，所以上面的 `Badge` 会在 `unread` 变化时更新文本，而不必再次运行 `Badge`。

当界面有自己的 props 或事件，或者 TSX 入口要导入它时，写成 `#[component]`：Rust 组件按类型注册（`registry.register::<Badge>()`），props 的类型由结构体生成（[用 Rust 开发](./rust.md#用-tsx-扩展-rust-应用)）。只在 Rust 中使用的一段界面，用一个返回 `impl IntoElement` 的普通函数就够了，它的参数就是 props。在 TSX 中，组件可以返回元素、字符串或数字、数组、`null`，或者返回上述任意值的函数（渲染器会跟踪它）；`nsh` 中的 `Component<P>` 类型描述了这样的组件：

```rust tabs
fn row(title: impl Into<SharedString>, content: impl IntoElement) -> impl IntoElement {
    view()
        .flex_row()
        .gap_2()
        .child(text(title.into()))
        .child(content)
}
```

```tsx tabs
import type { Component, JSX } from "nsh";
import { Text, View } from "nsh";

const Row: Component<{ title: string; children?: JSX.Element }> = (props) => (
  <View style={{ flexDirection: "row", gap: 8 }}>
    <Text>{props.title}</Text>
    {props.children}
  </View>
);
```

### 哪些会重新运行

交给元素的值只设置一次；绑定会跟随它读取的内容。在 Rust 中，绑定是在需要值的地方传入的闭包（或 signal、memo、prop）。在 TSX 中，编译器为 JSX 中的每个表达式做判断：**调用了函数或读取了属性**（嵌套函数之外）的表达式会变化，其他的只设置一次：

```rust tabs
text(move || format!("{}", count.get()))     // follows count
text(props.title)                            // follows the prop
text(label.clone())                          // a plain value: set once
view().opacity(move || if busy.get() { 0.5_f32 } else { 1.0 })   // follows busy
```

```tsx tabs
<Text>{count()}</Text>              // follows count
<Text>{props.title}</Text>          // follows the prop
<Text>{user.name}</Text>            // re-read when something it depends on changes
<Text>{label}</Text>                // a plain variable: set once
<View style={{ opacity: busy() ? 0.5 : 1 }} />   // the style object is rebuilt when busy changes
```

会变化的 prop 或子节点是一个小的原生 effect，只设置那一个 prop 或替换那一个子节点。样式在 Rust 中做差异比较，所以变化的样式只会发送变化了的属性。

事件处理函数只设置一次：Rust 中是闭包，TSX 中是函数或名称（`onPress={() => …}`、`onPress={save}`）。在 TSX 中，其他表达式会被跟踪（`onPress={props.onPress}` 会跟随该 prop）。

### props

Rust 组件的 props 是它的 `#[derive(Props)]` 结构体的字段，每个都是一个 `Prop<T>`：一个值，或者父组件传入的绑定。在绑定中读取它（`text(props.title)`、`move || props.title.get()`）就会跟随它；在函数体中用 `props.title.get()` 只读取一次。带 `#[prop(default)]` 或 `#[prop(default = …)]` 的字段以及 `Option` 字段是可选的。构造函数让每个 prop 从默认值开始，父组件调用需要的 prop 的设置方法：`badge().label("New")`。

TSX 中被赋予变化表达式的 prop 以 getter 的形式传入：读取 `props.title` 就是调用它，这正是读取它的 JSX 能够跟随它的原因。静态 props 是普通值。两种写法都应该在使用 props 的地方读取它：

```rust tabs
// Wrong: reads the prop once, when the component runs.
#[component]
fn Title(props: TitleProps) -> impl IntoElement {
    let content = props.text.get();
    text(content)
}

// Right: binds the text to the prop.
#[component]
fn Title(props: TitleProps) -> impl IntoElement {
    text(props.text)
}
```

```tsx tabs
// Wrong: reads the prop once, when the component runs.
function Title(props: { text: string }) {
  const { text } = props;
  return <Text>{text}</Text>;
}

// Right: reads it in JSX, which follows it.
function Title(props: { text: string }) {
  return <Text>{props.text}</Text>;
}
```

在参数中解构 props 的 TSX 组件，`function Title({ text }: …)`，同样只读取一次，构建时会给出警告，并列出应该改为读取的 props：

```text
warn App.tsx:3:16: Title takes its props apart (`{ text }`): each is read once, when Title runs, and does not follow changes; take `props` and read `props.text` where it is used (`split(props, [...])` to pass the rest on)
```

只需要读取一次的 prop，比如组件启动时使用的 id，就在函数体中读取（`props.id.get_untracked()`、`const { id } = props;`），这样写也表明了意图。

在 TSX 中，默认值也是一样：在 JSX 中写 `props.color ?? "#ddf4ff"`，而不是用带默认值的解构。要从 props 计算出某个值，使用一个闭包或 [`computed`](./reactivity.md#computed)：

```rust tabs
#[component]
fn Price(props: PriceProps) -> impl IntoElement {
    let formatted = move || format!("${:.2}", props.cents.get() as f64 / 100.0);
    text(formatted)
}
```

```tsx tabs
function Price(props: { cents: number }) {
  const formatted = () => `$${(props.cents / 100).toFixed(2)}`;
  return <Text>{formatted()}</Text>;
}
```

### children

父组件放进组件里的内容作为它的 children 传入：Rust 中是一个 `children: Prop<Children>` 字段，父组件用 `.child(..)` 填充；TSX 中是 `props.children`，一个读取时才构建这些元素的 getter：

```rust tabs
#[derive(Debug, Clone, PartialEq, Props)]
pub struct CardProps {
    /// The title.
    pub title: Prop<SharedString>,
    /// The content.
    pub children: Prop<Children>,
}

#[component]
pub fn Card(props: CardProps) -> impl IntoElement {
    view()
        .p(px(14.0))
        .rounded(px(12.0))
        .bg(move || theme().background)
        .gap_2()
        .child(text(props.title).font_weight(FontWeight::SEMIBOLD))
        .child(props.children)
}

card()
    .title("Account")
    .child(text(move || format!("Signed in as {}", user.get().name)))
```

```tsx tabs
function Card(props: { title: string; children?: JSX.Element }) {
  return (
    <View style={{ padding: 14, borderRadius: 12, backgroundColor: "#ffffff", gap: 8 }}>
      <Text style={{ fontWeight: "600" }}>{props.title}</Text>
      {props.children}
    </View>
  );
}

<Card title="Account">
  <Text>Signed in as {user().name}</Text>
</Card>
```

在 TSX 中，每次读取 `props.children` 都会重新构建子元素（新的原生视图）：只在放置子元素的地方读取一次。多个子元素中，会变化的那个（`<If>`、`<Each>`、`{cond() ? a : b}`）以函数的形式传入，`{props.children}` 只更新它：它的兄弟元素保留各自的视图，输入框保留文字和焦点。Fragment（`<>…</>`）把元素组合在一起而不产生视图。

children 也可以由组件带参数调用的函数生成，即渲染回调：

```rust tabs
fn repeat<E: IntoElement>(times: usize, row: impl Fn(usize) -> E) -> impl IntoElement {
    view().child((0..times).map(row))
}

repeat(3, |i| text(format!("Row {i}")))
```

```tsx tabs
function Repeat(props: { times: number; children: (i: number) => JSX.Element }) {
  return <View>{Array.from({ length: props.times }, (_, i) => props.children(i))}</View>;
}

<Repeat times={3}>{(i) => <Text>Row {i}</Text>}</Repeat>
```

## 控制流

Rust 中的 `when` 和 `each`、TSX 中的 `<If>` 和 `<Each>` 是内置的控制流，本身不渲染视图。

```rust tabs
when(move || user.get().is_some(), move || {
    text(move || format!("Hello, {}", user.get().map(|u| u.name).unwrap_or_default()))
})
.otherwise(|| text("Signed out"))

each(todos, |todo| todo.id, |todo, index| {
    text(move || format!("{}. {}", index.get() + 1, todo.get().title))
})
```

```tsx tabs
<If when={user()} else={<Text>Signed out</Text>}>
  {(u) => <Text>Hello, {u().name}</Text>}
</If>

<Each of={todos()} key={(t) => t.id}>
  {(todo, index) => (
    <Text>
      {index() + 1}. {todo().title}
    </Text>
  )}
</Each>
```

- **`when`** / **`<If>`** 在条件成立时显示它的分支，否则显示 `otherwise` / `else` 分支。只有当条件是否成立发生变化时，才会重新渲染分支，而不是条件每次重新求值都渲染。在 TSX 中，函数形式的子元素会得到 `when` 值的访问器，其类型去掉了 `null` 和 `undefined`：分支显示期间 `u()` 就是该用户，并随之变化。
- **`each`** / **`<Each>`** 为每个条目渲染一行，由它的行函数生成。行按 key 保留（Rust：key 函数；TSX：`key`，默认是条目本身，对象按引用、原始值按值）：列表变化时，保留下来的行会被移动而不是重建，只为新的 key 创建新行。行函数收到条目及其索引的 **signal**（Rust 中是 `todo.get()` 和 `index.get()`，TSX 中是 `todo()` 和 `index()`），因为保留的行的条目和位置都可能变化。在 TSX 中，`key="index"`（或 `key={(item, i) => i}`）改为按位置保留行：原地变化的字符串列表（例如流式输入的文本）会保留它的行，只有 `item()` 变化。

在闭包中做出的选择（Rust 中的 `dynamic(move || if busy.get() { … } else { … })`，TSX 中的三元表达式或 `&&`）在它读取的任何内容变化时都会重新构建分支。分支包含较多元素时，优先使用 `when` / `<If>`。

长列表或无限列表请使用 [`List`](./lists.md)（Rust 中是 `virtual_list`）：它只为屏幕上的行创建视图并复用它们。详见[控制流](../elements/control-flow.md)。

## ref

ref 指向一个宿主元素，用于命令式调用：`focus()`、`blur()`、`scroll_to()` / `scrollTo()`、`scroll_to_index()` / `scrollToIndex()`、`measure()`（[视图在哪里](./touch-and-gestures.md)）等。在 Rust 中，`element_ref()` 创建一个 ref，`.element_ref(&handle)` 把它放到元素上；在 TSX 中，`ref` 给你元素的原生节点，即一个 `YNode`：

```rust tabs
fn search() -> impl IntoElement {
    let field = element_ref();
    view()
        .child(input().element_ref(&field).placeholder("Search"))
        .child(text("Focus").on_press(move || field.focus()))
}
```

```tsx tabs
import type { YNode } from "nsh";
import { Text, View } from "nsh";
import { Input } from "nsh/base";

function Search() {
  let input: YNode | undefined;
  return (
    <View>
      <Input ref={input} placeholder="Search" />
      <View onPress={() => input?.focus()}>
        <Text>Focus</Text>
      </View>
    </View>
  );
}
```

Rust 的 ref 是一个 `Copy` 句柄；它的调用发往携带它的元素，所有者不存在后不再有任何作用。在 TSX 中，`ref={…}` 所指的对象会收到节点：

- 用 `let` 声明的变量会被赋值；
- 字段（`ref={refs.input}`、`ref={refs[name]}`）会被赋值；
- [signal](./reactivity.md) 会被设置为该节点，读取这个 signal 的地方会随之更新；
- 函数会以节点为参数被调用（`<Scroll ref={(node) => (scroller = node)} />`）。

`const` 或导入的绑定应持有 signal 或函数，例如 `const input = signal<YNode>()` 配合 `<Input ref={input} />` 和 `input()?.focus()`；持有其他内容时，会在元素创建时报告，并说明应该怎么写。

ref 在元素创建时就被设置，早于组件返回，因此在 [effect](./reactivity.md#effect) 和事件处理函数中都可以使用。调用会按顺序发送给视图，排在它之前的修改之后。基础组件以及你自己 crate 中的 Rust 组件同样接受 `ref`（Rust 中是 `component_ref()`，用 `.component_ref(&r)` 放到元素上：`dialog().component_ref(&r)`）。

## 展开 props

在 Rust 中，父组件调用需要的 prop 的设置方法，其余保持默认，包装组件把自己的 `Prop` 原样传下去（`card().title(props.title)`）：`Prop` 会继续跟随它被赋予的内容。

在 TSX 中，用 `{...props}` 把一个 props 对象展开到元素或组件上。getter 仍然是 getter，所以展开的 props 会继续跟随它们读取的内容。要取出一部分 props 自己用、把其余的传下去，使用 `split`：

```tsx
import { split, Text, View } from "nsh";
import { Input, type InputProps } from "nsh/base";

function Field(props: InputProps & { label: string }) {
  const [own, rest] = split(props, ["label"]);
  return (
    <View style={{ gap: 4 }}>
      <Text>{own.label}</Text>
      <Input style={{ borderWidth: 1, borderRadius: 8, padding: 8 }} {...rest} />
    </View>
  );
}

<Field label="Email" value={email()} onChange={(t) => email.set(t)} keyboardType="email-address" />
```

`split(props, keys)` 返回 `[picked, rest]`，两者都仍然读取原始的 props（而解构 `{ label, ...rest } = props` 会把每个 prop 都读取一次）。JSX 中靠后的元素 props 会覆盖靠前的。

`<If>` 和 `<Each>` 不接受展开的 props，也不支持展开的子元素（`{...items}`）：请使用 `<Each>` 或数组表达式。

## 标签与名称

Rust 元素就是代码所调用的东西：基础元素的函数、组件的构造函数（`badge()`、`nsh_base::button()`），或你自己的函数。TSX 标签和平常一样指向作用域中的绑定：`<Badge />`、`<Theme.Provider>`、你自己的 `<Button>`。指向的名称不在作用域中的标签会导致构建错误，`<If>` 和 `<Each>` 除外，它们是全局组件。

```rust tabs
/// The app's button: a press target styled by the app.
fn primary_button(title: &'static str, on_press: impl Fn() + 'static) -> impl IntoElement {
    view()
        .role(AccessibilityRole::Button)
        .rounded_lg()
        .bg(rgb(0x2563eb))
        .px_5()
        .py_3()
        .active(|s| s.opacity(0.6))
        .on_press(on_press)
        .child(text(title).text_base().font_weight(FontWeight::SEMIBOLD).text_color(white()))
}

primary_button("Save", save)
```

```tsx tabs
import { Text, View } from "nsh";

function Button(props: { title: string; onPress: () => void }) {
  return (
    <View onPress={props.onPress} activeStyle={{ opacity: 0.6 }} role="button" class="rounded-lg bg-blue-600 px-5 py-3">
      <Text class="text-base font-semibold text-white">{props.title}</Text>
    </View>
  );
}

<Button title="Save" onPress={save} />
```

`nsh_base` 的 `Button`（Rust 中是 `button()`，`nsh/base` 中的 `<Button>`）是无样式的按压目标，带有禁用和选中状态及其无障碍信息；外观由应用提供：`button().disabled(move || saving.get()).on_press(move || save()).px_4().active(|s| s.opacity(0.6)).child(text("Save"))`。

在 TSX 中，你的绑定优先于全局组件：作用域中有名为 `Each` 的组件时，`<Each>` 就是那个组件。原语通过导入识别，所以 `import { View as Box } from "nsh"` 会让 `<Box>` 成为一个 view，而你自己名为 `Text` 的组件就只是你的组件。原语本身也是真正的组件：`const Tag = inline ? Text : View;`，然后 `<Tag>…</Tag>` 即可工作。

组件由它们自己的声明确定类型：Rust 的 props 结构体由编译器检查，TypeScript 在每个使用 TSX 组件的地方检查它的 props，不需要生成任何东西。TSX 入口导入的 Rust 组件会得到由其结构体生成的 TypeScript 声明。

## 挂载与根视图

Rust 应用的根是 `nsh.json` 的 `"root"` 指定的组件；`nsh run` 和 `nsh package` 挂载它。TSX 入口调用 `mount(App)` 渲染根组件（`mount(App, props)` 会传入 props）。根视图会填满整个界面（窗口，或应用用来嵌入 NSH 的视图）。给根视图设置 `flex: 1` 让它铺满屏幕，并设置背景色：界面自身的背景取决于平台。

```rust tabs
// nsh.json: { "rust": ".", "root": "App" }
#[component]
pub fn App() -> impl IntoElement {
    view()
        .flex_1()
        .bg(move || theme().background)
        .child(home())
}
```

```tsx tabs
mount(() => (
  <View style={{ flex: 1, backgroundColor: "#ffffff" }}>
    <App />
  </View>
));
```

## 相关内容

- [响应式](./reactivity.md)：signal、effect、context。
- [元素](../elements/index.md)：所有宿主元素及其 props。
- [样式](./styling.md)和 [Tailwind](./tailwind.md)：组件的外观。
- [用 Rust 开发](./rust.md)：Rust 应用、应用自己 crate 中的组件，以及在其上使用 TSX。
