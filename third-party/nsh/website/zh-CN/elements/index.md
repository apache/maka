---
title: 元素
description: 构成每个 NSH 应用的原语和基础组件，附 Rust 与 TSX 示例，以及它们共有的属性、事件和 ref 方法。
order: 1
---

# 元素

Native Shell 用一小组元素构建每个界面：`View`、`Text`、`Image` 等原语，以及 `Button`、`Dialog`、`NavStack` 等基础组件。每个原语都对应一个原生视图（iOS 和 Mac Catalyst 上是 UIView 子类，Android 上是 `View`，桌面上是 AppKit、GTK 或 Win32 视图），由 NSH 运行时创建并布局。应用显示的一切都由它们组成：应用的按钮、卡片、列表行和页面都是它自己的组件，用这些元素绘制、由应用设置样式，因此应用的外观完全由应用决定。

这些页面上的每个示例都同时给出 Rust 和 TSX：选择一个标签页，页面上的所有示例都会随之切换。

```rust tabs
use nsh_core::ui::prelude::*;

fn app() -> impl IntoElement {
    let count = signal(0_u32);
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_3()
        .child(text(move || format!("已点击 {} 次", count.get())).text_2xl())
        .child(
            view()
                .rounded_lg()
                .bg(rgb(0x2563eb))
                .px_4()
                .py_2()
                .active(|s| s.opacity(0.6))
                .on_press(move || count.update(|n| *n += 1))
                .child(text("点我").text_color(white())),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";

function App() {
  const count = signal(0);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }}>
      <Text style={{ fontSize: 24 }}>已点击 {count()} 次</Text>
      <View onPress={() => count.update((n) => n + 1)} class="rounded-lg bg-blue-600 px-4 py-2 active:opacity-60">
        <Text class="text-white">点我</Text>
      </View>
    </View>
  );
}

mount(App);
```

在 Rust 中，原语是 `nsh_core::ui::prelude` 中的函数（`view()`、`text(..)`、`image(..)`），基础组件来自 `nsh_base` crate。样式是有类型的方法（`.flex_1()`、`.gap_3()`、`.px(px(20.0))`、`.bg(..)`），状态样式接收一个闭包（`.active(|s| s.opacity(0.6))`），监听器是接收事件的闭包（`.on_press(move || ..)`、`.on_change(move |text: &str| ..)`），`.child(..)` 添加子元素。一段 UI 就是一个返回 `impl IntoElement` 的普通函数，只运行一次；它在闭包里读取的 signal（`text(move || ..)`、`.bg(move || ..)`）会更新所绑定的内容。参见[用 Rust 构建](../docs/rust.md)。

在 TSX 中，每个标签都使用 PascalCase，并指向作用域中的绑定：原语从 `nsh` 导入，基础组件从 `nsh/base` 导入。只有 `<If>` 和 `<Each>` 是无需导入的全局组件。`<view>` 这样的小写标签会导致构建错误，因为 TypeScript 只能对照每个名称一个的全局类型来检查它，`List`、`Each` 这类泛型组件就无法推断条目类型。编译器通过导入识别这些元素并就地创建原生视图，所以导入它们在运行时没有任何开销。参见 [JSX 与组件](../docs/jsx-and-components.md)。

```tsx
import { Canvas, Image, Input, List, Overlay, Scroll, Text, Video, View, WebView } from "nsh";
import { Button, Dialog, Menu, NavPage, NavStack, Popover, SafeAreaView, Sheet, Tooltip } from "nsh/base";
```

> [!NOTE]
> 为早期版本构建的应用从 `nsh/image`、`nsh/list`、`nsh/canvas`、`nsh/webview` 和 `nsh/video` 导入 `Image`、`List`、`Canvas`、`WebView` 和 `Video`；这些导入继续有效，指向同样的元素。

## 原语

TSX 从 `nsh` 导入，Rust 从 `nsh_core::ui::prelude` 导入。

