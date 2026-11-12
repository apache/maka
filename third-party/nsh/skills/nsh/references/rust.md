# Writing an NSH app in Rust

Start here for an app, or part of an app, written in Rust. Rust is the preferred mode: the whole app is native code,
no JavaScript VM ships with it, and `cargo check` and `cargo test` cover the real UI.

- [rust-ui.md](rust-ui.md): the components of `nsh_base`, family by family.
- [rust-testing.md](rust-testing.md): `cargo test` with `Headless`, `nsh test`, platform runs.
- [rust-recipe.md](rust-recipe.md): a complete app (store, pages, list, dialog, tests).

Start with the bundled [rust-recipe.md](rust-recipe.md) for a complete app. For a specific
component, use [rust-ui.md](rust-ui.md) and `https://nsh.dev/elements/{name}.md`,
then confirm the API against the project’s resolved crate source. In an NSH checkout,
`examples/gallery-rs/native/src` and `crates/nsh-base/tests/base` provide more compiled uses.

## The one rule

**A component body runs once. Only bindings run again.** Everything below follows from it. A value read in the body
is a snapshot; a closure, signal or memo handed to a setter is a binding and stays current. There is no re-render,
no diffing of a returned tree, and no hook order.

## Project layout

`nsh init my-app --template rust` (`crates/nsh-cli/src/init.rs`, templates in `crates/nsh-cli/src/templates/rust/`)
writes:

```text
my-app/
  Cargo.toml       # package nsh-app-my-app, its own [workspace], nsh-core and nsh-base at the CLI's version
  nsh.json         # name, id, version, build, "rust": ".", "root": "App"
  src/lib.rs       # the #[native_module] set and the root component
  src/main.rs      # `cargo run`: run_app on the desktop backend (nsh-platform-linux/macos/windows)
  App.test.tsx     # the root tested from TypeScript with open(".")
  tsconfig.json    # for that test, extends .nsh/tsconfig.json
  README.md
  .gitignore
  .nsh/            # generated: types and tsconfig. Do not edit
```

Commands, from the app's directory:

```sh
nsh run                     # this machine; --target ios, android, web, macos, linux, windows
nsh check                   # cargo check --all-targets, then type checks the test files
nsh test                    # cargo test, then *.test.tsx, headless
nsh package --target web    # or ios, ios-simulator, android, macos, linux, windows
cargo run                   # the root directly on the desktop backend, without the CLI
```

Use `nsh check` or `cargo check` while working. A Rust edit under `nsh run` rebuilds and restarts the app; there is
no hot update for Rust.

The package name is `nsh-app-<slug>`, so tests import it as `nsh_app_my_app`. Keep every `nsh-*` dependency at the
version of the `nsh` you run; a mismatch is a build problem, not something to work around with a pin.

### nsh.json

| Key | For Rust | Notes |
|---|---|---|
| `rust` | `"."`, `"native"`, or a list of crate paths | Where the crate is. With a list, each crate has its own `#[native_module]` and package name |
| `root` | `"App"`, `"shell::Gallery"` | The component's path in the crate (in the first crate of a list). Without it the app is TSX |
| `theme` | `"theme.json"` or the theme inline | shadcn `cssVars`. A bad path, bad JSON or another format fails the build |
| `appearance` | `"system"` | As in any app |

`examples/gallery-rs/nsh.json` is a real one, with `"rust": "native"` and `"root": "Gallery"`. Every key is in
`website/docs/project-structure.md`.

### The root

```rust
use nsh_base::theme;
use nsh_core::prelude::*;

/// The app's UI set; what a TSX entry could import, and `registry()` for tests.
#[native_module("my-app/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

#[component]
pub fn App() -> impl IntoElement {
    view()
        .flex_1()
        .bg(move || theme().background)
        .text_color(move || theme().foreground)
        .p_safe_area()
        .child(text("Hello"))
}
```

`#[native_module]` must be at the root of `lib.rs`; anywhere else is a compile error. Give the root `.flex_1()` and a background from the theme: it fills the surface, and nothing else paints the window
behind your content. Put `.p_safe_area()` on the content, or leave it to a `nav_page`, which handles its own header.

### How a larger app splits its crate

Follow `examples/gallery-rs/native/src`:

