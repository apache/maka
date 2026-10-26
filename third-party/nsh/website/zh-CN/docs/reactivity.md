---
title: 响应式
description: Rust 与 TSX 中的 signal、computed、effect、resource、batch、untracked、cleanup 和 context：NSH 如何只更新真正变化的部分，以及需要避开的常见错误。
order: 31
group: ui
demo: guide-reactivity
---

# 响应式

NSH 用 **signal** 更新界面：signal 是知道谁在读取自己的值。signal 变化时，NSH 只重新运行读取了它的那些计算（一段文本、一个样式、一个 effect），其他一概不动。组件不会重新渲染。这套模型来自 Solid，而响应式图本身是原生实现的：Rust 组件和 TSX 运行在同一个用 Rust 编写的图上，所以在 TSX 中，调度、依赖跟踪和清理同样都在解释器之外完成。

Rust 组件从 prelude 中取得本页的所有内容；TSX 从 `nsh` 导入：

```rust tabs
use nsh_core::prelude::*;   // signal, computed, effect, resource, batch, untracked, cleanup, provide_context, use_context
```

```tsx tabs
import { batch, cleanup, computed, context, effect, resource, signal, untracked } from "nsh";
```

## signal

`signal(value)` 创建一个 signal。Rust 中用 `get()` 读取，TSX 中调用它来读取；用 `set` 和 `update` 写入：

```rust tabs
let count = signal(0);

count.get();                    // 0, and tracks the read
count.set(5);
count.update(|n| *n += 1);      // 6
```

```tsx tabs
const count = signal(0);

count();                     // 0, and tracks the read
count.set(5);
count.update((n) => n + 1);  // 6
```

在跟踪作用域（绑定、`computed`、`effect`）中读取，会让该作用域订阅这个 signal。写入时，如果值发生了变化就通知订阅者：Rust 中用 `PartialEq` 比较，TSX 中用 `===` 比较。

```rust tabs
fn counter() -> impl IntoElement {
    let count = signal(0);
    view()
        .on_press(move || count.update(|n| *n += 1))
        .child(text(move || format!("Tapped {} times", count.get())))
}
```

```tsx tabs
function Counter() {
  const count = signal(0);
  return (
    <View onPress={() => count.update((n) => n + 1)}>
      <Text>Tapped {count()} times</Text>
    </View>
  );
}
```

点击只会更新读取 `count` 的那一个文本节点。`counter()` / `Counter` 本身只运行一次。Rust 的 signal 是一个 `Copy` 句柄，闭包用 `move` 获取它即可随意使用。

signal 可以把每次写入都算作变化，TSX 还可以用自己的方式比较值：

```rust tabs
let tick = signal_with(0, SignalEquals::Never);   // every write notifies
```

```tsx tabs
const tick = signal(0, { equals: false });   // every write notifies
const position = signal({ x: 0, y: 0 }, { equals: (a, b) => a.x === b.x && a.y === b.y });
```

在 TSX 中，不带初始值的 `signal<T>()` 初始为 `undefined`，类型为 `Signal<T | undefined>`；在 Rust 中，用 `Option` 表达同样的意思（`signal(None::<User>)`）。

### 对象与数组

在 Rust 中，`update` 原地修改值并通知读取者；`set` 替换它。在 TSX 中，signal 用 `===` 比较，原地修改的值不算变化：请写入一个新的对象或数组。

```rust tabs
let todos = signal(Vec::<Todo>::new());

todos.update(|list| list.push(Todo { id: 3, title: "New".into(), done: false }));   // notifies
todos.update(|list| {
    if let Some(todo) = list.iter_mut().find(|t| t.id == id) {
        todo.done = true;
    }
});
```

```tsx tabs
const todos = signal<Todo[]>([]);

todos.update((list) => [...list, { id: 3, title: "New" }]);                 // notifies
todos.update((list) => list.map((t) => (t.id === id ? { ...t, done: true } : t)));

todos().push(item);    // does not notify anyone
todos.set(todos());    // still the same array: no change
```

