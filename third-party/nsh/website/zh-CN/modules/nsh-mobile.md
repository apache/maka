---
title: nsh/mobile
description: iOS 和 Android 都有的 API：isAvailable 和系统标签栏 TabBar。
order: 12.2
---

# nsh/mobile

`nsh/mobile` 收录 iOS 和 Android 共有的移动平台专属能力：目前是系统的标签栏 `TabBar`。它在 iOS（包括 iPadOS 和 Mac Catalyst）和 Android 上工作。Rust 代码使用 `nsh_core::mobile`；TSX 导入 `nsh/mobile`。这个模块在所有平台上都可以导入，所以同一个 bundle 能在各处运行：在其他平台上，它的组件不占空间、不显示内容，`isAvailable` 告诉你当前是否在 iOS 或 Android 上。只有其中一个平台才有的东西在 [nsh/ios](./nsh-ios.md) 或 [nsh/android](./nsh-android.md) 中，只有桌面才有的在 [nsh/desktop](./nsh-desktop.md) 中。

```rust tabs
use nsh_core::mobile::{TabBarItem, tab_bar};
```

```tsx tabs
import { isAvailable, TabBar } from "nsh/mobile";
import type { TabBarItem, TabBarProps } from "nsh/mobile";
```

## 模块范围

这个模块提供移动平台专属的能力，例如用于应用顶层导航的系统标签栏。通用控件属于 [`nsh/base`](./nsh-base.md)：例如 [Switch](../elements/switch.md) 在手机、桌面和 Web 上共享行为与 API，轨道、滑块和各状态的样式由应用提供。`TabBar` 服务于移动应用导航，`Tabs` 服务于跨平台的标签内容切换。这个模块仅接受具有移动平台专属交互语义的能力。系统外观、尺寸或动画本身仍属于通用控件的共享职责。这个职责区别决定哪些能力适合放在这里（[目标与设计原则](../docs/goals.md)）。

## isAvailable

```ts
const isAvailable: boolean;
```

在 iOS、iOS 模拟器、Mac Catalyst 和 Android 上为 `true`，其他平台为 `false`。Rust：`matches!(os(), Os::Ios | Os::Android)`。

## TabBar

标签栏在应用的几个顶层部分之间切换：记录和统计、收件箱和设置。`TabBar` 就是系统自己的标签栏，所以它的外观和行为与系统应用一致：iOS 和 iPadOS 上是 `UITabBar`（iOS 26 上是 Liquid Glass 及其选中效果），Android 上是 Material 3 的导航栏，使用系统的颜色，浅色和深色都一样。应用提供标签（`items`），指明选中哪一个（`selectedIndex`），接收用户的选择（`onChange`），用 `class` 和 `style` 摆放标签栏，并自己显示选中部分的内容。页面内的标签，以及在所有平台上，请使用 `nsh/base` 的 [Tabs](../elements/tabs.md)。

```rust tabs
use nsh_core::{
    mobile::{TabBarItem, tab_bar},
    ui::prelude::*,
};

fn sections() -> impl IntoElement {
    let section = signal(0u32);
    view()
        .flex_1()
        .child(text(move || match section.get() {
            0 => "Records",
            _ => "Stats",
        }))
        .child(
            tab_bar()
                .items(vec![
                    TabBarItem::new("Records").icon("list.bullet"),
                    TabBarItem::new("Stats").icon("chart.bar"),
                ])
                .selected_index(section)
                .on_change(move |index: &u32| section.set(*index))
                .absolute()
                .left_0()
                .right_0()
                .bottom_0(),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { TabBar } from "nsh/mobile";
import { platform } from "nsh/device";

function App() {
  const section = signal(0);
  return (
    <View class="flex-1">
      <Text>{section() === 0 ? "Records" : "Stats"}</Text>
      <TabBar
        items={[
          { title: "Records", icon: platform.select({ ios: "list.bullet", android: "ic_records" }) },
          { title: "Stats", icon: platform.select({ ios: "chart.bar", android: "ic_stats" }) },
        ]}
        selectedIndex={section()}
        onChange={(index) => section.set(index)}
        class="absolute inset-x-0 bottom-0"
      />
    </View>
  );
}

mount(App);
```

`TabBar` 来自 `nsh/mobile`，在 Rust 中是 `nsh_core::mobile`。选中状态属于应用：一次点按通过 `onChange` 报告该标签的索引，标签栏像系统的一样立即显示这次选择，应用显示那一部分并把索引作为 `selectedIndex` 传回。样式没有给定高度时，高度是系统的。在 Rust 中，`tab_bar()` 创建它，每个 prop 一个 setter（`.items(..)`、`.selected_index(..)`），每个事件一个监听方法（`.on_change(..)`），以及带类型的样式方法；`TabBarItem::new(title).icon(name)` 创建一个标签。

### Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `TabBarItem[]` | `[]` | 各个标签，按顺序。 |
| `selectedIndex` | `.selected_index(..)` | `number` | `0` | 选中的标签的索引；超出标签数量的索引不选中任何标签。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 标签栏的位置和尺寸。外观是系统的。 |
| `testID` | `.test_id(..)` | `string` | 无 | 在测试和 `nsh test --trace` 中找到标签栏。 |

#### TabBarItem

| 字段 | Rust | 类型 | 说明 |
|---|---|---|---|
| `title` | `TabBarItem::new(title)` | `string` | 标签的标题，屏幕阅读器会读出它。 |
| `icon` | `.icon(name)` | `string` | 标签的图标，用平台对它的称呼：iOS 上是 [SF Symbol](https://developer.apple.com/sf-symbols/)（`"house"`），Android 上是应用的 drawable（`res/drawable/home.xml` 写作 `"home"`，`"android:ic_menu_search"` 是系统的）。用 `platform.select` 按平台选择。 |

### 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange` | `.on_change(\|index: &u32\| ..)` | 用户选择了一个标签：它的索引。标签栏立即显示这次选择；应用显示该标签的内容并设置 `selectedIndex`。 |

### 平台说明

- **iOS 和 Mac Catalyst**：`UITabBar`，采用当前 iOS 版本的系统外观：iOS 26 上是悬浮的 Liquid Glass 标签栏及其选中效果。图标是 SF Symbols。
- **Android**：Material 3 的导航栏，由平台的 View 组成：每个标签的文字上方是放在激活指示器中的图标，按压时有水波纹；Android 12 及以上使用系统的动态颜色，更早的版本使用 Material 的基准颜色；浅色或深色跟随应用的外观。位于窗口底部时，它延伸到导航栏下方，高度增加导航栏的 inset，与 Material 的一致。图标是应用的 drawable（由标签栏着色）。
- **桌面（macOS、Windows、Linux、GPUI）和 Web**：各个部分用 [Tabs](../elements/tabs.md) 显示，外观由应用决定。`TabBar` 在这些平台上不占空间，所以一个布局可以同时包含两者，用 `platform.os`（[nsh/device](./nsh-device.md)）来选择。
