# Reactive Rust components (design proposal)

Status: implemented. `docs/dev/components.md` is the reference for the API as built; this page keeps the proposal
and its reasons. The components it takes as examples (`Button`, `Stepper`, `Sheet` of `nsh-ui-mobile`) were NSH's own
when it was written; NSH now ships capabilities and no styled components, and the same API writes an app's own. Where the implementation differs from the proposal:

- **The shape.** `#[component] fn Stepper(props: StepperProps, cx: Scope<StepperEvent>) -> impl IntoElement`:
  `Scope` is typed by the event, not the component (it only emits, reads the insets and registers methods), and the
  trait's one function is `Component::view`. Methods are an API type (`#[methods] impl StepperApi`, `&self` methods
  over the signals they read and write) the view registers with `cx.methods(..)` and the component names with
  `#[component(methods = StepperApi)]`; Rust calls them with `ComponentRef::api::<StepperApi>()`.
- **Bindings queue patches, not ops.** A binding's run queues a `Patch` with the part's new value (`core/views.rs`),
  which the core applies against what it applied last with the field diffs it has for host props, styles and list
  layouts, so the kind-by-kind prop diff, style lowering and class merging stay in one place. `Expanded`,
  `reconcile_children` and `reconcile_node` stay too: they mount a view and reconcile a region's elements by key.
- **Rows read a `Position`.** A list cell's content, and the wrapper of an app's row, is made once and reads its row
  through a `Position` (signals of its index and the row count): a memo of the list's count and keys moves the
  cells' index signals before the bindings that read them run, so a splice runs only the moved rows' bindings.
- **Error boundaries reset.** `catch_error(|| view, |error, reset| fallback)`: `reset.reset()` makes the view again.
  Failures go to the nearest boundary of the owner they happened under (`boundary_of`), never by walking the tree.
- **Modules keep a context for sync functions.** A sync `#[module]` function may take `&mut ModuleCx` (the
  platform's services, applied in order right after the call); an `async fn` takes none and uses the free functions.
- **Views JS made adopt the owner above them.** A component JS creates among another's JS children is made once its
  host is in the tree, under the owner of where the component above places its children, so context and failures
  reach it.
- **The first frame costs more.** "The first render costs about the same" did not hold: 200 Buttons take ~40%
  more core time to mount (1.04ms against 0.75ms; JS is unchanged), the bindings' computations and the props'
  signals that make every later update cost only what it changes (`docs/dev/performance.md`). A binding's first
  value is applied with its element's static parts, not as a patch after them.
- **One pull request**, not one per step: the old model went in the same change.

Rust components move from today's model (a component's `render` runs again on every change, the core rebuilds its
element tree and diffs it against the last one) to the model TSX already uses: **a component runs once, signals drive
fine-grained bindings, nothing is diffed**. The reactive graph that JS runs on (Solid 1.9's algorithm, written in Rust
in `nsh-js`) becomes a generic graph in `nsh-core` that both sides instantiate.

## Why

An update costs what it changes, not what was rendered.

- Today a change anywhere in a component rebuilds the component's whole element tree (`ElNode`s, their strings and
  styles) and compares it node by node with the last render (`reconcile_children` / `reconcile_node`,
  `core/components.rs`). The cost grows with the size of the component, not with the size of the change. Keeping it
  small is left to the app: split components finely and make their props `PartialEq` so unchanged children skip their
  render (`AnyInstance::set_props`), React's `memo` problem.
- With fine-grained bindings a change runs exactly the bindings that read it, and each binding sends one operation.
  There is no tree to rebuild, nothing to compare, no allocation for it. A large form, a screen with a ticking clock, a
  progress bar or a live feed in a big component costs the same as in a small one.
- It is the model TSX apps already have (`docs/dev/architecture.md`: "Components run once. Only bindings re-run"). The
  rule "what TSX can write, Rust can write" becomes the same way of writing, not just the same capabilities: a
  component body that runs once, `signal`, `computed`, `effect`, `cleanup`, `when`, `each`.

