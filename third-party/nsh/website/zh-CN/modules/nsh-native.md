---
title: nsh/native
description: nativeComponent 与 nativeModule：把你的应用连接到宿主应用注册的原生视图和 Rust 函数。
order: 9
---

# nsh/native

`nsh/native` 在运行时按名称把你的应用与宿主应用提供的能力连接起来。嵌入了 NSH 的 iOS 或 Android 应用可以按名称注册自己的视图（地图、图表、相机预览等）；`nativeComponent` 为其中一个视图生成带类型的组件。由于 NSH 使用真正的原生视图渲染，这样的组件和其他视图一样位于视图层级中：由 NSH 布局，随父视图裁剪和滚动，层叠关系也正确。用 Rust 嵌入 NSH 的应用还可以注册函数、类和 Rust 组件；`nativeModule` 把它们作为一个带类型的对象交给你。两种方式下应用都用标准的 `nsh build` 构建：宿主在运行应用时接上它提供的内容。Rust 代码用 `nsh_core::ui::prelude` 中的 `native(name)` 放置已注册的视图，用 `.prop(name, value)` 设置它的属性（一个 JSON 值，或给出 JSON 值的信号或闭包），或用 `.bind_prop(name, &value)` 把属性绑定到动画值，用 `.on_native_event(…)` 接收它的事件，并通过 `ElementRef` 调用它的命令；TSX 导入 `nsh/native`。

```rust tabs
use nsh_core::ui::prelude::*; // native、NativeEvent、element_ref
```

```tsx tabs
import { nativeComponent, nativeModule } from "nsh/native";
```

原生侧的注册方法见[原生组件](../docs/native-components.md)，以及 [iOS 嵌入](../docs/ios.md) / [Android 嵌入](../docs/android.md)。

## nativeComponent

```ts
function nativeComponent<P extends object = {}, E extends object = {}>(
  name: string,
  spec: NativeComponentSpec<P, E>,
): (props: NativeComponentProps<P, E>) => YNode;

interface NativeComponentSpec<P, E> {
  /** 组件自己的属性：发送给组件（任意 JSON 值），每个属性在变化时发送。 */
  props: readonly (keyof P & string)[];
  /** 组件会发出的事件。 */
  events?: readonly (keyof E & string)[];
}
```

返回一个组件，对应宿主应用以 `name` 注册的原生组件（Swift `NshAppView.register(component:)`，Java `NshView.registerComponent`）。Rust：`native(name)`，一个属性为 JSON 值（`.prop("text", json!(…))`）、事件以 `NativeEvent { name, data }` 送达的视图。

- `P` 是组件自身属性的类型。`spec.props` 中列出的每个属性变化时都会以 JSON 发送到原生侧；设为 `undefined` 会移除该属性。
- `E` 把事件名映射到事件数据。事件 `regionChange` 对应处理属性 `onRegionChange`。
- 组件还接受除 `children` 之外的所有[视图属性](../elements/view.md)：`style`、`class`、布局、无障碍、触摸处理和 `ref`。

```ts
type NativeComponentProps<P, E> = Omit<ViewProps, "children"> & P & NativeEventHandlers<E>;
type NativeEventHandlers<E> = { [K in keyof E & string as `on${Capitalize<K>}`]?: (data: E[K]) => void };
```

### 尺寸

组件像普通视图一样布局，尺寸由样式决定。样式没有确定的维度会使用原生组件报告的尺寸（就像图片使用其原始尺寸一样）。

### 命令

它的 `ref` 拿到一个 `YNode`；`ref.command(name, args)` 调用原生组件的 `name` 命令，参数 `args` 为任意 JSON 值。Rust：`ElementRef::command(name, args)`。

```rust tabs
map.command("zoomTo", json!({ "level": 3 }));
```

```tsx tabs
map.command("zoomTo", { level: 3 });
```

### 没有注册时

如果 `name` 下没有注册任何组件（换了宿主应用、开发宿主、浏览器），组件会渲染为一个空视图，并输出一次警告。请让应用在没有它时仍然可用，或在使用前确认宿主环境。

## 示例

这里的徽标是宿主应用的原生视图，注册名为 `embed.badge`。NSH 负责布局，向它发送 `text` 和 `color`，接收它的 `tap` 事件，并调用它的 `pulse` 命令：

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

返回嵌入应用以 `specifier` 注册的套件的导出：其中的模块、类、函数和 Rust 组件，合成一个对象。类型 `T` 由应用自己声明，因此构建应用时不需要了解宿主。与宿主的 crate 一起构建的 Rust 代码直接以 Rust 调用这些函数；`nativeModule` 是 TSX 访问它们的方式。

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

- 调用方式与导入套件时相同：普通 Rust 函数立即返回结果，`async` 函数返回 Promise，传入的函数是 Rust 之后可以调用的回调。Rust 检查每个参数，参数类型不对时抛出 `TypeError`。
- 在同一个虚拟机中，同一个 `specifier` 每次调用都返回同一个对象，其导出值与导入该套件时得到的相同。
  首次通过任一路径访问时，宿主值工厂会运行一次；两种路径共享同一个原生实例，重载会创建新实例。
- `specifier` 下没有注册内容时，`nativeModule` 抛出注明该名称的 `ReferenceError`。请在应用能处理这种情况的地方调用它，或只在为之开发的宿主中使用。

宿主用 Rust 注册套件：在创建视图之前调用平台 crate 的 `set_ui_sets`（与 NSH 自己的套件放在一起），或使用 `EngineConfig::ui_sets`：

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

`subscribe` 让宿主的数据与每个应用保持同步：它的任务等待宿主的变化，并把每次变化发送给应用；因此宿主自己做出的修改，或任一应用通过其他函数做出的修改，都会到达所有订阅了的应用。

嵌入宿主还可以通过 `Registry::value(name, factory)` 注册已有客户端。工厂捕获宿主授予该界面的客户端，
并返回 `Instance::new(service)` 等类型化值；其 Rust 类方法组成应用可使用的 API。取消和外部资源由宿主管理。
参见[宿主管理的服务](../docs/tui.md#宿主管理的服务)，了解按视图注册的方式。

> [!NOTE]
> 属性、事件和命令参数都以 JSON 形式传到原生侧。注册的组件和函数是宿主应用自己的代码：NSH 的[沙箱限制与权限](../docs/sandbox-and-capabilities.md)不约束它们的行为。
