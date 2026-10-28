# Rust exports

A tiny ledger whose logic is Rust: a TSX app (`App.tsx`) that uses everything a Rust crate can export to TSX, one
of each. The app's crate is `native/` (`nsh.json` `"rust": "native"`); its `#[native_module("rust-exports/native")]`
function in `native/src/lib.rs` registers them, and `App.tsx` imports them by that specifier:

```tsx
import { Account, Gauge, Ledger } from "rust-exports/native";
```

Their TypeScript declarations, doc comments included, are generated from the Rust types into
`.nsh/types/rust-exports/native.d.ts`, so `nsh check` and the editor check the TSX against the Rust signatures.

| Export | Rust | TSX |
|---|---|---|
| A component | `#[component] fn Gauge` with `#[derive(Props)] GaugeProps` (a required `value`, a defaulted `max` and `step`, an optional `label`, `children`) and `#[derive(Event)] GaugeEvent::Change(f64)` (`native/src/gauge.rs`) | `<Gauge value={spent()} step={25} label="Groceries" onChange={({ value }) => spent.set(value)}>…</Gauge>` |
| A module | `#[module] impl Ledger` (`native/src/ledger.rs`): `format` (a plain `fn`), `copy` (taking `cx: &mut ModuleCx`, returning a count), `fetch_rate` (an `async fn`) | `Ledger.format(1234.5)` returns a string at once; `await Ledger.copy(text)` and `await Ledger.fetchRate()` are Promises (an op returning `()` would be a plain call, `void`; one returning `Result<(), E>` a `Promise<void>`) |
| A class | `#[class] struct Account` and its `#[class] impl` (`native/src/account.rs`) | `new Account("Savings", 120)`, `Account.parse("Checking: 40")` (a static), `account.balance` (a getter), `account.name = "…"` (a setter), `deposit` (`&mut self`), `statement` (`&self`), `transfer(other, 30)` (another instance), `await account.accrue(rate)` (an `async` member), `onChange(listener)` (a `Callback` Rust posts to, also from `accrue`'s task), `dispose()` and `using`; `book`, a `fn` without `pub`, is a helper TS does not see |

```sh
cargo build -p nsh-cli
./target/debug/nsh run examples/rust-exports              # or --target macos, ios, android, web, ...
./target/debug/nsh check examples/rust-exports            # the TSX against the generated declarations
cargo test -p rust-exports-native                         # the headless tests
```

`nsh` describes the crate with a small program of it and builds the app's hosts with it linked in (`docs/dev/tooling.md`, "Apps with Rust
components of their own"): TSX edits are hot updates, Rust edits rebuild and restart the app. The tests
(`native/tests/rust_exports/`) build `App.tsx` against the crate's set (`rust_exports_native::registry()`) and run it
headless with `nsh-testing`, press through its UI, check what each export shows, and check the declarations TSX
reads.

How each kind of export runs, crosses and is typed: [Building with Rust](../../website/docs/rust.md) and, for
NSH's developers, `docs/dev/rust-classes.md` (classes, module functions, callbacks) and `docs/dev/components.md`
(components). `examples/gallery-rs` is a whole app written in Rust.
