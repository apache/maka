---
title: Menu
description: Menu 和 ContextMenu，配合 MenuItem、MenuSeparator 和 Submenu：桌面上是带级联子菜单的弹出层，手机上是就地展开子菜单的 sheet，样式由应用决定。
group: base
demo: el-menu
---

# Menu

菜单是由触发元素打开的一组操作。同一个结构适用于每种设备，并按各自的习惯呈现：

- 在桌面平台和桌面浏览器中，它是触发元素处的弹出层；指针移到 `Submenu` 的条目上或按下它时，子菜单在条目旁级联展开。
- 在手机和平板上，它是屏幕底部、覆盖在背景层之上的 sheet；`Submenu` 在 sheet 中就地显示它的条目，取代菜单的条目，并由你提供的一行返回上一级。

选择一个条目、外部按压、Escape、Android 返回键和 VoiceOver 的退出手势都会关闭它。`ContextMenu` 是同样的菜单，由辅助按键（右键单击）在指针处打开，或在触摸屏上由手指按住触发元素打开。

```rust tabs
use nsh_base::{menu, menu_item, menu_separator, submenu};
use nsh_core::prelude::*;

fn item(label: &'static str, on_select: impl Fn() + 'static) -> impl IntoElement {
    menu_item()
        .on_select(on_select)
        .px_3()
        .py_2()
        .rounded_md()
        .child(text(label))
}

fn file_menu() -> impl IntoElement {
    menu()
        .offset(px(4.0))
        .trigger(view().px_3().py_2().child(text("File")))
        .child(item("New", || log::info!("new")))
        .child(item("Open…", || log::info!("open")))
        .child(menu_separator().h(px(1.0)).my_1().bg(rgb(0xe5e7eb)))
        .child(
            submenu()
                .trigger(view().px_3().py_2().child(text("Share ›")))
                .back(view().px_3().py_2().child(text("‹ Back")))
                .child(item("Mail", || log::info!("mail")))
                .child(item("Copy link", || log::info!("link"))),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator, Submenu } from "nsh/base";

function Item(props: { label: string; onSelect: () => void }) {
  return (
    <MenuItem onSelect={props.onSelect} class="rounded-md px-3 py-2 hover:bg-gray-100 active:bg-gray-200">
      <Text>{props.label}</Text>
    </MenuItem>
  );
}

function FileMenu() {
  return (
    <Menu
      offset={4}
      popupClass="min-w-48 rounded-lg bg-white p-1 shadow-lg"
      backdropClass="bg-black/40"
      trigger={<View class="px-3 py-2"><Text>File</Text></View>}
    >
      <Item label="New" onSelect={newFile} />
      <Item label="Open…" onSelect={openFile} />
      <MenuSeparator class="my-1 h-px bg-gray-200" />
      <Submenu
        trigger={<View class="px-3 py-2"><Text>Share ›</Text></View>}
        back={<View class="px-3 py-2"><Text>‹ Back</Text></View>}
      >
        <Item label="Mail" onSelect={mail} />
        <Item label="Copy link" onSelect={copyLink} />
      </Submenu>
    </Menu>
  );
}
```

这五个组件都来自 [`nsh/base`](../modules/nsh-base.md)。条目会自己找到所属的菜单，所以你可以自由地编排它们：放在视图里分组、加标签、用 `If` 让条目出现和消失。`popupClass` 在桌面上设置弹出层的样式，在手机上设置 sheet 的样式；两者需要不同样式时，可以把 `platform.idiom`（`nsh`）与 `"desktop"` 比较。

<a id="context-menus"></a>

## 上下文菜单

```tsx
import { ContextMenu, MenuItem } from "nsh/base";

<ContextMenu
  popupClass="min-w-40 rounded-lg bg-white p-1 shadow-lg"
  backdropClass="bg-black/40"
  trigger={<PhotoTile photo={photo} />}
>
  <MenuItem onSelect={() => share(photo)}><Text>Share</Text></MenuItem>
  <MenuItem onSelect={() => remove(photo)}><Text>Delete</Text></MenuItem>
</ContextMenu>
```

在桌面平台上，辅助按键在指针所在处打开它。在触摸屏上，手指按住触发元素会以 sheet 的形式打开它；触发元素自己的按压和周围的滚动视图照常工作，移动手指会取消这次按住。

<a id="checkable-items"></a>

## 可勾选的条目

`checked` 让条目可以勾选：菜单显示的一项设置（「显示侧边栏」），或者在 `role="menuitemradio"` 时，一组选项中的一个（「排序方式」）。值由你持有：选择条目会调用 `onSelect`，你设置下一个值，条目就显示它。勾选时，它的 `checked:` 类和 `checkedStyle` 生效，它的指示部件（位于内容之前，`indicatorClass`、`indicatorStyle`）也一样，部件里是你给它的标记（`indicator`）。标记只创建一次并保留下来，由指示部件的 `checked:` 类显示和隐藏它；也可以在 `indicatorClass` 中加 `group`，用标记自己的 `group-checked:` 类。`closeOnSelect={false}` 让菜单保持打开，这样设置会立刻显示新的值。

