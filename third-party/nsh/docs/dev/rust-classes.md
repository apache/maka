# Classes and functions from Rust

Status: implemented (`nsh_core::element` `class.rs`, `callback.rs`, `call.rs`, `js.rs`; `nsh-macros` `class.rs`;
`nsh-js` `classes.rs`, `components.rs`); "Implementation notes" at the end says where it differs from the
proposal.

An app's Rust crate (`nsh.json` `"rust"`) exports components, modules (`#[module]`: functions) and classes
(`examples/rust-exports`: one of each, every member kind below, used from TSX and tested headless). This
describes classes: a Rust type that TypeScript uses as a class, with a constructor, methods, getters and setters, statics and
instances that keep their state in Rust; synchronous functions on the same footing; and how NSH's own standard
library shares the machinery.

```rust
/// A tally kept in Rust.
#[class]
pub struct Tally {
    count: i64,
    log: Vec<String>,
}

#[class]
impl Tally {
    /// Starts at `start` (0 when left out).
    pub fn new(start: Option<i64>) -> Self {
        Tally { count: start.unwrap_or(0), log: Vec::new() }
    }

    /// Adds `by`; the new count.
    pub fn add(&mut self, by: i64) -> i64 {
        self.count += by;
        self.log.push(format!("+{by}"));
        self.count
    }

    /// The count.
    #[getter]
    pub fn count(&self) -> i64 {
        self.count
    }

    #[setter]
    pub fn set_count(&mut self, count: i64) {
        self.count = count;
    }

    /// A tally from `"12"`; throws on anything else.
    pub fn parse(text: String) -> Result<Tally, String> {
        Ok(Tally::new(Some(text.trim().parse().map_err(|_| format!("not a number: {text}"))?)))
    }

    /// Saves the log; resolves when it is written.
    pub async fn save(this: Instance<Tally>, path: String) -> Result<(), String> {
        let lines = this.with(|t| t.log.join("\n"));
        blocking(move || std::fs::write(path, lines)).await.map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())
    }
}

#[native_module("app/native")]
fn native(registry: &mut Registry) {
    registry.class::<Tally>();
}
```

```ts
// .nsh/types/app/native.d.ts, generated
/** A tally kept in Rust. */
export declare class Tally {
  /** Starts at `start` (0 when left out). */
  constructor(start?: number);
  /** Adds `by`; the new count. */
  add(by: number): number;
  /** The count. */
  get count(): number;
  set count(count: number);
  /** A tally from `"12"`; throws on anything else. */
  static parse(text: string): Tally;
  /** Saves the log; resolves when it is written. */
  save(path: string): Promise<void>;
  /** Frees the Rust value now (else when the object is collected); the object throws after. */
  dispose(): void;
  [Symbol.dispose](): void;
}
```

```tsx
import { Tally } from "app/native";
const tally = new Tally(3);
tally.add(2);            // 5, synchronously
tally.count = 10;
await tally.save("/tmp/log");
```

## Why synchronous

Module functions are ops: JS queues them and the core runs them after the turn, so they always return a promise.
That is fine for "do something" (show an alert) but not for something that looks like a class: a getter cannot be a
promise, and `tally.add(2) + 1` should be a number. JS and Rust components already run on one thread (the engine's),
so a class's methods can run directly inside the JS call, as the web classes nsh-js implements in Rust (`Blob`,
`Headers`, `URL`) do.

## The model