What does not change: the first render costs about the same; structural changes (rows added, removed, reordered)
are still reconciled by key, as `Each` does in JS; layout, text and the core's frame and style diffs are the core's in
both models.

## Goals and non-goals

Goals:

- One reactive algorithm, in `nsh-core`, generic over what a value and a computation are. JS keeps exactly its current
  behavior and speed; Rust components run on the same algorithm.
- Rust components that run once, with typed, `Copy` signals, static values at zero cost, and bindings only where a
  value changes.
- The Rust view layer emits the same `Op`s JS does. The core stops expanding and diffing renders; the code that does
  (`render_components`, `reconcile_*`, `Expanded`, the scans for readers: about a third of `core/components.rs`'s
  2,878 lines) goes.
- The JS face of components does not change: props, events, slots, children, items and methods keep their specs, and
  the generated TypeScript stays the same.

Non-goals (for now):

- Sharing signals across the JS / Rust boundary. JS passes a Rust component props (as today, one op per changed prop)
  and hears its events. One graph per side, both the same code. A shared graph stays possible later (see "Open
  questions").
- Changing styles' vocabulary. `Styled`'s ~1,470 methods keep their names and meaning; they gain reactive arguments.

## The reactive graph in `nsh-core`

`nsh-js/src/reactive.rs` (1,959 lines) is about 530 lines of Solid's algorithm written over node indices (`run_updates`
through `dispose`, lines 242–774) and about 900 lines of QuickJS plumbing (classes, GC marks, finalizers, natives,
exceptions). The algorithm moves to `nsh_core::reactive`, generic over a host:

```rust
/// What a graph stores and runs. JS: `JsValue`s and JS functions; Rust:
/// boxed Rust values and closures.
pub trait Host: 'static {
    type Value;                       // a signal's or memo's value
    type Func: Clone;                 // a computation (cloned out before it runs: it re-enters)
    type Equals;                      // how a write or a memo compares
    type Error;                       // what a computation can fail with
    fn run(&self, f: &Self::Func, prev: Option<&Self::Value>) -> Result<Self::Value, Self::Error>;
    fn changed(&self, eq: &Self::Equals, old: &Self::Value, new: &Self::Value) -> bool;
    fn release(&self, held: Held<Self>);  // values leave the graph before they are freed
}

pub struct Graph<H: Host> { /* nodes: Vec<Node<H>>, free list, generations,
                              listener, owner, update and effect queues, ... */ }
```

- Storage stays an arena of nodes with generations and two-way edges, as today (`alloc`, `track`, swap-remove
  unlinking). No `Rc` per node.
- The rules that make re-entry safe stay: nothing holds a borrow of the graph across a call into a computation or a
  release; values are taken out of a node before they are freed (`Held`).
- `nsh-js` instantiates `Graph<JsHost>`: `Value = JsValue`, `Func` a JS function, `Equals` `Strict | Never |
  Custom(JsValue) | Truthiness`, errors are exceptions. Its classes, `gc_mark`, `finalize`, `signal_call` and the
  natives stay in `nsh-js`; they call the generic graph.
- Rust instantiates `Graph<RustHost>`: `Value = Box<dyn Any>` (or a small-value optimization for `Copy` types up to 16
  bytes), `Func = Rc<dyn Fn(Option<&dyn Any>) -> Box<dyn Any>>`, `Equals` a comparison function taken from
  `PartialEq` where the type has it, errors are panics caught at the computation (as Rust components' renders are
  caught today).
- Monomorphization keeps JS at today's speed. The bar is the benchmarks in `docs/dev/performance.md` (a counter tap
  ~47 µs, a list rebind ~4 µs per frame) and `nsh-engine`'s `bench_gallery_scroll`; the extraction lands only if they
  hold.

The extraction is its own step with no behavior change: `reactive.rs`'s 265 lines of tests move with the algorithm and
run against both hosts; the engine tests and the TSX gallery's tests are the safety net.

## The Rust API

### Signals and friends

Free functions, as in TSX (`import { signal, computed, effect, ... } from "nsh"`). They act on the current reactive
runtime, which the engine sets while it runs Rust code on its thread (each engine thread has its own; a call with no
runtime panics with a message that says so).