| 元素 | Rust | 原生视图（iOS / Android） | 页面 |
|---|---|---|---|
| `<View>` | `view()` | UIView / ViewGroup | [View](./view.md) |
| `<Text>` | `text(content)` | CoreText 视图 / StaticLayout 视图 | [Text](./text.md) |
| `<Image>` | `image(src)` | 带图片图层的视图 / 图片视图 | [Image](./image.md) |
| `<Scroll>` | `scroll()` | UIScrollView / ScrollView | [Scroll](./scroll.md) |
| `<Input>` | `input()` | UITextField 或 UITextView / EditText | [Input](./input.md) |
| `<List>` | `virtual_list(count, \|at\| row)` | 复用单元格的 UIScrollView / ScrollView | [List](./list.md) |
| `<Canvas>` | `canvas(painter)` | 回放 2D 绘制的视图 | [Canvas](./canvas.md) |
| `<WebView>` | `web_view(url)`、`web_view_html(html, base)` | WKWebView / android.webkit.WebView | [WebView](./web-view.md) |
| `<Video>` | `video(url)` | AVPlayerLayer / TextureView 上的 MediaPlayer | [Video](./video.md) |
| `<Overlay>` | `overlay()` | 窗口（或所在对话框）之上的视图，相对锚点放置 | [Overlay](./overlay.md) |
| `<If>`、`<Each>` | `when(..)`、`each(..)`、`dynamic(..)` | 控制流：它们选出的元素 | [控制流](./control-flow.md) |
| `<InputAccessoryView>`（`nsh/ios`） | `input_accessory_view(id)` | iOS 上键盘上方的工具栏 | [nsh/ios](../modules/nsh-ios.md) |

## Base

TSX 从 `nsh/base` 导入，Rust 从 `nsh_base` crate 导入。它们负责行为、状态、焦点和无障碍，外观由应用决定。

| 组件 | Rust | 作用 | 页面 |
|---|---|---|---|
| `<Button>` | `nsh_base::button()` | 带有状态和角色的可按压控件 | [Button](./button.md) |
| `<Checkbox>` | `nsh_base::checkbox()` | 带指示器的勾选 / 未勾选 / 半选控件 | [Checkbox](./checkbox.md) |
| `<Radio>`、`<RadioGroup>` | `nsh_base::radio()`、`radio_group()` | 一组只能选一个的选项中的一项，以及这一组 | [Radio](./radio.md) |
| `<Tab>`、`<Tabs>` | `nsh_base::tab()`、`tabs()` | 标签列表中的一个标签页，以及这个列表 | [Tabs](./tabs.md) |
| `<Switch>` | `nsh_base::switch()` | 带轨道和滑块的开 / 关控件 | [Switch](./switch.md) |
| `<Collapsible>` | `nsh_base::collapsible()` | 内容可展开和收起的区域 | [Collapsible](./collapsible.md) |
| `<Progress>` | `nsh_base::progress()` | 进度条：任务完成了多少，或正在进行 | [Progress](./progress.md) |
| `<Dialog>` | `nsh_base::dialog()` | 把子元素呈现在其他一切之上 | [Dialog](./dialog.md) |
| `<NavStack>`、`<NavPage>` | `nsh_base::nav_stack()`、`nsh_base::nav_page()` | 原生导航：带有平台标题栏和返回手势的页面栈 | [NavStack](./nav-stack.md) |
| `<SafeAreaView>` | `nsh_base::safe_area_view()` | 让内容避开刘海、系统栏和主屏幕指示条 | [SafeAreaView](./safe-area-view.md) |
| `<KeyboardAvoidingView>` | `nsh_base::keyboard_avoiding_view()` | 让内容保持在软键盘之上 | [KeyboardAvoidingView](./keyboard-avoiding-view.md) |
| `AlertDialog` | `nsh_base::alert_dialog()` | 系统的提示框和操作表 | [AlertDialog](./alert-dialog.md) |
| `<TextView>` | `nsh_base::text_view()` | 用文本和视图显示 Markdown 或 HTML 文档 | [TextView](./text-view.md) |
| `<SelectionArea>` | `nsh_base::selection_area()` | 让其中的文字一起选择 | [SelectionArea](./selection-area.md) |
| `<Popover>` | `nsh_base::popover()` | 锚定在触发元素上、显示在一切之上的内容 | [Popover](./popover.md) |
| `<Menu>`、`<ContextMenu>`、`<MenuItem>`、`<MenuSeparator>`、`<Submenu>` | `nsh_base::menu()`、... | 菜单：桌面上是带级联子菜单的弹出层，手机上是 sheet | [Menu](./menu.md) |
| `<Tooltip>` | `nsh_base::tooltip()` | 悬停或手指按住时显示在触发元素旁的提示 | [Tooltip](./tooltip.md) |
| `<Sheet>` | `nsh_base::sheet()` | 位于屏幕一侧边缘、覆盖在背景层之上的面板 | [Sheet](./sheet.md) |
| `<Toast>`、`<ToastStack>` | `nsh_base::toast()`、`toast_stack()` | toast 的语义根；从一侧边缘排成层叠的 toast | [Toast](./toast.md) |
| `<ResizablePanelGroup>`、`<ResizablePanel>` | `nsh_base::h_resizable()`、`resizable_panel()` | 并排或上下排列的面板，以及调整它们大小的手柄 | [Resizable](./resizable.md) |
| `<DockArea>` | `nsh_base::dock_area()` | 由分栏、标签组和边缘停靠区组成、用户自行安排的工作区 | [Dock](./dock.md) |

