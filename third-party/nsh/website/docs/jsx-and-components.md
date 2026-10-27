---
title: JSX and components
description: How NSH describes UI in Rust and in TSX - elements, components, props, children, control flow, refs and spreads - and how the JSX compiler and Rust's builders make the same native elements.
order: 30
group: ui
demo: guide-components
---

# JSX and components

NSH apps describe their UI with elements and components, in Rust or in TSX. Rust builds elements with functions and typed builder methods (`view().gap_4().child(..)`); TSX writes them as JSX, which NSH's compiler turns into direct calls of the same native renderer, with no React and no virtual DOM. Either way, a component is a function that runs once to build its part of the tree. What keeps the UI up to date afterwards is [reactivity](./reactivity.md): the bindings that read signals are followed natively, and only they run again.

## Elements

The **host elements** are each backed by a native view. Rust makes them with the prelude's functions; TSX imports them from `nsh` as components, and only `If` and `Each` are globals that need no import:

| Rust | TSX | Native view | Page |
|---|---|---|---|
| `view()` | `<View>` | `UIView` / `ViewGroup`: a box for layout, styling and touches | [View](../elements/view.md) |
| `text(..)` | `<Text>` | A native text view; nested text elements are spans | [Text](../elements/text.md) |
| `image(src)` | `<Image>` | An image view (local assets and URLs) | [Image](../elements/image.md) |
| `scroll()` | `<Scroll>` | `UIScrollView` / `ScrollView` | [Scroll](../elements/scroll.md) |
| `input()` | `<Input>` | `UITextField` / `UITextView` / `EditText` | [Input](../elements/input.md) |
| `virtual_list(count, row)` | `<List>` | A virtualized, recycling list | [List](../elements/list.md) |
| `canvas(..)`, `web_view(url)`, `video(url)` | `<Canvas>`, `<WebView>`, `<Video>` | A drawing, a web page, a video player | [Elements](../elements/index.md) |
| `nsh_base::dialog()` | `<Dialog>` from `nsh/base` | A presented layer | [Elements](../elements/index.md) |
| `when(..)`, `each(..)` | `<If>`, `<Each>` | Control flow, no view of its own | [Control flow](../elements/control-flow.md) |

```rust tabs
use nsh_core::prelude::*;   // view, text, image, scroll, input, virtual_list, ..., when, each
```

```tsx tabs
import { Image, mount, Text, View } from "nsh";
```

In Rust, styles are typed methods named as Tailwind's utilities are (`.px_4()`, `.rounded_lg()`, `.bg(..)`), and
listeners are methods too (`.on_press(..)`); platform-only settings have methods of their own. In TSX, props keep
their camelCase names (`onPress`, `numberOfLines`, `backgroundColor`); every element accepts `style`, `class` /
`classList` ([Tailwind](./tailwind.md)), `ref`, touch handlers, accessibility props and `testID`, and platform-only
props go in `ios={{…}}` and `android={{…}}`, where only the current platform's object is sent:

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

TSX tags are PascalCase so that TypeScript checks each one against the binding it names: a lowercase tag is checked against one global type per name, so a generic component such as `List` or `Each` could not infer its rows' type from `each` / `of`, and an app's own components would not be typed at all. The imports cost nothing at run time: the compiler recognizes the primitives through their imports (aliases too) and makes the native element in place, so `<View>` is a direct call of the renderer and the import is dropped from the bundle. A lowercase tag is a build error that says what to write:

```text
x lowercase tag <view>: tags are PascalCase components: write <View> and
| `import { View } from "nsh"`
```

> [!IMPORTANT]
> Text is only displayed inside a text element: `text(..)` in Rust, `<Text>` in TSX. A string directly in a `<View>` creates no native view and is not shown.

## Components

