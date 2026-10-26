---
title: nsh/native
description: nativeComponent and nativeModule, which connect your app to the native views and Rust functions the embedding app registers.
order: 9
---

# nsh/native

`nsh/native` connects your app to what the host app provides, by name, at run time. An iOS or Android app that embeds NSH can register its own views (a map, a chart, a camera preview) by name; `nativeComponent` gives you a typed component for one of them. Because NSH renders with real native views, such a component sits in the view hierarchy like any other view: it is laid out by NSH, clips and scrolls with its parents, and overlaps correctly. An app that embeds NSH from Rust can also register functions, classes and Rust components; `nativeModule` gives you them as one typed object. Your app builds with the stock `nsh build` either way: the host connects what it provides when it runs the app. Rust code places a registered view with `native(name)` from `nsh_core::ui::prelude`, sets its props with `.prop(name, value)` (a JSON value, or a signal or closure of one) or binds one to an animated value with `.bind_prop(name, &value)`, hears its events with `.on_native_event(…)` and calls its commands through an `ElementRef`; TSX imports `nsh/native`.

```rust tabs
use nsh_core::ui::prelude::*; // native, NativeEvent, element_ref
```

```tsx tabs
import { nativeComponent, nativeModule } from "nsh/native";
```

See [Native components](../docs/native-components.md) for registering the native side, and [Embedding on iOS](../docs/ios.md) / [Embedding on Android](../docs/android.md).

## nativeComponent

```ts
function nativeComponent<P extends object = {}, E extends object = {}>(
  name: string,
  spec: NativeComponentSpec<P, E>,
): (props: NativeComponentProps<P, E>) => YNode;

interface NativeComponentSpec<P, E> {
  /** Its own props: sent to the component (any JSON value), each when it changes. */
  props: readonly (keyof P & string)[];
  /** The events it emits. */
  events?: readonly (keyof E & string)[];
}
```

Returns a component for the native component the embedding app registered as `name` (Swift `NshAppView.register(component:)`, Java `NshView.registerComponent`). Rust: `native(name)`, a view whose props are JSON values (`.prop("text", json!(…))`) and whose events arrive as `NativeEvent { name, data }`.

- `P` is the type of its own props. Each prop listed in `spec.props` is sent to the native side as JSON when it changes; setting it to `undefined` removes it.
- `E` maps event names to their payloads. An event `regionChange` becomes the handler prop `onRegionChange`.
- The component also takes every [view prop](../elements/view.md) except `children`: `style`, `class`, layout, accessibility, touch handlers and `ref`.

```ts
type NativeComponentProps<P, E> = Omit<ViewProps, "children"> & P & NativeEventHandlers<E>;
type NativeEventHandlers<E> = { [K in keyof E & string as `on${Capitalize<K>}`]?: (data: E[K]) => void };
```

### Size

The component is laid out like a view, at the size its style gives it. Where the style leaves a dimension open, it uses the size the native component reports (as an image uses its natural size).

### Commands

Its `ref` receives a `YNode`; `ref.command(name, args)` calls command `name` of the native component with `args` (any JSON value). Rust: `ElementRef::command(name, args)`.

```rust tabs
map.command("zoomTo", json!({ "level": 3 }));
```

```tsx tabs
map.command("zoomTo", { level: 3 });
```

### When nothing is registered

Where nothing is registered under `name` (a different host app, the dev host, the browser), the component renders an empty view and a warning is logged once. Keep the app usable without it, or check for your host before using it.

## Example

The badge here is a native view of the host app, registered as `embed.badge`. NSH lays it out, sends it `text` and `color`, receives its `tap` events, and calls its `pulse` command:

```rust tabs
use nsh_core::ui::prelude::*;
use serde_json::json;

#[component]
pub fn App() -> impl IntoElement {
    let taps = signal(0_u64);
    let badge = element_ref();
    view()
        .flex_1()
        .p_5()
        .gap_4()
        .child(
            native("embed.badge")
                .prop("text", json!("Tap the native badge"))
                .prop("color", json!("#8250df"))
                .element_ref(&badge)
                .on_native_event(move |e: &NativeEvent| {
                    if &*e.name == "tap" {
                        taps.set(e.data["count"].as_u64().unwrap_or(0));
                        badge.command("pulse", json!(null));
                    }
                })
                .self_start()
                .rounded(px(8.0))
                .overflow_hidden(),
        )
        .child(text(move || format!("Tapped {}×", taps.get())))
}
```

