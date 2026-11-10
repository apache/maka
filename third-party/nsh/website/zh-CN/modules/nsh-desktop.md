---
title: nsh/desktop
description: 桌面专有 API：应用的窗口（主窗口和应用自己的窗口，它们的种类、属性、状态和事件）、显示器、自定义标题栏、应用菜单、右键菜单、托盘和全局快捷键。
order: 12.5
---

# nsh/desktop

`nsh/desktop` 包含只有桌面才有的东西：应用的窗口和它们的标题栏、显示器、应用菜单和右键菜单、托盘和全局快捷键。它在 macOS、Windows 和 Linux 上可用。Rust 代码在 `nsh_core::element::desktop` 中有同样的功能：应用自己的窗口（`window()`）、组件所在的窗口（`current_window()`，一个 `WindowRef`）、显示器（`displays`）、`quit`、`restart`、应用菜单和右键菜单（`set_application_menu`、`popup_menu`，由 `MenuItem` 组成），并用 `.window_drag(true)` 标记可拖动的视图；TSX 导入 `nsh/desktop`。这个模块在所有平台上都可以导入，因此同一个 bundle 可以在所有平台运行：在 iOS 和 Android 上它的函数什么也不做，`isAvailable` 告诉你当前是否有它的窗口和菜单。

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

## isAvailable

```ts
const isAvailable: boolean;
```

在这个模块的窗口和菜单 API 可用的地方为 `true`：macOS、Windows 和 Linux；其他平台为 `false`。Rust：`os().is_desktop()`。

