---
title: Reactivity
description: Signals, computed values, effects, resources, batch, untracked, cleanup and context in Rust and TSX - how NSH updates exactly what changed, and the mistakes to avoid.
order: 31
group: ui
demo: guide-reactivity
---

# Reactivity

NSH updates the UI with **signals**: values that know who reads them. When a signal changes, NSH runs again exactly the computations that read it (a text, a style, an effect) and nothing else. Components do not re-render. The model is Solid's, and the reactive graph itself is native: Rust components and TSX run on the same graph, written in Rust, so in TSX too the scheduling, dependency tracking and cleanup all happen outside the interpreter.

Rust components take everything on this page from the prelude; TSX imports it from `nsh`:

```rust tabs
use nsh_core::prelude::*;   // signal, computed, effect, resource, batch, untracked, cleanup, provide_context, use_context
```

```tsx tabs
import { batch, cleanup, computed, context, effect, resource, signal, untracked } from "nsh";
```

## Signals

`signal(value)` makes a signal. Read it with `get()` in Rust, by calling it in TSX; `set` and `update` write it:

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

A read inside a tracking scope (a binding, `computed`, `effect`) subscribes that scope to the signal. A write notifies the subscribers when the value changed: compared with `PartialEq` in Rust, with `===` in TSX.

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

Tapping updates the one text node that reads `count`. `counter()` / `Counter` itself runs once. A Rust signal is a `Copy` handle, so closures take it with `move` and use it freely.

A signal can count every write as a change, and TSX can compare values its own way:

```rust tabs
let tick = signal_with(0, SignalEquals::Never);   // every write notifies
```

```tsx tabs
const tick = signal(0, { equals: false });   // every write notifies
const position = signal({ x: 0, y: 0 }, { equals: (a, b) => a.x === b.x && a.y === b.y });
```

In TSX, `signal<T>()` without a value starts as `undefined` and is typed `Signal<T | undefined>`; in Rust, an
`Option` says the same (`signal(None::<User>)`).

### Objects and arrays

In Rust, `update` changes the value in place and notifies the readers; `set` replaces it. In TSX, signals compare with `===`, so a value mutated in place is no change: write a new object or array.

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