```rust tabs
use nsh_base::{menu, menu_item};
use nsh_core::{element::StyleRefinement, prelude::*};

fn view_menu(sidebar: Signal<bool>, sort: Signal<&'static str>) -> impl IntoElement {
    // The indicator part shows the mark while the item is checked.
    let part = |s: StyleRefinement| s.w(px(16.0)).opacity(0.0).checked(|s| s.opacity(1.0));
    let by = move |label: &'static str| {
        menu_item()
            .role(AccessibilityRole::MenuItemRadio)
            .checked(move || Some(sort.get() == label))
            .indicator_style(part)
            .indicator(text("✓"))
            .on_select(move || sort.set(label))
            .flex_row()
            .gap_2()
            .px_3()
            .py_2()
            .child(text(label))
    };
    menu()
        .trigger(view().px_3().py_2().child(text("View")))
        .child(
            menu_item()
                .checked(move || Some(sidebar.get()))
                .close_on_select(false)
                .indicator_style(part)
                .indicator(text("✓"))
                .on_select(move || sidebar.set(!sidebar.get_untracked()))
                .flex_row()
                .gap_2()
                .px_3()
                .py_2()
                .child(text("Show sidebar")),
        )
        .child(by("Name"))
        .child(by("Date modified"))
}
```

```tsx tabs
import { Text, View, signal } from "nsh";
import { Menu, MenuItem } from "nsh/base";

// The indicator part shows the mark while the item is checked.
const part = "w-4 opacity-0 transition-opacity checked:opacity-100";

function ViewMenu() {
  const sidebar = signal(true);
  const sort = signal("Name");
  return (
    <Menu popupClass="min-w-48 rounded-lg bg-white p-1 shadow-lg" trigger={<View class="px-3 py-2"><Text>View</Text></View>}>
      <MenuItem
        checked={sidebar()}
        closeOnSelect={false}
        indicatorClass={part}
        indicator={<Text>✓</Text>}
        onSelect={() => sidebar.set(!sidebar())}
        class="flex-row gap-2 rounded-md px-3 py-2 hover:bg-gray-100"
      >
        <Text>Show sidebar</Text>
      </MenuItem>
      <Each of={["Name", "Date modified", "Size"]}>
        {(by) => (
          <MenuItem
            role="menuitemradio"
            checked={sort() === by()}
            indicatorClass={part}
            indicator={<Text>✓</Text>}
            onSelect={() => sort.set(by())}
            class="flex-row gap-2 rounded-md px-3 py-2 hover:bg-gray-100 checked:font-semibold"
          >
            <Text>{by()}</Text>
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}
```

放在末端的标记则写在内容里，在条目上加 `group`，用 `group-checked:` 类设置它的样式。

<a id="entrance-and-exit"></a>

## 出现与离开