> [!NOTE]
> 字符串只有放在 `Text` 里才会被绘制。`View` 的字符串子节点不会创建原生视图，也不参与布局。

## 通用属性

所有原语都接受下列属性（TSX 中为 `CommonProps` 类型；Rust 中为 `Styled`、`Interactive` 和 `Accessible` trait）。各元素页面只列出该元素自己的属性。Rust 一列给出对应的构建方法。

### 样式

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `style` | 有类型的 `Styled` 方法；`.inline_style(style)` | `StyleProp<ViewStyle>`（`<Text>` 和 `<Input>` 为 `TextStyle`，`<Image>` 为 `ImageStyle`） | 内联样式，或从左到右合并的样式数组（假值项会被跳过；数组可以嵌套，所以 `style={[base, props.style]}` 中的 `props.style` 本身也可以是数组）。优先级高于 `class`。参见[样式参考](../modules/style-reference.md)。 |
| `class` | 有类型的 `Styled` 方法（`.flex_row().gap_2().p_4()`） | `string` | Tailwind 类名，在原生侧解析（`"flex-row gap-2 p-4 dark:bg-zinc-900"`）。后面的类覆盖前面的类。参见 [Tailwind](../docs/tailwind.md)。 |
| `classList` | `.style_when(when, \|s\| ..)` | `Record<string, boolean \| null \| undefined>` | 值为真时才应用的类（`{ "opacity-50": busy() }`）。 |
| `disabled` | `.disabled(..)` | `boolean` | 忽略按压（也没有按压反馈），应用禁用样式，禁用输入框等控件，屏幕阅读器也会读出它已停用（`accessibilityState.disabled`）。 |

### 按压与反馈

按压处理在原生侧完成：由平台识别按压并应用应用设定的按压样式，应用代码只在事后收到通知。只有最内层可按压的视图会响应；在滚动视图内，按下会等待约 130 ms，让滚动有机会先开始。

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `onPress` | `.on_press(..)` | `() => void` | | 在视图内完成一次点击。 |
| `onLongPress` | `.on_long_press(..)` | `() => void` | | 手指按住达到 `delayLongPress`。 |
| `onPressDown` | `.on_press_down(..)` | `() => void` | | 手指在视图上按下。 |
| `onPressUp` | `.on_press_up(..)` | `() => void` | | 手指抬起或移出。 |
| `delayLongPress` | `.long_press_delay(ms)` | `number` | `500` | 按压变为长按前的毫秒数。 |
| `hitSlop` | `.hit_slop(EdgeInsets::all(px(8.0)))` | `number \| Partial<Edges>` | | 把触摸区域扩展到边界之外，单位为点。 |
| `pointerEvents` | `.pointer_events(PointerEvents::BoxNone)` | `"auto" \| "none" \| "box-none" \| "box-only"` | `"auto"` | 视图及其子元素接收哪些触摸：`"none"` 都不接收，`"box-none"` 只有子元素接收，`"box-only"` 只有视图本身接收。 |