| File | Holds |
|---|---|
| `lib.rs` | `mod` lines, `#[native_module]`, the root component and nothing else |
| `shell.rs` | The layouts: phone stack or desktop sidebar, chosen by `when(desktop, ..)` |
| `nav.rs` | The route type, `global::<Routes>()`, `push`, `pop`, `reset` |
| `ui/` | The app's own component library: `theme.rs` (colors, radii), `controls.rs`, `parts.rs`, `icons.rs` |
| `demos/<feature>.rs`, `demos/stocks/` | One module per feature; a big feature is a directory with its store in `mod.rs` |
| `assets.rs` | `asset!` constants |

`nsh_base` draws nothing, so an app's own `ui/` is not optional: wrap each base component once, with the app's look,
and call that wrapper everywhere. Do not repeat `.bg(..).rounded(..)` at call sites. Keep domain logic in plain Rust
types that know nothing of NSH, so `cargo test` can exercise them without an engine.

## Components

### Choose the unit

- **A plain function** returning `impl IntoElement` is the default for a piece of UI. It costs nothing and keeps
  nothing but the bindings it made. Signals created in it belong to whoever called it.
- **`#[component]`** when it needs an owner of its own (state and tasks disposed when it leaves), events through
  `cx`, or to be exported to TSX. `examples/gallery-rs/native/src/ui/controls.rs` has both side by side.

### #[component], Props, Prop, Event, Scope

```rust
use nsh_base::theme;
use nsh_core::prelude::*;

#[derive(Clone, PartialEq, Props)]
pub struct StepperProps {
    /// The current value. The parent owns it.
    pub value: Prop<i32>,
    /// The largest value.
    #[prop(default = 10)]
    pub max: Prop<i32>,
    /// What the row says. `Option` props default to `None`.
    pub label: Prop<Option<SharedString>>,
    /// Content placed after the buttons.
    pub children: Prop<Children>,
}

#[derive(Event)]
pub enum StepperEvent {
    /// The user asked for another value.
    #[args(value)]
    Change(i32),
}

/// A row that steps a number.
#[component]
pub fn Stepper(props: StepperProps, cx: Scope<StepperEvent>) -> impl IntoElement {
    let add = move |by: i32| {
        // Read untracked in a handler: the current value, no subscription.
        let next = (props.value.get_untracked() + by).min(props.max.get_untracked());
        cx.emit(StepperEvent::Change(next));
    };
    view()
        .flex_row()
        .items_center()
        .gap_2()
        .child(text(move || props.label.get().unwrap_or_default()))
        .child(text(move || props.value.get().to_string()).tabular_nums())
        .child(
            view()
                .px_3()
                .py_1()
                .rounded(move || theme().radius)
                .bg(move || theme().secondary)
                .active(|s| s.opacity(0.6))
                .role(AccessibilityRole::Button)
                .label("Add one")
                .on_press(move || add(1))
                .child(text("+")),
        )
        .child(props.children)
}

fn place_it() -> impl IntoElement {
    let count = signal(0);
    stepper()
        .value(count)
        .max(5)
        .label("Seats")
        .on_change(move |value: &i32| count.set(*value))
        .child(text(move || format!("{} chosen", count.get())))
}
```

What the macros give you, and only this:

- `#[component] fn Stepper` makes the unit struct `Stepper`, the `Component` impl, the element `StepperElement` and the
  constructor `stepper()`. The element takes every `Styled`, `Interactive` and `Accessible` method, applied to the
  component's root.
- Each field is a setter of the same name. `Prop<T>` is `Copy`, and its setter takes a value, a signal, a memo or a
  closure. Reading uses `.get()` (tracked), `.with(|v| ..)`, `.get_untracked()`, `.with_untracked(..)`.