- **Instances live in Rust, owned by their JS object.** A JS object of the class holds the Rust value as its opaque
  (`Rc<RefCell<T>>`, the web classes' slot, `nsh-js` `web/mod.rs`); the object being collected drops it.
  `dispose()` (and `[Symbol.dispose]`, for `using`) drops it now (a value holding a file or a large buffer); any use
  after throws. `T: 'static`, not
  `Send`: it never leaves the engine thread.
- **Synchronous members run in the JS call.** `&self` / `&mut self` methods, getters and setters, statics and the
  constructor run inside the JS turn, outside the core: they compute and keep state, and cannot use the UI's free
  functions (signals, `dialog`, `theme()`): the reactive graph is not entered there, and calling one panics with a
  message saying so (as on any thread without it). A method borrows its instance for its call; a re-entrant call
  (a method reaching the same instance again) throws instead of aliasing, as the web classes do.
- **`async` members are core tasks.** An `async fn` method gets `this: Instance<Self>` (a handle: `with` /
  `with_mut` borrow the value between awaits) and returns a promise; it runs as a task of the core, where the free
  functions work (`dialog`, `timer`, `blocking`, `background`, the clipboard), as an `async` module function does.
  `this` and the arguments are converted in the JS call, as a synchronous member's are (a wrong one rejects the
  promise with the same `TypeError`), into the start of the task: a closure holding the typed values, the
  instance among them, that an op carries to the core ([below](#how-calls-cross)). The task keeps the instance
  alive until it ends.
- **One object per instance.** While both live, an instance has one JS object (`nsh-js` remembers it by the `Rc`'s
  address): a member returning an instance Rust keeps gives the object it has, so `a.badge === a.badge`.
- **Errors.** `Result<T, E: Display>` throws (`Error` with the message) or rejects; a wrong argument throws a
  `TypeError` naming the member and the parameter (``Tally.add: `by`: expected a number, got "x"``), and so does a
disposed or busy instance passed for a borrowed parameter (``Account.transfer: `to`: Account is disposed``); a panic in
  Rust is caught and thrown as an `Error`, or rejects (the engine stays up) where Rust unwinds: the web runtime is
  built with `panic = "abort"` (`[profile.web]`), so there a panic ends the page's engine. Integer parameters take
  whole numbers in their range (a fraction, `NaN` or a value out of range is a `TypeError`, not rounded or
  clamped), and one call reads at most 2^20 array items and fields, as a JSON conversion does.

## Functions

Rust exports functions through `#[module]` (an object, `AlertDialog.show(..)`, or `#[module(flat)]`, top-level
functions, which a module named like one with `#[module(name = "…")]` gives properties: `test.skip(..)`;
`docs/dev/components.md`). Every call used to be an op ordered with the UI's, so every result was a promise. The class's split
applies to functions too, decided by the signature (`FunctionCall::Sync` / `Op` / `Async`) of each function with
a visibility (`pub fn`, `pub(crate) fn`; the others are the block's helpers):

- **`fn` without a context:** synchronous, called directly in the JS call like a class's method (`parse(text)`,
  `checksum(bytes)`): TS gets the value, not a promise.
- **`fn` taking `cx: &mut ModuleCx`:** an op, run in order with what JS set before it (a dialog, the status bar,
  focus). Its return type decides what TS gets:
  - returning `()`, it gives `void`, with no reply: JS calls it and moves on, the op runs in order with the UI at
    the commit, nothing answers it (`RustOp::call` 0, no `JsEvent::Reply`), and a wrong argument throws in the call;
  - returning `Result<(), E>`, it gives `Promise<void>`: resolved once the op ran, rejected with the `Err`'s message.
    It cannot throw instead, because the op runs at the commit, after the JS call returned. A call nobody awaits or
    catches is still seen: the rejection is logged as an unhandled one (`docs/dev/pitfalls.md`);
  - returning a value (`T`, `Result<T, E>`), it gives `Promise<T>`, and a wrong argument rejects it.
- **`async fn`:** a task of the core; it gives a Promise (`Promise<void>` for `()`, resolved when the task ends).

The same holds for a component's ref methods (`docs/dev/components.md`, "Methods"). An op returning `()` is
`void` because the runtime modules released theirs as `void` (`Window.close`,
...) and a return type never changes (`docs/dev/compatibility.md`); a Rust function that can fail says so with
`Result<(), E>`, and TS gets a promise to see the error. `FunctionSpec::promises` / `MethodSpec::promises` decide
it for the declarations and the JS face alike; `-> ()` written out is the same as no return type.

A plain `fn` that returns a value (today a promise in TS) becomes synchronous: no runtime module has one (theirs
take `ModuleCx` or are `async`), and an app crate's are rebuilt with the app, whose types change with them.

## The standard library

What TSX imports from NSH is made two ways today:

- **Runtime modules in Rust** (`crates/nsh-core/src/runtime/`: `nsh`'s `Keyboard`, `Image`, `Clipboard`,
  `Storage` and accessibility functions, `nsh/mobile`, `nsh/desktop`) already use `#[module]` and `Registry`, the app crates'
  mechanism; they take the synchronous functions and classes as they come.
- **Hand-written in `nsh-js`:** the reactive graph and the renderer (`nsh`), `nsh`'s `AnimatedValue` and
  `AnimatedNode`, `nsh`'s `Path2D`, `CanvasGradient` and `CanvasRenderingContext2D`, the keymap, lists, and the
  web globals (`URL`, `Headers`, `Blob`, `fetch`, streams, events). Their classes already sit on one piece of
  machinery: a QuickJS class whose opaque is the Rust value in a `RefCell` (`nsh-js` `web/mod.rs`).

So the classes of this proposal are built on that same machinery: one implementation of "a JS class backed by a
Rust value", with `#[class]` its declarative front. Which standard classes move to `#[class]` depends on what they
need beyond the first version:

| Class | Needs | Moves |
|---|---|---|
| `Path2D`, `CanvasGradient` | plain values, called often | when calls convert QuickJS values directly (below) |
| `CanvasRenderingContext2D` | 17 500 calls in ~1 ms (`docs/dev/performance.md`) | stays recorded natively: a class front adds nothing |
| `AnimatedValue`, `AnimatedNode` | values the renderer reads from style props, ops ordered with the UI | stays: it is part of the renderer |
| `URL`, `TextEncoder` | WebIDL coercion, `new.target`, iterators | after subclassing and iterators |
| `Headers`, `Blob`, streams, `EventTarget` | callbacks, events, promises interleaved with JS | after callbacks and events |
| `nsh` itself (signals, `View`, `mount`) | the reactive graph and the JSX compiler's calls | stays: it is the runtime |

For that, two choices of the first version change:

- **Values convert directly**, QuickJS value to Rust type and back, not through `JsonValue`: a synchronous call is
  what makes these classes worth using, and a JSON round trip per call would cost more than the call (the canvas'
  recording is a native list for that reason). `JsValue` has only the direct conversions; what crosses to the
  core (ops, `async` calls, Rust components' props, events and methods) crosses typed too
  ([below](#how-calls-cross)).
- **The machinery is shared from the start**: `#[class]` instances are the web classes' slots, so `instanceof`,
  re-entrancy, finalization and (later) `new.target` behave the same for NSH's classes and an app's.

## What crosses

- **Arguments and results** are the module functions' types (`JsValue`: numbers, `bool`, strings, `Option`, `Vec`,
  `JsonValue`, `#[derive(JsObject)]` structs, `#[derive(PropEnum)]` enums), so classes and modules share one set of
  conversions and TypeScript types (`Arg` and `Ret` over them); a trailing `Option` parameter is optional.
  `Vec<u8>` is bytes: a `Uint8Array` (a `Buffer` too), copied in the call (`u8` is no `JsValue`, so it never
  overlaps the arrays); `SystemTime` is a `Date`. `#[prop(exact)]` on a `JsObject` struct refuses other own keys
  (options, where a typo must not pass), and `#[prop(skip_none)]` on an `Option` field leaves it out when `None`
  rather than `null` (`process`' exit `error`).
- **Interfaces**: `#[class(interface)]` on the struct makes a class whose objects come from members only: its
  module exports no value of it and TypeScript declares an `interface` (`fs/promises`' `Stats`); it has no
  constructor or statics. Its getters are read once when its object is made, as own enumerable data properties
  (so `Object.keys`, spread and `JSON.stringify` see them, as Node's `Stats`' fields), its methods stay on the
  prototype (`nsh-js` `classes.rs`). A result `Vec<Instance<T>>` is an array of objects.
- **The VM's `System`**: a parameter `sys: System` of a function or member (any kind) is not one JS passes: the
  call fills it in (an `async` one when it is made) with the app's `Access`, its data directory, the host's
  `TrustedPaths`, the VM's `Quotas` (counts of limited resources, `quotas.take(kind, max)` or
  `quotas.reserve(kind, amount, max)` giving a `Held` back when dropped) and the surface's `Os`. The host provides it (`JsHost::system`); one that configured nothing grants nothing.
- **Work started in the call**: a function or method that is not `async` and returns `Later<T>` (or
  `Result<Later<T>, E>`) runs in the JS call, where its checks throw as a synchronous call's do, and the work it
  returns runs as a core task: TS `Promise<T>` (`FunctionCall::Start`, `MemberCall::Start`). The system modules
  use it to keep Node's shape, a `RangeError` at the call and I/O errors as rejections (`net`, `fs/promises`).
- **Errors of a chosen class**: `Result<T, JsError>` throws a `TypeError`, `RangeError` or `Error`
  (`JsError::Type` / `Range` / `Error`); any other `E: Display` throws an `Error` with its message. A `Later`
  task's (and an `async` function's) `Err(JsError)` rejects with the same, any other error with an `Error` of its
  message (the reply carries a `Thrown`). `JsError::with(key, value)` / `with_code(code)` add properties
  (`JsError::Fields`), so errors keep Node's shape: `code`, `syscall`, `path` (`error.code === "ENOENT"`);
  `JsError::from(io::Error)` and `io_code` name an I/O error's code from its OS error or kind. The system modules
  share it (`fs/promises`; `process` and `net` can).
- **What a synchronous call can do beyond computing**: a parameter `cx: CallCx` (filled in by the call, never in an
  `async` one) starts a task of the core in order with the ops (`cx.start(future)`, nothing waits for it) and ties
  work to what owns the call in JS (`cx.on_cleanup(f)`: the reactive owner, else the module's run under hot
  reload). `process.spawn` returns its child at once and delivers the child's events from such a task.
- **The VM's own state**: `sys.locals.get::<T: Local>()` is one `T` per VM, made on first use and closed
  (`Local::close`) when the VM goes, before its callbacks are released (`process`'s children).
- **Getters of a module**: `#[getter]` on a function without JS parameters makes it a property of the module's
  object (`process.env`), declared `readonly`, never a named export. A flat default module's object also carries
  the registry's native values (`Registry::native_values`: `process.nextTick`), and stays one object per VM, so
  a global made from it (`process`) is the default export.
- **`this` in a synchronous method**: `fn on(this: Instance<Self>, ..) -> Instance<Self>` gets the handle instead
  of a borrow, so it can return its own object (`child.on(..)` chains).
- **Overloads**: `#[overload(fn(event: ExitEvent, handler: Callback<ExitResult>) -> Instance<ChildProcess>)]`
  (repeatable) on a module function or a member declares those signatures, from their Rust types, instead of
  the one its own types give (the result is a promise when the function's is): what an argument selects
  (`on("exit", ..)`, `readFile(path, "utf8")`).
- **Instances of classes**, by reference: a parameter `&Other` / `&mut Other` borrows another instance for the call
  (TS: `other: Other`), `Instance<Other>` keeps a handle (to store one instance in another), and a result `Other`
  or `Instance<Other>` is a JS object (`Self` from `new` and statics; `Option<Instance<Other>>` for none). An
  instance of another app's or set's class is refused with a `TypeError`. `async` members and module functions keep
  what they take: `Instance<Other>`, not `&Other`.
- **JS functions** (callbacks), below.
- **Not in the first version:** events emitted by an instance (`EventTarget`) and iterators. Constructors honor
  `new.target` as the web classes' do, so a TS class may extend a Rust one.

## Callbacks

A parameter `Callback<A, R = ()>` takes a JS function: `A` is its argument (a `JsValue` type, or a tuple for
several), `R` what it returns. TS: `Callback<f64>` is `(value: number) => void`, `Callback<(String, f64), bool>`
`(a: string, b: number) => boolean`; `#[args(..)]` on the parameter (a function's, a member's or an `#[overload]`'s)
names the function's arguments, checked at compile time to name each (`#[args(name, amount)] check: Callback<(String,
f64), bool>` is `check: (name: string, amount: number) => boolean`), in classes, modules and ref methods alike. The
attribute is the macros': it is removed from the function they leave.

```rust
#[class]
impl Downloader {
    /// Calls `progress` with each fraction done; resolves with the bytes' count.
    pub async fn fetch(this: Instance<Downloader>, url: String, progress: Callback<f64>) -> Result<u64, String> {
        // ...
        progress.post(0.5);                       // runs in JS after this step, in order
        progress.call_async(1.0).await?;          // runs in JS, its result back here
        Ok(bytes)
    }

    /// Sorts with the app's comparison, at once.
    pub fn sort_by(&mut self, compare: Callback<(String, String), f64>) -> Result<(), String> {
        self.items.sort_by(|a, b| {
            let order = compare.call((a.clone(), b.clone())).unwrap_or(0.0);
            order.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        Ok(())
    }
}
```

- **Calling it now** (`call(args) -> Result<R, String>`): inside a synchronous call from JS (a method, a function,
  the constructor), the JS function runs on the spot and its result comes back, as a JS callback passed to
  `Array.prototype.sort` does. Its exception is the `Err` (its message). The instance stays borrowed meanwhile:
  the callback reaching the same instance again throws, as any re-entrant call does. `call` outside a call from
  JS (in a task) panics with a message saying to use `post` or `call_async` there.
- **Calling it later** (`post(args)`, `call_async(args).await -> Result<R, String>`): from anywhere on the engine
  thread (an async member's task, a timer, a stored callback), the call is queued for JS and runs in the engine's
  next JS turn, in order with the other posts: `post` forgets the result, `call_async` waits for it (and settles a
  promise the function returns). The calls wait in one ordered queue (`Posts`, made by the engine and handed to
  `nsh-js` and the core: `HostOptions::posts`, `Core::set_posts`), which the engine runs at each commit round
  before the core's events (`Host::run_posted`), so a task's posts reach JS before its result and cost one turn,
  not a thread hop. They run in the order they were posted, keeping JS's program order: a post made inside a
  synchronous call from JS is parked in its place until an op JS sends after it is applied
  (`RustCall::Post`, whose place is released when the op goes by any path, applied or dropped, so a lost op
  never holds back later posts), and what the ops JS sent before it post while the core applies them goes before
  it. So an op function posting and then a synchronous one posting arrive in that order, and a task posting while
  JS is still busy after the synchronous call arrives after it. Once the VM stops, queued calls and those posted later are
  dropped and their replies say so. `call_async_traced` is `call_async` with what was thrown whole (`Exception`: its
  message and, for an `Error`, its stack), for a caller that says where it was thrown (`nsh test`'s failures).
  `call` rethrows an uncatchable exception (the CPU budget's interrupt, running
  out of memory) when the synchronous call around it returns, whatever Rust made of its `Err`.
- **In a finalizer:** a value whose JS object goes drops inside QuickJS's finalizer, where no JS may run. That is
  every finalizer, not only a collection's sweep: an object freed because its last reference went (a refcount
  free, at any point JS releases a value) finalizes the same way. `nsh-js` raises a counter around every
  finalizer's drop (`web::finalizing`); while it is raised, a callback's `call` fails (`Err`: called while JS
  collects garbage, use `post`) and `post` is not parked in program order: it goes to the end of the queue, without
  an op, and runs in the next turn. Both are about callbacks the dropping value does not own, since its own were
  released first (below).
- **Keeping it:** a `Callback` can be stored (in an instance's field, a `Vec`, a global) and called any number of
  times; dropping the last clone releases the JS function. A callback an instance keeps is reported to QuickJS's
  collector through the class's mark hook, as the web classes report the JS values they hold. `#[class]` traces
  every field whose type implements the `unsafe trait Trace` (`Callback`, `Instance`, and `Option`, `Box`,
  `RefCell`, `Vec`, `VecDeque`, map values and pairs of them; chosen by type, so aliases count and other types are
  skipped) and reports them while the object is the instance's only owner and the callback has no other clone,
  so a callback that captures the object owning the instance does not keep both alive forever. Callbacks held
  elsewhere (an `Rc` shared by two instances included) are roots until dropped. The functions belong to the VM:
  freed with it, a callback Rust keeps longer does nothing. When the collector frees an object that owns its
  instance alone, the instance's callbacks are released before its value drops, so a `Drop` calling or posting
  one finds it gone instead of a function the same collection frees. That includes the callbacks of instances
  it alone holds: a `Drop` that moves such an instance out (into a static, a task) keeps the instance, but its
  callbacks are dead (calling fails, posting does nothing). `Trace` never panics, allocates JS values or runs JS
  (it runs in the collector's mark phase), part of its safety contract.
- **Functions take them too:** `fn watch(path: String, on_change: Callback<String>)` (`on_change` kept and posted
  later), and `async` functions and members can `call_async`.
- **Listeners**: an instance keeps them in a field (`listeners: Vec<Callback<String>>`, added by
  `on(&mut self, listener: Callback<String>)`) and its tasks post to them (`Later` work cloning the field); the
  field is traced like any other, so no event machinery is needed for `child.on("stdout", ..)`.


## How calls cross

Nothing crosses between JS and the core as JSON for a Rust component, module or class (`nsh_core::element::call`):

- **Arguments are converted in the JS call** by the generated decoders (`JsValue::from_js`), for every kind of
  call: a synchronous member or function runs on them; a function with `cx`, an `async` function or member and a
  component's ref method become a closure holding the typed values (`OpCall`, `TaskStart`, `MethodCall`) that an
  op carries (`Op::Rust(RustOp { call, run })`, `RustCall::Op` / `Task` / `Method`). The core runs it in order with
  the UI's ops: a function with a `ModuleCx` (its actions applied after it), the start of a task, the method with
  the API the component registered. Instances and callbacks ride in the closure as the `Rc`s they are: no table,
  no ids. A value of the wrong type throws a `TypeError` in the call, or rejects the promise of a call that returns
  one, with the same message whatever the kind (``Ints.op: `n`: expected an integer that fits u32, got 1.5``).
- **Results are boxed Rust values** (`JsResult = Result<Box<dyn ToJs>, String>`): the core hands them back in its
  event stream (`JsEvent::Reply { call, result }`, `Core::take_events`), in order with the nodes' events, and
  `nsh-js` converts the value (`Ret::into_js`) when it settles the promise (`Host::deliver`). Every path that drops
  a call settles its promise: a panic or an error rejects it, a method of a node hosting no component rejects, and
  the ops the engine drops when the script stops reject theirs (`Core::discard_ops`). The app's code that runs
  on the way back stays caught: a panic converting a result rejects its promise with the message, one converting
  an event's data or a posted call's arguments is logged, one in a prop's decoder throws at the assignment, and values
  dropped unused (a result nobody waits for, a call that does not run) drop where a panicking `Drop` is logged.
- **A Rust component's props** are decoded when JS sets them (`PropSpec::decode`, one per prop, generated by
  `derive(Props)` from the field's type) into a type-erased value (`AnyValue`) that `Prop::RustProp` carries; the
  core's instance takes it out (`Props::set`). A value of the wrong type is a warning, as a host element's bad
  value is (logged with the VM's warnings, which the dev overlay shows: `Gauge.level: expected an integer that fits
  u32, got 1.5`): the prop keeps its value (its default in the first render) and every other prop is set;
  `undefined` resets the prop to its default. A decoder's panic, or a getter's exception, still throws there.
- **A Rust component's events** reach JS as the event itself (`JsEvent::Component`, `Event::data_js` converting
  its data when JS hears it), and whether its lazy children are placed as `JsEvent::Children`.
- **Platform native components** (Java, Swift, the embedder's GPUI components) keep JSON (`Prop::ComponentProp`,
  `MountItem::ComponentProps`, `EventPayload::Native`, `Command::Native`): their values cross into another
  language. The two kinds stay apart.
- **A class a signature names is registered with it**: each member, module function and ref method lists the
  classes its parameters and result name (`ClassRefs`: `Instance<Other>`, `&Other`, `Other` by value, the
  arguments of a `Callback`), and `Registry::class` / `module` / `register` register them in turn, so their objects
  have a class in JS, `import { Other }` and `instanceof` work, and the declarations declare it, in every build
  (WebAssembly included: the lists are not TypeScript, which those builds leave out). Registering a class again does
  nothing.

## The pieces

- **`nsh-macros`:** `#[class]` on the struct (a marker; the type's name is the JS name) and on its `impl`. The
  block's functions with a visibility (`pub fn`, `pub(crate) fn`) are exported; those without one are helpers,
  Rust's only, as in `#[module]` and `#[methods]` blocks (a `#[getter]` / `#[setter]` without one is a compile
  error: it can only be TS's). `new`
  is the constructor (a class without one cannot be made from JS, only returned); `&self` / `&mut self` methods,
  `#[getter]` / `#[setter]` (one name: `count` and `set_count` are the property `count`), functions without `self`
  are statics, `async fn` with `this: Instance<Self>` are async methods. A raw identifier is its name in TS
  (`r#type` is `type`). Doc comments become the declarations':
  the struct's documents the class, as a module's struct (`#[module]` on it and on its `impl`, `ModuleDoc`) does
  the module and a component's `#[component] fn` the component; one on a `#[class]` or `#[module]` `impl` block is a
  compile error (TS would not show it). TS gets a doc comment up to its first heading (`nsh-macros` `docs`, outside
  code fences): what follows `# Rust` (or rustdoc's `# Panics`, `# Examples`) is for Rust callers only, the place
  for notes about `&self`, `cx` or how a call crosses. `Registry::undocumented` lists the exports TS sees without a doc comment;
  the command line warns of an app's when it writes `.nsh/types`, and nsh's own sets are tested to have none.
  It implements `element::Class` (`Class::DEF`, a `ClassDef`: name, doc, members, each a `Member` with its
  `MemberCall`), as `#[module]` implements `Module`; on the struct it implements `Trace` (the callbacks the fields
  keep) and `Ret` (a value of the struct is a new instance).
- **`nsh-core`:** `element::Class`, `ClassSpec` (for the declarations), `Instance<T>`, `Callback<A, R>`, `Posts`,
  `Registry::class::<C>()`; the direct conversions (`JsHost`, `JsIn`, `JsOwned`; `JsValue`'s `from_js` /
  `to_js`); the typed calls (`call.rs`: `RustOp`, `RustCall`, `JsEvent`, `AnyValue`, `ToJs`); the core runs
  them in order with the ops (`Core::run_rust`).
- **`nsh-js`:** `classes.rs` makes each class's constructor and prototype from its `ClassDef` when a bundle imports
  the set or a member first returns one of its values: C closures calling the members through `CallHost` (its
  `JsHost`); calls that become ops convert their values and push the op (`classes::send`), returning the promise
  `components.rs` settles when the core's events bring the result (`components::deliver`); the object is the web
  classes' (`web/mod.rs`), its slot holding the instance, and its mark hook reports the instance's callbacks.
- **Declarations:** `nsh_core::element::declarations` writes `export declare class` for each, with the types the members
  use, next to the set's components and modules; the declarations test checks that what exists is declared.
- **The CLI** needs no change: classes are part of the app's set like its modules.

## Costs

A synchronous call converts its arguments from QuickJS values to the Rust types directly (no `JsonValue`, no op, no
commit, no promise), as the web classes' methods do. `bench_calls` (`docs/dev/performance.md`): a class method with
a number costs what a JS method call does (~34ns), with a `{ x, y }` object ~139ns, a module function without a
context ~28ns; an awaited op, async function or async member ~0.56–0.63µs (1.6–2.15µs when they crossed as
JSON).

## Decisions

1. **Synchronous or a promise is the Rust signature's `async`**: a member or function that is not `async` runs in
   the JS call and returns its value (it computes and keeps state, without the UI's free functions); an `async`
   one returns a promise and runs as a core task, with them. The one exception, for functions only: one taking
   `cx: &mut ModuleCx` stays an op ordered with the UI (the status bar, focus), as now.
2. **`dispose()` and `[Symbol.dispose]`** besides collection.
3. **Callbacks in the first version** (above); events and iterators later.
4. **Functions follow the same rule**, so a plain `fn` returning a value becomes synchronous in TS.
5. **The standard library's classes move to `#[class]`** as the mechanism gains what each needs (the table above);
   the renderer's own classes stay hand-written. Their TS interfaces stay as they are: names, members and
   signatures are generated alike; arguments are checked by type rather than coerced (`moveTo("10", 0)` throws
   instead of reading 10), and errors read as the generated ones do.

## Implementation notes

Where the implementation differs from the proposal above, and why:

- **Posted calls go through one queue the engine shares, not a core action.** `Callback::post` / `call_async`
  queue a `JsCall` in `Posts` (it wakes the engine), and the engine runs the queue at each commit round before
  dispatching the core's events. A callback may be posted from a synchronous member, where the core is not
  running, so the queue belongs to the engine rather than to the core's actions; the order with the core's events
  is the same.
- **Typed calls instead of a table.** The first version sent ops and async calls as JSON, the instances and
  callbacks among them held in a table both sides shared under ids the op carried (and replies' instances under
  an id beside the value). Converting in the JS call and carrying closures removed the table, the ids (so no data
  can look like one, and no id can leak or be forged), the name-based lookup of the member or function the core
  calls (`app/native:Tally#save`), and a JSON round trip per call.
- **Results by value.** `Self` and another class's value are results through the `Ret` impl `#[class]` writes for
  the struct; `Option<Other>` by value cannot be one (Rust's coherence rules), `Option<Instance<Other>>` can.
- **Subclassing works already**: constructors are QuickJS constructors (called only with `new`) and honor
  `new.target`, so a TS subclass's objects are its own.
- **A class without `new`** is declared with `private constructor()`; JS calling it throws a `TypeError`. Members
  named `dispose` or `constructor`, and statics named `prototype`, `name` or `length`, are compile errors (the
  object has those already).
- **Panics in `async` module functions** now reject their promise too (they used to fail the root and leave JS
  waiting), as an `async` member's do.
- **Module functions take instances and callbacks** in every kind: an op's and a task's ride in its closure like
  an async member's.
- **A context makes at most 32768 classes** (QuickJS keeps a constructor's index in 16 signed bits) and a class
  at most 65535 members: past them, making the class throws a `RangeError` instead of a constructor naming
  another class.
- **The standard library's classes** (the table above) have not moved yet; the machinery is shared, so each moves
  when it needs nothing more.

## Known limits

- **Deep chains of instances.** Dropping an instance that holds another (`Instance<Node>` in a field, as a linked
  list) drops the chain recursively, and the mark hook traces it recursively: a chain of very many instances can
  overflow the stack. Keep long sequences in a `Vec`.
- **A promise that never settles.** `call_async` on a function returning a promise that never settles waits for
  ever; a cycle through such a promise (the promise's reactions holding the callback whose reply holds it) keeps
  both alive until the VM goes.