按压反馈由应用决定：视图被按下时，`activeStyle`（或 `active:` 类，Rust 中为 `.active(..)`）在原生侧生效，无需经过应用代码（见下文）。

<a id="state-styles"></a>

### 状态样式

视图处于某种状态时，在其自身样式之上、由原生侧应用的样式。每一个都是某个 Tailwind 变体的对象形式。后面的状态优先（selected、checked 与 indeterminate，然后是 hover、focus、active）；`disabledStyle` 优先于所有状态，视图被禁用时其他状态样式不生效。

| 属性 | Rust | 类变体 | 生效时机 |
|---|---|---|---|
| `activeStyle` | `.active(\|s\| ..)` | `active:` | 被按下时。 |
| `hoverStyle` | `.hover(\|s\| ..)` | `hover:` | 指针悬停在视图上时。 |
| `focusStyle` | `.focus(\|s\| ..)` | `focus:` | 视图获得焦点时。 |
| `disabledStyle` | `.disabled_style(\|s\| ..)` | `disabled:` | `disabled` 时。 |
| `checkedStyle` | `.checked(\|s\| ..)`、`.checked_style(style)` | `checked:` | `accessibilityState.checked` 为 `true` 时（复选框、开关、单选框；`"mixed"` 不算勾选）。 |
| `indeterminateStyle` | `.indeterminate(\|s\| ..)`、`.indeterminate_style(style)` | `indeterminate:` | `accessibilityState.checked` 为 `"mixed"` 时（既非勾选也非未勾选的复选框）。 |
| | `.selected(\|s\| ..)` | `selected:` | `accessibilityState.selected` 为 `true` 时（选中的 `Button`、标签页）。 |

```rust tabs
view()
    .rounded_lg()
    .bg(rgb(0x2563eb))
    .px_4()
    .py_2()
    .active(|s| s.opacity(0.6))
    .hover(|s| s.bg(rgb(0x1d4ed8)))
    .on_press(save)
    .child(text("保存").text_color(white()))
```

```tsx tabs
<View onPress={save} activeStyle={{ opacity: 0.6 }} hoverStyle={{ backgroundColor: "#1d4ed8" }} class="rounded-lg bg-blue-600 px-4 py-2">
  <Text class="text-white">保存</Text>
</View>
```

### 悬停

应用可以得知鼠标移到视图上、在视图上移动和离开视图：macOS、Windows、Linux、GPUI 后端和桌面浏览器都支持；iOS 上是 iPad 的指针或 Mac 的鼠标，Android 上是鼠标或手写笔。悬停样式（`hover:`、`.hover(..)`）在同样的地方为悬停的视图设置样式。

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `onHoverIn` | `.on_hover_in(..)` | `() => void` | 鼠标移到视图或其内部的视图上。 |
| `onHoverMove` | `.on_hover_move(..)` | `(e: HoverEvent) => void` | 没有按下按键时，鼠标在视图（或其内部的视图）上移动。 |
| `onHoverOut` | `.on_hover_out(..)` | `() => void` | 鼠标离开视图及其内部的视图，或离开窗口。 |

与 CSS 的 `:hover` 一样，鼠标在视图上或在其内部任何内容上时，视图都算作被悬停，因此鼠标下方视图外层的视图也会收到 `onHoverIn`（由外向内；`onHoverOut` 由内向外）。事件在发生之后才通知应用，触摸从不触发；按着按键移动属于触摸（`onTouchMove`、响应者系统）。从鼠标下方移除的视图会收到 `onHoverOut`，在 Linux 和 Windows 上要等到鼠标下一次移动。

`HoverEvent` 像 GPUI 的 `MouseMoveEvent` 一样给出鼠标的位置：`position` 是在视图中的位置（一个 `Point`，单位为点，已去掉视图的变换），`pagePosition` 是在视图所在根视图中的位置（与触摸相同），以及按住的 `modifiers`（`control`、`alt`、`shift`、`platform`：Apple 平台上是 Command，其他平台是 Windows 键）；Rust 中为 `position`、`page_position` 和 `modifiers`。移动事件每帧最多一次，总是最新的那次，并且一定在随后的 `onHoverOut` 之前到达，因此处理函数可以在每次移动时重绘：

