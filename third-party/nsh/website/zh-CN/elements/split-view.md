---
title: SplitView
description: SplitView：并排显示两到三栏导航栈（侧边栏、可选的内容栏和详情栏），空间紧凑时一次显示一栏。在 iOS 和 Mac Catalyst 上是 UISplitViewController，其他平台上是固定宽度的栏；显示哪些栏是应用持有的值。
group: base
demo: el-split-view
---

# SplitView

分栏视图把应用的导航分成几栏显示：侧边栏（分区或列表）、可选的内容栏（侧边栏所选内容中的条目）和详情栏。每一栏都是一个独立的 [`NavStack`](./nav-stack.md)，因此每一栏保留自己的页面，各自推入和弹出。在 iOS、iPadOS 和 Mac Catalyst 上，这些栏属于 `UISplitViewController`：在 iPadOS 26 上侧边栏浮在内容之上，从边缘轻扫或按系统的侧边栏按钮即可呼出，窗口旋转和改变大小时由系统安排各栏。其他平台上各栏以固定宽度并排显示。空间紧凑时（手机、窄窗口）一次只显示一栏。显示哪些栏由 `columnVisibility` 决定，这个值由应用持有。

```rust tabs
use nsh_base::{ColumnVisibility, button, nav_page, nav_stack, split_view, theme};
use nsh_core::prelude::*;

const MESSAGES: [&str; 2] = ["Welcome", "Release notes"];

/// A message of the inbox: a press shows it in the detail.
fn row(
    title: &'static str,
    selected: Signal<&'static str>,
    visibility: Signal<ColumnVisibility>,
) -> impl IntoElement {
    button()
        .on_press(move || {
            selected.set(title);
            // Where one column shows, the message comes in front.
            if horizontal_size_class() == SizeClass::Compact {
                visibility.set(ColumnVisibility::DetailOnly);
            }
        })
        .px_4()
        .py_3()
        .child(text(title).text_color(move || theme().foreground()))
}

fn mail() -> impl IntoElement {
    let visibility = signal(ColumnVisibility::Automatic);
    let selected = signal(MESSAGES[0]);
    split_view()
        .flex_1()
        .column_visibility(move || Some(visibility.get()))
        .on_column_visibility_change(move |next: &ColumnVisibility| visibility.set(*next))
        .sidebar(nav_stack().child(nav_page().title("Inbox").child(
            view()
                .flex_1()
                .children(MESSAGES.map(|title| row(title, selected, visibility))),
        )))
        .detail(nav_stack().child(
            nav_page()
                .title(move || SharedString::from(selected.get()))
                .child(text(move || format!("{} …", selected.get())).p_4()),
        ))
}
```

```tsx tabs
import { horizontalSizeClass, mount, signal, Text, View } from "nsh";
import { Button, type ColumnVisibility, createNavStack, NavPage, NavStack, SplitView } from "nsh/base";

const messages = ["Welcome", "Release notes"];
const inbox = createNavStack(["inbox"]);
const message = createNavStack(["message"]);

function App() {
  const visibility = signal<ColumnVisibility>("automatic");
  const selected = signal(messages[0]);
  const open = (title: string) => {
    selected.set(title);
    // Where one column shows, the message comes in front.
    if (horizontalSizeClass() === "compact") visibility.set("detailOnly");
  };
  return (
    <SplitView
      class="flex-1"
      columnVisibility={visibility()}
      onColumnVisibilityChange={({ columnVisibility }) => visibility.set(columnVisibility)}
      sidebar={
        <NavStack state={inbox}>
          {() => (
            <NavPage title="Inbox">
              <View class="flex-1">
                {messages.map((title) => (
                  <Button onPress={() => open(title)} class="px-4 py-3">
                    <Text class="text-foreground">{title}</Text>
                  </Button>
                ))}
              </View>
            </NavPage>
          )}
        </NavStack>
      }
      detail={
        <NavStack state={message}>
          {() => (
            <NavPage title={selected()}>
              <Text class="p-4 text-foreground">{`${selected()} …`}</Text>
            </NavPage>
          )}
        </NavStack>
      }
    />
  );
}

mount(App);
```

