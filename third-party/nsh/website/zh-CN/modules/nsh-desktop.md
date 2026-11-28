---
title: nsh/desktop
description: 桌面专有 API：应用的窗口（全部是一等窗口，它们的种类、属性、状态和事件）、显示器、自定义标题栏、应用菜单、右键菜单、托盘和全局快捷键。
order: 12.5
---

# nsh/desktop

`nsh/desktop` 包含只有桌面才有的东西：应用的窗口和它们的标题栏、显示器、应用菜单和右键菜单、托盘和全局快捷键。它在 macOS、Windows 和 Linux 上可用。Rust 代码在 `nsh_core::element::desktop` 中有同样的功能：应用自己的窗口（`window()`）、组件所在的窗口（`current_window()`，一个 `WindowRef`）、显示器（`displays`）、`quit`、`restart`、登录时打开（`launch_at_login`、`set_launch_at_login`）、应用菜单和右键菜单（`set_application_menu`、`popup_menu`，由 `MenuItem` 组成）、托盘（`set_tray`）和全局快捷键（`register_global_shortcut`），并用 `.window_drag(true)` 标记可拖动的视图；TSX 导入 `nsh/desktop`。这个模块在所有平台上都可以导入，因此同一个 bundle 可以在所有平台运行：在 iOS 和 Android 上它的函数什么也不做，`isAvailable` 告诉你当前是否有它的窗口和菜单。声明了能力的应用需要 `"application": true` 才能使用应用菜单、托盘、全局快捷键、`quit` 和退出请求、`restart`、退出模式和登录时打开（[能力](../docs/sandbox-and-capabilities.md#application)），否则它们什么也不做。右键菜单和应用打开的窗口（由 `windows` 授权）不需要 `application`。

```tsx tabs
import {
  Application,
  currentWindow,
  displays,
  focusedWindow,
  isAvailable,
  Menu,
  titleBar,
  Window,
  windows,
  windowState,
} from "nsh/desktop";
```

```rust tabs
use nsh_core::{
    desktop::{MenuRole, TitleBarOptions, TitleBarStyle, WindowAttributes, WindowKind, WindowMode},
    element::desktop::{
        MenuItem, current_window, displays, popup_menu, quit, set_application_menu, title_bar,
        window,
    },
    prelude::*,
};
```

在 AppKit 和 Win32 后端中，NSH 创建的菜单及未指定标签的角色菜单项会跟随 `nsh/i18n` 选择的语言，运行时切换语言也会更新。内置菜单翻译支持英语、日语、简体中文和繁体中文，其他语言回退为英语；菜单项显式指定的 `label` 始终优先。

## isAvailable

```ts
const isAvailable: boolean;
```

在这个模块的窗口和菜单 API 可用的地方为 `true`：macOS、Windows 和 Linux，但终端应用里不可用（终端应用用它的唯一界面填满终端，没有窗口）；其他平台为 `false`。Rust：桌面操作系统且 idiom 不是 `Terminal`。

[`platform.desktop`](./nsh.md#platform) 是更宽的桌面行为判断（`desktop={{…}}` 属性、`platform.select({ desktop })`）：桌面形态的浏览器也算在内，它们运行在浏览器自己的窗口中。桌面布局、密度和输入方式用 `platform.desktop` 判断，窗口和菜单用 `isAvailable` 判断。

## 窗口

应用的每个窗口都由应用唯一的引擎渲染：所有窗口共享它的 signal、context、主题和模块，窗口之间不需要传递消息。每个窗口都是一个 `WindowRef`，API 和地位都相同；`"main"` 只是应用常给第一个窗口起的 id。

- 窗口在应用根中用 [`<Window>`](#window) 声明，或用 [`Window.open`](#windowopen) 命令式地打开。
- [`currentWindow()`](#currentwindow) 是调用它的组件所在的窗口；`windows()`、`focusedWindow()` 和 `Window.get(id)` 找到其他窗口。
- 只有应用会改的东西（标题、标题栏、层级、外观、关闭策略）是窗口的[属性](#属性)：`<Window>` 的 props 和 `set()`。用户也会改的东西（外框、模式、是否打开）从 `default…` 选项开始，通过请求（`setMode`、`setBounds`、`close`……）改变，结果通过 [`state()`](#窗口状态与显示器) 和[事件](#事件)报告回来。
- 请求没有返回值：平台可能调整或拒绝一个请求（窗口管理器自己放置窗口、显示器被拔掉了），`state()` 报告实际发生了什么。
- 关闭窗口只销毁这个窗口，并释放它的 signal 和 effect；应用按退出模式继续运行。

应用宿主（app host）是不可见的。nsh.json 的 [`window`](#应用宿主与第一个窗口) 为应用声明的第一个窗口提供启动默认值，但不会创建窗口。

### Window

```ts
const Window: Component<WindowProps> & {
  open(component: () => JSX.Element, options: WindowOptions): WindowRef;
  get(id: string): WindowRef | null;
};

interface WindowProps extends WindowOptions {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (event: { open: boolean; reason: WindowCloseCause }) => void;
  onClosePress?: (event: { reason: CloseReason }) => void;
  onFocusChange?: (event: { focused: boolean }) => void;
  onModeChange?: (event: { mode: WindowMode; minimized: boolean }) => void;
  onBoundsChange?: (event: { bounds: Bounds }) => void;
  onDisplayChange?: (event: { display: Display }) => void;
  children?: JSX.Element;
}
```

在桌面上，`<Window>` 是应用自己的一个窗口，和 [`Dialog`](./nsh-base.md) 一样受控：`open` 不为 `false` 时打开（没有 `open` 时看 `defaultOpen`，默认为 `true`），卸载时关闭。在应用根的最外层，它是应用的窗口之一；在另一个窗口的内容里，它是那个窗口的场景，随它关闭。它从不作为视图渲染：它的子节点是自己树的根，有自己的响应式 owner，因此关闭窗口会释放它的 signal、effect 和按键绑定，而应用根的状态保留。子节点仍然读取应用共享的 context 和 signal，其中的 `currentWindow()` 就是这个窗口。窗口不是因 `open` prop 而关闭时，`onOpenChange({ open: false, reason })` 通知应用，应用据此设置 `open`。原因有 `"closePress"`（用户关闭了它）、`"escape"`（`closeOnEscape`）、`"blur"`（`closeOnBlur`）、`"parentClose"`（父窗口关闭了）和 `"close"`（应用调用了它的 `WindowRef.close()`）。桌面之外（iOS、Android、Web 和终端应用）没有窗口：`<Window>` 在打开时把内容作为应用唯一表面的一部分渲染；它的 `ref` 不会被设置，`currentWindow()` 就是应用的唯一表面，和旧模型的主窗口一样。

它的 props 就是它的[选项](#选项)和[属性](#属性)；属性是响应式的，`title={`${doc().name} – Editor`}` 会跟随 signal。

```tsx tabs
import { signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { Window } from "nsh/desktop";

const inspector = signal(false);

function Toolbar() {
  return (
    <View>
      <Button onPress={() => inspector.set(true)}>
        <Text>Inspector</Text>
      </Button>
      <Window
        id="inspector"
        kind="panel"
        title="Inspector"
        defaultSize={{ width: 320, height: 560 }}
        open={inspector()}
        onOpenChange={({ open }) => inspector.set(open)}
      >
        <InspectorPanel />
      </Window>
    </View>
  );
}
```

```rust tabs
#[component]
fn Inspector(open: Signal<bool>) -> impl IntoElement {
    window()
        .id("inspector")
        .kind(WindowKind::Panel)
        .title("Inspector")
        .default_size(size(px(320.0), px(560.0)))
        .open(open)
        .on_open_change(move |e| open.set(e.open))
        .content(inspector_panel)
}
```

在 Rust 中，`window()` 是一个 builder：`.id()`、`.kind()`、`.parent()`、`.modal()`、`.default_size()`、`.default_position()`、`.display()`、`.default_mode()`、`.restore_bounds()`、`.title()` 和 `.attributes(..)`（一个 `WindowAttributes`、它的 signal 或闭包）、`.open(..)`、`.on_open_change(..)`、`.on_close_press(..)` 和 `.content(..)`（每次打开时生成）；内容中的 `current_window()` 就是它的 `WindowRef`。在非桌面平台上，`<Window>` 和 `window()` 什么也不显示。

### Window.open

`Window.open(Component, options)` 是 `<Window>` 的命令式写法：在一个单独的窗口中渲染 `Component`，返回它的 `WindowRef`。打开一个已经打开的 `id` 会返回那个窗口。用户关闭它（`closeOnPress` 时）或应用调用 `close()` 时窗口关闭。

```tsx
import { signal, Text, View } from "nsh";
import { Window } from "nsh/desktop";

const unread = signal(0);

function Chat() {
  return <View><Text>{`${unread()} unread`}</Text></View>;
}

const chat = Window.open(Chat, { id: "chat", title: "Chat", defaultSize: { width: 360, height: 480 } });
chat.focus();
```

在 Rust 中，`open_window(window()...)` 是同样的写法（GPUI：`cx.open_window`）：可以在任何地方（事件处理、菜单项、任务）打开 `window()` builder 描述的窗口，并立即返回它的 `WindowRef`。如果同 id 的窗口已经打开（无论是 `open_window` 打开的还是用 `window()` 声明的），它会聚焦该窗口并返回它的 ref。在 `Window.open` 会抛错的情况下（非桌面平台，或权限不允许该窗口），它返回 `None` 并记录警告。它不使用 `.open(..)`；窗口一直打开，直到用户或 `close()` 关闭它，`.on_open_change(..)` 会收到通知。每个文档一个窗口时，给每个窗口自己的 id：

```rust
let Some(doc) = open_window(
    window()
        .id(format!("doc:{id}"))
        .title(name)
        .content(move || editor(id)),
) else {
    return;
};
```

`Window.get(id)` 是 id 为 `id` 的已打开窗口，没有时为 `null`（响应式）。每个 id 都由应用决定；`"main"` 只是第一个窗口的约定 id，没有特殊行为。在非桌面平台上 `Window.open` 抛出 `code` 为 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 的错误；应用的[权限](#权限)不允许的窗口抛出 `ERR_ACCESS_DENIED`。

### 种类

窗口的 `kind` 说明它的用途。每个种类是一组属性的默认值，应用设置的任何属性都会覆盖它：`<Window kind="popup" closeOnBlur={false}>` 是一个失去焦点时不关闭的弹出窗口。

| 种类 | 用途 | 默认值 |
|---|---|---|
| `"normal"`（默认） | 文档窗口、第一个窗口 | 在任务栏中，会激活，可调整大小。 |
| `"dialog"` | 设置、关于、确认 | 属于打开它的窗口并居中于其上；没有最小化和最大化；Escape 关闭；不在任务栏中。`modal: true` 让父窗口在它打开期间不接受输入。 |
| `"panel"` | 检查器、调色板、工具窗口 | 浮在父窗口之上；没有最小化和最大化；不在任务栏中；不激活应用。 |
| `"popup"` | 启动器、托盘弹出框、命令面板 | 没有边框；不可调整大小；Escape 和失去焦点会关闭它；浮在所有工作区之上；不在任务栏中。 |
| `"overlay"` | HUD、字幕、标注、桌宠 | 透明，指针穿透（`pointerEvents: "none"`），从不获得焦点，位于 Dock 和任务栏之上，出现在所有工作区，没有阴影。需要 `windows` 权限的 `overlay`。 |

每个平台用自己同类角色的窗口显示一个种类：macOS 上面板和弹出窗口是 `NSPanel`，Windows 上是属于父窗口的工具窗口，Linux 上是 transient 窗口。

### 选项

`WindowOptions` 是窗口打开时的设置：`<Window>` 的 props 和 `Window.open` 的第二个参数。它们也包含所有[属性](#属性)。

| 选项 | Rust（`window()`） | 说明 |
|---|---|---|
| `id` | `.id(id)` | 应用给它的 id（必填）：每个 id 一个窗口，也是 `restoreBounds` 的键。 |
| `kind` | `.kind(kind)` | 它的用途（见上）。 |
| `parent` | `.parent(id)` | 拥有它的窗口（`WindowRef` 或 id）：它保持在父窗口之上，随父窗口关闭。对话框和面板默认属于打开它们的窗口。 |
| `modal` | `.modal(true)` | 它打开期间父窗口不接受输入（对话框）。 |
| `defaultSize` | `.default_size(size)` | 打开时的内容尺寸，单位为点。 |
| `defaultPosition` | `.default_position(position)` | 打开的位置：屏幕上的一个点（`{ x, y }`）、`"center"`（所在显示器的中心）或 `"parentCenter"`。对话框在父窗口中心打开；其他窗口由系统放置。 |
| `display` | `.display(id)` | 在哪个显示器上打开。 |
| `defaultMode` | `.default_mode(mode)` | 打开时的模式：`"normal"`、`"maximized"` 或 `"fullScreen"`。 |
| `restoreBounds` | `.restore_bounds(true)` | 在用户上次离开的位置打开：它的位置按 `id` 保存在应用的数据中，再次打开时按当前的显示器夹好。 |

### 属性

`WindowAttributes` 是窗口打开期间应用会改的东西：`<Window>` 的响应式 props 和 `WindowRef.set(partial)`，后者只改它给出的属性，其他保持不变。应用设置之前，每个属性取它的种类的默认值。一次提交中的改动一起到达平台。

| 分组 | 属性 | 说明 |
|---|---|---|
| 窗口外框 | `title` | 显示在标题栏、任务栏、窗口切换器中，也提供给辅助技术。浏览器中没有窗口：页面的标题来自 [`Head`](./nsh-web.md#head)，显示在标签页上。 |
| | `titleBar` | `{ style: "default" \| "hidden"; height?; controlsOffset? }`：系统标题栏，或应用自己的标题栏（[见下](#自定义标题栏)）。`controlsOffset`（`{ x, y }`）设置隐藏标题栏中 macOS 红绿灯的位置。 |
| | `frame` | `"default"`，或 `"none"`：没有标题栏和边框，由应用绘制全部内容。 |
| 尺寸 | `minSize`、`maxSize` | 用户能调整到的最小和最大内容尺寸，`{ width, height }`，单位为点；`null` 清除。 |
| | `aspectRatio` | 用户调整大小时内容保持的比例：宽除以高（`16 / 9`），用户拖动边或角时视频、画布始终铺满窗口。`null` 清除。只限制用户的调整：`setBounds`、`sizeToContent` 和最大化不受它约束；设置后窗口保持当前尺寸，直到用户调整。Windows 和 macOS 支持（GPUI 应用只有 macOS）；Linux 暂不支持（[见下文](#宽高比)）。 |
| | `sizeToContent` | `true`、`"width"` 或 `"height"`：窗口跟随内容布局后的尺寸，原生完成，不经过 JS。 |
| 行为 | `resizable`、`movable`、`minimizable`、`maximizable`、`closable` | 用户能对它做什么。应用的请求不受它们限制。 |
| | `focusable` | 它接受键盘焦点。 |
| | `activate` | 它打开或显示时激活应用并获得焦点。 |
| 关闭 | `closeOnPress` | 按下关闭按钮或关闭快捷键时立即关闭（`true`，默认）；`false`：应用收到 `closePress`，由应用决定何时关闭（[关闭](#关闭)）。 |
| | `closeOnEscape`、`closeOnBlur` | 按 Escape 或失去焦点时关闭。 |
| 层级 | `level` | `"normal"`、`"floating"`（在普通窗口之上）、`"aboveDock"`（在 Dock 和任务栏之上）或 `"desktopIcon"`（macOS 的桌面图标层级，出现在所有空间；Windows 上移到 z 序底部）。 |
| | `taskbar` | 它在任务栏上有按钮（Windows）。 |
| | `workspaces` | `"current"` 或 `"all"`：它出现在哪些工作区（macOS 的空间）。 |
| | `pointerEvents` | `"auto"`；`"none"`：点击穿透它到达下面的内容；或 `"box-none"`：它的根视图如同视图的 `box-none`，点在它的视图上的点击由它接收，其余的穿透下去，适合放在较大透明窗口里的小面板（[见下文](#点击穿过空白区域)）。`"none"` 和 `"box-none"` 需要 `windows` 权限的 `overlay`。 |
| 外观 | `transparent` | 背景透明：只显示应用的视图。 |
| | `backdrop` | 内容背后的系统材质：`"none"`、`"window"`、`"sidebar"`、`"popover"` 或 `"hud"`。各平台映射到自己的材质（macOS 的视觉效果材质，Windows 11 的 Mica 和 Acrylic）。 |
| | `shadow` | 窗口周围的系统阴影。 |
| 任务栏 | `progress` | `{ value?, state? }` 或 `null`：任务栏按钮或 Dock 图标上的进度；`value` 从 0 到 1，`state` 为 `"normal"`、`"indeterminate"`、`"paused"` 或 `"error"`。 |

平台的窗口没有的属性会被保留，在那里不起作用：Linux 上由窗口管理器放置窗口和安排层叠，因此位置、层级和 `taskbar` 由它决定。

### 宽高比

`aspectRatio` 约束的是内容区域，不是窗口外框：标题栏和边框另算。视频播放器知道视频比例后设置一次即可：

```tsx
<Window id="player" aspectRatio={video.width / video.height} minSize={{ width: 320, height: 180 }}>
```

| 平台 | 用户看到的效果 |
|---|---|
| macOS | AppKit 的 `contentAspectRatio`：拖动任何边或角都保持比例。 |
| Windows | 在 `WM_SIZING` 里修正拖动的矩形：拖左右边按宽度定高度，拖上下边按高度定宽度，拖角按宽度。用户按住的边始终跟着指针。`minSize` 和 `maxSize` 仍然有效；比例和它们冲突时以它们为准。 |
| Linux | 暂不生效。GTK 4 没有对应的调用；Wayland 在交互式调整时根本没有宽高比约束（尺寸由合成器决定），X11 上 GDK 4 每次排版窗口（包括拖动中的每一步）都会整个重写 `WM_NORMAL_HINTS`，不带宽高比字段，另外写进去的比例会在用户拖动时被冲掉。可以让内容加黑边显示，或者在 `onBoundsChange` 里修正尺寸。 |
| GPUI 应用（Windows、Linux） | 不生效：调整大小的过程由 GPUI 控制。 |
| iOS、Android、Web、终端 | 没有窗口，不生效。 |

### 点击穿过空白区域

会变大变小的弹出面板，常常放在按最大状态设定尺寸的透明窗口里。设置 `pointerEvents: "box-none"` 后，窗口只接收落在它的视图上的点击；点在面板周围空白处的点击会到达下面的窗口，由那个窗口获得焦点，因此失去焦点时关闭的弹出窗口（`closeOnBlur`）会关闭。

窗口的根视图如同视图的 `box-none`：其中的视图按各自的 `pointerEvents`、`hidden` 和 `hitSlop` 决定，铺满窗口的视图仍然会接收落在它上面的点击。把这样的外层容器也设为 `box-none`；有没有背景并不决定窗口在哪里接收点击。窗口自己的标题栏和边框同样会让点击穿过，因此请用于无边框窗口。

```tsx
<Window id="palette" kind="popup" transparent defaultSize={{ width: 640, height: 480 }} pointerEvents="box-none">
  <View pointerEvents="box-none" class="flex-1 items-center">
    <View class="w-96 rounded-xl bg-white p-3 shadow-lg">{/* 面板 */}</View>
  </View>
</Window>
```

| 平台 | 用户看到的效果 |
|---|---|
| macOS（AppKit 与 GPUI 应用） | 视图以外的点击、滚轮和悬停交给下面的窗口或桌面。布局变化立即生效，指针移动随到随跟；一次按下在松开按键之前一直交给它开始时所在的窗口。 |
| Windows（Win32 与 GPUI 应用） | 与 macOS 相同：视图以外的点击、滚轮和悬停交给下面的窗口或桌面，布局变化立即生效，一次按下在松开按键之前一直交给它开始时所在的窗口。窗口显示期间大约每帧跟随一次指针。 |
| Linux（GTK 与 GPUI 应用，Wayland 与 X11） | 窗口只在它的视图范围内接收点击，每次布局变化后更新；其余位置交给下面的窗口。旋转或倾斜的视图、圆角的 `clipPath` 按包住它们的矩形计算。 |
| iOS、Android、Web、终端 | 没有窗口，不生效。 |

### currentWindow

```ts
function currentWindow(): WindowRef;
function windows(): WindowRef[];
function focusedWindow(): WindowRef | null;
```

`currentWindow()` 是调用它的组件所在的窗口：外层最近的 `<Window>`（或 `Window.open` 的窗口）。它跟随组件树，而不是焦点，因此组件无论用在哪里，都显示正确窗口的状态，并作用于自己的窗口。在渲染时调用并保留 `WindowRef`：在组件之外（事件处理函数、定时器、`await` 之后）调用会抛出 `TypeError`；在应用根中（任何 `<Window>` 之外）调用时，它返回主窗口的 ref：`mount` 为裸 root 创建的隐式首窗口（root 声明了 `<Window>` 场景时该窗口不打开）。桌面之外，它就是应用的唯一表面（[`isAvailable`](#isavailable) 为 false），`windows()` 只列出它；`focusedWindow()` 为 `null`。

```tsx
function SaveButton() {
  const win = currentWindow(); // 渲染时
  return <Button onPress={() => save().then(() => win.close())}><Text>Save</Text></Button>;
}
```

`windows()` 是已打开的窗口，按打开顺序排列；`focusedWindow()` 是拥有键盘焦点的窗口，焦点在其他应用时为 `null`。两者都是响应式的，在应用根和任何窗口中都可以调用。

Rust：`current_window() -> WindowRef`，同样通过组件的 context 查找。`main_window()` 返回应用根用来向宿主发命令的 ref，它不是用户窗口。

### WindowRef

```ts
interface WindowRef {
  readonly id: string;
  readonly main: boolean;
  readonly parent: WindowRef | null;
  state(): WindowState | null;
  titleBar(): TitleBarArea;
  set(attributes: Partial<WindowAttributes>): void;
  show(): void;
  hide(): void;
  focus(): void;
  close(): void;
  minimize(): void;
  restore(): void;
  setMode(mode: WindowMode): void;
  setBounds(bounds: { origin?: Partial<Point>; size?: Partial<Size>; animated?: boolean }): void;
  setPlacement(placement: WindowPlacement): void;
  center(options?: { display?: DisplayId }): void;
  requestAttention(options?: { critical?: boolean }): void;
  on(event: WindowEventName, listener: (event) => void): () => void;
}

type WindowMode = "normal" | "maximized" | "fullScreen";
```

Rust 列给出 `WindowRef` 的方法。

| 成员 | Rust | 说明 |
|---|---|---|
| `id` | `id()` | 应用给它的 id。`"main"` 只是约定俗成的第一窗口 id。 |
| `main` | `is_main()` | id 是否为 `"main"`；没有特权窗口。 |
| `parent` | | 拥有它的窗口，或 `null`。 |
| `state()` | `state()` | 平台报告的它的状态（响应式；[见下](#窗口状态与显示器)）。在非桌面平台上、显示之前和关闭之后为 `null`。 |
| `titleBar()` | `title_bar()` | 它隐藏的标题栏的区域（[见下](#titlebar)）。 |
| `set(attributes)` | `set(WindowAttributes)` | 修改给出的[属性](#属性)；其他保持原值。应用的权限不允许的属性保持不变，并给出警告。 |
| `show()`、`hide()` | `show()`、`hide()` | 显示它（最小化时还原），或隐藏它。macOS 上全屏窗口会先退出全屏再隐藏（与 macOS 应用的窗口一致），再次显示时是普通窗口。 |
| `focus()` | `focus()` | 显示它，提到所在层级的最前并给它键盘焦点；应用随之激活。窗口保持原有层级。 |
| `close()` | `close()` | 关闭它，不论 `closeOnPress` 如何，销毁它的树并释放 owner（`<Window>`：`reason` 为 `"close"` 的 `onOpenChange`）。其他窗口不受影响；只有最后一个窗口关闭时，应用才按[退出模式](#退出)退出。 |
| `minimize()`、`restore()` | `minimize()`、`restore()` | 最小化它，或按原来的模式还原：最大化的窗口最小化后还原时仍是最大化。 |
| `setMode(mode)` | `set_mode(mode)` | 让它进入 `"normal"`、`"maximized"` 或 `"fullScreen"`；请求它当前的模式不会有变化。隐藏的窗口保持隐藏：它的 `state()` 读出这个模式，显示时进入该模式。 |
| `setBounds({ origin?, size?, animated? })` | `set_bounds(WindowFrame { .. })` | 移动它并调整大小，单位为点；省略的字段保持原值。`origin`（`x`、`y`）是它的左上角，从主显示器的左上角量起，`y` 向下增长；只给 `height` 而不给 `y` 时顶边保持不动。macOS 和 Windows 上的 `size` 包含窗口装饰；Linux 上设置 GTK 的默认窗口尺寸。`animated: true` 启用 macOS 的窗口调整动画。宽度和高度接受正有限数值，`x` 和 `y` 接受有限数值；其他值保留字段原值。 |
| `setPlacement(placement)` | `set_placement(placement)` | 恢复从 `state().placement` 保存的位置：先还原到它的外框，模式要求时再最大化或进入全屏（隐藏的窗口保持隐藏，显示时进入该模式）。外框会先放到当前的显示器上：窗口的标题栏仍能在某个显示器上抓到时保持不变，否则居中放到主显示器上，尺寸不超过它。 |
| `center({ display? })` | `center(display)` | 让它居中于 `display`，省略时居中于它所在的显示器。 |
| `requestAttention({ critical? })` | `request_attention(critical)` | 请求用户注意：Dock 图标跳动，任务栏按钮闪烁；`critical` 时持续到用户激活应用。 |
| `on(event, listener)` | `on_<event>(f)` | 监听一个[事件](#事件)；返回一个停止监听的函数。 |

双击带 `windowDrag` 的视图会原生地执行系统标题栏的双击动作，因此自定义标题栏不需要自己的最大化切换。

### 事件

| 事件 | 参数 | 时机 |
|---|---|---|
| `closePress` | `{ reason }` | 用户要求关闭它，不论 `closeOnPress` 是否让它关闭。`reason`：`"closeButton"`、`"shortcut"`、`"menu"`、`"taskbar"` 或 `"system"`。 |
| `close` | | 它已关闭。 |
| `focusChange` | `{ focused }` | 它获得或失去键盘焦点。 |
| `modeChange` | `{ mode, minimized }` | 它的模式改变，或被最小化、还原。 |
| `boundsChange` | `{ bounds }` | 它被移动或调整大小，在移动或调整结束后报告。 |
| `displayChange` | `{ display }` | 它移到了另一个显示器。 |

`win.on("focusChange", l)` 返回一个停止监听的函数；组件渲染时注册的监听随组件一起移除。`<Window>` 以 props 的形式接受同样的事件（`onClosePress`、`onFocusChange`……）。Rust：`WindowRef::on_focus_change`、`on_mode_change`、`on_bounds_change`、`on_display_change`，以及 `window()` 的 `.on_close_press(..)` 和 `.on_open_change(..)`。

### 关闭

关闭在原生侧立即处理：用户按下关闭按钮（或 Cmd+W、Alt+F4、任务栏的「关闭」）时，平台读取窗口的 `closeOnPress`，因此即使应用的 JS 正忙，窗口也能关闭。

- `closeOnPress: true`（默认）：窗口关闭；应用先收到 `closePress`，再收到 `close`（`<Window>`：`reason` 为 `"closePress"` 的 `onOpenChange`）。
- `closeOnPress: false`：窗口保留，应用收到 `closePress`。由应用决定，然后用 `close()`（或 `open={false}`）关闭它：编辑器先询问是否保存修改。
- `close()` 和 [`Application.quit()`](#application) 不论 `closeOnPress` 如何都会关闭。退出结束整个应用，而不是逐个关闭窗口：窗口的 `onOpenChange` 可能不会运行，因此要在 `Application.on("quit")` 中保存（或先用 `quitRequest` 询问）。

```tsx
function Editor() {
  const win = currentWindow();
  win.set({ closeOnPress: false });
  win.on("closePress", () => {
    if (!edited()) win.close();
    else askToSave.set(true); // 应用自己的对话框，确认后调用 win.close()
  });
  return <EditorView />;
}
```

`closeOnEscape` 和 `closeOnBlur` 以同样的方式关闭窗口，`reason` 为 `"escape"` 或 `"blur"`；父窗口关闭时，窗口随之关闭（`"parentClose"`）。

### 应用宿主与第一个窗口

应用宿主是不可见的：它持有事件循环、Storage、`Application`、应用菜单、窗口注册表和退出模式，并且在所有窗口关闭后继续存在。它不是 `WindowRef`，`currentWindow()` 也不会返回它。

nsh.json 的 `window` 保存应用声明的第一个窗口的启动默认值，在第一帧之前应用：

```json
{
  "window": {
    "title": "Mail",
    "defaultSize": { "width": 1100, "height": 720 },
    "minSize": { "width": 640, "height": 420 },
    "titleBar": { "style": "hidden", "height": 40 },
    "backdrop": "sidebar"
  }
}
```

它接受[选项](#选项)中的 `defaultSize`、`defaultPosition`、`display`、`defaultMode` 和 `restoreBounds`，以及所有[属性](#属性)；应用打开的第一个 `<Window>` 继承它们，它自己的选项和属性覆盖它们。同一份 nsh.json 适用于所有构建：桌面应用这些设置，网页以 `title` 作为页面标题，在 iOS 和 Android 上应用填满它在屏幕中的视图。`"defaultVisible"` 不再适用：宿主没有可显示的窗口；想以无窗口状态启动的应用只要不打开窗口（或让第一个 `<Window open={false}>` 保持关闭，直到需要它）。

[托盘](#tray)应用可以在启动时隐藏窗口，在图标被点击时打开它，窗口隐藏后应用继续运行：

```tsx
import { mount, signal, View } from "nsh";
import { Tray, Window } from "nsh/desktop";
import icon from "./tray.svg";

function App() {
  const shown = signal(false);
  Tray.set({ icon, onClick: () => shown.set(true), menu: [{ role: "quit" }] });
  return (
    <Window id="main" title="Focus" open={shown()} closeOnPress={false} onClosePress={() => shown.set(false)}>
      <Timer />
    </Window>
  );
}

mount(App);
```

[`examples/tray`](https://github.com/longbridge/nsh/tree/main/examples/tray) 启动时显示窗口，关闭时隐藏它，再从托盘图标重新显示。

### 权限

nsh.json 中没有 `"capabilities"` 的应用可以打开除浮层（overlay）外所有种类的窗口。声明了权限的应用，在 `capabilities.windows` 允许时才能打开自己的窗口（[沙箱与权限](../docs/sandbox-and-capabilities.md#windows)）。浮层和点击穿透的窗口（`pointerEvents: "none"` 或 `"box-none"`）只有声明后才会授予。对于不允许的窗口，`Window.open` 和 `<Window>` 抛出 `ERR_ACCESS_DENIED`，`permission` 为 `"windows"`，`resource` 为窗口的 id；`set()` 中不允许的属性保持不变，并给出警告。

## Application

```ts
const Application: {
  quit(): void;
  restart(): void;
  launchAtLogin(): Promise<boolean>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  on(event: "secondInstance", listener: (launch: { args: string[]; cwd: string }) => void): () => void;
  on(event: "openFiles", listener: (files: { paths: string[] }) => void): () => void;
  on(event: "quit", listener: () => void): () => void;
  on(event: "quitRequest", listener: () => void): () => void;
  on(event: "reopen", listener: () => void): () => void;
  on(event: "lastWindowClosed", listener: () => void): () => void;
  setQuitMode(quitMode: "platform" | "lastWindowClosed" | "explicit"): void;
};
```

| 成员 | Rust | 说明 |
|---|---|---|
| `quit()` | `quit()` | 退出应用，与应用菜单的「退出」项（`{ role: "quit" }`）和平台的退出快捷键相同。 |
| `restart()` | `restart()` | 像 `quit()` 一样退出应用，然后用相同的参数重新启动它。 |
| `launchAtLogin()` | `launch_at_login()` | 系统是否在用户登录时打开应用（见[登录时打开](#登录时打开)）。 |
| `setLaunchAtLogin(enabled)` | `set_launch_at_login(enabled)` | 打开或关闭登录时打开应用。 |
| `on("secondInstance", listener)` | `next_second_instance()` | 应用运行时再次被启动（[单实例](#单实例)）。 |
| `on("openFiles", listener)` | `next_open_files()` | 系统用应用声明的类型的文件打开了它（[打开文件](#打开文件)）。 |
| `on("quit", listener)` | `on_app_quit(f)` | 应用正在退出：运行它的清理（[退出](#退出)）。 |
| `on("quitRequest", listener)` | `on_quit_request(f)` | 用户要求退出；监听期间由应用决定何时退出（[退出](#退出)）。 |
| `on("reopen", listener)` | `on_reopen(f)` | 系统要求应用显示自己：macOS 的 Dock/访达重新打开，或 Windows/Linux 上的再次启动。应用自己打开或聚焦想要的窗口；不会隐式显示任何窗口。 |
| `on("lastWindowClosed", listener)` | `on_last_window_closed(f)` | 应用最后一个窗口关闭，在它自己的关闭流程之后。Rust listener 同步运行、在模式生效之前；JS listener 异步投递、在决定之后运行。要在没有窗口时继续运行的应用，在启动时设置 `quitMode: "explicit"`。 |
| `setQuitMode(quitMode)` | `set_quit_mode(QuitMode)` | 最后一个窗口关闭时何时退出：`"platform"`（macOS 留下；Windows 和 Linux 退出）、`"lastWindowClosed"`（所有平台都退出）、`"explicit"`（由应用决定）（[退出](#退出)）。 |

`Application.quit()` 用于应用自己的「退出」（自定义文字的菜单项、按钮），以及更新后重新启动。它结束应用，而不是逐个关闭窗口：窗口的 `onOpenChange` 可能不会运行。应用像最后一个窗口关闭时那样停止，然后结束运行；只关窗口会让应用继续运行时（`quitMode: "explicit"` 且没有打开的窗口）也一样。关闭的过程与「退出」菜单项相同：macOS 上的独立应用像按下 Cmd+Q 一样从 `run_app` 返回；在拥有窗口的 GPUI 应用中，请求以 `CloseRequest::Quit` 交给它的 `AppView::on_close_request` 回调，由应用在准备好后退出；其他平台上退出照常进行，与「退出」菜单项相同。嵌入在其他应用中的视图把应用的生命周期交给那个应用。在终端中应用结束，与退出角色相同。

`Application.restart()` 用于下次启动才生效的设置，比如应用的语言：应用先征得用户同意，再调用它。应用像 `quit()` 一样退出，
进程结束后，同一个程序以原来的启动参数重新启动；新旧两个进程不会同时运行。在 macOS 上，`.app` 包里的应用通过
Launch Services 重新打开，与用户打开它时相同。它在 macOS、Windows 和 Linux 的独立应用中生效，包括 `nsh package`
构建的应用；嵌入在其他应用中的视图（比如 GPUI 应用的 `AppView`）把重启交给那个应用。在 `nsh run` 下应用会退出，
`nsh run` 也随之结束：重启的效果请在 `nsh package` 构建的应用中检查。

```tsx
import { Application } from "nsh/desktop";

async function changeLanguage(language: string) {
  await saveLanguage(language);
  if (await confirmRestart()) Application.restart();
}
```

### 退出

应用的生命周期由应用自己负责。关闭窗口只关闭那个窗口；最后一个窗口关闭时按退出模式处理：
`"platform"`（声明了 `<Window>` 场景的应用的默认值）让 macOS 应用留在 Dock 中，在 Windows 和 Linux 上退出；`"lastWindowClosed"` 在所有平台上退出；
`"explicit"` 让应用继续运行，以便打开另一个窗口、显示托盘菜单或调用 `quit()`。未声明 `<Window>` 的裸 `mount(App)` 应用使用隐式主窗口，除非显式在 nsh.json 中配置 `application.quitMode` 或调用 `Application.setQuitMode`，关闭该窗口时在所有平台（包括 macOS）上都会直接退出。应用用
`Application.setQuitMode("platform")`（Rust：`set_quit_mode(QuitMode::Platform)`）设置它；nsh.json 的
`application.quitMode` 保存启动时的同一个模式。`Application.on("lastWindowClosed")` 在最后一个窗口
关闭后收到通知。Rust listener 在退出模式生效前同步运行；JS listener 在后续提交中、决定之后运行。

macOS 的 Dock/访达重新打开，或 Windows/Linux 上的再次启动，会交给 `Application.on("reopen")`（Rust：
`on_reopen`）：应用自己打开或聚焦想要的窗口。NSH 不会自己显示窗口。

没有监听 `quitRequest` 时，应用菜单的 `{ role: "quit" }`
项和平台的退出快捷键（Cmd+Q、Ctrl+Q）会立即退出。需要先询问用户的应用（有未保存的修改、正在上传）用
`Application.on("quitRequest", listener)`（Rust：`on_quit_request`）监听它，与 AppKit 的 `applicationShouldTerminate:`
相同：此后「退出」项、退出快捷键和 Dock 的「退出」都交给 listener，应用不会退出；应用询问之后调用 `quit()`，`quit()`
总会退出。最后一个 listener 停止后，「退出」项和快捷键恢复立即退出。默认情况下，系统结束应用（用户注销、关机）时会先执行清理，再退出。
它适用于 macOS、Windows 和 Linux 的独立应用；拥有窗口的 GPUI 应用以 `CloseRequest::Quit` 收到这个请求。

macOS 独立应用可以把系统退出请求纳入同一个确认流程：

```tsx
Application.setQuitRequestOptions({ system: true });
Application.on("quitRequest", async () => {
  if (await confirmSaveAndQuit()) Application.quit();
  else Application.cancelQuitRequest();
});
```

该选项默认为 `false`，每次调用 `setQuitRequestOptions` 都会替换它。Rust 使用
`nsh_core::element::desktop` 的 `set_quit_request_options(QuitRequestOptions)` 和 `cancel_quit_request()`，
`QuitRequestOptions` 位于 `nsh_core::desktop`。这些选项在注册了退出请求 listener 时生效。
Rust 调用方可以用 `QuitRequestOptions::default().system(true)` 构造选项。
替换应用时会取消其待处理的确认，并将选项恢复为默认值。

`system: true` 让注销、重新启动和关机等待应用的答复。`quit()` 会先运行应用的清理，再由 AppKit 结束进程。
Rust 宿主把这类清理放在 `on_app_quit` 中，而不是 `run_app` 返回之后。`cancelQuitRequest()` 会取消系统请求，
让应用继续运行。未答复的系统请求会在 110 秒后取消，早于 AppKit 的注销超时。移除最后一个 listener 或更改选项也会取消待处理的请求。

`mainWindowClose` 保留给嵌入宿主；窗口模型 v2 的独立应用没有可见主窗口，因此它不会触发。
确认尚未答复时，重复的退出请求共用该确认。如果此时收到系统退出请求，同一个答复也会批准或取消系统请求。

在 Web 上，用户离开页面（关闭标签页、刷新、前往其他网站）就是退出请求：它在用户离开时交给 listener，所以下面的示例在
Web 上原样可用。listener 立即调用 `quit()` 时，页面直接离开，不会询问。先询问的 listener（这里是 `askToSave()`）让浏览器
询问用户是否离开；用户留下时，应用自己的询问就在页面上，工作保存之后，下一次离开会立即进行。桌面浏览器在用户与页面交互过
之后显示它的询问。不论用户怎样离开，应用的 `quit` listener 都在页面离开时开始运行一次：它们同步做的事会完成，它们等待的
工作在页面还在时继续运行。浏览器保留在前进 / 后退缓存中的页面，它的应用继续运行，用户回来时应用接着运行。不论 `isAvailable`
怎么说都是这样；声明了能力的应用为此列出 `"application": true`。

```tsx tabs
import { Application } from "nsh/desktop";

function Editor() {
  Application.on("quitRequest", () => (dirty() ? askToSave() : Application.quit()));
  // 不论应用怎样退出都会运行；它不能让应用继续运行。
  Application.on("quit", async () => {
    await saveSession();
  });
  return <EditorView />;
}
```

```rust tabs
use nsh_core::{
    element::desktop::{on_app_quit, on_quit_request, quit},
    prelude::*,
};

#[component]
fn Editor() -> impl IntoElement {
    let dirty = signal(false);
    on_quit_request(move || {
        if dirty.get_untracked() {
            ask_to_save(); // 它的「退出」按钮调用 `quit()`
        } else {
            quit();
        }
    });
    // 不论应用怎样退出都会运行；它不能让应用继续运行。
    on_app_quit(move || async move { save_session().await });
    editor()
}
```

`Application.on("quit", listener)`（Rust：`on_app_quit`）是应用的清理，与 GPUI 的 `on_app_quit` 相同：不论应用怎样停止
（它的「退出」项、`quit()`、最后一个窗口关闭、Dock 的「退出」、用户注销时系统结束它、宿主应用移除它的视图、Web 页面离开）都会运行，
并且不能让应用继续运行。listener 返回的 promise 会被等待，所有 listener 合计最多 200 毫秒，这期间平台也在等应用；
超过这个时间应用就停止。组件渲染时添加的 listener 随组件一起移除；`on` 返回的函数也能停止它。

### 打开文件

打开文档的应用（播放器、编辑器）在 nsh.json 的 `fileTypes` 中列出文件类型。`nsh package` 把它们声明给系统，应用就会出现在
「打开方式」中，并打开用户双击或拖到图标上的文件。文件以绝对路径送到 `Application.on("openFiles")`，包括启动应用的文件。
应用 [scheme](nsh.md#urlscheme) 的链接与之分开，仍由 `UrlScheme.on("open")` 送达。`Application` 从 `nsh/desktop` 导入，
`openFiles` 在 iOS 和 Android 上同样送达。

```json
{
  "fileTypes": [
    { "name": "Video", "extensions": ["mp4", "mov"], "mimeTypes": ["video/mp4", "video/quicktime"], "contentTypes": ["public.movie"] }
  ]
}
```

```tsx
import { Application } from "nsh/desktop";

Application.on("openFiles", ({ paths }) => {
  for (const path of paths) play(path);
});
```

| 键 | 说明 |
| --- | --- |
| `name` | 系统对这种文件的称呼（`"Video"`），必填。 |
| `extensions` | 扩展名，不带点（`["mp4", "mov"]`）。 |
| `mimeTypes` | MIME 类型（`["video/mp4"]`）：Linux 按它们列出应用，Android 按它们把应用列入分享面板（可用 `image/*` 这样的通配）。 |
| `contentTypes` | 统一类型标识符（`["public.movie"]`）：iOS 按它们列出应用。 |
| `role` | `"viewer"`（默认）或 `"editor"`。 |

每种类型要给出 `extensions` 或 `contentTypes`。Rust 代码 await `nsh_core::prelude` 的 `next_open_files()`，得到
`Vec<PathBuf>`。没有监听时到达的文件会一次交给下一个监听者（最多 64 个，丢弃最早的）。只有声明了文件类型的应用，NSH
才接收打开的文件。

| 平台 | 应用如何打开文件 |
| --- | --- |
| macOS | `Info.plist` 中的 `CFBundleDocumentTypes`；Launch Services 打开应用，或把文件交给正在运行的应用 |
| iOS、Mac Catalyst | `Info.plist` 中的 `CFBundleDocumentTypes`（按 `contentTypes`）；系统把文件的副本交给应用 |
| Windows | 应用每次启动时写在 `HKEY_CURRENT_USER\\Software\\Classes` 下：每种类型一个 ProgID，列在各扩展名的 `OpenWithProgids` 中。带文件的第二次启动把文件交给正在运行的应用 |
| Linux | 桌面条目的 `MimeType`，`Exec … %U`；应用只运行一份，第二次启动把文件交给正在运行的应用 |
| Android | 分享面板：为 `mimeTypes` 声明 `SEND` 与 `SEND_MULTIPLE` intent filter；只有 `extensions` 的类型不会列出。`AppActivity` 把每个分享来的流复制到应用缓存，再把副本的路径交给应用 |
| Web | 不声明；它的包不包含 `fileTypes` |

Android 上，当某个类型给出 `mimeTypes` 时，应用会收到其他应用分享给它的文件：只接收这些类型的 `content://` 流，最多 16 个文件、
每个 256 MiB（每次分享共 512 MiB）。应用已在运行时，分享会交给现有的 Activity（`singleTask`）。路径指向临时副本，Android 可能清理这些缓存；NSH 收到新分享时也会清理超过一周的副本。

开启 [`singleInstance`](#单实例) 时，第二次启动还会以原样的参数报告 `secondInstance`。

### 单实例

桌面应用通常只运行一份：再次打开时把正在运行的应用带到前台。应用在 nsh.json 中写 `"singleInstance": true` 开启。
之后第二次启动会把它的命令行交给正在运行的应用，并在打开窗口、启动引擎之前退出；正在运行的应用以
`secondInstance` 报告这次启动，带上参数（不含程序路径）和启动时的目录，并报告 `reopen`，由应用决定显示哪个窗口：

```json
{ "singleInstance": true }
```

```tsx
import { Application } from "nsh/desktop";

Application.on("secondInstance", ({ args, cwd }) => {
  const file = args.find((arg) => !arg.startsWith("-"));
  if (file) openDocument(resolve(cwd, file));
});
```

Rust 代码 await `nsh_core::prelude` 的 `next_second_instance()`，得到带 `args` 和 `cwd` 的 `SecondInstance`。没有监听者时到达的启动会
留给下一个监听者（最多 16 个，丢弃最早的）。任何人都能用任意参数启动应用，所以要像检查其他输入一样检查它们。参数中属于
应用 [scheme](nsh.md#urlscheme) 的链接也会通过 `UrlScheme.on("open")` 送达。

| 平台 | 如何只运行一份 |
| --- | --- |
| Windows | 以应用 id 命名的互斥量；第二次启动把参数和工作目录发给正在运行的应用的窗口（`WM_COPYDATA`） |
| Linux | GApplication 在会话总线上按应用 id 保证唯一；第二次启动的命令行交给正在运行的应用 |
| macOS | Launch Services 对一个应用包只运行一份，再次打开时激活它，因此不报告 `secondInstance`；文件通过 `openFiles`、链接通过 `UrlScheme` 送达 |
| iOS、Android、Web | 系统只运行一份应用；不报告 `secondInstance` |

`nsh package` 构建的发布运行器读取这个设置；`nsh run` 仍按原样启动开发宿主。

### 登录时打开

`Application.launchAtLogin()` 返回系统此刻是否会在用户登录时打开应用，`Application.setLaunchAtLogin(enabled)` 打开或关闭它。Rust
代码在任务中等待 `launch_at_login()` 和 `set_launch_at_login(enabled)`。和 `quit`、`restart` 一样，声明了能力的应用需要 `"application": true`：没有它时 `launchAtLogin()` 返回 `false`，`setLaunchAtLogin` 以 `ERR_ACCESS_DENIED` 拒绝。

```tsx
import { signal } from "nsh";
import { Application } from "nsh/desktop";

const openAtLogin = signal(false);
// 应用显示自己的设置时读取：用户可能在系统设置中改过。
Application.launchAtLogin().then(openAtLogin.set);

async function setOpenAtLogin(enabled: boolean) {
  await Application.setLaunchAtLogin(enabled);
  openAtLogin.set(await Application.launchAtLogin());
}
```

```rust
use nsh_core::element::desktop::{launch_at_login, set_launch_at_login};
use nsh_core::prelude::*;

let open_at_login = signal(false);
spawn(async move { open_at_login.set(launch_at_login().await) });
// 用户打开或关闭应用自己的设置时：
let turn = move |enabled: bool| {
    spawn(async move {
        if let Err(error) = set_launch_at_login(enabled).await {
            log::warn!("{error}");
        }
        open_at_login.set(launch_at_login().await);
    });
};
```

在用户打开或关闭应用自己的设置时调用 `setLaunchAtLogin`，不要由应用自行调用（比如每次启动时）：以用户在系统设置中的选择为准。打开已打开的、关闭已关闭的都会成功，修改按应用发出的顺序执行。
应用无法登录时打开的地方（嵌入在其他应用中的视图、`nsh run`、iOS、Android 和 Web），以及 macOS 上系统还在“登录项”中等待用户批准时，`launchAtLogin()` 为 `false`。
应用无法登录时打开的地方，`setLaunchAtLogin` 以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` reject；系统出错时以它的错误码 reject，其中系统不允许修改时为 `EACCES`，应用加引号后的路径超出
Windows 登录项能容纳的长度（260 个字符）时为 `ENAMETOOLONG`，应用 id 或路径无法命名登录项时为 `EINVAL`，错误没有自己的错误码时为 `EIO`。

| 平台 | 设置的内容 | 显示在 |
|---|---|---|
| macOS | 应用包的登录项（`SMAppService.mainApp`），按 bundle id 保存：应用的每个副本共用一个。 | 系统设置的“登录项” |
| Windows | 当前用户 `Run` 键下以应用 id 命名、内容为本可执行文件路径的值。指向其他副本的值读作 `false`；`nsh package` 构建的安装程序卸载时，会删除指向所卸载副本的值。 | 设置中的启动应用、任务管理器的“启动应用” |
| Linux | XDG 自启动条目 `~/.config/autostart/<app id>.desktop`，启动本可执行文件。在桌面设置中关闭的条目读作 `false`，再次打开会重新写入。Flatpak 或 Snap 沙箱中不可用。 | 桌面的自启动设置 |

它在独立应用中生效，包括 `nsh package` 构建的应用；`nsh run` 下读到 `false`，请在打包后的应用中检查。[`examples/tray`](https://github.com/longbridge/nsh/tree/main/examples/tray) 在托盘菜单中提供了这个选项。

## 自定义标题栏

隐藏标题栏（`titleBar: { style: "hidden" }`）后，应用绘制自己的标题栏，并指定哪些部分可以拖动窗口：Rust 用 `.window_drag(true)`，TSX 用 `desktop={{ windowDrag: true }}`。第一个窗口的 `titleBar` 写在 nsh.json 的 [`window`](#应用宿主与第一个窗口) 中，第一帧就会带上它；每个 `<Window>` 也把它作为 prop 接受。

```tsx tabs
import { Text, View } from "nsh";
import { Input } from "nsh/base";
import { currentWindow } from "nsh/desktop";

function TitleBar() {
  const win = currentWindow();
  win.set({ titleBar: { style: "hidden", height: 40 } }); // 40 点高的标题栏
  return (
    <View
      desktop={{ windowDrag: true }}
      style={{
        height: win.titleBar().height || 40,
        paddingLeft: win.titleBar().left + 8, // macOS 的红绿灯
        paddingRight: win.titleBar().right + 8, // Windows 的标题栏按钮、GTK 的窗口按钮
        flexDirection: "row",
        alignItems: "center",
      }}
    >
      <Text>My App</Text>
      <View style={{ flex: 1 }} />
      <Input placeholder="搜索" style={{ width: 180 }} />
    </View>
  );
}
```

```rust tabs
use nsh_core::{
    desktop::{TitleBarOptions, TitleBarStyle, WindowAttributes},
    element::desktop::{current_window, title_bar},
    prelude::*,
};

#[component]
fn TitleBar() -> impl IntoElement {
    let win = current_window();
    let mut bar = TitleBarOptions::default();
    bar.style = TitleBarStyle::Hidden;
    bar.height = Some(px(40.0)); // 40 点高的标题栏
    let mut attributes = WindowAttributes::default();
    attributes.title_bar = Some(bar);
    win.set(attributes);
    view()
        .window_drag(true)
        .h(move || match title_bar().top {
            top if top > px(0.0) => top,
            _ => px(40.0),
        })
        .pl(move || title_bar().left + px(8.0)) // macOS 的红绿灯
        .pr(move || title_bar().right + px(8.0)) // Windows 的标题栏按钮、GTK 的窗口按钮
        .flex_row()
        .items_center()
        .child(text("My App"))
        .child(view().flex_1())
        .child(input().placeholder("搜索").w(px(180.0)))
}
```

按住带 `windowDrag` 的视图会像按住系统标题栏一样拖动窗口：双击最大化（或执行用户的设置：macOS 的“连按窗口标题栏以”），在 Windows 和 Linux 上右键打开窗口菜单。在 Linux 的 GPUI 应用中，若点击处的可拖动视图本身或其内部的视图监听 `onContextMenu`，右键点击交给应用；外层视图（包括根视图）上的监听不会取代窗口菜单。

- 由最近的设置了 `windowDrag` 的视图决定：`.window_drag(false)`（`desktop={{ windowDrag: false }}`）让可拖动视图中的一部分保持可点击。
- 可拖动视图中的文本框，以及带按压或触摸处理（`onPress`、`onTouch*`、responder）的视图，不用设置也保持可点击：上例中的搜索框和其中的按钮照常工作。
- `windowDrag` 在系统标题栏下也能用：侧边栏或工具栏同样可以拖动窗口。

没有边框（`frame: "none"`）或隐藏了标题栏的窗口可以自己绘制窗口按钮和调整大小的边缘：

| 属性 | Rust | 说明 |
|---|---|---|
| `desktop={{ windowControl }}` | `.window_control(WindowControl::Close)` | `"minimize"`、`"maximize"` 或 `"close"`：这个视图就是对应的系统窗口按钮。平台执行它的按下动作（关闭按下遵循 `closeOnPress`），辅助技术把它识别为该按钮，在 Windows 上鼠标停在最大化视图上会出现 Windows 11 的贴靠布局。它的外观由应用决定（`hover:`、`active:`）。 |
| `desktop={{ windowResize }}` | `.window_resize(ResizeEdge::BottomRight)` | `"top"`、`"bottom"`、`"left"`、`"right"`、`"topLeft"`、`"topRight"`、`"bottomLeft"` 或 `"bottomRight"`：按住这个视图从对应的边或角调整窗口大小。 |

```tsx
<View style={{ flexDirection: "row", gap: 8 }}>
  <View desktop={{ windowControl: "minimize" }} class="size-3 rounded-full bg-amber-400" />
  <View desktop={{ windowControl: "maximize" }} class="size-3 rounded-full bg-green-500" />
  <View desktop={{ windowControl: "close" }} class="size-3 rounded-full bg-red-500" />
</View>
```

### titleBar

```ts
function titleBar(): TitleBarArea; // currentWindow().titleBar()

interface TitleBarArea {
  height: number;
  left: number;
  right: number;
}
```

当前窗口隐藏的标题栏的区域，单位为点（响应式）：它的 `height`，以及系统窗口按钮在左端（`left`）和右端（`right`）占用的宽度。用它来布局标题栏，避免内容被窗口按钮遮住。系统显示标题栏时（以及全屏时、桌面平台之外、终端应用中或窗口已关闭时）三者都为 0。在渲染期外调用（事件回调、定时器或异步回调）时，为兼容单窗口应用会读取已打开的 `"main"` 窗口（未打开时返回全 0）；多窗口应用应在渲染时先捕获 `currentWindow()` 再调用 `win.titleBar()`。Rust：`title_bar() -> Edges<Points>`，其中 `top` 是高度，`left` 和 `right` 是窗口按钮的宽度；读取它会订阅变化。

| | `height` | `left` | `right` |
|---|---|---|---|
| macOS | `height`，否则为标题栏的高度（28 或 32，视 macOS 版本而定） | 红绿灯的宽度 | 0 |
| Windows | `height`，否则为 32 | 0 | 三个标题栏按钮（138） |
| Linux | `height`，否则为标题栏（header bar）的高度 | 开头的窗口按钮（按桌面的按钮布局） | 末尾的窗口按钮 |

在 macOS 上，红绿灯在 `height` 中垂直居中，窗口保持普通标题栏窗口的圆角。在 Windows 上，标题栏按钮由 NSH 按 Windows 11 的样式绘制，跟随应用的外观；鼠标停在最大化按钮上会出现 Windows 11 的贴靠布局。在所有平台上窗口都保留调整大小的边框、阴影和圆角。嵌入应用已有的工具栏保留自身的高度，`titleBar()` 报告这个高度。

## 窗口状态与显示器

```ts
function windowState(): WindowState | null; // currentWindow().state()
const displays: Accessor<Display[]>;

interface WindowState {
  mode: WindowMode;            // "normal"、"maximized" 或 "fullScreen"
  minimized: boolean;
  visible: boolean;            // 在屏上：没有隐藏，也没有最小化
  focused: boolean;            // 拥有键盘焦点
  bounds: Bounds;              // 当前的外框，包含窗口装饰
  contentBounds: Bounds;       // 当前的内容区域
  nativeContentBounds: { x: number; y: number; width: number; height: number } | null;
                              // macOS 点、Windows/X11 原生像素；无法全局定位时为 null
  placement: WindowPlacement;  // 模式，以及还原时的外框
  display: Display | null;     // 窗口大部分所在的显示器
  scaleFactor: number;         // 每点的设备像素数
}
interface WindowPlacement {
  mode: WindowMode;
  bounds: Bounds;
}
interface Display {
  id: string;                  // 下次启动时不变
  name: string;
  bounds: Bounds;
  visibleBounds: Bounds;       // 去掉菜单栏、Dock 或任务栏后的区域
  primary: boolean;
  scaleFactor: number;
  refreshRate: number | null;  // 单位为赫兹
  cutouts: Bounds[];           // 摄像头外壳挡住的区域：MacBook 的刘海
}
```

`win.state()` 是平台报告的一个窗口的状态，`windowState()` 是当前窗口的（在渲染期外的事件回调、定时器或异步回调中调用时，为兼容单窗口应用会读取已打开的 `"main"` 窗口，窗口未打开或已关闭时返回 `null`；多窗口应用应在渲染时先捕获 `currentWindow()` 再调用 `win.state()`），`displays()` 是各个显示器，主显示器排在最前；它们都是响应式的。除 `nativeContentBounds` 外，矩形的单位都是点，使用屏幕坐标：从主显示器的左上角量起，`y` 向下增长，与 `setBounds` 相同。模式、所在显示器、焦点、最小化或可见状态的变化立即报告；移动和调整大小在窗口停下片刻后报告，读取它们的代码每次移动只运行一次，而不是每一步都运行。Press handler 执行前会先发布最新的待报告位置，保证 handler 读取当前位置。Rust：`WindowRef::state() -> Option<WindowState>` 和 `displays() -> Vec<Display>`（类型在 `nsh_core::desktop` 中）；读取即订阅变化。

显示器的 `cutouts` 是摄像头外壳挡住的区域，使用同样的屏幕坐标：在有刘海的 MacBook 上，是屏幕顶部正中的一个矩形，高度与菜单栏相同。窗口可以据此贴在刘海旁边，或者让内容从刘海里展开；其他显示器上这个列表为空。

```tsx
const notch = () => displays().flatMap((d) => d.cutouts)[0] ?? null;
```

窗口在屏上而 [`lifecycle()`](./nsh.md#device) 报告 `"background"` 时，说明它被别的窗口挡住了。

`placement` 是按用户离开时的样子打开窗口所要保存的值：最大化或全屏的窗口带着它还原时的外框。`<Window restoreBounds>` 按窗口 id 保存并恢复它。要恢复整个窗口集合的应用自己保存每个窗口的 `placement`，并在打开窗口时调用 `setPlacement`；Rust 窗口组件和 TSX 组件可以共用同一条记录，因为 `WindowPlacement` 的 serde 形式就是 TSX 保存的那个对象。要在窗口内部读取它：在组件里用 `currentWindow()`，而不是在模块顶层用 `Window.get`（那时场景还没打开）。

```tsx tabs
import { effect, Storage } from "nsh";
import { currentWindow } from "nsh/desktop";

function Restore() {
  const main = currentWindow();
  Storage.getItem("window").then((saved) => {
    if (saved) main.setPlacement(JSON.parse(saved)); // 按当前的显示器夹好
  });
  effect(() => {
    const state = main.state();
    if (state) Storage.setItem("window", JSON.stringify(state.placement));
  });
  return <></>;
}
// <Window id="main"><Restore />…</Window>
```

```rust tabs
#[component]
fn App() -> impl IntoElement {
    let main = current_window();
    if let Some(saved) = Storage::get_item("window")
        .and_then(|json| serde_json::from_str::<WindowPlacement>(&json).ok())
    {
        main.set_placement(saved); // 按当前的显示器夹好
    }
    effect(move || {
        if let Some(state) = main.state() {
            let json = serde_json::to_string(&state.placement).unwrap();
            let _ = Storage::set_item("window", json);
        }
    });
    view() // ...
}
```

桌面平台报告窗口状态和显示器。在 iOS、Android、Web 和终端应用中，`windowState()` 为 `null`，`displays()` 为空。

## Menu

```ts
const Menu: {
  setApplicationMenu(items: MenuItem[] | null): void;
  setMenuBar(mode: "shown" | "autoHide"): void;
  popup(items: MenuItem[], at?: Point): Promise<void>;
};
```

| 成员 | 说明 |
|---|---|
| `setApplicationMenu(items)` | 设置应用菜单：每个顶层项是一个子菜单（`File`、`Edit`……）。在 macOS 上是菜单栏，第一个菜单是应用菜单（AppKit 以应用名作为标题）。窗口模型 v2 尚未在 Windows 和 Linux 上显示它（那里本应是窗口的菜单栏）：菜单发往应用宿主，因此请绘制应用自己的控件（用 `⋯` 按钮打开 `Menu.popup`），并用 `keymap` 绑定它们的快捷键。`null` 恢复平台默认菜单。 |
| `setMenuBar(mode)` | 在 GPUI 应用的 Windows 和 Linux 上，窗口把应用菜单绘制成应用上方的菜单栏：`"shown"`（默认）始终显示；`"autoHide"` 在单独按下并松开 Alt 后显示，再次单独按 Alt 时隐藏，与 Windows 和 GNOME 应用一致。两种模式下 F10 和 Alt 加菜单首字母都会打开菜单，菜单打开期间菜单栏显示。macOS 的菜单栏是系统的。Rust：`set_menu_bar(mode)`。 |
| `popup(items, at?)` | 显示右键菜单，左上角在 `at`（窗口坐标，单位为点：`onContextMenu` 的 `e.pagePosition`），省略时在指针处。菜单关闭时（无论是否选中了菜单项）返回的 Promise 会 resolve：打开它的按钮可以在此之前一直保持按下样式。 |

在 Rust 中，`set_application_menu(items)` 接受 `Vec<MenuItem>`（`None` 恢复平台默认菜单），`popup_menu(items)`（在指针处）和 `popup_menu_at(items, at)` 返回一个 `Answer<()>`，菜单关闭时得到结果（可以不 await）。菜单项的处理函数在设置菜单的 owner 下运行，只在该 owner 存活期间有效。

再次调用 `setApplicationMenu` 即可修改菜单。放在 `effect` 里时，它会跟随读取的 signal：依赖应用状态的勾选或可用状态始终保持最新。

### 菜单项

```ts
type MenuItem =
  | { type: "separator" }
  | {
      label?: string;
      role?: MenuRole;
      shortcut?: string;
      when?: "always" | "auto" | "notEditing";
      disabled?: boolean;
      checked?: boolean;
      onSelect?: () => void;
      icon?: ImageAsset | string;
      symbol?: string;
      destructive?: boolean;
      submenu?: MenuItem[];
      inline?: boolean;
    };
```

| 字段 | 说明 |
|---|---|
| `label` | 菜单项显示的文字。带 role 的菜单项省略时使用自己的默认文字。 |
| `onSelect` | 菜单项被选中时调用，无论是点击还是快捷键。 |
| `shortcut` | 快捷键：修饰键和一个按键用 `+` 连接，例如 `"mod+n"`、`"mod+shift+z"`、`"alt+f4"` 或 `"f11"`。修饰键见下表。按键可以是字母、数字和标点，写作它在美式键盘上不按 Shift 时输入的字符（`,`、`/`；`?` 写作 `"shift+/"`），也可以是名称：`plus`（`=` / `+` 键，也可写 `=`）、`minus`（也可写 `-`）、`space`、`enter`（`return`）、`escape`（`esc`）、`tab`、`backspace`、`delete`（`del`）、`insert`、方向键 `up`、`down`、`left`、`right`（`arrowup` 等）、`home`、`end`、`pageup`、`pagedown`、`f1`–`f24`。大小写不影响（`"Mod+Shift+N"` 就是 `"mod+shift+n"`；大写字母表示同一个键，并不意味着 Shift），推荐全小写的写法。无效的快捷键（`"mod-n"`、`"mod++"`、`"mod+?"`）会抛出错误并给出正确的写法。`keymap` 使用同样的按键写法。菜单按各平台自己的样式显示快捷键（macOS 上是 `⇧⌘N`，Windows 上是 `Ctrl+Shift+N`）。 |
| `when` | 在 GPUI 后端上，输入框获得键盘焦点时快捷键何时选中该菜单项：`"always"`（默认）、`"auto"`（除非输入框自己使用这个按键：输入字符、移动光标或删除的键，以及编辑快捷键，和 [`keymap`](./nsh.md#keymap) 的绑定相同）或 `"notEditing"`。菜单项让出的键交给输入框。 |
| `disabled` | `true` 时菜单项变灰（默认 `false`）。 |
| `checked` | 设置（为 `true` 或 `false`）后菜单项带勾选标记。 |
| `icon` | 标签旁的图片，写法与 `<Image>` 的 `src` 相同（导入的文件或 URL）。会适配到菜单的图标尺寸；各平台细节见 TypeScript 声明。iOS 标题栏菜单的 SF Symbol 名称请用 `symbol`。 |
| `symbol` | iOS 标题栏菜单中标签旁的 SF Symbol 名称；其他平台（包括 macOS）忽略。与 `icon` 同时设置时以它为准。 |
| `destructive` | `true` 表示破坏性操作：iOS 显示为红色（`UIMenuElementAttributesDestructive`）。桌面端忽略。 |
| `submenu` | 让菜单项成为子菜单（需要 `label`）。配合 `inline: true` 成为内联分组：在 iOS 上是带 `label` 为分组标题的 `UIMenuOptions.displayInline`；在桌面上是夹在分隔线之间的条目，不显示 `label`。 |
| `inline` | 在设置了 `submenu` 时表示内联分组（见 `submenu`）。 |
| `role` | 由平台执行的标准菜单项（见下）。 |

`null`、`undefined` 和 `false` 项会被忽略，因此可以在列表中写 `cond && { … }`。

在 Rust 中，菜单项是 `MenuItem::new(label)`、`MenuItem::role(role)`、`MenuItem::separator()` 或 `MenuItem::submenu(label, items)`，字段对应同名方法：`.shortcut("mod+n")`（快捷键无效时 panic，并给出正确写法）、`.shortcut_when(When::Auto)`、`.disabled(true)`、`.checked(on)`、`.on_select(f)`、`.icon(..)`、`.symbol(..)`、`.destructive(true)`、子菜单上的 `.inline(true)`，以及给 role 菜单项设置文字的 `.label(..)`。

修饰键：

| 修饰键 | macOS | Windows | Linux |
|---|---|---|---|
| `mod`（也可写 `cmdorctrl`） | Command（⌘） | Ctrl | Ctrl |
| `cmd`（也可写 `command`、`meta`、`super`、`win`） | Command（⌘） | Windows 键 | Super |
| `ctrl`（也可写 `control`） | Control（⌃） | Ctrl | Ctrl |
| `alt`（也可写 `option`、`opt`） | Option（⌥） | Alt | Alt |
| `shift` | Shift（⇧） | Shift | Shift |

应用自己的快捷键请用 `mod`：它就是各平台应用习惯使用的那个键（macOS 上是 ⌘N，Windows 和 Linux 上是 Ctrl+N），一种写法到处适用。Windows 键和 Super 基本归系统使用（Win+E、GNOME 的活动视图），所以在 macOS 以外很少该用 `cmd`。

Role：

| Role | 作用 | 平台 |
|---|---|---|
| `about`、`hide`、`hideOthers`、`showAll` | 应用菜单的标准项 | macOS（其他平台忽略） |
| `quit` | 退出应用 | 全部 |
| `undo`、`redo`、`cut`、`copy`、`paste`、`selectAll` | 编辑获得焦点的文本框（快捷键仍归文本框自己） | 全部 |
| `minimize`、`zoom`、`toggleFullScreen`、`close` | 窗口操作 | macOS（key window）；Windows 和 Linux 在当前版本仍作用于宿主 |

在 macOS 上，第一个含窗口 role 的顶层菜单就是应用的 Window 菜单：macOS 会在它末尾加上“Bring All to Front”和已打开的窗口（按标题），并自动保持同步。默认菜单栏的 Window 菜单同样如此。其他平台没有这个列表。

带 role 的菜单项默认使用平台的文字和快捷键，除非自己设置（macOS 会在 `about`、`hide` 和 `quit` 中加上应用名）。

菜单快捷键的优先级最高，和原生应用一样：菜单项占用的按键不会再传给获得焦点的输入框，也不会触发 NSH 自己的按键处理。只有 [`keymap`](./nsh.md#keymap) 中相同按键组合的绑定排在它们前面。所以编辑快捷键（`mod+c`、`mod+v`、`mod+x`、`mod+a`、`mod+z`）只交给编辑类 role（它们会把按键转给输入框），也不要使用不带修饰键的键（`escape`、方向键、字母），否则输入框和返回导航就收不到它们了。在 GPUI 后端上，`when: "auto"` 让菜单项和输入框共用按键：没有输入框获得焦点时，`delete` 或 `mod+z` 选中菜单项；有输入框获得焦点时，它们编辑文本。

在 GPUI 后端上，拥有键盘焦点的原生组件先看到每个按键。它自己处理的按键不会到达快捷键表或菜单。它放过的按键按输入框获得焦点时的规则进入 `keymap` 的快捷键，然后再到菜单。

```tsx tabs
import { effect, signal } from "nsh";
import { platform } from "nsh";
import { Menu } from "nsh/desktop";

const mac = platform.os === "macos";
const wrap = signal(true);

effect(() => {
  Menu.setApplicationMenu([
    mac && {
      label: "My App",
      submenu: [{ role: "about" }, { type: "separator" }, { role: "hide" }, { role: "hideOthers" }, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "File",
      submenu: [
        { label: "New", shortcut: "mod+n", onSelect: () => createDocument() },
        { label: "Open…", shortcut: "mod+o", onSelect: () => openDocument() },
        !mac && { type: "separator" },
        !mac && { role: "quit", label: "Exit" },
      ],
    },
    {
      label: "Edit",
      submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }],
    },
    {
      label: "View",
      submenu: [
        { label: "Word Wrap", checked: wrap(), onSelect: () => wrap.update((w) => !w) },
        { role: "toggleFullScreen" },
      ],
    },
  ]);
});
```

```rust tabs
use nsh_core::{
    desktop::MenuRole,
    element::desktop::{MenuItem, set_application_menu},
    platform::Os,
    prelude::*,
};

#[component]
fn AppMenu() -> impl IntoElement {
    let mac = os() == Os::MacOs;
    let wrap = signal(true);
    effect(move || {
        let mut menus = Vec::new();
        if mac {
            menus.push(MenuItem::submenu("My App", [
                MenuItem::role(MenuRole::About),
                MenuItem::separator(),
                MenuItem::role(MenuRole::Hide),
                MenuItem::role(MenuRole::HideOthers),
                MenuItem::separator(),
                MenuItem::role(MenuRole::Quit),
            ]));
        }
        let mut file = vec![
            MenuItem::new("New").shortcut("mod+n").on_select(create_document),
            MenuItem::new("Open…").shortcut("mod+o").on_select(open_document),
        ];
        if !mac {
            file.push(MenuItem::separator());
            file.push(MenuItem::role(MenuRole::Quit).label("Exit"));
        }
        menus.push(MenuItem::submenu("File", file));
        menus.push(MenuItem::submenu("Edit", [
            MenuItem::role(MenuRole::Undo),
            MenuItem::role(MenuRole::Redo),
            MenuItem::separator(),
            MenuItem::role(MenuRole::Cut),
            MenuItem::role(MenuRole::Copy),
            MenuItem::role(MenuRole::Paste),
        ]));
        menus.push(MenuItem::submenu("View", [
            MenuItem::new("Word Wrap")
                .checked(wrap.get())
                .on_select(move || wrap.update(|w| *w = !*w)),
            MenuItem::role(MenuRole::ToggleFullScreen),
        ]));
        set_application_menu(menus);
    });
    view()
}
```

在按钮按下时弹出右键菜单：

```tsx tabs
<View
  onPress={() =>
    Menu.popup([
      { label: "重命名", onSelect: rename },
      { label: "复制一份", onSelect: duplicate },
      { type: "separator" },
      { label: "删除", onSelect: remove },
    ])
  }
>
  <Text>更多</Text>
</View>
```

```rust tabs
text("更多").on_press(|| {
    let _ = popup_menu(vec![
        MenuItem::new("重命名").on_select(rename),
        MenuItem::new("复制一份").on_select(duplicate),
        MenuItem::separator(),
        MenuItem::new("删除").on_select(remove),
    ]);
})
```

> [!NOTE]
> 菜单是系统原生的（NSMenu、Win32 菜单、GTK popover 菜单）：外观和行为与其他应用一致，跟随系统（或应用）的外观，并支持键盘操作。`examples/desktop` 是一个带自定义标题栏、应用菜单和右键菜单的示例应用。

## Tray

```ts
interface TrayModule {
  set(options: TrayOptions | null): void;
}
```

`Tray.set` 在系统托盘显示应用图标，或修改它；传 `null` 移除。每个应用只有一个。托盘在 Windows 上是通知区域，在 macOS 上是菜单栏右侧，在 Linux 上是 StatusNotifierItem，Plasma、Waybar 和大多数面板都能显示（GNOME 需要 AppIndicator 扩展）。

| 选项 | 说明 |
| --- | --- |
| `icon` | 图标，写法与 `<Image>` 的 `src` 相同。面板按 16 到 24 像素绘制，图标应简单、方形。在 macOS 和 Windows 上 SVG 是模板图标，用菜单栏或任务栏的文字颜色绘制。不设时 Windows 显示应用图标。 |
| `tooltip` | 指针停在图标上时显示；不设时显示应用名。 |
| `title` | 图标旁边的文字，由若干段文字 `{ text, color? }` 组成，每段可以有自己的颜色（CSS 颜色；不设时用菜单栏的文字颜色）：应用想让用户一直看得到的东西，比如价格。macOS 的菜单栏用菜单栏字体显示。Linux 上支持 AppIndicator 标签的面板（GNOME 的 AppIndicator 扩展、Unity、MATE、Budgie）在图标右边显示它的文字，颜色跟随面板；Plasma、Waybar 和 Windows 的通知区只显示图标。 |
| `titlePlacement` | 文字显示在图标的哪一边：`"right"`（默认）或 `"left"`。仅 macOS 支持；Linux 的面板总是把文字放在图标右边。 |
| `menu` | 图标的菜单，菜单项与 `Menu` 的相同。右键打开；没有 `onClick` 时左键也打开。 |
| `onClick` | 左键点击图标时调用（在 Windows 上，图标获得焦点时按 Enter 或空格也会调用），参数是 `{ bounds }`：图标在哪里（见[下文](#在图标旁打开窗口)）。 |

再次调用 `set` 即可修改；放在 `effect` 里时会跟随它读取的 signal 更新。

```tsx
import { Tray, Window } from "nsh/desktop";
import icon from "./tray.svg";

Tray.set({
  icon,
  tooltip: "Mail",
  onClick: () => Window.get("main")?.focus(),
  menu: [
    { label: "New Message", onSelect: compose },
    { type: "separator" },
    { role: "quit" },
  ],
});
```

应用在 `onClick` 或菜单项的 `onSelect` 中显示或聚焦的窗口会来到最前面；在 Linux 的 Wayland 桌面上，面板会把这次点击的激活令牌交给应用。

标题让 macOS 菜单栏里图标旁边一直显示一段文字，比如价格，涨跌幅用应用主题里的颜色。文字段的颜色在调用 `set` 时就固定下来；要让主题颜色跟随浅色和深色外观，就在读取配色方案的 `effect` 中设置托盘：

```tsx tabs
import { token } from "nsh";

Tray.set({
  icon,
  title: [{ text: "AAPL 228.00 " }, { text: "+1.33%", color: token("up") }],
});
```

```rust tabs
use nsh_core::desktop::TrayTitleRun;

set_tray(tray().icon(icon).title([
    TrayTitleRun::new("AAPL 228.00 "),
    TrayTitleRun::new("+1.33%").color(color(tokens().color("up").unwrap())),
]));
```

### 在图标旁打开窗口

`onClick` 的 `bounds` 是点击时图标在屏幕上的框，单位是点，坐标系与 `displays()`、`setBounds` 相同：从主显示器左上角算起，`y` 向下。在 macOS 上它是状态项在菜单栏里的位置，在 Windows 上是图标在通知区域或其溢出区里的位置。在 Linux 上它是 `null`，因为那里由窗口管理器摆放应用的窗口；系统报告的点击不带框时，它也是 `null`。据此打开的弹出窗口出现在图标旁边：屏幕顶部是菜单栏时在图标下方，底部是任务栏时在图标上方。

```tsx
import type { Bounds, Point, Size } from "nsh";
import { Tray, Window, displays } from "nsh/desktop";
import { TrayPanel } from "./TrayPanel";

const size = { width: 320, height: 240 };

Tray.set({
  icon,
  onClick: ({ bounds }) => {
    if (!bounds) return Window.get("main")?.focus();
    Window.open(TrayPanel, {
      id: "tray-panel",
      kind: "popup",
      defaultSize: size,
      defaultPosition: atIcon(bounds, size),
    }).focus();
  },
});

/** 以图标为中心，放在它所在显示器上空间更大的一侧，并限制在显示器的可见区域内。 */
function atIcon(icon: Bounds, size: Size): Point {
  const inside = (b: Bounds, p: Point) =>
    p.x >= b.origin.x && p.x < b.origin.x + b.size.width && p.y >= b.origin.y && p.y < b.origin.y + b.size.height;
  const display = displays().find(d => inside(d.bounds, icon.origin)) ?? displays()[0];
  if (!display) return { x: icon.origin.x, y: icon.origin.y + icon.size.height };
  const area = display.visibleBounds;
  const below = icon.origin.y < area.origin.y + area.size.height / 2;
  const x = icon.origin.x + (icon.size.width - size.width) / 2;
  const y = below ? icon.origin.y + icon.size.height + 4 : icon.origin.y - size.height - 4;
  const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), max);
  return {
    x: clamp(x, area.origin.x, area.origin.x + area.size.width - size.width),
    y: clamp(y, area.origin.y, area.origin.y + area.size.height - size.height),
  };
}
```

在 Rust 中，`set_tray(tray()...)` 与之相同（传 `None` 移除）：`tray()` 是一个 builder，有 `.icon(..)`、`.tooltip(..)`、`.title(runs)`（`TrayTitleRun::new(text)`，可加 `.color(..)`）、`.title_placement(..)`（`TrayTitlePlacement`）、`.menu(items)`（与 `set_application_menu` 相同的 `MenuItem`）和 `.on_click(|e| ..)`，它的 `TrayClickEvent` 带有 `bounds: Option<Bounds<Points>>`。处理函数在设置它的 owner 下运行，只在该 owner 存活期间有效；放在 `effect` 中会跟随读取的 signal 更新。每个应用只有一个托盘，与 TSX 共用：后设置的生效。

```rust
use nsh_core::element::desktop::{MenuItem, open_window, quit, set_tray, tray, window};

// 图标要带到前面的窗口；`open_window` 返回它的 ref。
let mail = open_window(window().id("main").title("Mail").content(Timer));
set_tray(
    tray()
        .icon("tray.svg")
        .tooltip("Mail")
        .on_click(move |_| {
            if let Some(mail) = &mail {
                mail.focus();
            }
        })
        .menu([
            MenuItem::new("New Message").on_select(compose),
            MenuItem::separator(),
            MenuItem::new("Quit").on_select(quit),
        ]),
);
```

## GlobalShortcut

```ts
interface GlobalShortcutModule {
  register(shortcut: string, onPress: () => void): Promise<boolean>;
  unregister(shortcut: string): void;
  unregisterAll(): void;
}
```

全局快捷键不论哪个应用持有键盘都会送到本应用。`register` 的按键写法与菜单项的 `shortcut` 相同（`"mod+shift+k"`），返回系统是否接受：被其他应用占用、或不在桌面平台时为 `false`。同一按键再次注册会替换回调。

在 macOS 上不需要用户授予权限。字母对应注册时键盘布局上输入该字母的键，所以 Dvorak 布局下 `k` 仍是 `k`。

在 Windows 上一个按键只属于一个应用：已被其他应用占用或由系统保留（Win+L）时返回 `false`。按住不放只触发一次。

在 Linux 上通过桌面 portal（`org.freedesktop.portal.GlobalShortcuts`）注册，这是 Wayland 下唯一的方式。按键只是建议值：桌面可能请用户确认或改选其他按键。Hyprland 在自己的配置里绑定，按应用 id 和小写的按键名：`bind = CTRL ALT, K, global, com.example.mail:ctrl+alt+k`，Lua 配置写作 `hl.bind("CTRL + ALT + K", hl.dsp.global("com.example.mail:ctrl+alt+k"))`。portal 按应用 id 识别应用，这需要应用的 `.desktop` 文件：`nsh package` 会安装它，`nsh run` 会为带 URL scheme 的应用写入它。

```tsx
import { GlobalShortcut, Window } from "nsh/desktop";

const ok = await GlobalShortcut.register("mod+shift+space", () => Window.get("main")?.focus());
```

在 Rust 中，`register_global_shortcut(keystroke, on_press)` 返回 `Answer<bool>`，可以在 task 中 await，也可以不管它；按键写法无效时会 panic，与 `MenuItem::shortcut` 相同。`unregister_global_shortcut(keystroke)` 和 `unregister_all_global_shortcuts()` 用来注销；注册它的 owner 销毁时，快捷键也会被注销。

```rust
use nsh_core::element::desktop::{open_window, register_global_shortcut, window};

// 快捷键要显示的窗口，应用这样声明它。
let mail = open_window(window().id("main").title("Mail").content(Inbox));
let taken = register_global_shortcut("mod+shift+space", move || {
    if let Some(mail) = &mail {
        mail.focus();
    }
});
spawn(async move {
    if !taken.await {
        log::warn!("mod+shift+space is taken");
    }
});
```
