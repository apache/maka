---
title: 原生组件
description: 在 NSH 应用中使用宿主应用的视图（地图、播放器、任意 UIView 或 Android View），支持 props、事件、命令和尺寸上报。
order: 18
group: platforms
---

# 原生组件

原生组件是由**嵌入方应用**按名称注册的视图：地图、相机预览、图表库，或者 iOS 上任意的 `UIView`、Android 上任意的
`android.view.View`、macOS 上任意的 `NSView`、Linux 上任意的 `gtk::Widget`，或者 Windows 上的 Direct2D 绘制或子 `HWND`。NSH 应用像使用其他元素一样使用它：Rust 应用用 `nsh_core::ui::prelude` 的 `native(name)` 创建它，TSX 应用用 [`nsh/native`](../modules/nsh-native.md) 提供的 `nativeComponent()` 声明它。NSH
会把它和应用的其余部分一起布局，向它发送 props，把它的事件交给对应的处理函数，并转发通过 `ref` 发出的命令。

NSH 本身就用系统原生视图渲染，所以原生组件只是同一视图层级里多出来的一个子视图：不存在层级叠放问题，它会像 `<View>`
一样被裁剪、随内容滚动并接收触摸。

> [!NOTE]
> 只有在嵌入 NSH 的应用中（[iOS](./ios.md)、[Android](./android.md)、[macOS](./macos.md#嵌入-mac-应用)、[Linux](./linux.md#嵌入-gtk-应用)、[Windows](./windows.md#嵌入-win32-应用)）才有原生组件。
> 打包出的独立应用（`nsh package`）和开发宿主不会注册任何组件，因此在那里该元素会渲染成一个空视图（并记录一次“未知名称”日志）。

## 整体流程

1. 宿主应用在它的 `NshAppView`（iOS）或 `NshView`（Android）上以某个名称（如 `"embed.badge"`）注册一个工厂。
   每个视图都有自己的注册表，没有任何全局状态。
2. NSH 应用为这个名称声明一个组件，列出它用到的 props 和事件。
3. 元素创建时，NSH 先创建一个容器视图（和普通视图一样负责装饰、定位和命中测试），再向工厂请求一个组件，并把组件的视图放进容器、铺满容器。
4. 组件创建后会立即收到所有 props，之后每当某个 prop 变化时再收到该 prop。
5. 组件可以发出事件、上报自身尺寸；应用通过 `ref` 调用它的命令。

## 在应用中使用组件

在 Rust 中，`native(name)` 创建这个元素：`.prop(name, value)` 给它一个 prop（`serde_json::Value`，或者它的 signal 或闭包，变化时重新发送），
`.on_native_event(..)` 以 `NativeEvent { name, data }` 接收它的事件，用 `.element_ref(&r)` 挂上的 `element_ref()` 的方法发送它的命令。
在 TSX 中，`nativeComponent()` 为这个名称声明一个组件，列出它用到的 props 和事件。

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

TSX 版本就是 `examples/embedded/App.tsx`，仓库里的两个嵌入示例运行的都是它。

### `nativeComponent(name, spec)`

```ts
function nativeComponent<P extends object = {}, E extends object = {}>(
  name: string,
  spec: NativeComponentSpec<P, E>,
): (props: NativeComponentProps<P, E>) => YNode;
```

| 参数 | 类型 | 说明 |
|---|---|---|
| `name` | `string` | 宿主应用注册时使用的名称。请加上自己的前缀（`"maps.view"`、`"acme.chart"`），以保证名称唯一。 |
| `spec.props` | `readonly (keyof P & string)[]` | 组件自己的 props。只有这里列出的 props 才会发送到原生端。 |
| `spec.events` | `readonly (keyof E & string)[]` | 组件发出的事件。可选。 |

类型参数描述 props（`P`）以及每个事件的负载（`E`）。返回的组件接受：

- 组件自己的 props `P`；
- 每个事件对应一个处理函数：事件 `tap` 由 `onTap` 处理，`regionChange` 由 `onRegionChange` 处理（首字母大写并加上
  `on` 前缀）；
- `<View>` 能接受的一切（children 除外）：`style`、`class` / `classList`（[Tailwind](./tailwind.md)）、布局、
  无障碍 props、`testID`、`onLayout`、`ref`。这些作用于 NSH 绘制的容器，而不是组件本身。

原生组件是叶子节点：它不接受 children。

## Props

每个自有 prop 都以 JSON 形式发送，所以它的值可以是任意 JSON 值：字符串、数字、布尔值、`null`、数组和普通对象。props
和其他属性一样是响应式的：当 Rust 中 prop 的闭包（`.prop("text", move || json!(label.get()))`）或 TSX 的 `text={label()}` 读取了一个 signal，signal 变化时（且仅在此时）新值才会被发送。

| 应用中发生了什么 | 组件收到什么 |
|---|---|
| 元素被创建 | 组件创建后立即收到所有已设置的自有 prop |
| 某个 prop 的值变化 | 该 prop 及其新值 |
| 某个 prop 变为 `undefined` | 该 prop，但没有值（Swift 中为 `nil`，Java 中为 `null`） |

Props 携带 JSON 值；接口只传数据（函数、类实例和 `AnimatedValue` 留在应用中）。

## 事件

组件按名称发出事件，可附带一个 JSON 负载。NSH 把它投递到引擎线程，并用该负载调用对应的处理函数（在 Rust 中是那个 `on_native_event` 监听函数，带着事件的 `name` 和 `data`）：

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

事件是异步的：主线程从不等待应用的代码。如果组件必须当场做出决定（这个手势能否开始、这个区域能否改变），就只能在原生端根据之前收到的
props 来决定。

## 命令

命令式调用（缩放到某个点、开始播放、播放一段动画）通过元素的 ref 发起（Rust 中是 `element_ref()`，TSX 中是 `ref`）：

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

`command(name, args)`（TSX：`command(name, args?)`）把名称和参数（任意 JSON 值）发送给组件的 `command` 方法。命令会和在它之前做出的变更按顺序应用，所以紧跟在
prop 变更之后发出的命令能看到新的 prop。

## 尺寸

容器的布局方式与 `<View>` 相同：

- 样式给出了某个维度时（`width`、`height`、`flex: 1`、`alignSelf: "stretch"` 等），以样式为准。
- 样式未确定某个维度时，容器采用组件通过 `setSize` 上报的尺寸，就像图片采用它的固有尺寸一样。从不上报尺寸的组件在未确定的维度上尺寸为 0。

每当内容变化时，以点（iOS）或 dp（Android）为单位上报尺寸。上面的 badge 每次 `text` 变化时都会测量标签，并上报标签尺寸加上内边距，因此
`alignSelf: "flex-start"` 能让 badge 恰好与文字等宽。

## 在 iOS 上注册（Swift）

实现 `NshComponent`，并在 `NshAppView` 上注册一个工厂：

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

（`UIColor(hex:)` 是示例里的一个小工具函数，不属于 NativeShell。）

| API | 说明 |
|---|---|
| `NshAppView.register(component:_:)` | 以某个名称注册一个工厂 `(NshComponentContext) -> NshComponent`。此后每创建一个元素，它就生成一个组件。重复注册同一名称会替换工厂。 |
| `protocol NshComponent` | `var view: UIView`（铺满容器）、`setProp(_:_:)`、`command(_:_:)`（可选：默认实现忽略命令）。隔离在 main actor 上。 |
| `setProp(_ name: String, _ value: Any?)` | 值是 Foundation 的 JSON 对象：`String`、`NSNumber`、`[Any]`、`[String: Any]`、`NSNull`；prop 被移除时为 `nil`。 |
| `NshComponentContext.emit(_:_:)` | 发出一个事件；数据必须是 `JSONSerialization` 能接受的值（或 `nil`）。线程安全。 |
| `NshComponentContext.setSize(_:)` | 以点为单位上报组件自身的尺寸。线程安全。 |

## 在 Android 上注册（Java / Kotlin）

实现 `com.longbridge.nsh.NshComponent`，并在 `NshView` 上注册一个工厂：

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

用 Kotlin 写法相同：

```kotlin
nsh.registerComponent("embed.badge") { context -> Badge(this, context) }
```

| API | 说明 |
|---|---|
| `NshView.registerComponent(String name, NshComponent.Factory factory)` | 以某个名称注册一个工厂；此后每创建一个元素，它就生成一个组件（UI 线程）。 |
| `interface NshComponent` | `View view()`、`void setProp(String, Object)`、`default void command(String, Object)`、`default void destroy()`（元素已移除：被移除，或它的应用被 `NshView.destroy()` 停止、被再次加载替换；每个组件调用一次）。在 UI 线程上调用。 |
| `setProp` 的值 | `String`、`Number`、`Boolean`、`java.util.List`、`java.util.Map`；被移除时（或 JSON `null`）为 `null`。 |
| `NshComponentContext.emit(String event, Object data)` | 发出一个事件；`data` 使用同样的 Java 类型，或 `null`。可在任意线程调用。 |
| `NshComponentContext.setSize(float width, float height)` | 以 dp 为单位上报组件自身的尺寸。可在任意线程调用。 |

## 从 Rust 注册

从 Rust 嵌入 iOS 运行时（`nsh-platform-ios`）的应用，在 `AppView` 上注册一个 `NativeComponent`：

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

`ComponentContext::emit(name, data)` 发送一个事件（`data` 是 `serde_json::Value`），`set_size(width, height)`
上报尺寸；两者都可以在任意线程调用。

## 在 macOS 上注册（Rust）

在 macOS 上，组件是一个 `NSView`，注册在 `nsh-platform-macos` 的 [`AppView`](./macos.md#嵌入-mac-应用) 上：

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
        // 可选
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

视图会铺满 NSH 布局出的容器；与 iOS 一样，`ComponentContext::emit` 和 `set_size`（单位为点）可在任意线程调用。请在
`AppView::load` 之前注册；注册表属于一个 `AppView`（以及用同一个 `AppOptions` 创建的视图）。

## 在 Linux 上注册（Rust）

在 Linux 上，组件是一个 GTK 控件，注册在 `nsh-platform-linux` 的 [`AppView`](./linux.md#嵌入-gtk-应用) 上：

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

控件会铺满 NSH 布局出的容器；与 iOS 一样，`ComponentContext::emit` 和 `set_size`（单位为点）可在任意线程调用。请在
`AppView::load` 之前注册。注册表属于一个 `AppView`（以及用同一个 `AppOptions` 创建的视图，注册表就是它的 `components` 字段）。

## 在 Windows 上注册（Rust）

在 Windows 上，NSH 用 Direct2D 自己绘制所有视图，因此组件要么用 Direct2D 绘制在它的容器里（`draw`），要么提供一个自己的窗口
（`window`：地图控件、第三方视图），注册在 `nsh-platform-windows` 的 [`AppView`](./windows.md#嵌入-win32-应用) 上：

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

/// 一个按 `on` 属性填充颜色的方块。
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
        // 可选
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

`draw` 在窗口的每一帧都会调用，坐标为视图自身的坐标（点），并裁剪到视图边界；显示的内容变化时调用 `ComponentContext::redraw`。
绘制出来的组件会像普通视图一样被遮挡、裁剪和变换，触摸由它的容器接收。通过 `window` 返回子窗口的组件会随视图移动、裁剪和隐藏，
自己接收输入，并位于 NSH 绘制的所有内容之上（绘制在它上方的 NSH 内容会被遮住，和 Web 视图一样）。`ComponentContext::emit`、
`set_size`（单位为点）和 `redraw` 可以在任意线程调用。请在 `AppView::load` 之前注册；注册表属于一个 `AppView`（以及用同一个
`AppOptions` 创建的视图）。

## 规则与限制

- **先注册，再加载。** 工厂只对注册之后创建的元素生效。请在 `loadBundle` / `loadAssetBundle` / `run` 之前注册所有名称，这样第一帧就能找到它们。
- **装饰和触摸归容器管。** 背景、边框、圆角、阴影、不透明度、变换以及 `overflow: "hidden"` 都作用于 NSH 绘制的容器。你的视图铺满容器，并接收落在其中的触摸。
- **能力声明不适用。** 注册的组件是宿主应用自己的代码；应用声明的[能力](./sandbox-and-capabilities.md)限制不了它做什么。如果你嵌入的是不受信任的应用，就只注册那些可以放心让它们使用的组件。
- **接口只传数据。** Props、事件负载和命令参数都以 JSON 文本跨越边界；每次变更时传递标识符和小数据，而不是大块数据。
- **一个 bundle，两个平台。** 在 iOS 和 Android 上用相同的 props 和事件注册相同的名称，同一个 bundle 就能在两个平台上运行。
- **`nsh/` 下的名称属于 NSH。** NSH 自己的组件（`nsh/mobile` 的 `TabBar` 所用的系统标签栏）注册在 `nsh/` 下；请用你的应用或公司来命名自己的组件（`embed.badge`），在 `nsh/` 下注册会记录一条警告，并保留 NSH 的组件。

## 另请参阅

- [`nsh/native` 参考](../modules/nsh-native.md)
- [嵌入 iOS 应用](./ios.md)和[嵌入 Android 应用](./android.md)
- [架构](./architecture.md)：props 和事件如何跨线程传递