```rust tabs
// 图表上的十字线。
let at = signal(None::<Points>);

view()
    .h(px(200.0))
    .on_hover_move(move |e: &HoverEvent| at.set(Some(e.position.x)))
    .on_hover_out(move || at.set(None))
    .child(when(move || at.get().is_some(), move || {
        view()
            .absolute()
            .left(move || at.get().unwrap_or_default())
            .top_0()
            .bottom_0()
            .w(px(1.0))
            .bg(rgb(0x888888))
    }))
```

```tsx tabs
// 图表上的十字线。
const at = signal<number | null>(null);

<View onHoverMove={(e) => at.set(e.position.x)} onHoverOut={() => at.set(null)} style={{ height: 200 }}>
  <If when={at() !== null}>
    <View style={{ position: "absolute", left: at()!, top: 0, bottom: 0, width: 1, backgroundColor: "#888" }} />
  </If>
</View>
```

<a id="tooltips"></a>

### 工具提示

`tooltip` 为任意元素加上提示：在桌面平台（macOS、Windows、Linux、GPUI 后端和桌面浏览器）上，指针在元素上停留半秒后显示在它上方，指针离开或按下时隐藏。手机和平板不显示。提示从不接收指针或按压，所以元素的行为与没有它时完全一样。

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `tooltip` | `.tooltip(..)` | `string \| JSX.Element` | 文字，显示在用主题 `popover` 令牌（`bg-popover`、`text-popover-foreground`、`border-border`，外观由主题决定）绘制的小气泡中；或一个元素，按原样显示（`nsh/base` 的 `Tooltip` 就是工具提示本身）。 |

```rust tabs
view().on_press(save).tooltip("保存文档").child(text("💾"))
```

```tsx tabs
<View onPress={save} tooltip="保存文档">
  <Text>💾</Text>
</View>
```

需要自己的外观、位置、延迟或事件时，把 `nsh/base` 的 [`Tooltip`](tooltip.md) 作为 `tooltip` 传入，与 GPUI 的 `.tooltip(..)` 相同。

### 上下文菜单

`onContextMenu` 告诉视图：鼠标的辅助按钮在它上面按下了——右键单击、macOS 上的 Control 单击、触控板的双指单击、iPad 指针的辅助点按；在浏览器里还有键盘的菜单键。在这里打开应用自己的菜单；在 TSX 中，[`Menu.popup`](../modules/nsh-desktop.md) 显示系统菜单：

```rust tabs
// 应用自己的菜单，放在点击的位置。
let menu_at = signal(None::<Point<Points>>);

view()
    .on_context_menu(move |e: &ContextMenuEvent| menu_at.set(Some(e.page_position)))
    .child(text(row.name.clone()))
```

```tsx tabs
import { Menu } from "nsh/desktop";

<View onContextMenu={(e) => Menu.popup(rowMenu(row), e.pagePosition)}>…</View>
```

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `onContextMenu` | `.on_context_menu(..)` | `(e: ContextMenuEvent) => void` | 辅助按钮在视图或其内部的视图上按下。 |

`ContextMenuEvent` 包含视图中的 `position`、根视图中的 `pagePosition`（`Menu.popup` 放置菜单的位置：`Menu.popup(items, e.pagePosition)`）以及 `modifiers`；Rust 中为 `position`、`page_position` 和 `modifiers`。从指针下方的视图向外，最近的一个监听者收到事件。如果比它更近的是文本输入框，或带有编辑菜单的可选中文本（Windows、GPUI 后端、浏览器），则显示它们自己的菜单。平台在按钮按下时根据已挂载的内容做出决定，因此处理函数在事后得到通知，不需要取消任何东西。`disabled` 的视图把这次点击留给外层最近的、未停用的监听者。在触摸屏上用长按打开菜单：用同一个函数处理 `onLongPress`。

### 键盘焦点