```tsx tabs
import { mount, signal, type YNode } from "nsh";
import { nativeComponent } from "nsh/native";
import { SafeAreaView } from "nsh/base";

const Badge = nativeComponent<{ text: string; color?: string }, { tap: { count: number } }>("embed.badge", {
  props: ["text", "color"],
  events: ["tap"],
});

function App() {
  const taps = signal(0);
  let badge: YNode | undefined;
  return (
    <SafeAreaView style={{ flex: 1, padding: 20, gap: 16 }}>
      <Badge
        ref={(node) => (badge = node)}
        text={taps() === 0 ? "Tap the native badge" : `Tapped ${taps()}×`}
        color="#8250df"
        onTap={(e) => {
          taps.set(e.count);
          badge?.command("pulse");
        }}
        style={{ alignSelf: "flex-start", borderRadius: 8, overflow: "hidden" }}
      />
    </SafeAreaView>
  );
}

mount(App);
```

## nativeModule

```ts
function nativeModule<T extends object>(specifier: string): T;
```

Returns the exports of the set the embedding app registered as `specifier`: its modules, classes, functions and Rust components, as one object. The app writes the type `T` itself, so nothing about the host is needed when it is built. Rust code built together with the host's crate calls those functions as Rust; `nativeModule` is how TSX reaches them.

```ts
import { nativeModule } from "nsh/native";

interface TradingApi {
  quote(symbol: string): number;
  placeOrder(symbol: string, quantity: number, side: "Buy" | "Sell"): Promise<Order>;
  subscribe(onChange: (state: Desk) => void): Promise<void>;
}

const { Trading } = nativeModule<{ Trading: TradingApi }>("host/trading");

const price = Trading.quote("AAPL");
```

- Calls work as they do through an import of a set: a plain Rust function returns its value at once, an `async` one returns a promise, and a function you pass is a callback Rust can call later. Rust checks every argument and throws a `TypeError` for a wrong one.
- Each call with the same `specifier` returns the same object in that VM. Its exports are the same values an
  import of the set receives. Host-owned value factories run on the first access through either path; both paths
  share each native instance, and a reload creates new ones.
- Where nothing is registered under `specifier`, `nativeModule` throws a `ReferenceError` naming it. Call it where the app can handle that, or only in the host it is made for.

The host registers the set from Rust, with the platform crate's `set_ui_sets` (next to NSH's own sets) before it starts its views, or `EngineConfig::ui_sets`:

```rust
use nsh_core::ui::prelude::*;

pub struct Trading;

#[module]
impl Trading {
    /// A sample price.
    pub fn quote(symbol: String) -> Result<f64, String> { /* ... */ }

    /// Calls `on_change` with the desk now and on every change.
    pub async fn subscribe(on_change: Callback<Desk>) {
        let mut desk = DESK.subscribe(); // a tokio watch channel the host keeps
        loop {
            on_change.post(desk.borrow_and_update().clone());
            if desk.changed().await.is_err() {
                return;
            }
        }
    }
}

let mut trading = Registry::ui_set("host/trading");
trading.module::<Trading>();
nsh_platform_gpui::set_ui_sets(vec![nsh_base::registry(), trading]);
```

`subscribe` is how the host keeps every app in step with its own data: its task waits for the host's changes and posts each one to the app, so a change made by the host, or by any app through another function, reaches every app that subscribed.

An embedding host can also register an existing client through `Registry::value(name, factory)`. The factory
captures the client the host grants to that view and returns a typed value such as `Instance::new(service)`;
its Rust class methods form the API available to the app. The host manages cancellation and external resources.
See [Host-owned services](../docs/tui.md#host-owned-services) for per-view registration.

> [!NOTE]
> Props, events and command arguments cross to the native side as JSON. Registered components and functions are the host app's own code: NSH's [sandbox limits and capabilities](../docs/sandbox-and-capabilities.md) do not apply to what they do.
