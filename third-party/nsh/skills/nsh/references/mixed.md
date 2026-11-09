# Rust + TSX

One app, two languages: a Rust crate owns the core and exports typed components,
modules and classes; TSX screens import them by a specifier. Everything is checked
against declarations generated from the Rust signatures.

Rust UI: [rust.md](rust.md). TSX: [tsx.md](tsx.md). Commands: [tooling.md](tooling.md). This page covers the join.

Every Rust and TSX block here is verbatim from `examples/rust-exports`, which CI compiles and tests. The file is named above each.

## When to pick it

Start from what must ship after the binary does:

| Situation | Mode |
| --- | --- |
| All logic and UI ship in the binary; no JS VM wanted | Rust |
| Rust core, plus screens that change often, experiments, or screens delivered as signed packages | Rust + TSX |
| The app needs a crate (parser, crypto, storage engine, a native view) under TSX screens | Rust + TSX |
| UI delivered at run time, no Rust code of your own, no Rust toolchain | TSX |

Costs of this mode over the other two:

- It carries QuickJS, which a Rust app does not (in the browser, TSX runs on the browser's JavaScript engine).
- It needs the Rust toolchain, and `rustup target add ...` per target. A TSX app needs neither.
- It builds hosts for the app. The first `nsh check` or `nsh test` compiles the crate and NSH's core, a minute or more the first time; later runs reuse it.
- Rust edits restart the app. TSX edits are hot.

A Rust app can gain TSX later: it already has a `#[native_module]`; add an entry and name it (`nsh run App.tsx`).

## What `nsh init --template mixed` writes

```sh
nsh init my-app --template mixed     # add --nsh-source <checkout> to build against NSH's sources
```

| File | What it is |
| --- | --- |
| `nsh.json` | `name`, `id`, `version`, `build` and `"rust": "."`. No `"root"`: that is what makes `App.tsx` the entry |
| `App.tsx` | The entry. Imports `Badge`, `Counter` and `Format` from `<name>/native` |
| `App.test.tsx` | Presses through the app with `nsh/test`, in a headless runner linked with the crate |
| `Cargo.toml` | `nsh-core` and `nsh-base` at the CLI's version, and an empty `[workspace]`, so the app builds alone inside another project |
| `src/lib.rs` | The crate: `#[native_module("<name>/native")]` and one component, module and class |
| `tsconfig.json`, `.gitignore`, `README.md` | `.gitignore` holds `.nsh/` and `target/` |
| `.nsh/types/` | Generated. `.nsh/types/<name>/native.d.ts` appears after the first command that describes the crate |

Templates: `crates/nsh-cli/src/templates/mixed/`. The specifier is the app's name in lower case, words joined by `-`,
then `/native`. `rust-exports` keeps its crate in a subdirectory (`"rust": "native"`); both layouts work.

## The entry point: `#[native_module]`

`native/src/lib.rs`, which `App.tsx` imports as `import { Account, Gauge, Ledger } from "rust-exports/native";`:

```rust
/// The crate's UI set: what `App.tsx` imports from `rust-exports/native`.
#[native_module("rust-exports/native")]
fn native(registry: &mut Registry) {
    registry
        .register::<Gauge>()
        .module::<Ledger>()
        .class::<Account>();
}
```

- One per crate, at the crate's root. Without it the build fails: ``a crate of the app (nsh.json "rust") has no `#[native_module("…")]` at its root``.
- The specifier must be a bare import specifier, and not `nsh` or `nsh/...`.
- The attribute also makes `pub fn registry()`, the same set, for tests and other Rust code.
- What is not registered does not exist in TSX. `` `rust-exports/native` has no export `Nope` `` is a build error.

## Deciding the boundary

Decide per piece of state and per piece of logic. Do not split by screen.

**Rule: each piece of state has one owner, on one side.** The other side holds a view of it and asks for changes.

| Belongs in Rust | Belongs in TSX |
| --- | --- |
| Domain rules, money, parsing, validation that must not drift | Screen composition, navigation, routes |
| Anything CPU-heavy, or that touches files, sockets or a database through crates | Copy, layout, styling, experiments |
| State that must outlive a screen or stay consistent (a ledger, a session, a sync engine) | State of a screen: an open dialog, a filter, a draft, a selected tab |
| A view drawn every frame, or a hard interaction (a chart, an editor surface) | Forms and the order of steps through them |
| Code other apps or crates reuse | What changes often, or arrives as a signed package |

Check a boundary with these questions:

1. **Who writes this value?** The writer owns it. If both sides write it, move it to one.
2. **Must it survive a TSX hot update, or a signed package replacing the screens?** Then Rust owns it.
3. **Is it testable without a screen?** Logic that is goes in Rust, with `cargo test`.

### How one owner looks

Rust owns the balance. TSX keeps a signal that only mirrors it, updated by a listener, and writes only through
methods. The mirror is the one permitted copy: Rust state is invisible to the reactive graph, so TSX needs a signal to
re-render a binding.

`App.tsx`:

```tsx
  const balance = signal(savings.balance);
```

```tsx
  savings.onChange((b) => {
    balance.set(b);
    heard.update((h) => [...h, b]);
  });
```

Two failures to avoid:

- **A getter in JSX does not update.** `<Text>{savings.balance}</Text>` reads a Rust value the graph cannot track, so it never changes on screen. Mirror it in a signal.
- **A write from both sides.** A signal the TSX sets directly and Rust also tracks will drift. Call a method; let the listener or the return value update the signal.

In the other direction, a component's state belongs to whoever renders it. `Gauge` is controlled: TSX owns `spent`
and passes `value={spent()}`; Rust only asks for a change, through `onChange`.

## Component, module or class

| Export | Use for | Registered with | TSX |
| --- | --- | --- | --- |
| Component, `#[component]` | Something drawn, with props and events | `.register::<T>()` | `<Gauge … />` |
| Module, `#[module]` | Stateless functions, and calls to the platform | `.module::<T>()` | `Ledger.format(..)` |
| Class, `#[class]` | State with a lifetime TSX holds: many instances, disposal | `.class::<T>()` | `new Account(..)` |

Choose a class over a module with hidden global state: instances free themselves, tests stay independent, and two of them can exist.

A native component (`#[native_components(linux)]`, a platform view; `native/src/meter.rs`) is a fourth kind, for a
view of the OS. TSX declares it with `nativeComponent`, and props cross as JSON. Where nothing registers it, it is an
empty view. See `website/docs/native-components.md`.

### A component

`native/src/gauge.rs`:

```rust
/// The props of [`Gauge`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct GaugeProps {
    /// The amount spent (required).
    pub value: Prop<f64>,
    /// The budget (100 when left out).
    #[prop(default = 100.0)]
    pub max: Prop<f64>,
    /// What a press adds (10 when left out).
    #[prop(default = 10.0)]
    pub step: Prop<f64>,
    /// The title above the bar, when given.
    pub label: Prop<Option<SharedString>>,
    /// Shown under the bar: the app's own JSX.
    pub children: Prop<Children>,
}

/// The events of a [`Gauge`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum GaugeEvent {
    /// The gauge was pressed: the value it asks for.
    Change(f64),
}
```

TSX gets `value: number`, `max?: number`, `step?: number`, `label?: string | null`, `children?: JSX.Element` and
`onChange?: (event: { value: number }) => void`.

- A required prop is a `Prop<T>` with no default. `#[prop(default = ...)]` and `Option` are optional.
- `ComponentHostProps` adds `class`, `classList`, `style` and the rest of what a `View` takes. A TSX `class` merges after the component's own styles and wins at equal rank.
- An event's handler takes one object. A one-value variant's field is `value`; `#[args(price)]` renames it, and `#[args(open, reason)]` names a two-value variant's fields. A variant with no data gives `() => void`.
- Read props in a closure (`move || props.value.get()`). Read in the body, a prop is read once, as in TSX.
- A prop of the wrong type at run time is a warning, not a throw: the prop keeps its value and the rest render.
- A Rust component's own state stays private. TSX passes props and hears events; to call into it, add `#[methods]` ref methods (`docs/dev/components.md`).

Two more prop kinds have no example in `rust-exports`:

- `Prop<Option<Renderer<T>>>` is `(value: T) => JSX.Element`, content the app draws. Rust calls `r.render(key, value)`, which returns a view it can style and place. Content is kept per key while the value stays equal. `TextView` uses it.
- `Prop<Option<SharedString>>` named `symbol_class` is `symbolClass?: string | null`. Apply it with `.app_class(props.symbol_class)` on an element, so the app's Tailwind classes reach that part.

### A module

`native/src/ledger.rs`:

```rust
    /// `amount` as money: `$1,234.50`, `-$3.00`.
    // No `cx`, not `async`: it runs inside the TS call and returns the
    // string itself.
    pub fn format(amount: f64) -> String {
        money(amount)
    }
```

`#[module]` goes on the struct and on the `impl`. `pub fn` and `pub(crate) fn` are exported; a `fn` with no visibility stays in Rust.

### A class

`native/src/account.rs`:

```rust
    /// Adds a month's interest at `rate`, settled by a (pretend) bank
    /// after 200 ms; resolves with the new balance.
    // An `async` member runs as a task of the core: a Promise. `this`
    // keeps the instance until the task ends; `with` / `with_mut` borrow
    // it between awaits.
    pub async fn accrue(this: Instance<Self>, rate: f64) -> f64 {
        timer(Duration::from_millis(200)).await;
        this.with_mut(|account| {
            let interest = (account.balance * rate * 100.0).round() / 100.0;
            account.book(interest);
            account.balance
        })
    }
```

`new` is the constructor; without one, TSX cannot `new` the class, only receive it. No `self` is a static. `#[getter]` and
`#[setter]` (`name`, `set_name`) make one property. A getter with no setter is read-only.

TSX frees an instance three ways: the object is collected, `.dispose()`, or `using draft = Account.parse("Draft: 10")`, which frees it at the end of the block.
Use after disposal throws `TypeError: Account is disposed`.

## Signature to TS, and how the call runs

**The Rust signature decides how a call runs.** Read this table when writing any exported function.

| Rust | TS | Runs | Failure |
| --- | --- | --- | --- |
| `fn f(a: f64) -> T` | `f(a: number): T` | Inside the JS call, synchronously | Wrong argument throws `TypeError`; a panic throws `Error` |
| `fn f(a: f64) -> Result<T, E>` | `f(a: number): T` | Same | `Err` throws `Error` with the message |
| `fn f(cx: &mut ModuleCx)` | `f(): void` | Op, at the commit, in order with the UI | Nothing answers it. A wrong argument still throws in the call |
| `fn f(cx: &mut ModuleCx) -> Result<(), E>` | `f(): Promise<void>` | Op | `Err` rejects |
| `fn f(cx: &mut ModuleCx) -> T` | `f(): Promise<T>` | Op | Wrong argument rejects |
| `async fn f() -> T` | `f(): Promise<T>` | Task of the core, on the engine thread | Wrong argument, `Err` and panic all reject. It never throws |
| `async fn f()` | `f(): Promise<void>` | Task | Resolves when the task ends |

All of these rows were compiled and called from TSX. A wrong argument names the member and the parameter:
``TypeError: Ledger.format: `amount`: expected a number, got "x"``.

### What each kind may do

- **Synchronous** computes and keeps state. It runs outside the reactive runtime, so `signal(..)` panics, and TSX gets `Error: no reactive runtime: signals are used on the engine thread, while components run`. The same goes for `theme()`, `dialog` and the other UI free functions.
- **`cx: &mut ModuleCx`** reaches the platform in order with the changes TS made before the call: `set_clipboard`, `dialog`, `dismiss_keyboard`, `set_status_bar`, `animate_layout`, `announce_for_accessibility`, `set_color_scheme`.
- **`async`** gets the core's services: `timer`, `fetch`, dialogs. Move blocking work off the thread with `blocking(..)`, and async work with `background(..)`; those two are for native targets. It runs on the engine thread, so a long synchronous stretch inside a task freezes updates.

A synchronous call that blocks freezes the app too. A synchronous call costs about what a JS method call does, so crossing is rarely a reason to move code. Embedded under limits, a call over its budget (default 2 s) is cut off.

### Argument and result types

| Rust | TS |
| --- | --- |
| `f64`, `f32`, integers | `number`. Integers take whole numbers in range; `1.5` is a `TypeError`, not rounded |
| `bool`, `String`, `SharedString` | `boolean`, `string` |
| `Option<T>` | `T \| null`; a trailing one is also optional (`opening?: number \| null`) |
| `Vec<T>` | `T[]` |
| `Vec<u8>` | `Uint8Array`, copied. A `Buffer` is accepted |
| `SystemTime` | `Date` |
| `JsonValue` | Any JSON value |
| `#[derive(JsObject)] struct` | `interface`: fields in camelCase, doc comments kept, an `Option` field optional |
| `#[derive(PropEnum)] enum` of unit variants | String union: `SellShort` is `"sellShort"` |
| `Callback<f64>` | `(value: number) => void` |
| `#[args(value, index)] Callback<(f64, u32), bool>` | `(value: number, index: number) => boolean` |
| `Stop` | `() => void` |
| A `#[class]` value, or `Instance<T>` | The class. One object per live instance: `a.badge === a.badge` |
| `&T`, `&mut T` of a class, in a class's sync member | The class, borrowed for the call |

**Limits the compiler enforces.** A *module* function must take `Instance<T>`, not `&T`:
`error: a module function takes values: an instance as Instance<T>`. Only class members borrow. `async` members also
take `Instance<Other>`.

`rust-exports` has no `JsObject`, `PropEnum`, `Stop` or `Renderer`. For compiled uses see `crates/nsh-base/src/select.rs` and `crates/nsh-base/src/data_table/mod.rs`.

### Callbacks

`native/src/account.rs`:

```rust
    /// Calls `listener` with the new balance after every change.
    // A `Callback` is the TS function; kept here, it is called with `post`
    // from wherever the balance changes (see `book`).
    // `#[args(..)]` names the callback's arguments in TS:
    // `(balance: number) => void`.
    pub fn on_change(&mut self, #[args(balance)] listener: Callback<f64>) {
        self.listeners.push(listener);
    }
```

| Method | Where | Result |
| --- | --- | --- |
| `cb.call(args)` | Only inside a synchronous call from JS | `Result<R, String>`, at once. The JS exception is the `Err` |
| `cb.post(args)` | Anywhere on the engine thread | Queued for JS's next turn, in order. Result dropped |
| `cb.call_async(args).await` | In a task | `Result<R, String>` |

`call` in a task panics, and TSX sees: ``Error: `Callback::call` runs the function inside a synchronous call from JS; elsewhere (in a task) use `post` or `call_async` ``.
During `call` the instance stays borrowed: a callback reaching the same instance throws.

### Listening: `Stop`

A function that starts listening is named `on_*` or `on(event, listener)` and returns `Stop`, built with `Stop::new(|| ...)`.
TS gets `() => void`. It runs once: when TSX calls it, or when the owner of the call goes (the component, or the module's
run under hot reload). So a listener added in a component body needs no manual cleanup.

`Account.on_change` above returns nothing, so its listener lives as long as the instance. Prefer `Stop` for anything a screen subscribes to.

## Doc comments become the types

Generated `.nsh/types/<specifier>.d.ts` is what `nsh check` and the editor use. Do not edit it.

- A component is documented by its `#[component] fn`, not the props struct; a module or class by its struct; a prop, event, function or member by its own.
- TS shows a doc comment up to its first heading. Put Rust-only notes under `# Rust`, `# Panics` or `# Examples`.
- `//` comments stay in Rust.
- A `///` on a `#[module]` or `#[class]` `impl` block is a compile error: ``document the export on its struct, not on the `#[module] impl` block``.
- An undocumented export warns on each command that writes types: `warn <specifier> exports one item without a doc comment, which TSX sees in its declarations: Counter.increment`.

`native/src/ledger.rs`, a note kept out of TS:

```rust
    /// Puts `text` on the clipboard; resolves with the number of
    /// characters copied.
    ///
    /// # Rust
    ///
    /// Taking `cx` makes it an op, run in order with the UI changes TS made
    /// before the call (the platform's services are on `cx`). Returning a
    /// value makes it a Promise of the value; returning `()` it would be a
    /// plain call (`void`), and returning `Result<(), E>` a
    /// `Promise<void>`. What follows a heading stays in Rust's docs, out of
    /// TS's.
    pub fn copy(text: String, cx: &mut ModuleCx) -> u32 {
```

TS gets only `Puts ... copied.` and `copy(text: string): Promise<number>`.

## Several crates

`"rust"` takes a list, `"rust": ["native/charts", "native/storage"]`. Each listed crate is a library with its own `#[native_module]` and its own specifier:

- Every host and runner links them all, and `.nsh/types` declares each specifier.
- Share code with Cargo path dependencies. Only listed crates export to TSX.
- A crate listed twice, two crates with one package name (`-` and `_` count as one), or two with one specifier all fail with both paths named.
- With a `"root"`, it is a component of the first crate listed.

## The dev loop

| Edit | What happens | State |
| --- | --- | --- |
| A TSX file | Hot update, about 120 ms | Edited components render again. Others keep theirs |
| A top-level `signal(..)` or `createNavStack(..)` | Kept if its initializer is unchanged | Value kept |
| Module-level code that changed | Runs again | A module-level `new Account(..)` makes a new instance; the old state is gone |
| `capabilities` in `nsh.json`, a first import of a new NSH module | Full reload | Fresh |
| Rust in a listed crate, or a path dependency | Describe, rebuild, restart | All state is gone. Keep what must survive in `Storage` |
| A Rust signature | As above, and `.nsh/types` is rewritten | TSX then fails `nsh check` until it is fixed |

A Rust build error prints in the terminal, and the next save that compiles runs. A host built for another app gets no
build; it shows why, and the terminal prints a `warn` with the command that installs the right host. `nsh dev`
watches the same files.

## Tests on both sides

```sh
nsh test                  # cargo test for each crate in the directory, then the *.test.tsx files
nsh test App.test.tsx     # that file only, in a headless runner linked with the crate
nsh check                 # cargo check --all-targets for each crate, then tsc over the TSX
```

| Test | Tool | Covers |
| --- | --- | --- |
| Rust logic | `#[test]` in the crate | Rules, parsing, classes used as plain Rust |
| Exports as TSX sees them | `App.test.tsx` | The real signatures, conversion, errors, and presses through the UI |
| The TSX entry from Rust | `nsh_testing::tsx` (feature `bundle`) | Same, plus `app.screen().sent(..)` on commands |
| The declarations | `nsh_core::element::declarations` (feature `declarations`) | The `.d.ts` text, and `registry().undocumented()` |

See `examples/rust-exports/native/tests/rust_exports/`. Dev-dependencies: `nsh-core` with `declarations`, `nsh-engine`, and `nsh-testing` with `bundle`.

Test on a platform (`nsh test --target macos`) only what needs real input or a native component. Headless runs have no platform views, so a `#[native_components]` view is empty there.

## Signed packages

A package holds **TSX only**: JS source, bytecode, a source map and assets. It holds no Rust.

- Crates ship inside the host binary. A package imports them by specifier, and they must already be there.
- `nsh publish` does not deliver or update Rust. A change to a Rust signature needs a new host release.
- A package importing a specifier its host does not register fails to load: `could not load module '...' (only registered native modules and bundle chunks can be imported at run time)`.
- Treat exports as a public API between host and packages. Add; do not rename or change types. Old packages keep running against new hosts, so a renamed member breaks them when called.
- Gate a package on the host with `--min-runtime` (or `nsh.json` `minRuntime`). That covers NSH's runtime version, not your crate's. Version your crate's API yourself, for example with an exported `Version` function.
- A package also runs under the host's capability grants, and in hardened mode (no `eval`, frozen prototypes).

Details are in [tooling.md](tooling.md#signed-packages).

## Failure modes

| Symptom | Cause | Fix |
| --- | --- | --- |
| TSX shows an old value from Rust | Getter read in JSX, untracked | Mirror it in a signal; update it from a listener or a return value |
| `no reactive runtime` | `signal`, `theme()` or `dialog` in a synchronous function | Make it `async` or take `cx`; or do it in TSX |
| `` `Callback::call` runs the function inside a synchronous call `` | `call` in a task | `post` or `call_async` |
| An unhandled rejection in the log | An op returning `Result<(), E>`, or an `async` call, nobody awaits | `await` it or `.catch` it |
| `` `x/native` has no export `Y` `` | Not registered in `#[native_module]` | `.register`, `.module` or `.class` |
| `` `T: Module` is not satisfied `` | `#[module]` on the struct but the `impl` failed, or the reverse | Read the first error; it is usually in the `impl` |
| `Account is disposed` | Used after `dispose()` or the end of a `using` block | Do not keep the object past its scope |
| A re-entrant call throws | A callback reaches the instance `call` is borrowing | `post` instead |
| A panic ends the page on the web | The web runtime is `panic = "abort"`; natively a panic is caught | Return `Result`; do not rely on catching panics |
| Cargo errors about versions or a mismatch | `nsh-*` crates from different sources | All from one place, at the CLI's version |
