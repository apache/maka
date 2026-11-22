---
title: If / Each
description: "Control flow: If renders a branch by a condition, Each renders a keyed row per item of a list, in Rust and TSX."
order: 140
group: primitives
demo: el-control-flow
---

# If / Each

`If` and `Each` decide which elements exist: conditional and repeated content. They make no native view of their own.
The native renderer updates only what changed: `If` swaps a branch when its condition flips, `Each` adds, moves and
removes rows by key instead of rebuilding the list. Rust has `when(..)`, `each(..)` and `dynamic(..)` in
`nsh_core::prelude`; TSX has `<If>` and `<Each>`, globals that need no import.

```rust tabs
use nsh_core::prelude::*;

view()
    .child(
        when(move || user.with(|u| u.is_some()), move || {
            text(move || format!("Hello, {}", user.with(|u| u.as_ref().map(|u| u.name.clone()).unwrap_or_default())))
        })
        .otherwise(|| text("Signed out")),
    )
    .child(each(todos, |t: &Todo| t.id, |todo, _index| text(move || todo.get().title)))
```

```tsx tabs
<View>
  <If when={user()} else={<Text>Signed out</Text>}>
    {(u) => <Text>Hello, {u().name}</Text>}
  </If>
  <Each of={todos()}>{(todo) => <Text>{todo().title}</Text>}</Each>
</View>
```

In TSX they are globals (a binding of the same name in scope takes their place). Inside JSX expressions you can still
use plain JavaScript (`cond ? a : b`, `items.map(…)`), and in Rust `dynamic(move || ..)`: those make their elements
again every time what they read changes, while `If` and `Each` (`when` and `each` in Rust) keep the elements that stay.

## If

Renders its branch while the condition holds, else the other branch (or nothing).

| Prop | Rust | Type | Description |
|---|---|---|---|
| `when` | `when(cond, ..)` | `T` | The condition: a value, a signal or a closure in Rust; in TSX its truthiness. |
| `else` | `.otherwise(\|\| ..)` | `JSX.Element` | Rendered while `when` does not hold. |
| `children` | `when(.., \|\| ..)` | `JSX.Element` \| `(value: () => NonNullable<T>) => JSX.Element` | Rendered while `when` holds. In TSX, a function gets an accessor of `when`'s value. |

A branch is made when the condition flips to it, and what it made goes when it flips away. A TSX `when` that goes from
one truthy value to another (`user()` changing from one object to another) keeps the branch, and the expressions inside
it update on their own.

```rust tabs
let loading = signal(true);

when(move || !loading.get(), || profile())
    .otherwise(|| text("Loading…").text_color(rgb(0x6e7781)))
```

```tsx tabs
const loading = signal(true);

<If when={!loading()} else={<Text style={{ color: "#6e7781" }}>Loading…</Text>}>
  <Profile />
</If>;
```

In TSX, a function child reads the value `when` gave, without `null` or `undefined` in its type, so the branch needs no
`!`. In Rust, the branch reads the signal itself, or `dynamic` maps the value to elements:

```rust tabs
let user = signal(None::<User>);

dynamic(move || user.get().map(|u| text(u.name)))
```

```tsx tabs
const user = signal<User | null>(null);

<If when={user()}>{(u) => <Text>{u().name}</Text>}</If>;
```

## Each

Renders a row for each item of a list.

| Prop | Rust | Type | Description |
|---|---|---|---|
| `of` | `each(items, ..)` | `readonly any[] \| null \| undefined` | The items: in Rust a `Vec`, a signal of one or a closure returning one. `null` and `undefined` render nothing. |
| `key` | `each(.., \|item\| key, ..)` | `(item: any) => unknown` | The identity of an item. TSX's default: the item itself (objects by identity, primitives by value). |
| `children` | `each(.., .., \|item, index\| row)` | `(item: () => any, index: () => number) => JSX.Element` | Renders one row. |

The row function gets **accessors**, not values: call `item()` and `index()` in TSX, `item.get()` and `index.get()` in
Rust (both are `ReadSignal`s). When the items change, rows whose key is still there are kept (and moved if their position
changed); their item and index update, and only the expressions reading them run again. New keys get new rows; rows
whose key is gone are removed.

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

### Choosing a key

- Items replaced by new objects on every update (immutable updates, `{ ...t, done: true }`) need a `key`, usually an id.
  Without it each new object is a new row and its elements are made again. Rust always takes a key.
- In TSX, arrays of strings or numbers work without a key: they are compared by value.
- Each row has its own owner: effects and cleanups created in a row end when the row is removed.

> [!NOTE]
> `Each` and `each` are generic: TypeScript infers the item type from `of`, and Rust from the items, so the row's `todo()` and
> the `key` parameter are typed without annotations.

## Each or a list

`Each` creates every row. That is right for tens or a few hundred items, in a view or a [scroll view](./scroll.md).
For long or unbounded data, use a [list](./list.md): it creates the rows near the viewport and recycles them.

See [JSX and components](../docs/jsx-and-components.md) and [reactivity](../docs/reactivity.md) for how expressions
update.