The look of an app is the app's own. NSH provides two layers: the primitives (the elements above, styles, Tailwind classes) and the unstyled base components of [`nsh/base`](../modules/nsh-base.md) (`nsh_base` in Rust), which own behavior such as navigation, dialogs, the keyboard, the status bar and safe areas. The third layer, the component library, is yours: buttons, cards and every other piece of your UI are components you write on those two layers, in your app's crate ([Building with Rust](./rust.md)) or in TSX, or a library from the community ([Three layers](./architecture.md#three-layers)).

A Rust component is a `#[component] fn` that takes its props struct (and, when it has events, a `Scope` to emit them) and returns its elements. `#[component]` also makes its constructor, the function's name in snake case: `Badge` is placed with `badge()`, as `view()` places a view, with a setter per prop (`.label(..)`, `.color(..)`: a value, a signal or a closure). A TSX component is a function that takes a props object and returns JSX:

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

The function runs **once**, when the component is created, and does not track what it reads: there is no re-rendering. Code in its body (creating signals, starting effects, computing constants) runs one time. The elements it returns stay connected to the props and signals they read, so `Badge` above updates its text whenever `unread` changes, without running `Badge` again.

Write a `#[component]` when the UI has props or events of its own, or when a TSX entry imports it: a Rust component is registered under its type (`registry.register::<Badge>()`), with props typed from the struct ([Building with Rust](./rust.md#extending-a-rust-app-with-tsx)). For a piece of UI only Rust uses, a plain function returning `impl IntoElement` is enough, its arguments the props. In TSX, a component may return an element, a string or number, an array, `null`, or a function returning any of these (which the renderer follows); the `Component<P>` type from `nsh` describes one:

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

### What runs again

A value given to an element is set once; a binding follows what it reads. In Rust a binding is a closure (or a signal, a memo, a prop) given where a value goes. In TSX, the compiler decides for each expression in JSX: an expression changes when it **calls a function or reads a property** (outside nested functions), and everything else is set once:

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

A changing prop or child is a small native effect that sets that one prop or replaces that one child. Styles are diffed in Rust, so a style that changes only sends the properties that changed.

Event handlers are set once: a closure in Rust, a function or a name in TSX (`onPress={() => …}`, `onPress={save}`). In TSX, other expressions are followed (`onPress={props.onPress}` follows the prop).

### Props

A Rust component's props are the fields of its `#[derive(Props)]` struct, each a `Prop<T>`: a value, or a binding the parent passed. Read one in a binding (`text(props.title)`, `move || props.title.get()`) to follow it; `props.title.get()` in the body reads it once. Fields with `#[prop(default)]` or `#[prop(default = …)]`, and `Option`s, are optional. The constructor starts every prop at its default, and a parent calls the setters of the ones it needs: `badge().label("New")`.

A TSX prop given a changing expression is passed as a getter: reading `props.title` calls it, which is what lets the JSX that reads it follow it. Static props are plain values. In both, props are read where they are used:

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

A TSX component that takes its props apart in its parameter, `function Title({ text }: …)`, reads them the same once, and the build warns of it with the props to read instead:

```text
warn App.tsx:3:16: Title takes its props apart (`{ text }`): each is read once, when Title runs, and does not follow changes; take `props` and read `props.text` where it is used (`split(props, [...])` to pass the rest on)
```

A prop the component wants only once, such as an id it starts with, is read in the body (`props.id.get_untracked()`, `const { id } = props;`), which says so.

In TSX the same applies to default values: write `props.color ?? "#ddf4ff"` in the JSX rather than destructuring with a default. To compute something from props, use a closure or [`computed`](./reactivity.md#computed):

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

### Children

What a parent places in a component arrives as its children: a `children: Prop<Children>` field in Rust, which the parent fills with `.child(..)`; `props.children` in TSX, a getter that builds those elements when read:

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

In TSX, each read of `props.children` builds the children again (new native views): read it once, in the place where the children go. Among several children, one that changes (an `<If>`, an `<Each>`, `{cond() ? a : b}`) arrives as a function, and `{props.children}` updates that one alone: its siblings keep their views, an input its text and focus. Fragments (`<>…</>`) group elements without a view.

Children can also be made by a function the component calls with arguments, a render callback:

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

## Control flow

`when` and `each` in Rust, `<If>` and `<Each>` in TSX, are built-in control flow. They render no view of their own.

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

- **`when`** / **`<If>`** shows its branch while the condition holds, else the `otherwise` / `else` branch. It renders a branch again only when whether the condition holds changes, not every time the condition is re-evaluated. In TSX, a function child gets an accessor of `when`'s value, typed without `null` and `undefined`: `u()` is the user while the branch shows, and follows it when it changes.
- **`each`** / **`<Each>`** renders a row per item, made by its row function. Rows are kept by key (Rust: the key function; TSX: `key`, by default the item itself, objects by identity and primitives by value): when the list changes, kept rows are moved rather than rebuilt, and new rows are made only for new keys. The row function receives **signals** of the item and its index (`todo.get()` and `index.get()` in Rust, `todo()` and `index()` in TSX), because a kept row's item and position can change. In TSX, `key="index"` (or `key={(item, i) => i}`) keeps rows by position instead: a list of strings that changes in place, such as text streamed in, keeps its rows and only their `item()` changes.

A choice made in a closure (`dynamic(move || if busy.get() { … } else { … })` in Rust, a ternary or `&&` in TSX) builds its branch again every time anything it reads changes. Prefer `when` / `<If>` when a branch is more than a few elements.

For long or infinite lists, use [`List`](./lists.md) (`virtual_list` in Rust): it creates views only for the rows on screen and recycles them. See [Control flow](../elements/control-flow.md) for the details.

## Refs

A ref names a host element for imperative calls: `focus()`, `blur()`, `scroll_to()` / `scrollTo()`, `scroll_to_index()` / `scrollToIndex()`, `measure()` ([where a view is](./touch-and-gestures.md#where-a-view-is-measure)), ... In Rust, `element_ref()` makes one and `.element_ref(&handle)` puts it on an element; in TSX, `ref` gives you the element's native node, a `YNode`:

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

A Rust ref is a `Copy` handle; its calls go to the element that carries it, and do nothing once its owner is gone. In TSX, what `ref={…}` names receives the node:

- a variable declared with `let` is assigned it;
- a field (`ref={refs.input}`, `ref={refs[name]}`) is assigned it;
- a [signal](./reactivity.md) is set to it, so what reads the signal follows it;
- a function is called with it (`<Scroll ref={(node) => (scroller = node)} />`).

A `const` or an import holds a signal or a function, as in `const input = signal<YNode>()` with `<Input ref={input} />` and `input()?.focus()`; one holding anything else is reported when the element is made, with what to write.

The ref is set when the element is created, before the component returns, so it is available in [effects](./reactivity.md#effect) and event handlers. Calls are sent to the view in order with the changes made before them. The base components and the Rust components of your own crate accept `ref` too (in Rust `component_ref()`, put on the element with `.component_ref(&r)`: `dialog().component_ref(&r)`).

## Spreading props

In Rust, a parent calls the setters of the props it needs and the rest keep their defaults, and a wrapper passes its own `Prop`s on as they are (`card().title(props.title)`): a `Prop` keeps following what it was given.

In TSX, spread an object of props onto an element or a component with `{...props}`. Getters stay getters, so spread props keep following what they read. To take some props for yourself and pass the rest on, use `split`:

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

`split(props, keys)` returns `[picked, rest]`, both still reading through to the original props (destructuring `{ label, ...rest } = props` would read every prop once). Element props that come later in the JSX win over earlier ones.

`<If>` and `<Each>` take no spread props, and spread children (`{...items}`) are not supported: use `<Each>` or an array expression.

## Tags and names

A Rust element is whatever the code calls: a primitive's function, a component's constructor (`badge()`, `nsh_base::button()`), or a function of your own. A TSX tag names a binding in scope, as usual: `<Badge />`, `<Theme.Provider>`, a `<Button>` of your own. A tag that names nothing in scope is a build error, except `<If>` and `<Each>`, which are globals.

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

`nsh_base`'s `Button` (`button()` in Rust, `<Button>` from `nsh/base`) is the unstyled press target with the disabled and selected states and their accessibility; the app gives it its look: `button().disabled(move || saving.get()).on_press(move || save()).px_4().active(|s| s.opacity(0.6)).child(text("Save"))`.

In TSX, your bindings win over the globals: a component named `Each` in scope makes `<Each>` that component. A primitive is recognized by its import, so `import { View as Box } from "nsh"` makes `<Box>` a view, and a component of your own named `Text` is just your component. The primitives are real components too: `const Tag = inline ? Text : View;` and then `<Tag>…</Tag>` works.

Components are typed by their own declarations: Rust's props structs are checked by the compiler, and TypeScript checks a TSX component's props wherever it is used, with nothing to generate. A Rust component a TSX entry imports gets TypeScript declarations generated from its struct.

## Mounting and the root

A Rust app's root is the component `nsh.json`'s `"root"` names; `nsh run` and `nsh package` mount it. A TSX entry calls `mount(App)` to render the root component (`mount(App, props)` passes it props). The root view fills the surface (the window, or the view an app embeds NSH in). Give the root `flex: 1` so it fills the screen, and a background color: the surface's own background depends on the platform.

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

## Related

- [Reactivity](./reactivity.md): signals, effects, context.
- [Elements](../elements/index.md): every host element and its props.
- [Styling](./styling.md) and [Tailwind](./tailwind.md): the look of your components.
- [Building with Rust](./rust.md): Rust apps, components in your app's own crate, and TSX on top.