`each` / `<Each>` 按条目为行设置 key，所以修改一个条目只会重建那一行（[JSX 与组件](./jsx-and-components.md#控制流)）。

## computed

`computed(fn)` 从其他 signal 派生出一个值。它运行 `fn`、记住结果，并在它读取的 signal 变化时重新运行。读取它和读取 signal 一样：

```rust tabs
let price = signal(12);
let quantity = signal(2);
let total = computed(move || price.get() * quantity.get());

text(move || format!("Total: {}", total.get()))
```

```tsx tabs
const price = signal(12);
const quantity = signal(2);
const total = computed(() => price() * quantity());

<Text>Total: {total()}</Text>
```

当派生值在多处被读取，或者计算代价较高时，使用 `computed`：无论有多少读取者，每次变化它只运行一次，并且只有结果变化时才通知读取者。对于只读一次、计算便宜的值，一个普通闭包就够了：

```rust tabs
let label = move || format!("{} items", quantity.get());
text(label)
```

```tsx tabs
const label = () => `${quantity()} items`;
<Text>{label()}</Text>
```

在 TSX 中，`fn` 会收到上一次的值（第一次为 `undefined`），适合累积的值：

```tsx
const max = computed((prev: number | undefined) => Math.max(prev ?? 0, speed()));
```

## effect

`effect(fn)` 运行 `fn`，并在它读取的任一 signal 变化时再次运行。effect 用于副作用：记录日志、定时器、网络请求、对 [ref](./jsx-and-components.md#ref) 的命令式调用。

```rust tabs
#[derive(Debug, Clone, PartialEq, Props)]
pub struct SearchProps {
    /// What to search for.
    pub query: Prop<SharedString>,
}

#[component]
pub fn Search(props: SearchProps) -> impl IntoElement {
    let results = signal(Vec::<SharedString>::new());
    effect(move || {
        let q = props.query.get();          // tracked: runs again when the prop changes
        if q.is_empty() {
            return;
        }
        spawn(async move {
            if let Ok(response) = fetch(format!("https://api.example.com/search?q={q}")).await {
                results.set(response.text().lines().map(|line| SharedString::from(line.to_owned())).collect());
            }
        });
    });
    view().child(each(results, |item| item.clone(), |item, _| text(item)))
}
```

```tsx tabs
function Search(props: { query: string }) {
  const results = signal<string[]>([]);
  effect(() => {
    const q = props.query;          // tracked: runs again when the prop changes
    if (!q) return;
    fetch(`https://api.example.com/search?q=${encodeURIComponent(q)}`)
      .then((r) => r.json())
      .then((data) => results.set(data.items));
  });
  return <Each of={results()}>{(item) => <Text>{item()}</Text>}</Each>;
}
```

effect 只跟踪它同步运行期间的读取。任务中、`.then` 回调中或 `await` 之后的读取不会被跟踪。

调用 [ref](./jsx-and-components.md#ref) 的 effect 作用于 ref 所在的元素；在 TSX 中，effect 在同一轮创建的元素都已存在之后运行，所以 ref 已经设置好：

```rust tabs
let input = element_ref();
effect(move || {
    if editing.get() {
        input.focus();
    }
});
```

```tsx tabs
let input: YNode | undefined;
effect(() => {
  if (editing()) input?.focus();
});
```

> [!TIP]
> 不要用 effect 让一个 signal 与另一个保持同步（`effect(() => b.set(a() * 2))`）。请用 `computed`：它永远不会过期，也不会多引起一轮更新。一个 effect 如果写入了它自己也在读取的 signal，就会一次又一次地重新运行，直到 NSH 报错将其停止。

## resource

`resource(source, fetcher)` 异步加载一个值，并记录加载进行到哪一步，组件因此可以直接显示数据、加载指示或错误，而不必自己管理这些状态：

```rust tabs
let url = signal(SharedString::from("https://api.example.com/quote"));
let quote = resource(move || Some(url.get()), |url, _info| async move {
    let response = fetch(url.to_string()).await?;
    if !response.ok() {
        return Err(format!("HTTP {}", response.status()));
    }
    Ok(response.text())
});

view()
    .child(text(move || match (quote.get(), quote.error()) {
        (_, Some(error)) => format!("Failed: {error}"),
        (Some(quote), None) => quote,
        (None, None) => "Loading…".to_owned(),
    }))
    .child(text("Reload").on_press(move || quote.refetch()))
```

```tsx tabs
import { List, resource, signal, Text } from "nsh";

type Post = { id: number; title: string };