- `#[prop(default)]` uses `Default`; `#[prop(default = expr)]` uses `expr`. An `Option` field needs neither.
- `#[prop(lazy)]` on `children` makes the content only while the view places it (a sheet's body).
- `Prop<Option<Slot>>` is a named slot; its setter takes an element (`.trigger(view()..)`) and the view places it with
  `props.trigger.place(|s| s)`.
- `Prop<Option<Renderer<T>>>` is a render function; its setter takes a closure of `&T`. `r.render(key, value)` gives an
  element.
- Each `Event` variant is a listener `on_<variant>`: `Change(i32)` is `.on_change(move |v: &i32| ..)`. A variant of
  several values is heard as the whole event: `.on_open_change(move |e: &SelectEvent| ..)`. `#[args(..)]` only names
  the fields for TSX.
- `Scope<E>` is `Copy`. It has `emit`, `insets` (below the header, on a page) and `methods`. A component with no events
  takes `Scope<NoEvent>` or leaves `cx` out; one with no props leaves `props` out.

Derive `Clone, PartialEq, Props` on every props struct. Add `Copy` only if the fields allow it; `Prop` itself is always
`Copy`, which is why closures can capture individual fields.

**Controlled by default.** Take the value as a prop, emit the requested change, and let the owner write it. Do not copy
a prop into a local signal in the body (`signal(props.value.get())`): the copy stops following the parent. If a
component must keep an uncontrolled value, take a separate `default_value` and use it only for that.

### The builder convention

A function makes an element and methods configure it, consuming and returning `Self`:

- a prop's setter has the prop's name, with no `set_` (`.disabled(..)`, `.title(..)`);
- a listener is `on_<event>`, with a closure of `&Data`, or of nothing: `move || ..`. Press listeners may also take
  `move |_: &()| ..`, which helps when the closure is passed through a generic helper;
- text listeners take `&str`: `.on_change(move |text: &str| ..)`. Write the parameter type; inference across
  `IntoListener` fails without it.

Methods live on traits in the prelude: `Styled`, `Interactive`, `Accessible`, `ParentElement`, `Element`,
`FluentBuilder`. If a method "does not exist", check that `use nsh_core::prelude::*;` is present.

### `.child` forms

`.child` takes an element, or anything iterable of elements: `Option`, `Vec`, an array, an iterator. `.children` takes
an iterator too. Both are decided once, while building.

```rust
use nsh_core::prelude::*;

fn forms(subtitle: Option<&'static str>, tags: &[&'static str]) -> impl IntoElement {
    view()
        .child(text("One element"))
        .child(subtitle.map(text))                          // Option: one or none, decided now
        .child(tags.iter().map(|t| text(*t)))               // an iterator, made now, never updated
        .child([text("An"), text("array")])
        .children(tags.iter().map(|t| text(*t).text_sm()))  // the same, with .children
}
```

Elements of different types in one `Vec` or match need `.into_element()`, which gives `AnyElement`. See `sidebar_row`
in `examples/gallery-rs/native/src/shell.rs`.

## Bindings

### A binding or a value

Every setter takes `impl IntoReactive<T>`. What you pass decides whether it can ever change:

| You pass | Result |
|---|---|
| `text("Title")`, `.w(px(40.0))` | Static. Set once, no effect, no allocation |
| `text(count_string)`, `.opacity(fade)`, where the variable is a signal or memo | Bound directly, no closure |
| `.bg(move \|\| if up.get() { a } else { b })` | Bound. Runs again when `up` changes, and sends only that style |

```rust
use nsh_core::prelude::*;

#[component]
fn Reads() -> impl IntoElement {
    let count = signal(1_u32);
    // Wrong: `shown` is the value at this moment. The text is never updated.
    let shown = format!("Count: {}", count.get());
    view()
        .child(text(shown))
        // Right: a closure, so the read happens in a binding.
        .child(text(move || format!("Count: {}", count.get())))
        .on_press(move || count.update(|n| *n += 1))
}
```

The compiler accepts the wrong form, and the first frame looks right. The same applies to helper functions: a helper
taking `label: String` freezes the label, and a helper taking `impl IntoReactive<SharedString>` passes it through
(`examples/gallery-rs/native/src/demos/form.rs`, `Field::hint`).

`theme()` is a read too. `.bg(move || theme().primary)` follows a theme change; `.bg(theme().primary)` is fixed to that
theme object. Either follows light and dark, because the `AdaptiveColor` carries both values.

### Signals

```rust
use nsh_core::prelude::*;

#[derive(Clone, PartialEq, Default)]
struct Filter {
    query: String,
    done: bool,
}

fn signals() {
    let count = signal(0_u32);
    let filter = signal(Filter::default());

    let now = count.get();                          // clones; tracked inside a binding
    let empty = filter.with(|f| f.query.is_empty()); // borrows; prefer it for anything not Copy
    let held = count.get_untracked();               // never subscribes

    count.set(now + held);                          // skipped if equal to the current value
    count.update(|n| *n += 1);                      // in place; ALWAYS notifies
    filter.update(|f| f.done = !empty);

    // Several writes, one update of each binding.
    batch(|| {
        count.set(0);
        filter.set(Filter::default());
    });
    let read_only: ReadSignal<u32> = count.read_only();
    let _ = read_only.get();
}
```

- `Signal<T>`, `ReadSignal<T>`, `Memo<T>`, `Prop<T>`, `Stored<T>`, `ElementRef` and `AnimatedValue` are `Copy` handles.
  Capture them in `move` closures freely, and never clone or wrap them in `Rc`.
- `signal(v)` requires `T: PartialEq`, and `.set` of an equal value does nothing. For a type without `PartialEq`, use
  `signal_with(v, SignalEquals::Never)`, where every write notifies.
- `.update` needs `T: Clone` and always notifies, even if the closure changed nothing. Use `.set` when an equal value
  should not wake anything.
- A `Vec` field in a signal is not fine-grained. Prefer `.with` to reading one field, and a memo to narrow a large value
  to the part a binding needs.
- A signal belongs to the owner that made it. Reading one after its owner is disposed panics with its creation site.
  `try_get` and `try_set` are for code that can outlive it.
- `stored(v)` is a `Copy` handle to non-reactive state (a cache, a running task). Reading it subscribes nothing and
  writing it wakes nothing. Do not use a signal for what nothing displays.

**Reading outside a binding.** In a body, a listener or a task, `.get()` returns the value and subscribes to nothing.
So a read in a listener is always current, and a read in the body is a snapshot. Use `.get_untracked()` in listeners
anyway when the listener can be called from a binding or effect, and always inside an `effect` for a value that should
not re-run it. `untracked(|| ..)` covers a whole block, including function calls that read signals.

### computed and effect

```rust
use nsh_core::prelude::*;

#[component]
fn Totals() -> impl IntoElement {
    let prices = signal(vec![3.0_f64, 4.5]);
    // Runs when `prices` changes; its readers run only if the result changed.
    let total = computed(move || prices.with(|p| p.iter().sum::<f64>()));
    let expensive = computed(move || total.get() > 100.0);

    // Runs now and after each change, once the bindings are updated.
    effect(move || log::info!("total {}", total.get()));

    view()
        .child(text(move || format!("{:.2}", total.get())))
        .style_when(expensive, |s| s.opacity(0.5))
}
```

- Use a plain `move ||` closure for a cheap derived value read in one place. Use `computed` when several places read
  it, when it is expensive, or to stop updates that do not change the result. `computed` requires `PartialEq`.
- `effect` is for leaving the graph: saving, logging, calling a platform service, starting a task. **Do not use it to
  copy one signal into another**; that is a `computed`. An effect writing a signal it reads will loop.
- `cleanup(|| ..)` inside an effect runs before the effect's next run and when its owner goes. In a body, it runs when
  the component goes.

### dynamic, when, each

A `.child(..)` with a closure does not exist: `.child` is decided once. Content that comes and goes is a region:

```rust
use nsh_core::prelude::*;

#[derive(Clone, PartialEq)]
struct Row {
    id: u32,
    title: SharedString,
}

#[component]
fn Regions() -> impl IntoElement {
    let open = signal(false);
    let wide = signal(false);
    let rows = signal(vec![Row { id: 1, title: "First".into() }]);
    view()
        // One branch, made when the condition flips to it, disposed when it flips away.
        .child(when(open, || text("Open")).otherwise(|| text("Closed")))
        // A row per key. A row that stays keeps its nodes and bindings.
        .child(each(
            rows,
            |row: &Row| row.id,
            |row, index| {
                view()
                    .flex_row()
                    .child(text(move || (index.get() + 1).to_string()))
                    .child(text(move || row.with(|r| r.title.clone())))
            },
        ))
        // Anything else: made again, whole, whenever what it reads changes.
        .child(dynamic(move || {
            if wide.get() { text("Wide").into_element() } else { view().child(text("Narrow")).into_element() }
        }))
}
```

| Need | Use | Not |
|---|---|---|
| Show or hide structure on a signal | `when(cond, a).otherwise(b)` | `.when(bool, ..)`, decided once |
| A style on a signal | `.style_when(cond, \|s\| ..)` or a bound setter | `when` around two copies of the element |
| Hide without disposing state | `.style_when(cond, \|s\| s.hidden())` | `when`, which disposes it |
| A short list that changes | `each(items, key, row)` | `dynamic` plus `.map`, which remakes every row |
| A long or unbounded list | `virtual_list` ([rust-ui.md](rust-ui.md#lists-and-virtualized-data)) | `each` in a `scroll` |
| Choice among several shapes | `dynamic` | |

`dynamic` disposes everything it made on each run, signals and scroll offsets included. Read only what selects the
shape, and wrap the rest in `untracked`, as `examples/gallery-rs/native/src/demos/lists.rs` does:

```rust
use nsh_core::prelude::*;

fn cards(columns: u32) -> View {
    view().child(text(format!("{columns} columns")))
}

#[component]
fn Grid() -> impl IntoElement {
    let columns = computed(|| if window().width.0 > 700.0 { 3_u32 } else { 2 });
    view().flex_1().child(dynamic(move || {
        let columns = columns.get();
        // Only `columns` remakes this; reads inside `cards` do not.
        untracked(|| cards(columns).key(format!("cards-{columns}")))
    }))
}
```

Return the concrete type (`View`, `VirtualList`) from a helper that a caller might key: `.key` is not on
`impl IntoElement`.

### Keys and identity

- `each`'s key function must return a stable domain id, not an index. Same key, same row: its nodes, bindings, and
  focus stay, and its `item` and `index` signals update. A new key makes a new row.
- A row of `each` gets `ReadSignal`s: `row.get_untracked()` in the row body is a snapshot, as anywhere. Read fields in
  bindings if the item can change under the same key.
- `each` requires `T: Clone + PartialEq`. A row whose value changed but whose key did not is updated through the signal.
- `.key(..)` on an element identifies it among the siblings of a region. A new key forces a new element and new state,
  which is how to reset something on purpose (`cards-{columns}` above drops the old state).
- Give each `nav_page` a key, its route, so the pages below keep their state.
- `virtual_list` needs `.keys(move || ..)` when rows are inserted or removed anywhere but the end.

## Owning state

Put each piece of state in the narrowest owner that keeps it correct:

| State | Where |
|---|---|
| Open, hovered, draft text of one component | A `signal` in that component's body |
| Shared by a subtree | A `Copy` store passed as an argument, or `provide_context` |
| One per surface, read from anywhere (routes, session) | `global::<T>()` |
| Must outlive a run | `nsh_core::storage::Storage`, or a server |

An app-level store is a `Copy` struct of signals, made once in the root:

```rust
use nsh_core::prelude::*;

#[derive(Clone, PartialEq)]
pub struct Task {
    pub id: u64,
    pub title: SharedString,
    pub done: bool,
}

/// `Copy`: closures and rows capture it as they do a signal.
#[derive(Clone, Copy)]
pub struct Store {
    pub tasks: Signal<Vec<Task>>,
    next_id: Stored<u64>,
}

impl Store {
    pub fn new() -> Self {
        Self { tasks: signal(Vec::new()), next_id: stored(1) }
    }

    pub fn add(&self, title: impl Into<SharedString>) {
        let id = self.next_id.with(|n| { *n += 1; *n });
        let title = title.into();
        self.tasks.update(|tasks| tasks.push(Task { id, title, done: false }));
    }

    pub fn left(&self) -> usize {
        self.tasks.with(|tasks| tasks.iter().filter(|t| !t.done).count())
    }
}

fn store() -> Store {
    use_context::<Store>().expect("the root provides the store")
}

#[component]
pub fn Root() -> impl IntoElement {
    provide_context(Store::new());
    view().flex_1().child(footer())
}

fn footer() -> impl IntoElement {
    // Read the context here, while building, and keep what it gave.
    let store = store();
    view()
        .on_press(move || store.add("Another"))
        .child(text(move || format!("{} left", store.left())))
}
```

- **Read `use_context` while building, never in a listener or task**: there is no component to look it up from. Read it
  in the body and capture the `Copy` result. `examples/gallery-rs/native/src/demos/stocks/mod.rs` (`live()`) is this.
- Methods on the store are the only writers. Views do not reach into `tasks.update` directly.
- A page pushed on a stack is made under the stack, not under the screen that pushed it, so context from that screen
  does not reach it. Call `provide_context` again at the start of the page's maker, as `open` does in `stocks/mod.rs`.
- `provide_context` applies to what the current owner makes from then on: call it before building the children.
- `global::<T>()` needs `T: Default`, returns one `Signal<T>` per type per surface, and every write notifies. It works
  from listeners and tasks, unlike context. See `examples/gallery-rs/native/src/nav.rs`. Prefer a store for domain
  state, since a global cannot be replaced in a subtree.

### SharedString

Use `SharedString` for UI text that is retained: props, stored titles, values in signals. Cloning it into a binding
does not copy the text, and `From<&'static str>` does not allocate. Use `String` for a buffer being edited (an input's
draft) or assembled, and `&str` for reading during one call. `text(..)` accepts `&str`, `String`, `SharedString`, a
signal of `SharedString`, or a closure returning any of them. `signal("x")` is a `Signal<&str>`; write
`signal(SharedString::from("x"))`, as a `.set(response.text().into())` will need that type.

## Styles

Styles are typed methods, one per property, on the same builder. Most take a value, a signal or a closure.

```rust
use nsh_base::theme;
use nsh_core::prelude::*;

fn card(selected: Signal<bool>) -> impl IntoElement {
    view()
        .flex_row()                                     // the default direction is a column
        .items_center()
        .justify_between()
        .gap_3()                                        // the 4 pt scale: gap_3 is 12 points
        .gap(px(10.0))                                  // or an exact value
        .px_4()
        .h(px(44.0))
        .min_w(px(0.0))
        .rounded(move || theme().radius)
        .border_1()
        .border_color(move || theme().border)
        .bg(move || theme().card)
        // Native states: no binding, nothing runs.
        .hover(|s| s.bg(move || theme().accent))
        .active(|s| s.opacity(0.7))
        .focus_visible(|s| s.outline(px(2.0)).outline_color(move || theme().ring))
        .disabled_style(|s| s.opacity(0.5))
        .dark(|s| s.border_2())
        // App state.
        .style_when(selected, |s| s.bg(move || theme().accent))
        .cursor_pointer()
        .child(
            text("Title")
                .flex_1()
                .number_of_lines(1)
                .text_sm()
                .font_weight(FontWeight::MEDIUM)
                .text_color(move || theme().card_foreground),
        )
}
```

- Layout is flex with Taffy. A view is a column, and its children stretch across it. Use `.flex_1()` to fill and
  `.min_w(px(0.0))` on a flex child that must shrink below its text's width.
- `.text_color` on a `view` reaches the text inside it (the template sets the root's). Set it once on the root rather
  than on every text.
- `.active`, `.hover`, `.focus`, `.focus_within`, `.disabled_style`, `.selected`, `.checked`, `.dark` and `group_*` are
  native states: the platform switches them with no Rust running. Never hold press or hover state in a signal to drive
  a style.
- `.focus` appears only on a focusable element: `.focusable(true)`, or a control that is one.
- `.when(cond, |v| ..)`, `.when_some(opt, |v, x| ..)` and `.map(|v| ..)` run once, while building. They are for what
  never changes (an argument, the platform).
- For several properties that depend on state, use `.style_with(move |s| ..)`, which reruns when what it read changes.
- Animate with `AnimatedValue` (`animated_value`, `.bind_opacity`, `.bind_translate_y`), not a signal written per frame.
  `examples/gallery-rs/native/src/ui/animated.rs` shows it.

### Theme tokens

`nsh_base::theme()` returns `Arc<Theme>` with fields as `AdaptiveColor`: `background`, `foreground`, `card`,
`card_foreground`, `popover`, `popover_foreground`, `primary`, `primary_foreground`, `secondary`,
`secondary_foreground`, `muted`, `muted_foreground`, `accent`, `accent_foreground`, `destructive`, `border`, `input`,
`ring`, `chart_1`..`chart_5`, `sidebar` and its family; plus `radius`, `font_sans`, `font_mono`.

Do not write `rgb(..)` in app code. Name the role, so a theme file restyles the whole app.

Custom tokens go in the theme file under `cssVars` (any name), and are read by name:

```json
{ "cssVars": { "light": { "up": "#16a34a", "radius-card": "14px" }, "dark": { "up": "#4ade80" } } }
```

```rust
use nsh_base::theme;
use nsh_core::prelude::*;

fn change() -> impl IntoElement {
    let up = move || theme().color("up").unwrap_or(theme().foreground);
    let radius = move || px(theme().number("radius-card").unwrap_or(10.0));
    view().rounded(radius).child(text("+2.4%").text_color(up))
}
```

`color`, `number` and `font` return `Option`: a misspelled token is `None`, so give a fallback that looks wrong in
review rather than `.unwrap()`, which panics at run time. Wrap each custom token in one function of your `ui/theme`
module. Tokens and defaults are listed in `website/docs/rust.md`, "Theme".

### `.app_class`

`.app_class(..)` applies Tailwind classes that came from outside as a prop, to one part of a component, after that
element's own styles (`text(props.symbol).app_class(props.symbol_class)`, with `symbol_class: Prop<Option<SharedString>>`).
It is for components TSX also uses: `website/docs/rust.md`, "Render functions and the app's classes". For your own
elements in Rust, write typed styles. The exception is a base component's `*_class` prop, which some states can only
reach by class (`.item_class("focus:bg-accent")` on a `select`).

## Async

```rust
use std::time::Duration;

use nsh_core::prelude::*;

#[component]
fn Quotes() -> impl IntoElement {
    let quote = signal(SharedString::from("…"));

    // On the engine thread. Writes signals directly. Cancelled with this component.
    spawn(async move {
        match fetch("https://api.example.com/quote").await {
            Ok(response) if response.status() == 200 => quote.set(response.text().into()),
            Ok(response) => quote.set(format!("HTTP {}", response.status()).into()),
            Err(error) => quote.set(error.into()),
        }
    });

    // Timers belong to the owner too; the returned Spawned need not be kept.
    set_interval(Duration::from_secs(30), || log::debug!("tick"));
    set_timeout(Duration::from_secs(1), || log::debug!("once"));

    text(quote)
}

#[cfg(not(target_arch = "wasm32"))]
async fn digest(path: std::path::PathBuf) -> Result<usize, String> {
    // `blocking`: file I/O and other blocking calls.
    let bytes = blocking(move || std::fs::read(path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    // `background`: a Send future on the runtime's threads.
    background(async move { bytes.iter().filter(|b| **b == b'\n').count() })
        .await
        .map_err(|e| e.to_string())
}
```

| Function | Runs on | Use for | Web |
|---|---|---|---|
| `spawn(fut)` | Engine thread | Anything that writes signals | Yes |
| `fetch(url_or_HttpRequest)` | NSH's network stack | HTTP, under `capabilities.network` | Yes |
| `timer(d)`, `timer_until(at)` | Engine's loop | Waiting in a task | Yes |
| `set_timeout`, `set_interval` | Engine thread | Delayed and repeating work | Yes |
| `blocking(f)` | tokio's blocking threads | Blocking calls | **No** |
| `background(fut)` | tokio's threads | `Send` futures, CPU work | **No** |
| `run_on_main_thread(f)` | The platform's main thread, after the turn's views are mounted | APIs that only work there (AppKit, UIKit); await the result | Engine thread |

- Long work on the engine thread freezes the UI's bindings. Move it to `blocking` or `background`, await the result in a
  `spawn`, and write signals there.
- Signals are not `Send`. Closures given to `blocking` and `background` must not capture them. The compiler enforces
  this; the fix is to compute and return a value, then write it in the `spawn`.
- `blocking` and `background` do not exist on `wasm32`. Code that also targets the web uses `fetch` and `timer`, or sits
  under `#[cfg(not(target_arch = "wasm32"))]`.
- Do not use `reqwest`, `tokio::time::sleep` or `std::time::Instant` in code that runs on the web: use `fetch`, `timer`
  and `nsh_core::time::{Instant, now, unix_ms}`. In a headless test, those are also what the stub network and manual
  clock control.
- `response.text()` is a `String`, `response.status()` the code, `response.ok()` a success. The whole body arrives at once.

### Stale results

Three ways, in order of preference.

**`resource`**: for data that depends on a signal. Only the latest load counts, and a new one drops the last.

```rust
use nsh_core::prelude::*;

#[component]
fn User() -> impl IntoElement {
    let id = signal(1_u32);
    let user = resource(
        move || Some(id.get()), // tracked; None loads nothing
        |id, _info| async move {
            let response = fetch(format!("https://api.example.com/users/{id}")).await?;
            Ok::<_, String>(SharedString::from(response.text()))
        },
    );
    view()
        .on_press(move || id.update(|n| *n += 1))
        .child(text(move || match (user.get(), user.error()) {
            (Some(name), _) => name,
            (None, Some(error)) => error.into(),
            _ => "Loading".into(),
        }))
        .child(when(move || user.loading(), || text("Refreshing")))
}
```

It keeps the previous value while reloading. It also has `.refetch()` for pull to refresh and `.mutate(v)` for optimistic
updates.

**A `spawn` inside an `effect`**: the effect's rerun disposes what it owned, which cancels the last task.

```rust
use std::time::Duration;

use nsh_base::input;
use nsh_core::prelude::*;

#[component]
fn Search() -> impl IntoElement {
    let query = signal(String::new());
    let results = signal(Vec::<String>::new());
    effect(move || {
        let query = query.get();
        spawn(async move {
            timer(Duration::from_millis(250)).await; // debounce
            let url = format!("https://api.example.com/search?q={query}");
            if let Ok(response) = fetch(url).await {
                results.set(response.text().lines().map(str::to_owned).collect());
            }
        });
    });
    input().value(move || query.get()).on_change(move |text: &str| query.set(text.to_owned()))
}
```

**A held task**: for work started by a press. A press does not cancel the last one unless you do:

```rust
use nsh_core::prelude::*;

fn save_button(body: Signal<String>) -> impl IntoElement {
    let running = stored(None::<Spawned<()>>);
    view().child(text("Save")).on_press(move || {
        if let Some(last) = running.replace(None) {
            last.cancel();
        }
        let request = HttpRequest::post("https://api.example.com/save", body.get());
        let task = spawn(async move {
            let _ = fetch(request).await;
        });
        running.replace(Some(task));
    })
}
```

Never apply a result without one of these: two fast presses otherwise end in the order the network picks.

### Cleanup

Tasks, timers, effects, `on_key` bindings, signals, refs and `on_back_press` all belong to the current owner and go with
it: a component, a branch of `when`, a row of `each`, a run of `dynamic` or `effect`, a list cell. Write nothing for
them. `cleanup(|| ..)` is for what NSH does not own, such as a socket or a handle from another crate.

**Do not make owned things in a loop of a long-lived owner.** A `spawn` from a listener lives until the owner goes, or
until it ends by itself. A task that never ends started per press is a leak; hold it and cancel it, as above.

## Desktop

Do not guess these APIs; read the doc first.

- Title bars and window functions: `website/docs/rust.md`, "Desktop title bars", and `website/modules/nsh-desktop.md`.
- File dialogs and paths (`pick_paths`, `pick_save_path`, `open_path`, `reveal_path`, `move_to_trash`):
  `website/docs/rust.md`, "Files and folders". They answer an error on iOS, Android and the web.
- Exporting components, modules and classes to TSX: `website/docs/rust.md`, "Extending a Rust app with TSX", and
  `examples/rust-exports`.

## Before finishing

- A `text(..)` or setter with a value that should change: is it a closure?
- A `.when(..)` or `.child(option)` on something that changes: should it be `when(..)` or `.style_when(..)`?
- `signal(props.x.get())` in a body: remove it, and read the prop.
- Any local signal inside a `virtual_list` cell holding per-item state: move it to data keyed by id.
- A pressable without `.role(AccessibilityRole::Button)` and a `.label(..)` when it has no text: use `button()`.
- `rgb(..)` in app code: use a token.
- `cargo check --all-targets`, then a `Headless` test of what changed ([rust-testing.md](rust-testing.md)).
