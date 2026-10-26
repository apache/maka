---
title: 安全区
description: safe-area-inset 环境变量以及 safeArea 和 safeAreaInsets 访问器：让内容避开刘海、状态栏、主屏幕指示条和标题栏。
order: 10.6
group: primitives
demo: el-safe-area
---

# 安全区

安全区让内容避开刘海或灵动岛、状态栏、主屏幕指示条、导航标题栏以及 Mac Catalyst 的窗口标题栏。任何视图都可以用 CSS 的 `env()` 按它添加内边距：在 padding 或 margin 中使用 `env(safe-area-inset-top)`、`env(safe-area-inset-right)`、`env(safe-area-inset-bottom)` 和 `env(safe-area-inset-left)`。它们是节点所在根视图的边距：在 [NavPage](./nav-stack.md) 中是页面标题栏下方的边距，在 [Dialog](./dialog.md) 中是对话框的边距，其他地方是界面的安全区。在浏览器中页面就是根视图，这些变量就是浏览器自己的。

```rust tabs
use nsh_core::prelude::*;

fn app() -> impl IntoElement {
    view()
        .flex_1()
        .bg(rgb(0xfff8c5))
        .p_safe_area()
        .child(text("Clear of the notch").text_2xl().font_weight(FontWeight::BOLD))
}
```

```tsx tabs
import { mount, Text, View } from "nsh";

function App() {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: "#fff8c5",
        paddingTop: "env(safe-area-inset-top)",
        paddingRight: "env(safe-area-inset-right)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
      }}
    >
      <Text style={{ fontSize: 24, fontWeight: "700" }}>Clear of the notch</Text>
    </View>
  );
}

mount(App);
```

背景色填满整个区域，包括状态栏背后的区域，内容从它下方开始。这些值跟随边距变化：旋转屏幕、进入另一个页面或对话框时，内边距会在原生侧更新。

## 取值

| 值 | 示例 | 含义 |
|---|---|---|
| `env(name)` | `paddingTop: "env(safe-area-inset-top)"` | 该边距。 |
| `env(name, <length>)` | `env(safe-area-inset-top, 20px)` | 该边距；名称未知时使用这个长度，与 CSS 相同。 |
| `calc(env(name) + <length>)` | `calc(env(safe-area-inset-bottom) + 16px)` | 边距加上一个长度，用于保留自身间距的内容。 |
| `calc(<length> + env(name))` | `calc(16px + env(safe-area-inset-left))` | 同上。 |

它们适用于 `padding`、`paddingHorizontal`、`paddingVertical`、`paddingTop`、`paddingRight`、`paddingBottom`、`paddingLeft` 以及对应的 `margin` 键。在 Tailwind 中，它们是 `p`、`px`、`py`、`pt`、`pr`、`pb`、`pl` 和 `m` 系列工具类的任意值（可以省略空格）：`pt-[env(safe-area-inset-top)]`、`pb-[calc(env(safe-area-inset-bottom)+16px)]`。这些值的 TypeScript 类型是 `EnvValue`。参见[样式参考](../modules/style-reference.md)。

在 Rust 中由 `Styled` 方法设置：`.p_safe_area()`、`.px_safe_area()`、`.py_safe_area()`、`.pt_safe_area()`、`.pr_safe_area()`、`.pb_safe_area()`、`.pl_safe_area()`、对应的 `m` 方法，以及表示边距加长度的 `.pt_safe_area_plus(px(16.0))`（还有 `pr`、`pb`、`pl`、`mt`、`mr`、`mb`、`ml`）。

## 选择边

只给需要的边添加内边距，例如由标签栏或你自己的底部栏处理底部边距时：

```rust tabs
view()
    .flex_1()
    .pt_safe_area()
    .px_safe_area()
```

```tsx tabs
<View class="flex-1 pt-[env(safe-area-inset-top)] px-[calc(env(safe-area-inset-left)+16px)]">
  …
</View>
```

## 使用场景

标题栏可见且不透明的 [NavPage](./nav-stack.md) 已经把内容放在标题栏下方，因此那里的顶部边距为 0。安全区边距用于：

- 没有导航栈的应用的根视图，
- 设置了 `headerVisible={false}` 或 `headerTransparent` 的页面，
- 全屏 [Dialog](./dialog.md) 的内容，
- 位于屏幕边缘的自定义栏。

## safeArea 与 safeAreaInsets

需要在代码中使用这些数值时，可以直接读取。两个 TSX 访问器都来自 `nsh`，返回一个 `Edges` 对象（`{ top, right, bottom, left }`，单位为点），并且是响应式的：读取它们的代码会在其变化时（例如旋转屏幕时）重新运行。

| TSX | Rust | 返回 |
|---|---|---|
| `safeArea()` | `safe_area()` | 界面的安全区：避开系统 UI（刘海、主屏幕指示条、标题栏）的部分。 |
| `safeAreaInsets()` | `cx.insets()` | 组件渲染位置的边距：最近页面的（标题栏下方）、最近对话框的，否则是界面的安全区。它们就是 `safe-area-inset-*` 变量的值。在 TSX 中，请在组件内调用它；它返回一个访问器。你的 crate 中的 Rust 组件用 `cx.insets()` 读取。 |

```rust tabs
use nsh_core::prelude::*;

fn bottom_bar() -> impl IntoElement {
    view()
        .flex_row()
        .p_2()
        .pb(move || if safe_area().bottom > Points::ZERO { px(4.0) } else { px(8.0) })
        .child(text("Bottom bar"))
}
```

```tsx tabs
import { Text, View, safeArea } from "nsh";

function BottomBar() {
  const insets = safeArea();
  return (
    <View style={{ flexDirection: "row", padding: 8, paddingBottom: insets().bottom > 0 ? 4 : 8 }}>
      <Text>Bottom bar</Text>
    </View>
  );
}
```

如果只是按边距本身添加内边距，`env()` 更简单：它在原生侧更新，不需要运行代码。

## 平台说明

- **iOS**：边距来自 UIKit 的安全区：状态栏、刘海或灵动岛，以及主屏幕指示条。
- **Android**：NSH 报告系统栏和显示屏挖孔与 NSH 视图重叠的部分。当 NSH [嵌入](../docs/android.md)在原生工具栏下方时，视图的顶部边距为 0。
- **Mac Catalyst**：顶部边距是窗口的标题栏。
- **桌面平台（macOS、Windows、Linux、GPUI）和 Web**：页面内容从 `header` 下方开始，对话框为内容提供自己的边距，与手机上相同。

## 相关内容

- [键盘](./keyboard.md)：`env(keyboard-inset-height)`，让内容保持在软键盘之上。
- [设备与环境](../docs/device-and-environment.md)：安全区以及设备的其他值。