const url = signal("https://jsonplaceholder.typicode.com/posts?_limit=20");
const posts = resource(url, async (u, { signal }) => {
  const response = await fetch(u, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as Post[];
});

<If when={posts.error()}>
  <Text>Failed: {String(posts.error())}</Text>
</If>
<List
  each={posts() ?? []}
  refreshing={posts.state() === "refreshing"}
  onRefresh={posts.refetch}
>
  {(post) => <Text>{post().title}</Text>}
</List>
```

`source` 会被跟踪：每当它给出新值，`fetcher(value, info)` 就重新加载。在 Rust 中它是一个返回 `Option` 的闭包，`None` 表示不加载；在 TSX 中它是一个访问器（signal、函数）或一个值，`undefined`、`null` 或 `false` 表示不加载：适用于用户尚未登录或尚未选择任何内容的情况。没有 source 时，Rust 传入 `|| Some(())`，TSX 的 `resource(fetcher)` 只加载一次，调用 `fetcher(info)`。Rust 的 fetcher 返回 `Result`；TSX 的返回一个值或一个 promise，抛出异常即为失败。

| Rust | TSX | 含义 |
|---|---|---|
| `quote.get()` | `posts()` | 最新的值：第一次加载结束之前为空，重新加载期间和失败之后保留。 |
| `quote.loading()` | `posts.loading()` | 是否有加载正在进行。 |
| `quote.error()` | `posts.error()` | 上一次加载的错误，一旦某次加载得到值就清空。 |
| `quote.state()` | `posts.state()` | `Unresolved` / `"unresolved"`（没有要加载的内容）、`Pending`（第一次加载）、`Ready`、`Refreshing`（重新加载中，保留原值）、`Errored`。 |
| `quote.refetch()` | `posts.refetch()` | 用同一个 source 重新加载：重试、下拉刷新。 |
| `quote.mutate(value)` | `posts.mutate(value)` | 不经加载直接设置值（乐观更新），并清除错误。 |

Rust 的 resource 和 signal 一样是一个 `Copy` 句柄；TSX 的成员已绑定，所以 `onRefresh={posts.refetch}` 和 `const loading = posts.loading` 可以直接使用。

只有最新的一次加载有效。新的加载会放弃正在进行的那次，组件被移除时也一样；在 TSX 中，`info.signal` 会中止交给它的 `fetch`。被取代之后才结束的加载不会改变任何东西。`info.refetching` 表示这次加载是由 `refetch()` 发起的。Rust 的 `resource_with_value(value, source, fetcher)` 和 TSX 的 `{ initialValue }` 让 resource 从一开始就有值。

## cleanup

`cleanup(fn)` 注册 `fn`，它会在当前 effect 再次运行之前，或者所属组件或 effect 被移除时运行：

```rust tabs
effect(move || {
    if !running.get() {
        return;
    }
    let ticker = spawn(async move {
        loop {
            timer(Duration::from_millis(100)).await;
            tick();
        }
    });
    cleanup(move || ticker.cancel());   // before the next run, or on removal
});
```

```tsx tabs
function Clock() {
  const now = signal(Date.now());
  const id = setInterval(() => now.set(Date.now()), 1000);
  cleanup(() => clearInterval(id));       // when Clock is removed
  return <Text>{new Date(now()).toLocaleTimeString()}</Text>;
}

effect(() => {
  if (!running()) return;
  const id = setInterval(tick, 100);
  cleanup(() => clearInterval(id));       // before the next run, or on removal
});
```

在 Rust 中，任务、定时器和间隔（`spawn`、`set_timeout`、`set_interval`）本来就会随创建它们的所有者结束，所以视图自己的时钟不需要 cleanup：

```rust
use std::time::Duration;

use nsh_core::time::unix_ms;

fn clock() -> impl IntoElement {
    let now = signal(unix_ms());
    set_interval(Duration::from_secs(1), move || now.set(unix_ms()));   // 随 clock() 创建的视图一起结束
    text(move || format!("{:.0}", now.get() / 1000.0))
}
```

TSX 的 effect 也可以像 React 那样返回它的清理函数：`fn` 返回的函数与传给 `cleanup` 的函数在同样的时机运行。

```tsx
effect(() => {
  const id = setInterval(tick, 100);
  return () => clearInterval(id);
});
```

组件在不再被渲染时被移除：它所在的 `when` / `<If>` 分支被隐藏、它所在的 `each` / `<Each>` 行被删除，或者它所在的页面被弹出。它创建的一切（effect、computed 值、任务、清理函数、嵌套组件）都随之释放。

## batch

每次写入都会立即通知订阅者。要让多次写入算作一次变化，把它们包在 `batch` 中：依赖方只在最后一次写入之后运行一次。

```rust tabs
let save = move || {
    batch(|| {
        first_name.set(form.first.clone());
        last_name.set(form.last.clone());
        dirty.set(false);
    })
};
```

```tsx tabs
const save = () =>
  batch(() => {
    firstName.set(form.first);
    lastName.set(form.last);
    dirty.set(false);
  });
```

事件处理函数不会自动批处理：按压处理函数中的两次写入，会让读取这两个 signal 的 effect 运行两次。`batch` 返回其函数的返回值。

## untracked

`untracked(fn)` 运行 `fn`，但不订阅它读取的内容。在跟踪作用域中用它来读取一个值而不依赖它：

```rust tabs
effect(move || {
    let q = query.get();                          // runs again when query changes
    let filters = untracked(|| active_filters.get());   // read, but not a reason to run again
    search(q, filters);
});
```

```tsx tabs
effect(() => {
  const q = query();                     // runs again when query changes
  const filters = untracked(activeFilters); // read, but not a reason to run again
  search(q, filters);
});
```

Rust 的 `get_untracked()` 以同样的方式读取单个 signal。组件函数体本身就是不跟踪的：在那里读取 signal 只会读一次。

## context

context 是组件提供给它所渲染的一切内容（无论多深）的值。在 Rust 中，`provide_context(value)` 提供一个该类型的值，`use_context::<T>()` 查找最近的一个；在 TSX 中，`context(defaultValue)` 创建一个 context，调用它读取最近提供的值（或默认值），渲染 `<Ctx.Provider value>` 来提供值：

```rust tabs
#[derive(Clone, Copy)]
struct Dark(bool);

fn label(content: &'static str) -> impl IntoElement {
    let dark = use_context::<Dark>().is_some_and(|d| d.0);
    text(content).text_color(if dark { rgb(0xffffff) } else { rgb(0x1f2328) })
}

fn screen() -> impl IntoElement {
    provide_context(Dark(true));
    view().child(label("Hello"))
}
```

```tsx tabs
const Theme = context<"light" | "dark">("light");

function Label(props: { children: string }) {
  const theme = Theme();
  return <Text style={{ color: theme === "dark" ? "#ffffff" : "#1f2328" }}>{props.children}</Text>;
}

mount(() => (
  <Theme.Provider value="dark">
    <Label>Hello</Label>
  </Theme.Provider>
));
```

提供的值在查找时只读取一次。要提供会变化的东西，就提供一个 signal（或由 signal 组成的结构），并在绑定中读取它：

```rust tabs
#[derive(Clone, Copy)]
struct Accent(Signal<Hsla>);

#[component]
fn App() -> impl IntoElement {
    provide_context(Accent(signal(rgb(0x0969da).into())));
    view().child(swatch())
}

fn swatch() -> impl IntoElement {
    let Accent(accent) = use_context::<Accent>().expect("an accent");
    view()
        .w(px(40.0))
        .h(px(40.0))
        .bg(move || accent.get())
        .on_press(move || accent.set(rgb(0x8250df).into()))
}
```

```tsx tabs
const Accent = context(signal("#0969da"));

function App() {
  const accent = signal("#0969da");
  return (
    <Accent.Provider value={accent}>
      <Swatch />
    </Accent.Provider>
  );
}

function Swatch() {
  const accent = Accent();
  return <View onPress={() => accent.set("#8250df")} style={{ width: 40, height: 40, backgroundColor: accent() }} />;
}
```

请在组件函数体中（或在组件创建期间运行的代码中）读取 context，而不是在事件处理函数或定时器中读取：那里没有可供查找的组件。Rust 组件也是这样取得应用主题的：`nsh_base` 的 `theme()`（[主题](./rust.md#主题)）。

## 错误边界

错误边界把视图中某一部分的失败限制在这一部分之内。它下面的代码在渲染或运行时抛出异常（Rust 中为 panic），例如组件函数体、绑定、effect 或事件处理函数，失败的部分会被移除，错误边界在原处显示它的 fallback；视图的其余部分保持不变。Rust 中使用 `catch_error(view, fallback)`；TSX 中使用 `nsh` 的 `<ErrorBoundary fallback>`。fallback 得到错误（TSX 中就是抛出的值本身，通常是一个 `Error`）和一个重新渲染视图的 reset：

```rust tabs
fn profile_card(user: Signal<Option<User>>) -> impl IntoElement {
    catch_error(
        move || profile(user),
        |error, reset| {
            view()
                .child(text(format!("Something went wrong: {error}")))
                .child(text("Try again").on_press(move || reset.reset()))
        },
    )
}
```

```tsx tabs
import { ErrorBoundary, Text, View } from "nsh";

function ProfileCard(props: { user: User | undefined }) {
  return (
    <ErrorBoundary
      fallback={(error, reset) => (
        <View>
          <Text>Something went wrong: {error instanceof Error ? error.message : String(error)}</Text>
          <Text onPress={reset}>Try again</Text>
        </View>
      )}
    >
      <Profile user={props.user} />
    </ErrorBoundary>
  );
}
```

失败交给发生处上方最近的错误边界，fallback 中的失败交给再上一层的错误边界。没有错误边界时，失败作为未捕获的错误报告（开发时的错误浮层、日志）。TSX 中不带参数的 `fallback` 按原样显示：`fallback={<Text>Unavailable</Text>}`。

## 什么会运行，何时运行

| 你写的 | 何时运行 | 何时再次运行 |
|---|---|---|
| 组件函数体 | 创建时运行一次 | 从不（热重载除外） |
| 绑定：Rust 中交给 `text`、样式或 prop 的闭包；TSX 中调用函数或读取属性的 `{expr}` 或 `prop={expr}` | 元素创建时运行一次 | 它读取的 signal 变化时；只更新那一个 prop 或子节点 |
| `computed(fn)` | 创建时 | 它读取的 signal 变化时 |
| `effect(fn)` | 当前这一轮的元素都已存在之后 | 它读取的 signal 变化时 |
| `when(cond, ..)` / `<If when>` | 创建时 | 条件是否成立发生变化时 |
| `each(..)` / `<Each of>` 的行 | 它的 key 第一次出现时 | 从不；改为由条目和索引的 signal 变化 |

环境同样是响应式的：Rust 中的 `window()`、`dark()`、`font_scale()`、`safe_area()` 和 `keyboard_height()`，TSX 中 [`nsh` 的设备 API](../modules/nsh.md#device) 的 `windowSize()`、`colorScheme()`、`fontScale()` 以及 [`nsh`](../modules/nsh.md) 的 `safeArea()` 和 `keyboardFrame()`，读取它们的绑定会跟随屏幕旋转、深色模式或键盘变化。

## 常见错误

**在组件函数体中读取 signal 并期待它更新。**

```rust tabs
fn bad() -> impl IntoElement {
    let n = count.get();                       // read once
    text(format!("{n}"))                       // never changes
}

fn good() -> impl IntoElement {
    text(move || format!("{}", count.get()))   // a binding: follows count
}
```

```tsx tabs
function Bad() {
  const n = count();           // read once
  return <Text>{n}</Text>;     // never changes
}

function Good() {
  return <Text>{count()}</Text>;
}
```

**只读取一次 props。** 在 Rust 组件函数体中用 `props.title.get()` 读取的 prop 只读一次；请在绑定中读取它（`text(props.title)`、`move || props.title.get()`）。在 TSX 中，`const { title } = props` 只会读取一次 `title`：请在使用的地方读取 `props.title`，或用 [`split`](./jsx-and-components.md#展开-props) 拆分 props。

**在 TSX 中原地修改而不是重新设置。** `list().push(x)` 改变了数组，却不会通知任何人。请写入一个新数组，Rust 的 `update` 则会替你通知。

**用 effect 派生状态。** `effect(() => total.set(price() * qty()))` 能工作，但在写入和 effect 运行之间 `total` 是过期的，还要多付出一轮更新的代价。请使用 `computed`。

**在组件之外创建 effect。** effect 和 computed 值属于创建它们的组件，并随组件一起释放。如果在事件处理函数或定时器回调中创建，它们没有所有者，会永远存在。请在组件函数体中创建，让它们去读取会变化的 signal。

**期待异步代码被跟踪。** 只有 effect 或 computed 值运行期间同步发生的读取才会被跟踪。先读取 signal，再开始异步工作。

## 相关内容

- [JSX 与组件](./jsx-and-components.md)：Rust 与 TSX 中的组件、props、`when` / `<If>` 和 `each` / `<Each>`。
- [用 Rust 开发](./rust.md)：Rust 应用、任务和主题。
- [`nsh` 模块参考](../modules/nsh.md)：每个 TSX 函数的签名。
- [动画](./animation.md)：不经过 signal、在 UI 线程上运行动画的动画值。