`SplitView` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh_base::split_view()`，以及 `ColumnVisibility`。在 Rust 中每一栏是一个接收它的栈的设置方法（`.sidebar(..)`、`.content(..)`、`.detail(..)`）；在 TSX 中每一栏是一个接收 `<NavStack>` 的属性。

## 栏

- **`sidebar`**：第一栏，应用的分区或列表。
- **`content`**：三栏中间的一栏，侧边栏所选内容中的条目（例如一个邮箱里的邮件）。没有它时视图只有两栏。
- **`detail`**：最后一栏，显示其他栏选中的内容。

每一栏都是一个 `NavStack`：它的页面、标题栏、返回按钮和状态都属于这个栈，在一栏中推入或弹出页面不会影响其他栏。各栏的宽度由平台决定：在 iOS 上由 UIKit 决定，并随窗口变化；其他平台上采用 iPadOS 的默认值，侧边栏和内容栏宽 320 点，详情栏占据其余空间。外观属于应用：各栏的内容和背景（包括栏之间的分隔线）都由页面绘制。

## 显示哪些栏

| `columnVisibility` | 空间充足时 | 空间紧凑时 |
|---|---|---|
| `"automatic"`（默认） | 在 iPadOS 上由系统根据窗口大小和方向决定，并保留用户显示的栏；其他平台上显示所有栏 | 侧边栏 |
| `"all"` | 所有栏 | 侧边栏 |
| `"doubleColumn"` | 内容栏和详情栏；只有两栏时两栏都显示 | 内容栏；只有两栏时为侧边栏 |
| `"detailOnly"` | 详情栏 | 详情栏 |

不设置 `columnVisibility` 时，视图自己保存这个值，初始为 `"automatic"`。设置后由应用持有这个值，并在 `onColumnVisibilityChange({ columnVisibility })` 中更新它；这个事件报告用户或系统改为显示的栏：iPadOS 的侧边栏按钮、从边缘轻扫、在覆盖于详情栏之上的栏旁边按下、在手机上从一栏的第一页返回。应用保留另一个值时，视图会重新显示应用的值。在 `"automatic"` 下视图保留用户显示的栏；窗口旋转或改变大小时 iPadOS 自行做出的改变属于 `"automatic"` 本身，因此报告的是用户做出的改变。

## 手机与窄窗口

窗口在水平方向紧凑时（[`horizontalSizeClass()`](../modules/nsh.md#horizontalsizeclass--verticalsizeclass) 为 `"compact"`，Rust 中为 `horizontal_size_class()`）只显示一栏，即 `columnVisibility` 显示的第一栏。选中某项后要把详情栏显示到前面，就在这时设置 `"detailOnly"`，就像上面的例子所做的那样。

- **iOS、iPadOS 和 Mac Catalyst**：窗口在水平方向紧凑时（iPhone、侧拉（Slide Over）中的 iPad，或窄的分屏（Split View）和台前调度（Stage Manager）窗口），分栏视图收起为一个由各栏页面组成的导航栈：先是侧边栏的页面，再按 `columnVisibility` 依次是内容栏和详情栏的页面，栏之间使用系统的返回按钮和轻扫返回。在任何一栏推入的页面都会推入到这里。从一栏的第一页返回会显示前一栏，并通过 `onColumnVisibilityChange` 报告（三栏时 `"detailOnly"` 变为 `"doubleColumn"`，两栏时变为 `"all"`）；离开的页面若不是所在栏的第一页，就像在普通的栈中一样被弹出。窗口重新变宽时，每一栏取回自己的页面。
- **Android、桌面平台和 Web**：窗口在水平方向紧凑时（窗口宽度小于 600 点），这一栏单独占满全部空间。返回前一栏的方式由应用提供：栏标题栏中的返回按钮，或 Android 上的 [`BackHandler`](../modules/nsh-mobile.md#backhandler)。

在所有平台上，每一栏在两种呈现方式之间都保留自己的页面和状态。

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `sidebar` | `.sidebar(..)` | `JSX.Element` | 无 | 第一栏：一个 `NavStack`。 |
| `content` | `.content(..)` | `JSX.Element` | 无 | 三栏中间的一栏：一个 `NavStack`。没有它时视图只有两栏。 |
| `detail` | `.detail(..)` | `JSX.Element` | 无 | 最后一栏：一个 `NavStack`。 |
| `columnVisibility` | `.column_visibility(..)` | `ColumnVisibility` | 无 | 显示哪些栏（受控）：`"automatic"`、`"all"`、`"doubleColumn"` 或 `"detailOnly"`。不设置时视图自己保存，初始为 `"automatic"`。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 视图自身：它在父元素中的尺寸（如 `flex-1`）。它不会超出自己的边界，也不从各栏取得最小尺寸。 |

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onColumnVisibilityChange` | `.on_column_visibility_change(\|v: &ColumnVisibility\| ..)` | `{ columnVisibility }`：用户或系统改变了显示的栏，值为 `"all"`、`"doubleColumn"` 或 `"detailOnly"`。 |

## 无障碍

- 每一栏的页面属于它的栈，按栏的顺序朗读，侧边栏在前。在 iOS 上，系统的侧边栏按钮和返回按钮对 VoiceOver 来说与任何 `UISplitViewController` 中的一样。
- 只显示一栏时，屏幕阅读器只能读到这一栏。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

## 平台说明

- **iOS、iPadOS 和 Mac Catalyst**：两栏或三栏的 `UISplitViewController`，每一栏是对应 `NavStack` 的 `UINavigationController`。iPadOS 26 以 Liquid Glass 让侧边栏浮在内容之上。从边缘轻扫和侧边栏按钮都由系统提供。
- **Android、桌面平台和 Web**：各栏以固定宽度并排显示。由用户调整大小和重新排列的工作区是 [`DockArea`](./dock.md)。