在桌面平台上，弹出层像 [Popover](./popover.md#entrance-and-exit) 一样随你的过渡出现和离开：`popupStartingClass` 是它第一帧的外观，`popupEndingClass` 是关闭后的外观，在 `popupClass` 的 `transition-*` 类播放期间它会保留，随后触发 `onClose`。子菜单使用同样的外观，并随菜单一起关闭。手机上的 sheet 自带滑入和滑出的动作。

```tsx
<Menu
  popupClass="min-w-40 rounded-lg bg-white p-1 shadow-lg transition-all duration-100"
  popupStartingClass="opacity-0 -translate-y-1"
  popupEndingClass="opacity-0"
  trigger={<Text>File</Text>}
>
  <MenuItem onSelect={newFile}><Text>New</Text></MenuItem>
</Menu>
```

<a id="open-state"></a>

## 打开状态

没有 `open` 时，菜单自己保存状态（`Menu` 的初始值为 `defaultOpen`）。有 `open` 时，状态由应用持有，并在 `onOpenChange({ open, reason })` 中修改它，原因为 `"triggerPress"`、`"select"`、`"pressOutside"`、`"backdropPress"`、`"cancel"`、`"contextMenu"` 或 `"longPress"`。

<a id="props"></a>

## 属性

### Menu

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | 无 | 是否打开，由应用控制。 |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | 没有 `open` 时，初始是否打开。 |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | 桌面：它位于触发元素的哪一侧。 |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"start"` | 桌面：它如何与触发元素对齐。 |
| `offset` | `.offset(..)` | `number` | `0` | 桌面：触发元素与弹出层之间的间距。 |
| `margin` | `.margin(..)` | `number` | `0` | 桌面：它与安全区边缘保持的距离。 |
| `popupClass`、`popupStyle` | `popup_class`、`popup_style` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层（桌面）或 sheet（手机），以及子菜单的弹出层。 |
| `popupStartingClass`、`popupStartingStyle` | `popup_starting_class`、`popup_starting_style` | `string`、`StyleProp<ViewStyle>` | 无 | 桌面：弹出层第一帧的外观，叠加在它们自己的外观之上。 |
| `popupEndingClass`、`popupEndingStyle` | `popup_ending_class`、`popup_ending_style` | `string`、`StyleProp<ViewStyle>` | 无 | 桌面：弹出层关闭后的外观，过渡播放期间保留。 |
| `backdropClass`、`backdropStyle` | `backdrop_class`、`backdrop_style` | `string`、`StyleProp<ViewStyle>` | 无 | 手机：sheet 后面的背景层。 |
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 按下时打开它的元素。菜单打开时，它的 `aria-expanded:` 类和 `expandedStyle` 生效。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 条目，每次打开时创建。 |

### ContextMenu

`open`、`popupClass` / `popupStyle`、起始与结束外观、`backdropClass` / `backdropStyle`、`trigger` 和 `children` 与 `Menu` 相同，另外还有：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 辅助按键和按住的手指都不起作用。 |
| `offset` | `.offset(..)` | `number` | `0` | 桌面：指针与弹出层之间的间距。 |
| `margin` | `.margin(..)` | `number` | `0` | 桌面：它与安全区边缘保持的距离。 |

### MenuItem

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不可选择；`disabled:` 样式生效。 |
| `checked` | `.checked(..)` | `boolean` | 无 | 是否勾选，设置后它就是可勾选的条目；值由应用持有。 |
| `checkedStyle` | `.checked_style(..)` | `StyleProp<ViewStyle>` | 无 | 勾选时的样式，与 `checked:` 类相同。 |
| `role` | `.role(..)` | `AccessibilityRole` | 有 `checked` 时为 `"menuitemcheckbox"`，否则为 `"menuitem"` | 它对屏幕阅读器而言是什么；一组选项中的一个用 `"menuitemradio"`。 |
| `indicatorClass`、`indicatorStyle` | `.indicator_class(..)`、`.indicator_style(..)` | `string`、`StyleProp<ViewStyle>` | 无 | 指示部件，位于内容之前；它的 `checked:` 和 `disabled:` 类跟随条目。 |
| `indicator` | `.indicator(..)` | `JSX.Element` | 无 | 指示部件里的标记。 |
| `closeOnSelect` | `.close_on_select(..)` | `boolean` | `true` | 选择它会关闭菜单。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 内容不足以说明时，屏幕阅读器读出的文字。 |
| `children`、`class`、`style` | `.child(..)`、样式方法 | | 无 | 它的内容和外观，支持 `hover:`、`active:` 和 `checked:` 状态。 |

### Submenu

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 打开它的条目。 |
| `back` | `.back(..)` | `JSX.Element` | 无 | 手机：它的条目上方返回上一级条目的那一行。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 它不会打开。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 它的条目。 |

`MenuSeparator` 是一个由你设置样式（`class`、`style`）的视图，与所在层级的条目一起显示。

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onOpenChange`（`Menu`、`ContextMenu`） | `.on_open_change(\|e\| ..)` | 它打开或关闭了，附带原因。 |
| `onOpen`（`Menu`、`ContextMenu`） | `.on_open(\|\| ..)` | 它已显示；以 sheet 呈现时，在它进入之后。 |
| `onClose`（`Menu`、`ContextMenu`） | `.on_close(\|\| ..)` | 它已消失：以 sheet 呈现时在它离开之后，以弹出层呈现时在离开过渡之后。应用关闭它时也会触发。 |
| `onPosition`（`Menu`、`ContextMenu`） | `.on_position(\|e\| ..)` | 桌面：弹出层已放置：`placement`（它所在的一侧）、`bounds`、`available`。 |
| `onCancel`（`Menu`、`ContextMenu`） | `.on_cancel(\|\| ..)` | 用户没有选择条目就尝试关闭它（Escape 或返回键、外部按压或按下背景层）。 |
| `onSelect`（`MenuItem`） | `.on_select(\|\| ..)` | 条目被选择；可勾选的条目请求它的另一个值。 |

<a id="accessibility"></a>

## 无障碍

对屏幕阅读器而言，弹出层或 sheet 是一个菜单，其中的条目是菜单项；触发元素会告诉屏幕阅读器菜单是否已展开。可勾选的条目是复选或单选菜单项，读作已勾选或未勾选；它的标记是条目的一部分。在 TSX 中，触发元素就是你传入的元素：按压和展开状态都在它自己身上，所以它自己的 `active:` 类和 `activeStyle` 会在按下时生效，它自己的 `onPress` 也照常运行。屏幕上只有当前显示层级的条目，所以屏幕阅读器读到的就是显示出来的内容。