```rust
let count = signal(0);                 // Signal<i32>: Copy, 8 bytes (index + generation)
count.get();                           // tracked read (clones; `.with(|v| ..)` borrows)
count.set(1);                          // write; dependants run if it changed
count.update(|n| *n += 1);
let doubled = computed(move || count.get() * 2);   // Memo<i32>, also Copy
effect(move || log::info!("count {}", count.get()));
cleanup(|| { /* when the owner is disposed or the effect runs again */ });
batch(|| { a.set(1); b.set(2); });
untracked(|| count.get());
```

- `Signal<T>`, `Memo<T>` and `ReadSignal<T>` (`signal.read_only()`) are `Copy` handles into the arena, so closures and
  async blocks capture them without cloning anything. A handle whose node was disposed reads as gone: `get` panics with
  the signal's creation site; `try_get` / `try_set` return `None` / `false` (what `WeakComponent::update`'s `None` is
  for today).
- Equality: `signal(v)` requires `T: PartialEq` and skips writes of an equal value, as TSX's default `===` does.
  `signal_with(v, Equals::Never)` notifies on every write and needs no `PartialEq`. `computed` requires `PartialEq`.
- Owners are Solid's: a component's body, an effect, a branch of `when`, a row of `each` and a list cell each own what
  they create, and dispose it (signals, effects, timers, tasks, subscriptions) when they go.

### Components

A component is a unit struct (its name is still its type's name, so the registry, `NAME` and the generated TypeScript
stay as they are) and one function that runs once:

```rust
#[derive(Default)]
pub struct Counter;

impl Component for Counter {
    type Props = CounterProps;
    type Event = CounterEvent;

    fn render(props: CounterProps, cx: Scope<Self>) -> impl IntoView {
        let count = signal(props.start.get_untracked());
        view()
            .flex_row()
            .gap_3()
            .child(text(move || format!("{}", count.get())))          // a binding
            .child(
                Button::element(ButtonProps { title: "+".into(), ..Default::default() })
                    .on_event(move |_| {
                        count.update(|n| *n += 1);
                        cx.emit(CounterEvent::Change(count.get_untracked()));
                    }),
            )
    }
}
```

- `render` runs once. `setup`, `props_changed`, `environment_changed`, `cleanup` and `cx.notify()` go: their jobs are the
  body, an `effect` on a prop, an `effect` on the environment, `cleanup(..)`, and writing a signal.
- `Scope<Self>` is `Copy` and carries what is the component's own: `emit`, `methods` (below), element and component
  refs. Everything else is a free function.
- Listeners are plain closures (`move |e| ..`) that capture signals. They no longer receive `&mut Self` and props, so
  `cx.listener(..)` and `Listener::map` go.

**Props** are reactive. `#[derive(Props)]` keeps its attributes (`default`, `rename`, `lazy`) and its decoding (now typed, below), and
each field becomes readable in a binding:

```rust
#[derive(Props)]
pub struct StepperProps {
    pub value: Option<f64>,
    #[prop(default = 100.0)]
    pub max: f64,
    ...
}
// In render, `props.max` is a `Prop<f64>`: `props.max.get()` tracks it.
```