在 macOS 和 Web 上，Tab 在可按压的视图（以及输入框）之间移动键盘焦点，按 Return 或空格会按下获得焦点的视图，焦点样式（`focus:`、`.focus(..)`）为它设置样式。点击会按下视图但不让它获得焦点，所以焦点样式只在键盘聚焦时生效。

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `focusable` | `.focusable(..)` | `boolean` | `true` | 可按压的视图是否是 Tab 的停靠点；`false` 把它留给指针（关闭浮层的背景层、用方向键切换的列表行）。 |

```rust tabs
view()
    .rounded_lg()
    .p_3()
    .focus(|s| s.bg(rgb(0xe0f2fe)))
    .on_press(open)
    .child(text("打开"))

// 浮层的背景层：点击关闭浮层，Tab 直接越过它进入内容。
view().absolute().inset_0().focusable(false).on_press(close)
```

```tsx tabs
<View class="rounded-lg p-3 focus:bg-sky-100" onPress={open}>
  <Text>打开</Text>
</View>

{/* 浮层的背景层：点击关闭浮层，Tab 直接越过它进入内容。 */}
<View class="absolute inset-0" focusable={false} onPress={close} />
```

### 布局与标识

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `onLayout` | `.on_layout(\|frame: &Bounds<Points>\| ..)` | `(bounds: Bounds) => void` | 每次布局改变视图位置尺寸后，给出相对父视图的 frame `{ origin, size }`。 |
| `ref` | `.element_ref(&handle)` | `YNode \| (node: YNode) => void` | 原生节点（参见 [ref 方法](#ref-方法)）。`ref={el}` 赋值给变量，`ref={fn}` 调用函数。 |
| `nativeID` | `.native_id(id)` | `string` | 为视图命名，供其他元素引用，例如输入框引用的 `InputAccessoryView`。 |
| `testID` | `.test_id(id)` | `string` | UI 测试使用的标识（在 Android 上是视图的 resource id）。 |
| `key` | `.key(key)` | `string` | 元素在兄弟元素之间的标识。 |

### 驱动动画值的手势

这些属性把手势绑定到[原生动画值](../modules/nsh-animated.md)，值在 UI 线程上变化，每帧都不经过应用代码。参见[触摸与手势](../docs/touch-and-gestures.md)。

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `pan` | `.pan_values(Some(&x), Some(&y))` | `{ x?: AnimatedValue; y?: AnimatedValue }` | 拖动驱动这些值（单位为点）。 |
| `onPanStart` | `.on_pan_start(..)` | `(e: PanEvent) => void` | 拖动开始。 |
| `onPanEnd` | `.on_pan_end(..)` | `(e: PanEvent) => void` | 拖动结束，带有松手时的速度（例如用来启动 `decay`）。 |
| `pinch` | `.pinch_value(&scale)` | `{ scale?: AnimatedValue }` | 双指捏合驱动 `scale`。 |
| `onPinchStart` / `onPinchEnd` | `.on_pinch_start(..)` / `.on_pinch_end(..)` | `(e: { scale: number; velocity: number }) => void` | 捏合开始 / 结束。 |
| `rotation` | `.rotation_value(&angle)` | `{ angle?: AnimatedValue }` | 双指旋转驱动 `angle`（角度）。 |
| `onRotationStart` / `onRotationEnd` | `.on_rotation_start(..)` / `.on_rotation_end(..)` | `(e: { rotation: number; velocity: number }) => void` | 旋转开始 / 结束。 |

`PanEvent` 为 `{ translationX, translationY, velocityX, velocityY, valueX?, valueY? }`（Rust 中为 `translation`、`velocity_x`、`velocity_y`、`value_x`、`value_y`）：自开始以来的位移、以点每秒计的速度，以及此刻所绑定值的数值（拖动可能在动画中途抓住一个值）。

### 原始触摸与响应者系统

对于上面属性覆盖不到的手势，每个元素都支持触摸与响应者属性：
`onTouchStart`、`onTouchMove`、`onTouchEnd`、`onTouchCancel`（以及对应的 `…Capture` 形式）、
`onStartShouldSetResponder`、`onMoveShouldSetResponder`（以及 `…Capture`）、`onResponderGrant`、`onResponderReject`、
`onResponderStart`、`onResponderMove`、`onResponderEnd`、`onResponderRelease`、`onResponderTerminate` 和
`onResponderTerminationRequest`。每个处理函数都会收到一个 `GestureResponderEvent`
（`{ identifier, locationX, locationY, pageX, pageY, target, timestamp, touches, changedTouches, nativeEvent,
stopPropagation() }`）；`…ShouldSetResponder` 回调还会收到 `gestureState`（`dx`、`dy`、`vx`、`vy` 等）。
`onResponderGrant` 返回 `true` 可阻止原生滚动视图接管触摸。`panActivation`
（`{ activeOffsetX, activeOffsetY, failOffsetX, failOffsetY }`）让视图只在平台激活它的拖动后才成为响应者，
滚动视图里的拖动因此把另一个轴留给滚动视图（[触摸与手势](../docs/touch-and-gestures.md#滚动视图里的拖动panactivation)）。
[`nsh/gesture`](../modules/nsh-gesture.md) 中的 `PanResponder` 就构建在它们之上。在 Rust 中，`.on_touch(..)` 接收每次触摸（`TouchEvent`），`.claim_touches(..)` 决定视图何时接管触摸，`.on_responder_grant(..)`、`.on_responder_move(..)`、`.on_responder_release(..)` 等跟随响应者状态。

### 无障碍

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `accessible` | `.accessible(..)` | `boolean` | 视图对辅助技术而言是一个整体元素，子元素不再单独暴露。 |
| `accessibilityLabel` | `.label(..)` | `string` | 屏幕阅读器朗读的内容。没有标签的视图会朗读其中的文本。 |
| `accessibilityHint` | `.hint(..)` | `string` | 激活该元素会发生什么。 |
| `role` | `.role(AccessibilityRole::Button)` | `AccessibilityRole` | 元素是什么（`"button"`、`"header"`、`"link"`、`"switch"` 等）。 |
| `accessibilityState` | `.accessibility_state(..)` | `{ disabled?, selected?, checked?, busy?, expanded? }` | 辅助技术报告的状态（`checked` 可以是 `"mixed"`）。 |
| `accessibilityValue` | `.accessibility_value(..)` | `{ min?, max?, now?, text? }` | 范围类或文本类元素的值。 |
| `accessibilityElementsHidden` | | `boolean` | 对辅助技术隐藏该视图及其子树。 |
| `importantForAccessibility` | | `"auto" \| "yes" \| "no" \| "no-hide-descendants"` | 是否暴露该视图。 |
| `accessibilityActions` | | `{ name: string; label?: string }[]` | 提供给辅助技术的自定义操作。 |
| `onAccessibilityAction` | `.on_accessibility_action(..)` | `(e: { actionName: string }) => void` | 用户触发了 `accessibilityActions` 中的某个操作。 |

参见[无障碍](../docs/accessibility.md)。

### 平台专属属性

在 TSX 中，只在某个平台上存在的属性放在以该平台命名的对象里，这样共享属性在各平台上保持一致。只有当前平台的对象会被发送，其他的会被忽略。Rust 的构建器以方法的形式提供它们，在各自的平台上生效。

| 属性 | 说明 |
|---|---|
| `ios={{…}}` | iOS 和 Mac Catalyst。`<Input>`、`Dialog` 和 `WebView` 有各自的键。 |
| `android={{…}}` | Android。所有元素都支持 `ripple`、`elevation` 和 `accessibilityLiveRegion`（见下表）。 |
| `desktop={{…}}` | 桌面平台和桌面浏览器；在移动端被忽略。所有元素都支持 `windowDrag`（见下表）。 |
| `web={{…}}` | 浏览器；在其他平台被忽略。 |

| `android` 键 | Rust | 类型 | 说明 |
|---|---|---|---|
| `ripple` | `.ripple(Ripple { .. })` | `{ color?, borderless?, radius?, foreground? }` | 按下时的 Material 水波纹。 |
| `elevation` | `.elevation(px(2.0))` | `number` | 根据视图形状生成的 Material 阴影（单位为点）。 |
| `accessibilityLiveRegion` | | `"none" \| "polite" \| "assertive"` | 视图变化如何播报给 TalkBack。 |

| `desktop` 键 | Rust | 类型 | 说明 |
|---|---|---|---|
| `windowDrag` | `.window_drag(..)` | `boolean` | 按住视图拖动窗口，像按住标题栏一样；`false` 让可拖动视图中的一部分保持可点击。见[自定义标题栏](../modules/nsh-desktop.md#自定义标题栏)。 |

```rust tabs
use nsh_core::Ripple;

view()
    .rounded_lg()
    .bg(white())
    .p_4()
    .elevation(px(2.0))
    .ripple(Ripple { color: Some(rgba(0x00000022).into()), ..Ripple::default() })
    .on_press(save)
    .child(text("保存"))
```

```tsx tabs
<View onPress={save} android={{ ripple: { color: "#00000022" }, elevation: 2 }} class="rounded-lg bg-white p-4">
  <Text>保存</Text>
</View>
```

参见[平台相关代码](../docs/platform-specific.md)。

## ref 方法

在 TSX 中 `ref` 收到一个 `YNode`；在 Rust 中，`element_ref()` 创建一个 `ElementRef` 句柄，由 `.element_ref(&handle)` 附加到元素上。它们的方法向原生视图发送命令，与同一轮中先前的改动按顺序执行。各元素页面会说明哪些方法适用。

| 方法 | Rust | 适用于 | 说明 |
|---|---|---|---|
| `focus()` / `blur()` | `focus()` / `blur()` | `<Input>` | 获取焦点（弹出键盘）/ 失去焦点。 |
| `setSelection(start, end?)` | `set_selection(start, end)` | `<Input>` | 选中 `start..end`（UTF-16 单位）；省略 `end` 时为光标。 |
| `scrollTo({ x?, y?, animated? })` | `scroll_to(point, animated)` | `<Scroll>`、`List` | 滚动到某个偏移量。 |
| `zoomTo({ scale, x?, y?, animated? })` | `zoom_to(scale, center, animated)` | 可缩放的 `<Scroll>` | 围绕内容中的某点缩放到 `scale`。 |
| `scrollToOffset({ offset, animated? })` | `scroll_to_offset(offset, animated)` | `List` | 沿列表方向滚动到某个偏移量。 |
| `scrollToIndex({ index, animated?, viewPosition?, viewOffset? })` | `scroll_to_index(index, position, offset, animated)` | `List` | 把某一项滚动到可见区域。 |
| `scrollToEnd({ animated? })` | `scroll_to_end(animated)` | `List` | 滚动到内容末尾。 |
| `reload()`、`goBack()`、`goForward()`、`stopLoading()`、`injectJavaScript(script)`、`postMessage(data)` | `reload()`、`go_back()`、`go_forward()`、`stop_loading()`、`inject_java_script(..)`、`post_message(..)` | `WebView` | 控制页面。 |
| `seek(seconds)` | `seek(seconds)` | `Video` | 跳转到某个时间点。 |
| `command(name, args?)` | `command(name, args)` | 原生组件 | 调用已注册原生组件的命令（[`nsh/native`](../modules/nsh-native.md)）。 |

```rust tabs
let field = element_ref();

view()
    .on_press(move || field.focus())
    .child(input().element_ref(&field).placeholder("点击这一行开始输入"))
```

```tsx tabs
import { Input, View, type YNode } from "nsh";

let input!: YNode;
<View onPress={() => input.focus()}>
  <Input ref={input} placeholder="点击这一行开始输入" />
</View>;
```

## 为什么处理函数不会阻塞 UI

主线程从不等待应用代码。当系统需要立即得到答复时（这段文本能否修改、返回键能否返回上一页、这个 sheet 能否关闭），NSH 会根据事先设置好的属性（`maxLength`、`popOnBack`、`closeOnSwipe`、`pointerEvents` 等）在原生侧作答，事件随后才送达应用。正因如此，这类行为都是属性，而不是处理函数的返回值。
