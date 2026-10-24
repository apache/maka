---
title: Native Components
description: Use views of the host app (maps, players, any UIView or Android View) inside an NSH app, with props, events, commands and sizing.
order: 18
group: platforms
---

# Native Components

A native component is a view the **embedding app** registers by name: a map, a camera preview, a chart library, any
`UIView` on iOS, `android.view.View` on Android, `NSView` on macOS, `gtk::Widget` on Linux, or Direct2D drawing or a
child `HWND` on Windows. The NSH app uses it like any other element: a Rust app makes it with `native(name)` from
`nsh_core::ui::prelude`, a TSX app declares it with `nativeComponent()` from [`nsh/native`](../modules/nsh-native.md). NSH lays it out with the rest of the
app, sends it props, delivers its events to handlers and forwards commands from a `ref`.

Because NSH renders with the system's own views, a native component is just one more subview in the same hierarchy:
there is no layering problem, it clips, scrolls and receives touches like a `<View>`.

> [!NOTE]
> Native components exist only where an app embeds NSH ([iOS](./ios.md), [Android](./android.md),
> [macOS](./macos.md#embedding-in-a-mac-app), [Linux](./linux.md#embedding-in-a-gtk-app),
> [Windows](./windows.md#embedding-in-a-win32-app)).
> A packaged standalone app (`nsh package`) or a development host registers none, so the element renders an empty
> view there (the name is logged once as unknown).

## How it fits together

1. The host app registers a factory under a name, such as `"embed.badge"`, on its `NshAppView` (iOS) or `NshView`
   (Android). Each view has its own registry; there is nothing global.
2. The NSH app declares a component for that name with the props and events it uses.
3. When the element is created, NSH creates a container view (decorated, framed and hit-tested like any view), then
   asks the factory for a component and puts the component's view inside the container, filling it.
4. The component receives every prop right after it is made, then each prop again when it changes.
5. The component emits events and may report its own size; the app calls its commands through a `ref`.

## Using the component in the app

In Rust, `native(name)` makes the element: `.prop(name, value)` gives it a prop (a `serde_json::Value`, or a signal or a
closure of one, sent again when it changes), `.on_native_event(..)` hears its events as `NativeEvent { name, data }`, and the methods of an
`element_ref()` put on it with `.element_ref(&r)` send its commands. In TSX, `nativeComponent()` declares a component
for the name with the props and events it uses.

```rust tabs
use nsh_base::safe_area_view;
use nsh_core::ui::prelude::*;
use serde_json::json;

const COLORS: [&str; 4] = ["#8250df", "#0969da", "#1a7f37", "#cf222e"];

#[component]
pub fn App() -> impl IntoElement {
    let taps = signal(0_u64);
    let badge = element_ref();
    safe_area_view()
        .flex_1()
        .p(px(20.0))
        .gap(px(16.0))
        .bg(rgb(0xf6f8fa))
        .child(text("Rendered by nsh").text_size(px(22.0)).font_weight(FontWeight::BOLD))
        .child(
            // The host app's badge: a label it draws, sized to its text.
            native("embed.badge")
                .element_ref(&badge)
                .prop("text", move || match taps.get() {
                    0 => json!("Tap the native badge"),
                    n => json!(format!("Tapped {n}×")),
                })
                .prop("color", move || json!(COLORS[taps.get() as usize % COLORS.len()]))
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
        .child(text(move || format!("Rust saw {} taps", taps.get())))
}
```

```tsx tabs
import { mount, signal, Text, type YNode } from "nsh";
import { nativeComponent } from "nsh/native";
import { SafeAreaView } from "nsh/base";

/** The host app's badge: a label it draws, sized to its text. */
const Badge = nativeComponent<{ text: string; color?: string }, { tap: { count: number } }>("embed.badge", {
  props: ["text", "color"],
  events: ["tap"],
});

const colors = ["#8250df", "#0969da", "#1a7f37", "#cf222e"];

function App() {
  const taps = signal(0);
  let badge: YNode | undefined;
  return (
    <SafeAreaView style={{ flex: 1, padding: 20, gap: 16, backgroundColor: "#f6f8fa" }}>
      <Text style={{ fontSize: 22, fontWeight: "700" }}>Rendered by nsh</Text>
      <Badge
        ref={(node) => (badge = node)}
        text={taps() === 0 ? "Tap the native badge" : `Tapped ${taps()}×`}
        color={colors[taps() % colors.length]}
        onTap={(e) => {
          taps.set(e.count);
          badge?.command("pulse");
        }}
        style={{ alignSelf: "flex-start", borderRadius: 8, overflow: "hidden" }}
      />
      <Text>{`JS saw ${taps()} taps`}</Text>
    </SafeAreaView>
  );
}

mount(App);
```

The TSX version is `examples/embedded/App.tsx`, which both embedding samples in the repository run.

### `nativeComponent(name, spec)`

```ts
function nativeComponent<P extends object = {}, E extends object = {}>(
  name: string,
  spec: NativeComponentSpec<P, E>,
): (props: NativeComponentProps<P, E>) => YNode;
```

| Parameter | Type | Description |
|---|---|---|
| `name` | `string` | The name the host app registered. Use a prefix of your own (`"maps.view"`, `"acme.chart"`) so names stay unique. |
| `spec.props` | `readonly (keyof P & string)[]` | The component's own props. Only the props listed here are sent to the native side. |
| `spec.events` | `readonly (keyof E & string)[]` | The events it emits. Optional. |

The type parameters describe the props (`P`) and the payload of each event (`E`). The returned component accepts:

- the component's own props `P`;
- a handler per event: event `tap` is handled by `onTap`, `regionChange` by `onRegionChange` (the first letter is
  capitalized and `on` prepended);
- everything a `<View>` takes except children: `style`, `class` / `classList` ([Tailwind](./tailwind.md)), layout,
  accessibility props, `testID`, `onLayout`, `ref`. These belong to the container NSH draws, not to the component.

A native component is a leaf: it takes no children.

## Props

Each own prop is sent as JSON, so its value can be any JSON value: strings, numbers, booleans, `null`, arrays and
plain objects. Props are reactive like any other: when a Rust prop's closure (`.prop("text", move || json!(label.get()))`)
or a TSX `text={label()}` reads a signal, the new value is sent when the signal changes, and only then.

| What happens in the app | What the component receives |
|---|---|
| The element is created | Every own prop that is set, right after the component is made |
| A prop's value changes | That prop with its new value |
| A prop becomes `undefined` | That prop with no value (`nil` in Swift, `null` in Java) |

Props carry JSON values; keep the interface to data (functions, class instances and `AnimatedValue`s stay in the app).

## Events

The component emits an event by name with an optional JSON payload. NSH delivers it to the engine thread and calls the
matching handler with the payload (in Rust, the one `on_native_event` listener with the event's `name` and `data`):

```rust tabs
use serde_json::json;

native("acme.map")
    .prop("latitude", json!(52.52))
    .prop("longitude", json!(13.405))
    .on_native_event(move |e: &NativeEvent| match &*e.name {
        "regionChange" => center.set((
            e.data["latitude"].as_f64().unwrap_or_default(),
            e.data["longitude"].as_f64().unwrap_or_default(),
        )),
        "markerPress" => open(e.data["id"].as_str().unwrap_or_default()),
        _ => {}
    })
    .flex_1()
```

```tsx tabs
const MapView = nativeComponent<
  { latitude: number; longitude: number; zoom?: number },
  { regionChange: { latitude: number; longitude: number }; markerPress: { id: string } }
>("acme.map", {
  props: ["latitude", "longitude", "zoom"],
  events: ["regionChange", "markerPress"],
});

<MapView
  latitude={52.52}
  longitude={13.405}
  onRegionChange={(region) => center.set(region)}
  onMarkerPress={({ id }) => open(id)}
  style={{ flex: 1 }}
/>;
```

Events are asynchronous: the main thread never waits for the app's code. A component that must decide something on the spot (may
this gesture start, may this region change) has to decide it natively, from props it received earlier.

## Commands

Imperative calls (zoom to a point, start playback, pulse an animation) go through the element's ref (`element_ref()` in Rust, `ref` in TSX):

```rust tabs
let map = element_ref();

native("acme.map")
    .element_ref(&map)
    .prop("latitude", json!(52.52))
    .prop("longitude", json!(13.405))
    .flex_1()

map.command("zoomTo", json!({ "level": 3 }));
```

```tsx tabs
let map: YNode | undefined;

<MapView ref={(node) => (map = node)} latitude={52.52} longitude={13.405} style={{ flex: 1 }} />;

map?.command("zoomTo", { level: 3 });
```

`command(name, args)` (TSX: `command(name, args?)`) sends the name and the arguments (any JSON value) to the component's `command` method. Commands
are applied in order with the changes made before them, so a command issued right after a prop change sees the new prop.

## Sizing

The container is laid out like a `<View>`:

- Where the style gives a dimension (`width`, `height`, `flex: 1`, `alignSelf: "stretch"`, ...), that dimension wins.
- Where the style leaves a dimension open, the container takes the size the component reported with `setSize`, like an
  image takes its natural size. A component that never reports a size measures 0 along open dimensions.

Report the size in points (iOS) or dp (Android) whenever the content changes. The badge above measures its label each
time `text` changes and reports the label's size plus padding, so `alignSelf: "flex-start"` makes the badge exactly as
wide as its text.

## Registering on iOS (Swift)

Implement `NshComponent` and register a factory on the `NshAppView`:

```swift
import NativeShell
import UIKit

/// `embed.badge`: props `text` and `color`; emits `tap`; command `pulse`.
final class Badge: NshComponent {
    let view = UIView()
    private let label = UILabel()
    private let context: NshComponentContext
    private var taps = 0

    init(_ context: NshComponentContext) {
        self.context = context
        label.textColor = .white
        label.font = .boldSystemFont(ofSize: 17)
        label.textAlignment = .center
        label.frame = view.bounds
        label.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(label)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
    }

    func setProp(_ name: String, _ value: Any?) {
        switch name {
        case "text":
            label.text = value as? String
            let size = label.intrinsicContentSize
            context.setSize(CGSize(width: size.width + 32, height: size.height + 20))
        case "color":
            view.backgroundColor = (value as? String).flatMap(UIColor.init(hex:)) ?? .systemPurple
        default:
            break
        }
    }

    func command(_ name: String, _ args: Any?) {
        guard name == "pulse" else { return }
        view.alpha = 0.3
        UIView.animate(withDuration: 0.6) { self.view.alpha = 1 }
    }

    @objc private func tapped() {
        taps += 1
        context.emit("tap", ["count": taps])
    }
}

// Before loading the bundle:
app.register(component: "embed.badge") { context in Badge(context) }
```

(`UIColor(hex:)` is a small helper of the sample, not part of NativeShell.)

| API | Description |
|---|---|
| `NshAppView.register(component:_:)` | Registers a factory `(NshComponentContext) -> NshComponent` under a name. It makes one component per element created from then on. Registering a name again replaces the factory. |
| `protocol NshComponent` | `var view: UIView` (fills the container), `setProp(_:_:)`, `command(_:_:)` (optional: the default ignores commands). Main-actor isolated. |
| `setProp(_ name: String, _ value: Any?)` | Values are Foundation JSON objects: `String`, `NSNumber`, `[Any]`, `[String: Any]`, `NSNull`; `nil` when the prop was removed. |
| `NshComponentContext.emit(_:_:)` | Emits an event; the data must be something `JSONSerialization` accepts (or `nil`). Thread-safe. |
| `NshComponentContext.setSize(_:)` | Reports the component's own size in points. Thread-safe. |

## Registering on Android (Java / Kotlin)

Implement `com.longbridge.nsh.NshComponent` and register a factory on the `NshView`:

```java
import com.longbridge.nsh.NshComponent;
import com.longbridge.nsh.NshComponentContext;

final class Badge implements NshComponent {
    private final TextView label;
    private final NshComponentContext context;
    private final float density;
    private int taps;

    Badge(Context app, NshComponentContext context) {
        this.context = context;
        density = app.getResources().getDisplayMetrics().density;
        label = new TextView(app);
        label.setTextColor(Color.WHITE);
        label.setTextSize(17);
        label.setGravity(Gravity.CENTER);
        label.setOnClickListener(v -> context.emit("tap", Collections.singletonMap("count", ++taps)));
    }

    @Override
    public View view() {
        return label;
    }

    @Override
    public void setProp(String name, Object value) {
        if (name.equals("text")) {
            label.setText(value instanceof String ? (String) value : "");
            label.measure(0, 0);
            // Sizes are in dp.
            context.setSize(label.getMeasuredWidth() / density + 32, label.getMeasuredHeight() / density + 12);
        } else if (name.equals("color")) {
            label.setBackgroundColor(value instanceof String ? Color.parseColor((String) value) : 0xff8250df);
        }
    }

    @Override
    public void command(String name, Object args) {
        if (!name.equals("pulse")) return;
        label.setAlpha(0.3f);
        label.animate().alpha(1).setDuration(600).start();
    }
}

// Before loading the bundle:
nsh.registerComponent("embed.badge", context -> new Badge(this, context));
```

The same in Kotlin:

```kotlin
nsh.registerComponent("embed.badge") { context -> Badge(this, context) }
```

| API | Description |
|---|---|
| `NshView.registerComponent(String name, NshComponent.Factory factory)` | Registers a factory under a name; it makes one component per element created from then on (UI thread). |
| `interface NshComponent` | `View view()`, `void setProp(String, Object)`, `default void command(String, Object)`, `default void destroy()` (the element is gone: removed, or its app stopped by `NshView.destroy()` or replaced by another load; called once per component). Called on the UI thread. |
| `setProp` values | `String`, `Number`, `Boolean`, `java.util.List`, `java.util.Map`, or `null` when removed (or JSON `null`). |
| `NshComponentContext.emit(String event, Object data)` | Emits an event; `data` as the same Java types, or `null`. Any thread. |
| `NshComponentContext.setSize(float width, float height)` | Reports the component's own size in dp. Any thread. |

## Registering from Rust

Apps that embed the iOS runtime from Rust (`nsh-platform-ios`) register a `NativeComponent` on an `AppView`:

```rust
use std::rc::Rc;
use nsh_core::JsonValue;
use nsh_platform_ios::{AppView, ComponentContext, NativeComponent};
use objc2_ui_kit::UIView;

struct Badge {
    view: objc2::rc::Retained<UIView>,
    context: ComponentContext,
}

impl NativeComponent for Badge {
    fn view(&self) -> &UIView {
        &self.view
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        // ... update the view, then report its size in points:
        self.context.set_size(120.0, 40.0);
    }

    fn command(&mut self, name: &str, args: &JsonValue) {
        // optional
    }
}

fn register(app: &AppView, make_view: impl Fn() -> objc2::rc::Retained<UIView> + 'static) {
    app.register_component(
        "embed.badge",
        Rc::new(move |context: ComponentContext| -> Box<dyn NativeComponent> {
            Box::new(Badge { view: make_view(), context })
        }),
    );
}
```

`ComponentContext::emit(name, data)` sends an event (`data` is a `serde_json::Value`) and `set_size(width, height)`
reports the size; both work from any thread.

## Registering on macOS (Rust)

On macOS the component is an `NSView`, registered on the [`AppView`](./macos.md#embedding-in-a-mac-app) of
`nsh-platform-macos`:

```rust
use std::rc::Rc;
use nsh_core::JsonValue;
use nsh_platform_macos::{
    objc2::{rc::Retained, MainThreadMarker},
    objc2_app_kit::{NSTextField, NSView},
    objc2_foundation::NSString,
    AppView, ComponentContext, NativeComponent,
};

struct Badge {
    label: Retained<NSTextField>,
    context: ComponentContext,
}

impl NativeComponent for Badge {
    fn view(&self) -> Retained<NSView> {
        Retained::into_super(Retained::into_super(self.label.clone()))
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        if name == "text" {
            let text = value.and_then(|v| v.as_str()).unwrap_or("");
            self.label.setStringValue(&NSString::from_str(text));
            self.context.set_size(120.0, 40.0);
        }
    }

    fn command(&mut self, name: &str, args: &JsonValue) {
        // optional
    }
}

fn register(app: &AppView, mtm: MainThreadMarker) {
    app.register_component(
        "embed.badge",
        Rc::new(move |context: ComponentContext| -> Box<dyn NativeComponent> {
            Box::new(Badge { label: NSTextField::labelWithString(&NSString::new(), mtm), context })
        }),
    );
}
```

The view fills the container NSH lays out; `ComponentContext::emit` and `set_size` (points) work from any thread, as
on iOS. Register before `AppView::load`; a registry belongs to one `AppView` (and the views made from the same
`AppOptions`).

## Registering on Linux (Rust)

On Linux the component is a GTK widget, registered on the [`AppView`](./linux.md#embedding-in-a-gtk-app) of
`nsh-platform-linux`:

```rust
use std::rc::Rc;
use nsh_core::JsonValue;
use nsh_platform_linux::{gtk4 as gtk, AppView, ComponentContext, NativeComponent};
use gtk::prelude::*;

struct Badge {
    label: gtk::Label,
    context: ComponentContext,
}

impl NativeComponent for Badge {
    fn widget(&self) -> gtk::Widget {
        self.label.clone().upcast()
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        if name == "text" {
            self.label.set_text(value.and_then(|v| v.as_str()).unwrap_or(""));
            self.context.set_size(120.0, 40.0);
        }
    }

    fn command(&mut self, name: &str, args: &JsonValue) {
        // optional
    }
}

fn register(app: &AppView) {
    app.register_component(
        "embed.badge",
        Rc::new(|context: ComponentContext| -> Box<dyn NativeComponent> {
            Box::new(Badge { label: gtk::Label::new(None), context })
        }),
    );
}
```

The widget fills the container NSH lays out; `ComponentContext::emit` and `set_size` (points) work from any thread,
as on iOS. Register before `AppView::load`. A registry belongs to one `AppView` (and the views made from the same
`AppOptions`, whose `components` field it is).

## Registering on Windows (Rust)

On Windows NSH draws every view itself with Direct2D, so a component either draws into its container with Direct2D
(`draw`) or brings a window of its own (`window`: a map control, a third-party view), registered on the
[`AppView`](./windows.md#embedding-in-a-win32-app) of `nsh-platform-windows`:

```rust
use std::rc::Rc;
use nsh_core::JsonValue;
use nsh_platform_windows::{
    windows::Win32::Graphics::Direct2D::{
        Common::{D2D1_COLOR_F, D2D_RECT_F},
        ID2D1DeviceContext,
    },
    AppView, ComponentContext, NativeComponent,
};

/// A box filled with the color of its `on` prop.
struct Badge {
    on: bool,
    context: ComponentContext,
}

impl NativeComponent for Badge {
    fn draw(&self, dc: &ID2D1DeviceContext, size: (f32, f32)) {
        let color = if self.on {
            D2D1_COLOR_F { r: 0.2, g: 0.7, b: 0.3, a: 1.0 }
        } else {
            D2D1_COLOR_F { r: 0.6, g: 0.6, b: 0.6, a: 1.0 }
        };
        // SAFETY: Direct2D calls on the context nsh draws with.
        unsafe {
            if let Ok(brush) = dc.CreateSolidColorBrush(&color, None) {
                let rect = D2D_RECT_F { left: 0.0, top: 0.0, right: size.0, bottom: size.1 };
                dc.FillRectangle(&rect, &brush);
            }
        }
    }

    fn set_prop(&mut self, name: &str, value: Option<&JsonValue>) {
        if name == "on" {
            self.on = value.and_then(|v| v.as_bool()).unwrap_or(false);
            self.context.set_size(120.0, 40.0);
            self.context.redraw();
        }
    }

    fn command(&mut self, name: &str, args: &JsonValue) {
        // optional
    }
}

fn register(app: &AppView) {
    app.register_component(
        "embed.badge",
        Rc::new(|context: ComponentContext| -> Box<dyn NativeComponent> {
            Box::new(Badge { on: false, context })
        }),
    );
}
```

`draw` runs with every frame of the window, in the view's coordinates (points), clipped to its bounds; call
`ComponentContext::redraw` when what it shows changes. A drawn component is covered, clipped and transformed like any
view, and its container gets the touches. A component that returns a child window from `window` is moved, clipped and
hidden with its view, receives its own input, and sits above everything NSH draws (NSH content over it is hidden, as
with web views). `ComponentContext::emit`, `set_size` (points) and `redraw` work from any thread. Register before
`AppView::load`; a registry belongs to one `AppView` (and the views made from the same `AppOptions`).

## Rules and limits

- **Register before loading.** Factories apply to elements created after the registration. Register every name before
  `loadBundle` / `loadAssetBundle` / `run`, so the first frame finds them.
- **The container owns decoration and touches.** Background, borders, corner radius, shadows, opacity, transforms and
  `overflow: "hidden"` apply to the container NSH draws. Your view fills it and receives the touches that land inside.
- **Capabilities do not apply.** A registered component is the host app's own code; the
  [capabilities](./sandbox-and-capabilities.md) an app declares do not restrict what it does. If you embed apps you
  do not trust, only register components that are safe for them to use.
- **Keep the interface to data.** Props, event payloads and command arguments cross as JSON text; send identifiers and
  small values, not large blobs, on every change.
- **One bundle, both platforms.** Register the same names with the same props and events on iOS and Android, so one
  bundle runs on both.
- **Names under `nsh/` are NSH's.** NSH's own components (the system's tab bar of `nsh/mobile`'s `TabBar`) are
  registered under `nsh/`; name yours after your app or company (`embed.badge`), and a registration under `nsh/` logs
  a warning and keeps NSH's.

## See also

- [`nsh/native` reference](../modules/nsh-native.md)
- [Embedding in iOS apps](./ios.md) and [in Android apps](./android.md)
- [Architecture](./architecture.md): how props and events cross threads
