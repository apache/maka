---
title: View
description: 最基础的容器元素：布局、背景、边框、阴影、按压处理和手势。
order: 2
group: primitives
demo: el-view
---

# View

`View` 是每个界面的基本构件：一个原生容器（iOS 和 Mac Catalyst 上是 UIView，Android 上是 ViewGroup），用 flexbox 或 grid 布局子元素，绘制背景、边框、阴影和渐变，并处理按压。按钮、卡片、列表行和整个界面都是 view。Rust 用 `view()` 创建，TSX 用从 `nsh` 导入的 `<View>`。

```rust tabs
use nsh_core::ui::prelude::*;

fn app() -> impl IntoElement {
    let liked = signal(false);
    view()
        .flex_1()
        .p_6()
        .gap_4()
        .bg(rgb(0xf6f8fa))
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .p_4()
                .rounded(px(16.0))
                .bg(white())
                .shadow_md()
                .child(view().size(px(40.0)).rounded_full().bg(rgb(0x8250df)))
                .child(text("一张卡片").flex_1().text_base())
                .child(
                    view()
                        .hit_slop(EdgeInsets::all(px(8.0)))
                        .active(|s| s.opacity(0.5))
                        .on_press(move || liked.update(|l| *l = !*l))
                        .child(text(move || if liked.get() { "♥" } else { "♡" }).text_size(px(22.0))),
                ),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";

function App() {
  const liked = signal(false);
  return (
    <View style={{ flex: 1, padding: 24, gap: 16, backgroundColor: "#f6f8fa" }}>
      <View
        style={{
          backgroundColor: "#ffffff",
          borderRadius: 16,
          padding: 16,
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.08)",
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
        }}
      >
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: "#8250df" }} />
        <Text style={{ flex: 1, fontSize: 16 }}>一张卡片</Text>
        <View onPress={() => liked.set(!liked())} activeStyle={{ opacity: 0.5 }} hitSlop={8}>
          <Text style={{ fontSize: 22 }}>{liked() ? "♥" : "♡"}</Text>
        </View>
      </View>
    </View>
  );
}

mount(App);
```

## 布局

view 用 flexbox 布局子元素，默认值为：`flexDirection: "column"`、`flexShrink: 0`、`alignContent: "flex-start"`、`position: "relative"`。`display: "grid"`（Rust 中为 `.grid()`）切换为 CSS grid，`display: "block"` 切换为块布局。尺寸单位是点。参见[布局](../docs/layout.md)和[样式参考](../modules/style-reference.md)。

Tailwind 的 `flex` 类遵循 CSS 而不是样式的默认值：`class="flex"` 是横向排列。需要纵向排列时用 `flex-col`。Rust 中用 `.flex_row()` 和 `.flex_col()` 指定方向。

## 属性

