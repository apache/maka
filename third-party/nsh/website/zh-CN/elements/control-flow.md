---
title: If / Each
description: 控制流：If 按条件渲染一个分支，Each 为列表的每一项渲染一个带 key 的行，附 Rust 与 TSX 示例。
order: 140
group: primitives
demo: el-control-flow
---

# If / Each

`If` 和 `Each` 决定哪些元素存在：条件内容和重复内容。它们自身不创建原生视图。原生渲染器只更新发生变化的部分：`If` 在条件翻转时切换分支，`Each` 按 key 增加、移动和删除行，而不是重建整个列表。Rust 在 `nsh_core::prelude` 中提供 `when(..)`、`each(..)` 和 `dynamic(..)`；TSX 提供 `<If>` 和 `<Each>`，它们是无需导入的全局组件。

```rust tabs
use nsh_core::prelude::*;

view()
    .child(
        when(move || user.with(|u| u.is_some()), move || {
            text(move || format!("你好，{}", user.with(|u| u.as_ref().map(|u| u.name.clone()).unwrap_or_default())))
        })
        .otherwise(|| text("未登录")),
    )
    .child(each(todos, |t: &Todo| t.id, |todo, _index| text(move || todo.get().title)))
```

```tsx tabs
<View>
  <If when={user()} else={<Text>未登录</Text>}>
    {(u) => <Text>你好，{u().name}</Text>}
  </If>
  <Each of={todos()}>{(todo) => <Text>{todo().title}</Text>}</Each>
</View>
```

在 TSX 中它们是全局组件（作用域中同名的绑定会取代它们）。在 JSX 表达式里仍然可以使用普通 JavaScript（`cond ? a : b`、`items.map(…)`），在 Rust 中则是 `dynamic(move || ..)`：这些写法会在其读取的值变化时重新创建元素，而 `If` 和 `Each`（Rust 中的 `when` 和 `each`）会保留不变的元素。

## If

条件成立时渲染其分支，否则渲染另一个分支（或什么都不渲染）。

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `when` | `when(cond, ..)` | `T` | 条件：在 Rust 中是值、signal 或闭包；在 TSX 中看它的真假。 |
| `else` | `.otherwise(\|\| ..)` | `JSX.Element` | `when` 不成立时渲染。 |
| `children` | `when(.., \|\| ..)` | `JSX.Element` \| `(value: () => NonNullable<T>) => JSX.Element` | `when` 成立时渲染。在 TSX 中写成函数时，会收到 `when` 值的访问器。 |

条件翻转到某个分支时才创建该分支，翻转离开时它创建的内容随之移除。TSX 中如果 `when` 从一个真值变成另一个真值（例如 `user()` 从一个对象变成另一个对象），分支会保留，其中的表达式各自更新。

```rust tabs
let loading = signal(true);

when(move || !loading.get(), || profile())
    .otherwise(|| text("加载中…").text_color(rgb(0x6e7781)))
```

```tsx tabs
const loading = signal(true);

<If when={!loading()} else={<Text style={{ color: "#6e7781" }}>加载中…</Text>}>
  <Profile />
</If>;
```

在 TSX 中，函数形式的子元素读取的是 `when` 给出的值，类型中不含 `null` 和 `undefined`，所以分支里不需要写 `!`。在 Rust 中，分支自己读取 signal，或者用 `dynamic` 把值映射为元素：

```rust tabs
let user = signal(None::<User>);

dynamic(move || user.get().map(|u| text(u.name)))
```

```tsx tabs
const user = signal<User | null>(null);

<If when={user()}>{(u) => <Text>{u().name}</Text>}</If>;
```

## Each

为列表中的每一项渲染一行。

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `of` | `each(items, ..)` | `readonly any[] \| null \| undefined` | 条目：在 Rust 中是 `Vec`、`Vec` 的 signal 或返回 `Vec` 的闭包。`null` 和 `undefined` 不渲染任何内容。 |
| `key` | `each(.., \|item\| key, ..)` | `(item: any) => unknown` | 条目的标识。TSX 中默认是条目本身（对象按引用比较，原始值按值比较）。 |
| `children` | `each(.., .., \|item, index\| row)` | `(item: () => any, index: () => number) => JSX.Element` | 渲染一行。 |

行函数拿到的是**访问器**而不是值：TSX 中调用 `item()` 和 `index()`，Rust 中调用 `item.get()` 和 `index.get()`（两者都是 `ReadSignal`）。条目变化时，key 仍然存在的行会被保留（位置变了就移动），它们的条目和索引会更新，只有读取它们的表达式会重新执行。新的 key 产生新行；key 消失的行被删除。

```rust tabs
#[derive(Clone, PartialEq)]
struct Todo {
    id: u32,
    title: String,
    done: bool,
}

let todos = signal(Vec::<Todo>::new());

each(todos, |t: &Todo| t.id, |todo, index| {
    view()
        .flex_row()
        .gap_2()
        .child(text(move || format!("{}.", index.get() + 1)))
        .child(
            text(move || todo.get().title)
                .style_when(move || todo.get().done, |s| s.line_through()),
        )
})
```

```tsx tabs
interface Todo {
  id: number;
  title: string;
  done: boolean;
}

const todos = signal<Todo[]>([]);

<Each of={todos()} key={(t: Todo) => t.id}>
  {(todo, index) => (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text>{index() + 1}.</Text>
      <Text style={{ textDecorationLine: todo().done ? "line-through" : "none" }}>{todo().title}</Text>
    </View>
  )}
</Each>;
```

### 如何选择 key

- 如果每次更新都用新对象替换条目（不可变更新，`{ ...t, done: true }`），就需要 `key`，通常是 id。否则每个新对象都是一个新行，其中的元素会被重新创建。Rust 总是接收一个 key。
- 在 TSX 中，字符串或数字数组不需要 key：它们按值比较。
- 每一行都有自己的 owner：在行中创建的 effect 和清理函数会在行被删除时结束。

> [!NOTE]
> `Each` 和 `each` 是泛型的：TypeScript 从 `of` 推断条目类型，Rust 从条目推断，所以行中的 `todo()` 和 `key` 的参数无需类型注解就有类型。

## Each 还是列表

`Each` 会创建每一行。对于几十到几百个条目，放在 view 或[滚动视图](./scroll.md)里正合适。对于很长或无上限的数据，请使用[列表](./list.md)：它创建视口附近的行并复用它们。

表达式如何更新，参见 [JSX 与组件](../docs/jsx-and-components.md) 和[响应式](../docs/reactivity.md)。