- From JS, a changed prop writes that prop's signal: the JS face decodes it into the field's type when JS sets it
  (`PropSpec::decode`; a wrong type is a warning, as a host prop's, and the prop keeps its value) and sends the value (`Op::SetProp { RustProp }`, an `AnyValue`),
  which the core moves into the signal. Only the bindings that read it run.
- From Rust, a parent passes each prop as a value, a signal or a closure: `ButtonProps { title: "Save".into(),
  disabled: busy.into(), .. }`. The field type is `Prop<T>`, built from any `Into<Reactive<T>>`.
- `Props: Clone + PartialEq` and the parent-side equality skip go: there is nothing to skip.

**Events, methods, refs**

- `cx.emit(event)` from any closure. To a Rust parent it calls the `.on_event(..)` closure; to JS it is a `NativeEvent`
  as today.
- Methods JS calls on a ref: `#[methods]` moves from the component to a handle the body makes. It holds the signals the
  methods read and write: `cx.methods(StepperApi { value })` with `#[methods] impl StepperApi { fn set_value(&self, v:
  f64) {..} fn value(&self) -> f64 {..} }`. (JS's calls now cross typed: `docs/dev/rust-classes.md`, "How calls
  cross".)
- `element_ref()` and `component_ref()` become free functions returning `Copy` handles owned by the current owner;
  `.element_ref(r)` on an element attaches it once.

### Views: static by default, bindings where values change

Elements are built once. Every setter takes `impl Into<Reactive<T>>`, which a value, a signal, a memo or a closure is:

```rust
text("Order book")                                  // static: set once, no binding, no allocation
    .text_size(px(15.0))
    .text_color(colors::MUTED);

text(price)                                         // a signal: bound directly, no closure
text(move || format!("{:.2}", price.get()))         // derived: a closure
view().opacity(fade)                                // fade: Signal<f32>
view().bg(move || if up.get() { colors::UP } else { colors::DOWN })
view().w(move || px(width.get()))
```

- `Reactive<T>` is `Static(T) | Bound(Rc<dyn Fn() -> T>)` (a signal or memo converts into a reader without a box).
  Static setters compile to what they do today. Most of a view is static: layout, sizes, fixed colors and texts.
- A bound setter becomes one render effect on the node. Its first run sets the value; later runs send one op
  (`Op::SetStyle`, `Op::SetProp`, `Op::SetText`), and none when the value is equal to the last one. This is what JS's
  `bindProp` does (`dom.rs`).
- Styles stay typed. `StyleRefinement` gains reactive declarations: the static part lowers once (the same cached
  `ClassList` as today); each bound declaration is one effect that sets that one property.
- Styles that depend on app state: `.style_when(selected, |s| s.bg(theme.accent))` takes a reactive condition,
  lowers the extra layer once, and the binding switches it on and off. Native states (`.active`, `.hover`, `.dark`,
  `group_*`) stay native and need no binding, as today.
- `AnimatedValue` animation bindings (`bind_opacity`, `bind_translate_y`, ...) stay: they are bindings already, evaluated
  on the UI thread. A plain signal is for values the app computes; an animated value for values the UI thread drives.

### Control flow

The TSX primitives, with the same semantics and the same keyed reconciliation:

```rust
when(open, move || sheet_body())                 // <If when={open()}>…</If>
    .otherwise(move || text("Closed"))
each(move || rows.get(), |row| row.id, move |row, index| row_view(row, index))
                                                    // <Each of={rows()} key="id">{(row, i) => …}</Each>
dynamic(move || if wide.get() { two_columns() } else { one_column() })
```

- A branch of `when` and a row of `each` own what they create, and dispose it when they go.
- `each`'s row gets its item and its index as signals: a moved row keeps its nodes and updates its index binding.
- `.when(bool, ..)` and `.children(Option)` stay, with a plain `bool` / `Option`, for choices made once when the view
  is built. A choice that changes is a `when` (structure) or a `.style_when` (style).
- Lists: `virtual_list(count, move |index| row(index))` makes each cell's content once; when the cell shows another
  row, its `index: ReadSignal<usize>` changes and only the bindings that read it run. This is how JS's list cells work
  (`list::bind` writes the cell's item and index signals). Today every live cell renders again whenever the owner does.

### Children, slots, items

- `props.children` and `props.header` (a `Slot`) are placed once where the body puts them. Lazy children (`#[prop(lazy)]`)
  are made while the place that holds them is mounted: `when(open, move || props.children)` makes them only while
  open, as `Sheet` needs. The event that tells JS stays (`JsEvent::Children`).
- `children_each(children, |child, at| ..)` and `list(items, ..)` become `Each`-like: one wrapper per JS child, made
  once, with `at` as a signal.

### Context, globals, environment, theme

- `provide(value)` and `use_context::<T>()`: Solid's context, on the owner tree, as JS has it. `cx.provide` /
  `cx.context` go, and so does the core's scan of every instance for readers (`provided_changed`).
- Globals become signals: `global::<Routes>()` returns the app's one `Signal<Routes>`, made on first use under the
  root. `update_global` is `.update(..)`. The scan of every instance for readers (`mark_global_readers`) goes.
- The environment is a set of signals the core writes when it changes: `env().dark`, `env().window`,
  `env().keyboard_height`, `env().locale`, ... Reading one in a binding is the subscription; `environment_changed` is
  an `effect`. `color(AdaptiveColor)` reads `env().dark`.
- `theme()` is a signal too, so a new theme updates the bindings that read it instead of re-rendering everything.

### Tasks, timers, services

- `spawn(async move { .. })` runs on the engine thread as today and is owned by the current owner: it is cancelled
  when the owner goes. Async code writes signals directly; `WeakComponent`, `this.update(..)` and `Updated` go.
- `set_timeout`, `set_interval`, `request_animation_frame`, `timer(..).await`, `next_frame().await`: free functions,
  owned the same way. Dropping the returned handle still cancels early.
- `resource(source, fetcher)` (TS: `resource`): a render effect reads the source and spawns the load, whose task the
  next run (or the owner's disposal) drops, cancelling what it awaited; the value, error and state are signals, and
  which load counts is `nsh_core::resource::Runs`, the JS face's too.
- Platform services (`dialog`, `set_clipboard`, `clipboard_string`, `announce`, `image_size`, ...) become free
  functions on the current runtime, as `nsh/*` modules are free functions in TSX. `Context`, `RenderCx` and `AsyncCx`
  go; `ModuleCx` keeps only what a module call needs.
- `on_back_press(f)`: registered for as long as its owner lives. Listening only while something holds is an effect:
  `effect(move || if intercept.get() { on_back_press(|| { .. true }) })`.

### Errors

`catch_error(move || risky_view(), |error| fallback(error))` is the error boundary (`catch_error` on the component
today): a panic in a computation or a listener under it disposes the failed part and shows the fallback.

## How it runs

The Rust view layer becomes the Rust counterpart of `nsh-js/src/dom.rs`: it creates nodes (odd ids, as today), installs
bindings, and pushes `Op`s into a queue the core applies, exactly as JS's ops are applied.

1. A component's host node is created by JS or by a Rust parent. The core runs its `render` once under a new owner
   and applies the ops it queued.
2. Events for its nodes go to the closures registered for them (the core's routing of odd ids stays); a closure writes
   signals; the graph runs the dependent bindings in one batch; their ops are applied before the commit.
3. A prop from JS writes the prop's signal in the same way.
4. Releasing the host disposes the component's owner: its bindings, its tasks and timers, its back listeners and its
   child components.

What leaves the core: `render_components`, `MAX_RENDERS`, `Expanded`, `reconcile_children` / `reconcile_node` /
`reconcile_raw`, `Attrs::changes`, `ListConfig::changes`, per-render handler tables, `RenderReads` and the scans for
readers of the environment, globals and context, `AnimatedNode::derive`'s de-duplication (it existed because renders ran
again), the "absent means default" resets. What stays: host nodes, odd ids, prop decoding, event routing, slots and
children holders, the JS glue, the declarations.

## Example: `Stepper`

At the time (`crates/nsh-ui-mobile/src/stepper.rs`, 230 lines): state in fields, `setup` and `props_changed` to keep the value
in range, `Context` methods, a `spawn` with `this.update(..)` to repeat while held, and a render that runs again on
every step.

Proposed:

```rust
#[derive(Default)]
pub struct Stepper;

impl Component for Stepper {
    type Props = StepperProps;
    type Event = StepperEvent;

    fn render(props: StepperProps, cx: Scope<Self>) -> impl IntoView {
        let range = computed(move || Range::of(&props));
        // Our value, kept on the grid and within the bounds; the app's when it controls it.
        let own = signal(range.get_untracked().fit(props.default_value.get_untracked()));
        let value = computed(move || range.get().fit(props.value.get().unwrap_or(own.get())));
        let repeat = signal_with(None::<Task<()>>, Equals::Never);

        let change = move |next: f64| {
            if next == value.get_untracked() {
                repeat.set(None);
                return;
            }
            if !range.get_untracked().controlled {
                own.set(next);
            }
            cx.emit(StepperEvent::Change(next));
        };
        let step = move |direction: f64| {
            let range = range.get_untracked();
            change(range.fit(value.get_untracked() + direction * range.step));
        };
        let press = move |direction: f64| {
            step(direction);
            repeat.set(Some(spawn(async move {
                timer(HOLD).await;
                while repeat.with(Option::is_some) {
                    step(direction);
                    timer(REPEAT).await;
                }
            })));
        };
        effect(move || if props.disabled.get() { repeat.set(None) });
        cx.methods(StepperApi { value, change, range });

        let button = move |label, name, direction: f64, at_bound: Memo<bool>| {
            let off = computed(move || props.disabled.get() || at_bound.get());
            view()
                .size_10()
                .items_center()
                .justify_center()
                .rounded(theme().radius)
                .bg(theme().muted)
                .active(|s| s.bg(theme().border))
                .style_when(off, |s| s.opacity(0.4))
                .disabled(off)
                .role(AccessibilityRole::Button)
                .label(name)
                .on_press_in(move |_| press(direction))
                .on_press_out(move |_| repeat.set(None))
                .child(text(label).text_size(px(21.0)))
        };
        view()
            .flex_row()
            .items_center()
            .gap_3()
            .child(button("−", "Decrease", -1.0, computed(move || value.get() <= range.get().min)))
            .child(text(move || format!("{:.*}", decimals(range.get().step), value.get())))
            .child(button("+", "Increase", 1.0, computed(move || value.get() >= range.get().max)))
    }
}
```

A step now updates the number's text and, at a bound, one button's opacity and `disabled`: three small bindings, where
today the whole stepper renders and is diffed.

## Migration

One step per PR, each green on its own. The old API is gone at the end; there is no long-term second way.

1. **Extract the graph.** `nsh_core::reactive::Graph<H>`; `nsh-js` on `Graph<JsHost>`. No behavior change. Gate: the
   reactive tests on both hosts, the engine and gallery tests, and the benchmarks unchanged.
2. **The Rust runtime and view layer.** `Graph<RustHost>`, signals, owners, `Reactive<T>` setters, `If` / `Each` /
   `dynamic`, the op-emitting view layer, context, environment and theme signals, tasks and services as free
   functions. The new `Component::render(props, cx)` lives beside the old trait for the length of the migration. The
   core component tests (`core/tests.rs`, 28 components in `mod components`, `touch`, `painter`) are rewritten on it.
3. **`nsh-ui-mobile`.** 11 components (5 `notify`, 12 listeners). Their JS face and generated TypeScript are checked to
   be identical; the engine's `components.rs` tests (19, through the JS glue) and `rust_*.rs` tests (18) pass.
4. **The Rust gallery.** 91 components (185 `notify`, 246 listeners), file by file. Its 56 black-box tests hold
   unchanged: they only see mount batches.
5. **Remove the old model.** The old `Component` trait, `RenderCx` / `Context` / `AsyncCx`, the core's render and diff
   code; `docs/dev/components.md`, the `nsh-ui-mobile` README and `AGENTS.md` rewritten; `component_bench` rerun, with
   a new benchmark of the case this is for (one value changing often in a large component) in both models.

## Decisions

1. **Components are functions.** `#[component] fn Stepper(props: StepperProps, cx: Scope<Stepper>) -> impl IntoView`
   generates the unit struct (named after the function) and the `Component` impl, so the registry and the TypeScript
   are unchanged. The trait stays underneath.
2. **One graph per side.** JS and Rust each instantiate the generic graph; the boundary stays at props and events. The
   generic graph keeps a shared one possible later.
3. **Equal writes are skipped.** `signal(v)` requires `PartialEq` and skips writes of an equal value (TSX's `===`);
   `signal_with(v, Equals::Never)` notifies on every write and needs no `PartialEq`.
4. **A component's root can be anything.** The rule that a component's root is a plain view merged into its host
   existed for diffing; it goes. A component can render a screen, a modal or a stack: its root element's node is the
   host's content, and the host is a pass-through.