除[通用属性](./index.md#通用属性)外，`View` 没有自己的属性：样式（`style`、`class`、`classList`；Rust 中为 `Styled` 方法）、`disabled`，按压属性（`onPress`、`onLongPress`、`onPressDown`、`onPressUp`、`delayLongPress`、`hitSlop`、`pointerEvents`），状态样式（`activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle`、`checkedStyle`），`onHoverIn` / `onHoverMove` / `onHoverOut`、`onContextMenu`，`onFileDragEnter` / `onFileDragLeave` / `onFileDrop`，`focusable`、`onLayout`、`ref`、`nativeID`、`testID`，手势属性（`pan`、`pinch`、`rotation` 及其事件），触摸与响应者属性，无障碍属性，以及 `ios` / `android` / `desktop`。

## 按压反馈

带有按压处理函数的 view 就是可按压的。它的反馈由应用决定：按下时的样式，在手指按下期间于原生侧生效，不经过应用代码。`hoverStyle`、`focusStyle` 和 `disabledStyle` 对其他状态同样如此：

```rust tabs
// 整个视图淡化。
view().on_press(open).active(|s| s.opacity(0.6))

// 显示背景色；group_active 设置子元素的样式。
view()
    .group()
    .on_press(open)
    .active(|s| s.bg(rgb(0xe5e7eb)))
    .child(text("打开").group_active(|s| s.opacity(0.7)))

// 按下时改变任意样式。
view().on_press(open).bg(rgb(0x2563eb)).active(|s| s.bg(rgb(0x1e40af)).scale(0.95))
```

```tsx tabs
// 整个视图淡化。
<View onPress={open} activeStyle={{ opacity: 0.6 }}>…</View>

// 显示背景色；group-active: 设置子元素的样式。
<View onPress={open} class="group" activeStyle={{ backgroundColor: "#e5e7eb" }}>
  <Text class="group-active:opacity-70">打开</Text>
</View>

// 用 active: 类在按下时改变任意样式。
<View onPress={open} class="bg-blue-600 active:bg-blue-800 active:scale-95">…</View>
```

在 Android 上，`android={{ ripple: { color: "#0000001f" } }}`（Rust 中为 `.ripple(Ripple { .. })`）会加上 Material 水波纹（可用 `borderless`、`radius` 和 `foreground` 调整）。

`disabled` 会从原生视图上移除按压监听（既不响应按压，也没有反馈），并应用禁用状态的样式：

```rust tabs
view()
    .on_press(submit)
    .disabled(move || !valid.get())
    .bg(rgb(0x16a34a))
    .disabled_style(|s| s.opacity(0.4))
```

```tsx tabs
<View onPress={submit} disabled={!valid()} class="bg-green-600 disabled:opacity-40">…</View>
```

## 事件

| 事件 | Rust | 载荷 | 触发时机 |
|---|---|---|---|
| `onPress` | `.on_press` | 无 | 在视图内完成一次点击。 |
| `onLongPress` | `.on_long_press` | 无 | 手指按住达到 `delayLongPress`（500 ms）。 |
| `onPressDown` / `onPressUp` | `.on_press_down` / `.on_press_up` | 无 | 手指按下 / 抬起或移出。 |
| `onHoverIn` / `onHoverOut` | `.on_hover_in` / `.on_hover_out` | 无 | 鼠标移到视图（或其内部的视图）上 / 离开视图或窗口（见[悬停](./index.md#悬停)）。 |
| `onHoverMove` | `.on_hover_move` | `HoverEvent` | 没有按下按键时鼠标在视图上移动：`position`、`pagePosition`（`Point`）和 `modifiers`；每帧最多一次。 |
| `onMouseMove` | `.on_mouse_move` | TSX `Point`；Rust `Point<Points>` | macOS、Linux、Windows、GPUI 和 Web 上的鼠标移动，包括按键拖动。坐标以当前视图的点为单位；嵌套监听者从内向外接收，每帧最多一次。 |
| `onContextMenu` | `.on_context_menu` | `ContextMenuEvent` | 辅助按钮在视图上按下（见[上下文菜单](./index.md#上下文菜单)）。 |
| `onFileDragEnter` / `onFileDragLeave` | `.on_file_drag_enter` / `.on_file_drag_leave` | 无 | 本地文件拖入 / 离开当前桌面拖放目标。 |
| `onFileDrop` | `.on_file_drop` | `{ uris: string[] }`（`FileDropEvent`） | 本地文件或目录被放到桌面拖放目标。 |
| `onLayout` | `.on_layout` | `Bounds`（`Bounds<Points>`） | 相对父视图的 frame 发生变化。 |
| `onPanStart` / `onPanEnd` | `.on_pan_start` / `.on_pan_end` | `PanEvent` | 通过 `pan` 绑定的拖动开始 / 结束；系统取消时 `cancelled` 为 true。 |
| `onPinchStart` / `onPinchEnd` | `.on_pinch_start` / `.on_pinch_end` | `{ scale, velocity }` | 通过 `pinch` 绑定的捏合开始 / 结束。 |
| `onRotationStart` / `onRotationEnd` | `.on_rotation_start` / `.on_rotation_end` | `{ rotation, velocity }` | 通过 `rotation` 绑定的旋转开始 / 结束。 |
| `onAccessibilityAction` | `.on_accessibility_action` | `{ actionName }` | 执行了一个自定义无障碍操作。 |

触摸与响应者事件：参见[通用属性](./index.md#原始触摸与响应者系统)。

## 桌面文件拖放

在 AppKit、GTK 和 Win32 上，带有 `onFileDrop` 的视图可以接收从其他应用拖入的本地文件和目录。`onFileDragEnter` 和 `onFileDragLeave` 跟踪当前拖放目标；`onFileDrop` 接收 `{ uris: string[] }`，顺序与原生文件列表一致。每项都是绝对 `file:` URL，空格和非 ASCII 字符使用 URL 转义。请解析 URL 获取文件系统路径。

```rust tabs
let hovering = signal(false);
let files = signal(Vec::<String>::new());

view()
    .min_h(px(160.0))
    .p_6()
    .on_file_drag_enter(move || hovering.set(true))
    .on_file_drag_leave(move || hovering.set(false))
    .on_file_drop(move |event: &FileDropEvent| {
        files.set(event.uris.clone());
        hovering.set(false);
    })
    .child(text(move || if hovering.get() { "松开以接收文件" } else { "将文件拖到这里" }))
    .child(text(move || files.get().join("\n")))
```

```tsx tabs
const hovering = signal(false);
const files = signal<string[]>([]);

<View
  onFileDragEnter={() => hovering.set(true)}
  onFileDragLeave={() => hovering.set(false)}
  onFileDrop={(event) => {
    files.set(event.uris);
    hovering.set(false);
  }}
  style={{ minHeight: 160, padding: 24 }}
>
  <Text>{hovering() ? "松开以接收文件" : "将文件拖到这里"}</Text>
  <Text>{files().join("\n")}</Text>
</View>
```

最近的、已启用且监听 `onFileDrop` 的祖先视图接收文件，搜索范围止于模态根节点。`disabled` 会移除文件拖入、离开和放下的监听；离开、取消、完成或移除目标会清除当前拖放状态。原生侧根据已挂载的状态同步接受 Copy 操作。应用决定如何读取、打开或传输收到的文件。

## ref 方法

普通 view 没有自己的命令。`ref`（Rust 中为 `.element_ref(&handle)`）拿到它的节点，例如可以传给 `setAccessibilityFocus`（[`nsh/accessibility`](../modules/nsh-accessibility.md)），或者测量它（Rust 中为 `handle.measure()`）。

## 文本中的视图

放在文本里的 view 是行内附件：它坐落在基线上、随文字一起换行，并且可以单独响应按压。参见 [Text](./text.md#行内视图和图片)。

## 平台说明

- `boxShadow` 以及阴影属性（`shadowColor`、`shadowOpacity`、`shadowRadius`、`shadowOffset`）在两个平台上都会绘制；`android={{ elevation }}` 则改用 Android 的 Material 阴影。在 Android 上阴影需要背景色（背景透明的视图不会投下阴影）。
- view 上的 `filter`：iOS 支持 `opacity()`、不超过 1 的 `brightness()` 和 `drop-shadow()`（图片支持所有颜色滤镜和 `blur()`）；Android 从 API 31 起全部支持，低于该版本支持颜色滤镜。
- `backdropFilter: "blur(…)"` 在 iOS 上是系统材质（近似效果），在 Android 上需要 API 31。
- Android 绘制 `translate`、`scale` 和 `rotate` 变换；`skewX` / `skewY` 在其他平台上生效。
- `borderCurve: "continuous"`（`.border_curve(BorderCurve::Continuous)`）在两个平台上都会绘制平滑过渡到边的圆角（如同 iOS 应用图标）。
- `cursor` 样式在有指针的场合生效（Mac Catalyst、连接指针设备的 iPad、桌面平台）。