`each` / `<Each>` keys rows by item, so changing one item rebuilds only that row ([JSX and components](./jsx-and-components.md#control-flow)).

## computed

`computed(fn)` derives a value from other signals. It runs `fn`, remembers the result, and runs it again when a signal it read changes. Reading it is like reading a signal:

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

Use `computed` when a derived value is read in several places or is expensive: it runs once per change however many readers it has, and readers are notified only when its result changes. For a cheap value read once, a plain closure is enough:

```rust tabs
let label = move || format!("{} items", quantity.get());
text(label)
```

```tsx tabs
const label = () => `${quantity()} items`;
<Text>{label()}</Text>
```

In TSX, `fn` receives the previous value (`undefined` the first time), for values that accumulate:

```tsx
const max = computed((prev: number | undefined) => Math.max(prev ?? 0, speed()));
```

## effect

`effect(fn)` runs `fn`, and again whenever a signal it read changes. Effects are for side effects: logging, timers, network requests, imperative calls on [refs](./jsx-and-components.md#refs).

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

An effect tracks the reads made while it runs synchronously. Reads in a task, a `.then` callback or after an `await` are not tracked.

An effect that calls a [ref](./jsx-and-components.md#refs) acts on the element the ref is on; in TSX, effects run after the elements created in the same pass exist, so refs are set:

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
> Do not use effects to keep one signal in sync with another (`effect(() => b.set(a() * 2))`). Use `computed`: it is never out of date and does not cause a second pass. An effect that writes a signal it also reads runs itself again and again until NSH stops it with an error.

## resource

`resource(source, fetcher)` loads a value asynchronously and keeps where the load is, so a component shows data, a spinner or an error without managing them itself:

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

`source` is tracked: whenever it gives a new value, `fetcher(value, info)` loads again. In Rust it is a closure returning an `Option`, and `None` loads nothing; in TSX it is an accessor (a signal, a function) or a value, and `undefined`, `null` or `false` load nothing: for a user not signed in yet or nothing picked. With no source, Rust passes `|| Some(())`, and TSX's `resource(fetcher)` loads once, calling `fetcher(info)`. The Rust fetcher returns a `Result`; the TSX one a value or a promise, and a throw is a failure.

| Rust | TSX | What it is |
|---|---|---|
| `quote.get()` | `posts()` | The latest value: none before the first load ends, kept while loading again and after a failure. |
| `quote.loading()` | `posts.loading()` | Whether a load runs. |
| `quote.error()` | `posts.error()` | The last load's error, none once a load gives a value. |
| `quote.state()` | `posts.state()` | `Unresolved` / `"unresolved"` (nothing to load), `Pending` (the first load), `Ready`, `Refreshing` (loading again, the value kept), `Errored`. |
| `quote.refetch()` | `posts.refetch()` | Loads again from the same source: a retry, a pull to refresh. |
| `quote.mutate(value)` | `posts.mutate(value)` | Sets the value here with no load, an optimistic update, and clears the error. |

A Rust resource is a `Copy` handle, as signals are; the TSX members are bound, so `onRefresh={posts.refetch}` and `const loading = posts.loading` work as they are.

Only the latest load counts. A new one drops the one running, and so does the component going away; in TSX, `info.signal` aborts the `fetch` it is given. A load that ends after it was superseded changes nothing. `info.refetching` says that `refetch()` started the load. `resource_with_value(value, source, fetcher)` in Rust and `{ initialValue }` in TSX give the resource a value from the start.

## cleanup

`cleanup(fn)` registers `fn` to run before the current effect runs again, or when the component or effect it belongs to goes away:

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

In Rust, tasks, timers and intervals (`spawn`, `set_timeout`, `set_interval`) already end with the owner they were made under, so a view's own clock needs no cleanup:

```rust
use std::time::Duration;

use nsh_core::time::unix_ms;

fn clock() -> impl IntoElement {
    let now = signal(unix_ms());
    set_interval(Duration::from_secs(1), move || now.set(unix_ms()));   // ends with the view clock() made
    text(move || format!("{:.0}", now.get() / 1000.0))
}
```

A TSX effect can also return its cleanup, as in React: a function `fn` returns runs at the same moments as one it passes to `cleanup`.

```tsx
effect(() => {
  const id = setInterval(tick, 100);
  return () => clearInterval(id);
});
```

A component goes away when it is no longer rendered: its `when` / `<If>` branch is hidden, its `each` / `<Each>` row is removed, or its page is popped. Everything it created (effects, computed values, tasks, cleanups, nested components) is disposed with it.

## batch

Each write notifies its subscribers right away. To make several writes count as one change, wrap them in `batch`: dependants run once, after the last write.

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

Event handlers are not batched for you: two writes in a press handler run an effect that reads both signals twice. `batch` returns what its function returns.

## untracked

`untracked(fn)` runs `fn` without subscribing to what it reads. Use it in a tracking scope to read a value without depending on it:

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

Rust's `get_untracked()` reads one signal the same way. A component body is already untracked: reading a signal there reads it once.

## context

A context is a value a component provides to everything it renders, however deep. In Rust, `provide_context(value)` provides a value of its type, and `use_context::<T>()` finds the nearest one; in TSX, `context(defaultValue)` makes a context, calling it reads the nearest provided value (or the default), and `<Ctx.Provider value>` provides one:

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

A provided value is read once, when it is looked up. To provide something that changes, provide a signal (or a struct of signals) and read it in a binding:

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

Read a context in a component body (or in code that runs while components are being created), not in an event handler or a timer, where there is no component to look it up from. Rust components also take the app's theme this way: `theme()` from `nsh_base` ([Theme](./rust.md#theme)).

## Error boundaries

An error boundary keeps a failure in one part of a view to that part. When something under it throws (Rust: panics) while it renders or runs, such as a component's body, a binding, an effect or an event handler, the failed part is removed and the boundary shows its fallback in its place; the rest of the view stays as it is. In Rust it is `catch_error(view, fallback)`; in TSX, `<ErrorBoundary fallback>` from `nsh`. The fallback gets the error (in TSX the thrown value itself, usually an `Error`) and a reset that renders the view again:

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

A failure goes to the nearest boundary above where it happened, and one in a fallback to the boundary above that. Without a boundary, the failure is reported as an uncaught error (the development error overlay, the log). In TSX, a `fallback` that takes no arguments is shown as it is: `fallback={<Text>Unavailable</Text>}`.

## What runs, and when

| You write | Runs | Runs again when |
|---|---|---|
| Component body | Once, when it is created | Never (hot reload aside) |
| A binding: a closure given to `text`, a style or a prop in Rust; `{expr}` or `prop={expr}` that calls or reads a property in TSX | Once, when the element is created | A signal it read changes; only that prop or child is updated |
| `computed(fn)` | When created | A signal it read changes |
| `effect(fn)` | After the elements of the current pass exist | A signal it read changes |
| `when(cond, ..)` / `<If when>` | When created | Whether the condition holds changes |
| `each(..)` / `<Each of>` row | When its key first appears | Never; its item and index signals change instead |

The environment is reactive the same way: `window()`, `dark()`, `font_scale()`, `safe_area()` and `keyboard_height()` in Rust, `windowSize()`, `colorScheme()` and `fontScale()` from [`nsh`](../modules/nsh.md#device) and `safeArea()` and `keyboardFrame()` from [`nsh`](../modules/nsh.md) in TSX, so bindings that read them follow rotation, dark mode or the keyboard.

## Common mistakes

**Reading a signal in the component body and expecting updates.**

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

**Reading props once.** A Rust prop read with `props.title.get()` in the body is read once; read it in a binding (`text(props.title)`, `move || props.title.get()`). In TSX, `const { title } = props` reads `title` once: read `props.title` where you use it, or split props with [`split`](./jsx-and-components.md#spreading-props).

**Mutating instead of setting, in TSX.** `list().push(x)` changes the array but notifies nobody. Write a new array, as Rust's `update` does for you.

**Deriving state with effects.** `effect(() => total.set(price() * qty()))` works, but leaves `total` stale between the write and the effect, and costs a second pass. Use `computed`.

**Creating effects outside components.** Effects and computed values belong to the component that created them and are disposed with it. Created in an event handler or a timer callback, they have no owner and live forever. Create them in a component body and let them read the signals that change.

**Expecting asynchronous code to be tracked.** Only reads made synchronously while an effect or computed value runs are tracked. Read the signals first, then start the asynchronous work.

## Related

- [JSX and components](./jsx-and-components.md): components, props, `when` / `<If>` and `each` / `<Each>`, in Rust and TSX.
- [Building with Rust](./rust.md): Rust apps, tasks and the theme.
- [`nsh` module reference](../modules/nsh.md): every TSX function's signature.
- [Animation](./animation.md): animated values that animate on the UI thread without signals.