[`platform.desktop`](./nsh.md#platform) 是更宽的桌面行为判断（`desktop={{…}}` 属性、`platform.select({ desktop })`）：桌面形态的浏览器也算在内，它们运行在浏览器自己的窗口中。桌面布局、密度和输入方式用 `platform.desktop` 判断，窗口和菜单用 `isAvailable` 判断。

## 窗口

应用的每个窗口都由应用唯一的引擎渲染：主窗口和应用打开的窗口共享它的 signal、context、主题和模块，窗口之间不需要传递消息。每个窗口都是一个 `WindowRef`：主窗口和应用自己的每个窗口都是同一个类型。

- 应用自己的窗口用 [`<Window>`](#window) 在组件树中声明，或用 [`Window.open`](#windowopen) 命令式地打开。
- [`currentWindow()`](#currentwindow) 是调用它的组件所在的窗口；`windows()`、`focusedWindow()` 和 `Window.get(id)` 找到其他窗口。
- 只有应用会改的东西（标题、标题栏、层级、外观、关闭策略）是窗口的[属性](#属性)：`<Window>` 的 props 和 `set()`。用户也会改的东西（外框、模式、是否打开）从 `default…` 选项开始，通过请求（`setMode`、`setBounds`、`close`……）改变，结果通过 [`state()`](#窗口状态与显示器) 和[事件](#事件)报告回来。
- 请求没有返回值：平台可能调整或拒绝一个请求（窗口管理器自己放置窗口、显示器被拔掉了），`state()` 报告实际发生了什么。

主窗口的启动设置在 nsh.json 的 [`window`](#主窗口) 中，应用在第一帧之前就应用它们。

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

`<Window>` 是应用自己的一个窗口，和 [`Dialog`](./nsh-base.md) 一样受控：`open` 不为 `false` 时打开（没有 `open` 时看 `defaultOpen`，默认为 `true`），卸载时关闭。它的内容是周围组件树的一部分：读取相同的 signal 和 context，其中的 `currentWindow()` 就是这个窗口。窗口不是因 `open` prop 而关闭时，`onOpenChange({ open: false, reason })` 通知应用，应用据此设置 `open`。原因有 `"closePress"`（用户关闭了它）、`"escape"`（`closeOnEscape`）、`"blur"`（`closeOnBlur`）、`"parentClose"`（父窗口关闭了）和 `"close"`（应用调用了它的 `WindowRef.close()`）。

它的 props 就是它的[选项](#选项)和[属性](#属性)；属性是响应式的，`title={`${doc().name} – Editor`}` 会跟随 signal。

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

`Window.get(id)` 是 id 为 `id` 的已打开窗口，没有时为 `null`（响应式）；`"main"` 是主窗口。在非桌面平台上 `Window.open` 抛出 `code` 为 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 的错误；应用的[权限](#权限)不允许的窗口抛出 `ERR_ACCESS_DENIED`。

### 种类

窗口的 `kind` 说明它的用途。每个种类是一组属性的默认值，应用设置的任何属性都会覆盖它：`<Window kind="popup" closeOnBlur={false}>` 是一个失去焦点时不关闭的弹出窗口。

| 种类 | 用途 | 默认值 |
|---|---|---|
| `"normal"`（默认） | 文档窗口和主窗口 | 在任务栏中，会激活，可调整大小。 |
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
| 窗口外框 | `title` | 显示在标题栏、任务栏、窗口切换器中，也提供给辅助技术。 |
| | `titleBar` | `{ style: "default" \| "hidden"; height?; controlsOffset? }`：系统标题栏，或应用自己的标题栏（[见下](#自定义标题栏)）。`controlsOffset`（`{ x, y }`）设置隐藏标题栏中 macOS 红绿灯的位置。 |
| | `frame` | `"default"`，或 `"none"`：没有标题栏和边框，由应用绘制全部内容。 |
| 尺寸 | `minSize`、`maxSize` | 用户能调整到的最小和最大内容尺寸，`{ width, height }`，单位为点；`null` 清除。 |
| | `sizeToContent` | `true`、`"width"` 或 `"height"`：窗口跟随内容布局后的尺寸，原生完成，不经过 JS。 |
| 行为 | `resizable`、`movable`、`minimizable`、`maximizable`、`closable` | 用户能对它做什么。应用的请求不受它们限制。 |
| | `focusable` | 它接受键盘焦点。 |
| | `activate` | 它打开或显示时激活应用并获得焦点。 |
| 关闭 | `closeOnPress` | 按下关闭按钮或关闭快捷键时立即关闭（`true`，默认）；`false`：应用收到 `closePress`，由应用决定何时关闭（[关闭](#关闭)）。 |
| | `closeOnEscape`、`closeOnBlur` | 按 Escape 或失去焦点时关闭。 |
| 层级 | `level` | `"normal"`、`"floating"`（在普通窗口之上）、`"aboveDock"`（在 Dock 和任务栏之上）或 `"desktopIcon"`（macOS 的桌面图标层级，出现在所有空间；Windows 上移到 z 序底部）。 |
| | `taskbar` | 它在任务栏上有按钮（Windows）。 |
| | `workspaces` | `"current"` 或 `"all"`：它出现在哪些工作区（macOS 的空间）。 |
| | `pointerEvents` | `"auto"`，或 `"none"`：点击穿透它到达下面的内容。需要 `windows` 权限的 `overlay`。 |
| 外观 | `transparent` | 背景透明：只显示应用的视图。 |
| | `backdrop` | 内容背后的系统材质：`"none"`、`"window"`、`"sidebar"`、`"popover"` 或 `"hud"`。各平台映射到自己的材质（macOS 的视觉效果材质，Windows 11 的 Mica 和 Acrylic）。 |
| | `shadow` | 窗口周围的系统阴影。 |
| 任务栏 | `progress` | `{ value?, state? }` 或 `null`：任务栏按钮或 Dock 图标上的进度；`value` 从 0 到 1，`state` 为 `"normal"`、`"indeterminate"`、`"paused"` 或 `"error"`。 |

平台的窗口没有的属性会被保留，在那里不起作用：Linux 上由窗口管理器放置窗口和安排层叠，因此位置、层级和 `taskbar` 由它决定。

### currentWindow

```ts
function currentWindow(): WindowRef;
function windows(): WindowRef[];
function focusedWindow(): WindowRef | null;
```

`currentWindow()` 是调用它的组件所在的窗口：外层最近的 `<Window>`（或 `Window.open` 的窗口），没有时是主窗口。它跟随组件树，而不是焦点，因此组件无论用在哪里，都显示正确窗口的状态，并作用于自己的窗口。在渲染时调用并保留 `WindowRef`：在组件之外（事件处理函数、定时器、`await` 之后）调用会抛出 `TypeError`。

```tsx
function SaveButton() {
  const win = currentWindow(); // 渲染时
  return <Button onPress={() => save().then(() => win.close())}>Save</Button>;
}
```

`windows()` 是已打开的窗口，主窗口在前，然后是应用自己的窗口，按打开顺序排列；`focusedWindow()` 是拥有键盘焦点的窗口，焦点在其他应用时为 `null`。两者都是响应式的。

Rust：`current_window() -> WindowRef`，同样通过组件的 context 查找；以及 `main_window()`。

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
| `id` | `id()` | 应用给它的 id；主窗口为 `"main"`。 |
| `main` | `is_main()` | 它是主窗口。 |
| `parent` | | 拥有它的窗口，或 `null`。 |
| `state()` | `state()` | 平台报告的它的状态（响应式；[见下](#窗口状态与显示器)）。在非桌面平台上、显示之前和关闭之后为 `null`。 |
| `titleBar()` | `title_bar()` | 它隐藏的标题栏的区域（[见下](#titlebar)）。 |
| `set(attributes)` | `set(WindowAttributes)` | 修改给出的[属性](#属性)；其他保持原值。应用的权限不允许的属性保持不变，并给出警告。 |
| `show()`、`hide()` | `show()`、`hide()` | 显示它（最小化时还原），或隐藏它。 |
| `focus()` | `focus()` | 显示它，提到所在层级的最前并给它键盘焦点；应用随之激活。窗口保持原有层级。 |
| `close()` | `close()` | 关闭它，不论 `closeOnPress` 如何。应用自己的窗口卸载其内容（`<Window>`：`reason` 为 `"close"` 的 `onOpenChange`）；主窗口像用户关闭它那样关闭，最后一个窗口关闭时应用结束。 |
| `minimize()`、`restore()` | `minimize()`、`restore()` | 最小化它，或按原来的模式还原：最大化的窗口最小化后还原时仍是最大化。 |
| `setMode(mode)` | `set_mode(mode)` | 让它进入 `"normal"`、`"maximized"` 或 `"fullScreen"`；请求它当前的模式不会有变化。 |
| `setBounds({ origin?, size?, animated? })` | `set_bounds(WindowFrame { .. })` | 移动它并调整大小，单位为点；省略的字段保持原值。`origin`（`x`、`y`）是它的左上角，从主显示器的左上角量起，`y` 向下增长；只给 `height` 而不给 `y` 时顶边保持不动。macOS 和 Windows 上的 `size` 包含窗口装饰；Linux 上设置 GTK 的默认窗口尺寸。`animated: true` 启用 macOS 的窗口调整动画。宽度和高度接受正有限数值，`x` 和 `y` 接受有限数值；其他值保留字段原值。 |
| `setPlacement(placement)` | `set_placement(placement)` | 恢复从 `state().placement` 保存的位置：先还原到它的外框，模式要求时再最大化或进入全屏。外框会先放到当前的显示器上：窗口的标题栏仍能在某个显示器上抓到时保持不变，否则居中放到主显示器上，尺寸不超过它。 |
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
- `close()` 和 [`Application.quit()`](#application) 不论 `closeOnPress` 如何都会关闭。

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

### 主窗口

应用启动时主窗口就已存在。nsh.json 的 `window` 保存它的启动设置，应用的窗口从第一帧起就带着它们，早于任何 JS 运行：

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

它接受[选项](#选项)中的 `defaultSize`、`defaultPosition`、`display` 和 `defaultMode`，以及所有[属性](#属性)。应用运行时，任何 `<Window>` 之外的 `currentWindow()`（或 `Window.get("main")`）就是主窗口，它的 `set()` 修改同样的属性。

### 权限

nsh.json 中没有 `"capabilities"` 的应用可以打开除浮层（overlay）外所有种类的窗口。声明了权限的应用，在 `capabilities.windows` 允许时才能打开自己的窗口（[沙箱与权限](../docs/sandbox-and-capabilities.md#windows)）。浮层和点击穿透的窗口（`pointerEvents: "none"`）只有声明后才会授予。对于不允许的窗口，`Window.open` 和 `<Window>` 抛出 `ERR_ACCESS_DENIED`，`permission` 为 `"windows"`，`resource` 为窗口的 id；`set()` 中不允许的属性保持不变，并给出警告。

## Application

```ts
const Application: {
  quit(): void;
  restart(): void;
};
```

| 成员 | Rust | 说明 |
|---|---|---|
| `quit()` | `quit()` | 退出应用，与应用菜单的「退出」项（`{ role: "quit" }`）和平台的退出快捷键相同。 |
| `restart()` | `restart()` | 像 `quit()` 一样退出应用，然后用相同的参数重新启动它。 |

`Application.quit()` 用于应用自己的「退出」（自定义文字的菜单项、按钮），以及更新后重新启动。应用像最后一个窗口关闭时那样停止，然后结束运行；只关窗口会让应用继续运行时（为 Dock 保留的隐藏窗口、托盘图标）也一样。关闭的过程与「退出」菜单项相同：macOS 上的独立应用像按下 Cmd+Q 一样从 `run_app` 返回；在拥有窗口的 GPUI 应用中，请求以 `CloseRequest::Quit` 交给它的 `AppView::on_close_request` 回调，由应用在准备好后退出；其他平台上退出照常进行，与「退出」菜单项相同。嵌入在其他应用中的视图把应用的生命周期交给那个应用。在终端中应用结束，与退出角色相同。

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

## 自定义标题栏

隐藏标题栏（`titleBar: { style: "hidden" }`）后，应用绘制自己的标题栏，并指定哪些部分可以拖动窗口：Rust 用 `.window_drag(true)`，TSX 用 `desktop={{ windowDrag: true }}`。主窗口的 `titleBar` 写在 nsh.json 的 [`window`](#主窗口) 中，第一帧就会带上它；`<Window>` 把它作为 prop 接受。

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

当前窗口隐藏的标题栏的区域，单位为点（响应式）：它的 `height`，以及系统窗口按钮在左端（`left`）和右端（`right`）占用的宽度。用它来布局标题栏，避免内容被窗口按钮遮住。系统显示标题栏时（以及全屏时、非桌面平台上）三者都为 0。Rust：`title_bar() -> Edges<Points>`，其中 `top` 是高度，`left` 和 `right` 是窗口按钮的宽度；读取它会订阅变化。

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
}
```

`win.state()` 是平台报告的一个窗口的状态，`windowState()` 是当前窗口的，`displays()` 是各个显示器，主显示器排在最前；它们都是响应式的。所有矩形的单位都是点，使用屏幕坐标：从主显示器的左上角量起，`y` 向下增长，与 `setBounds` 相同。模式、所在显示器、焦点、最小化或可见状态的变化立即报告；移动和调整大小在窗口停下片刻后报告，读取它们的代码每次移动只运行一次，而不是每一步都运行。Rust：`WindowRef::state() -> Option<WindowState>` 和 `displays() -> Vec<Display>`（类型在 `nsh_core::desktop` 中）；读取即订阅变化。

窗口在屏上而 [`lifecycle()`](./nsh.md#device) 报告 `"background"` 时，说明它被别的窗口挡住了。

`placement` 是按用户离开时的样子打开窗口所要保存的值：最大化或全屏的窗口带着它还原时的外框。应用自己的窗口用 `restoreBounds: true` 即可。主窗口则保存 `placement`，再交给 `setPlacement`；应用启动时窗口和显示器已经有值，根组件第一次渲染时就可以恢复。Rust 根组件和 TSX 根组件可以共用同一条记录，因为 `WindowPlacement` 的 serde 形式就是 TSX 保存的那个对象。

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

```tsx tabs
import { effect, Storage } from "nsh";
import { Window } from "nsh/desktop";

const main = Window.get("main");
const saved = await Storage.getItem("window");
if (main && saved) main.setPlacement(JSON.parse(saved)); // 按当前的显示器夹好

effect(() => {
  const state = main?.state();
  if (state) Storage.setItem("window", JSON.stringify(state.placement));
});
```

桌面平台报告窗口状态和显示器。在 iOS、Android 和 Web 上，`windowState()` 为 `null`，`displays()` 为空。

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
| `setApplicationMenu(items)` | 设置应用菜单：每个顶层项是一个子菜单（`File`、`Edit`……）。在 macOS 上是菜单栏，第一个菜单是应用菜单（AppKit 以应用名作为标题）。在 Windows 和 Linux 上是窗口的菜单栏，隐藏标题栏时不显示；它的快捷键仍然有效，自定义标题栏可以用 `Menu.popup` 打开这些菜单。`null` 恢复平台默认菜单。 |
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
      submenu?: MenuItem[];
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
| `submenu` | 让菜单项成为子菜单（需要 `label`）。 |
| `role` | 由平台执行的标准菜单项（见下）。 |

`null`、`undefined` 和 `false` 项会被忽略，因此可以在列表中写 `cond && { … }`。

在 Rust 中，菜单项是 `MenuItem::new(label)`、`MenuItem::role(role)`、`MenuItem::separator()` 或 `MenuItem::submenu(label, items)`，字段对应同名方法：`.shortcut("mod+n")`（快捷键无效时 panic，并给出正确写法）、`.shortcut_when(When::Auto)`、`.disabled(true)`、`.checked(on)`、`.on_select(f)`，以及给 role 菜单项设置文字的 `.label(..)`。

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
| `minimize`、`zoom`、`toggleFullScreen`、`close` | 窗口操作 | 全部 |

带 role 的菜单项默认使用平台的文字和快捷键，除非自己设置（macOS 会在 `about`、`hide` 和 `quit` 中加上应用名）。

菜单快捷键的优先级最高，和原生应用一样：菜单项占用的按键不会再传给获得焦点的输入框，也不会触发 NSH 自己的按键处理。只有 [`keymap`](./nsh.md#keymap) 中相同按键组合的绑定排在它们前面。所以编辑快捷键（`mod+c`、`mod+v`、`mod+x`、`mod+a`、`mod+z`）只交给编辑类 role（它们会把按键转给输入框），也不要使用不带修饰键的键（`escape`、方向键、字母），否则输入框和返回导航就收不到它们了。在 GPUI 后端上，`when: "auto"` 让菜单项和输入框共用按键：没有输入框获得焦点时，`delete` 或 `mod+z` 选中菜单项；有输入框获得焦点时，它们编辑文本。

在 GPUI 后端上，拥有键盘焦点的原生组件先看到每个按键。它自己处理的按键不会到达快捷键表或菜单。它放过的按键按输入框获得焦点时的规则进入 `keymap` 的快捷键，然后再到菜单。

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

在按钮按下时弹出右键菜单：

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
| `menu` | 图标的菜单，菜单项与 `Menu` 的相同。右键打开；没有 `onClick` 时左键也打开。 |
| `onClick` | 左键点击图标时调用（在 Windows 上，图标获得焦点时按 Enter 或空格也会调用）。 |

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

目前只有 TSX 可用，Rust 组件还没有托盘 API。

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
