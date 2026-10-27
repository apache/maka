---
title: Menu
description: Menu 和 ContextMenu，配合 MenuItem、MenuSeparator 和 Submenu：桌面上是带级联子菜单的弹出层，手机上是就地展开子菜单的 sheet，样式由应用决定。
order: 27
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

<a id="open-state"></a>

## 打开状态

没有 `open` 时，菜单自己保存状态（`Menu` 的初始值为 `defaultOpen`）。有 `open` 时，状态由应用持有，并在 `onOpenChange(open, reason)` 中修改它，原因为 `"triggerPress"`、`"select"`、`"pressOutside"`、`"backdropPress"`、`"cancel"`、`"contextMenu"` 或 `"longPress"`。

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
| `backdropClass`、`backdropStyle` | `backdrop_class`、`backdrop_style` | `string`、`StyleProp<ViewStyle>` | 无 | 手机：sheet 后面的背景层。 |
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 按下时打开它的元素。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 条目，每次打开时创建。 |

### ContextMenu

`open`、`popupClass` / `popupStyle`、`backdropClass` / `backdropStyle`、`trigger` 和 `children` 与 `Menu` 相同，另外还有：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 辅助按键和按住的手指都不起作用。 |
| `offset` | `.offset(..)` | `number` | `0` | 桌面：指针与弹出层之间的间距。 |
| `margin` | `.margin(..)` | `number` | `0` | 桌面：它与安全区边缘保持的距离。 |

### MenuItem

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不可选择；`disabled:` 样式生效。 |
| `closeOnSelect` | `.close_on_select(..)` | `boolean` | `true` | 选择它会关闭菜单。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 内容不足以说明时，屏幕阅读器读出的文字。 |
| `children`、`class`、`style` | `.child(..)`、样式方法 | | 无 | 它的内容和外观，支持 `hover:` 和 `active:` 状态。 |

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
| `onClose`（`Menu`、`ContextMenu`） | `.on_close(\|\| ..)` | 它已消失；以 sheet 呈现时，在它离开之后。应用关闭它时也会触发。 |
| `onCancel`（`Menu`、`ContextMenu`） | `.on_cancel(\|\| ..)` | 用户没有选择条目就尝试关闭它（Escape 或返回键、外部按压或按下背景层）。 |
| `onSelect`（`MenuItem`） | `.on_select(\|\| ..)` | 条目被选择。 |

<a id="accessibility"></a>

## 无障碍

对屏幕阅读器而言，弹出层或 sheet 是一个菜单，其中的条目是菜单项；触发元素会告诉屏幕阅读器菜单是否已展开。在 TSX 中，触发元素就是你传入的元素：按压和展开状态都在它自己身上，所以它自己的 `active:` 类和 `activeStyle` 会在按下时生效，它自己的 `onPress` 也照常运行。屏幕上只有当前显示层级的条目，所以屏幕阅读器读到的就是显示出来的内容。
