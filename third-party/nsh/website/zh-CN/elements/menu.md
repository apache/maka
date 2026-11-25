---
title: Menu
description: Menu 和 ContextMenu，配合 MenuItem、MenuSeparator 和 Submenu：桌面和常规宽度的 iPad 上是带级联子菜单的弹出层，手机上是就地展开子菜单的 sheet，样式由应用决定；ContextMenu 的 items 在 iOS 和 Android 上显示系统的上下文菜单。
group: base
demo: el-menu
---

# Menu

菜单是由触发元素打开的一组操作。同一个结构适用于每种设备，并按各自的习惯呈现：

- 在桌面平台、桌面浏览器和窗口宽度为常规（regular）的 iPad 上，它是触发元素处的弹出层；指针移到 `Submenu` 的条目上或按下它时，子菜单在条目旁级联展开，它的第一个条目与该条目齐平（在你的 `popupClass` 的内边距和边框之内）。
- 在手机、其他平板和窗口宽度紧凑（compact）的 iPad 上（侧拉、较窄的分屏或台前调度窗口），它是屏幕底部、覆盖在背景层之上的 sheet；`Submenu` 在 sheet 中就地显示它的条目，取代菜单的条目，并由你提供的一行返回上一级。

iPad 跟随 UIKit 的水平尺寸类别，与系统自己的菜单一致：窗口大小跨过它时，菜单换成另一种呈现方式。

选择一个条目、外部按压、Escape、Android 返回键和 VoiceOver 的退出手势都会关闭它。`ContextMenu` 是同样的菜单，由辅助按键（右键单击）在指针处打开，在触摸屏上由手指按住触发元素打开，或在触发元素下方由浏览器和 Linux 上的键盘、macOS 和 Windows 上的读屏软件打开。

在获得焦点的触发元素上按 Return、Space 或 Down 键打开菜单时，键盘焦点落在第一个可用的条目上；按 Up 键打开时落在最后一个上，之后用方向键在条目间移动。按压打开时不聚焦任何条目；在弹出层中，之后按 Down 或 Home 键聚焦第一个可用的条目，按 Up 或 End 键聚焦最后一个，菜单外的输入框仍在编辑时也一样（比如触发元素旁的搜索框）；菜单里的输入框保留自己的方向键。Page Down 移到视图里最后一个可用的条目，Page Up 移到第一个，每次翻一屏，到头停住（`MenuList` 也一样，见[长列表](#长列表)）。在弹出层中，指针移到某个条目上时它获得键盘焦点，按键从指针下的条目接着走；给条目的 `focus:` 状态设和 `hover:` 一样的样式。在弹出层中按一个字母或数字，焦点跳到下一个文字（或 `accessibilityLabel`）以它开头的可用条目，与 `Select` 的列表一样：连按同一个字母在这些条目之间轮转，短时间内连续打几个字母按前缀匹配。它们只作用于焦点所在的那一级菜单或子菜单；菜单里的输入框照常接收字母；跳到视图外的条目会把它滚进来。
在弹出层和终端中，在 `Submenu` 的条目上按 Right、Return 或 Space 键打开它，键盘焦点落在它第一个可用的条目上；在它的条目上按 Left 键或按 Escape 键关闭它，焦点回到它的条目上。指针打开的子菜单，在方向键把焦点移到所在菜单的另一个条目时关闭。

```tsx tabs
import { Text, View } from "nsh";
import { Menu, MenuItem, MenuSeparator, Submenu } from "nsh/base";

function Item(props: { label: string; onSelect: () => void }) {
  return (
    <MenuItem onSelect={props.onSelect} class="rounded-md px-3 py-2 hover:bg-gray-100 focus:bg-gray-100 active:bg-gray-200">
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

菜单中某一行下面的一组项（分享、语言、外观）用 `Submenu`，不要做成点一下箭头向下转、把下级项在原位展开的行：没有哪个平台的菜单这样做，这些行也会失去子菜单的按键和角色。需要一直可见的少量选项改用分组：一个不可选的标题，下面是可勾选的项，不缩进，前后用分隔线隔开（见[可勾选的条目](#checkable-items)）。

这五个组件都来自 [`nsh/base`](../modules/nsh-base.md)。条目会自己找到所属的菜单，所以你可以自由地编排它们：放在视图里分组、加标签、用 `If` 让条目出现和消失。`popupClass` 设置菜单所呈现的弹出层或 sheet 的样式。两者需要不同样式时，沿用同一条规则，并在样式 getter 或绑定中读取，这样 iPad 的窗口大小变化时它也随之改变：

```tsx
import { horizontalSizeClass, platform } from "nsh";

// 菜单在这里是弹出层，其他情况下是 sheet。
const popup = () =>
  platform.desktop ||
  (platform.os === "ios" && platform.idiom === "pad" && !platform.catalyst && horizontalSizeClass() === "regular");
```

弹出层不会高过它打开那一侧的可用空间，子菜单的弹出层也不会高过它自己的可用空间：短窗口里的长菜单会在能完整放下的一侧打开（都放不下时在空间更大的一侧），条目在弹出层里滚动，不会越界回弹或显示滚动条。按键会把移到的条目滚进视野；子菜单的条目被滚出视野后，子菜单随之关闭。sheet 同样停在状态栏下方。用 `popupClass` 在条目外面画出面板（背景、边框、阴影），这样条目滚动时面板保持不动。

<a id="context-menus"></a>

## 菜单栏

同一个 `Toolbar` 里的多个 `Menu` 组成菜单栏：其中一个菜单打开时，指针移到另一个菜单的触发器上就会改为打开那个菜单，方向键在各触发器之间移动。

```tsx
<Toolbar accessibilityLabel="Menu bar">
  <Menu trigger={<View><Text>File</Text></View>}>{/* … */}</Menu>
  <Menu trigger={<View><Text>Edit</Text></View>}>{/* … */}</Menu>
</Toolbar>
```

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

在桌面平台上，辅助按键在指针所在处打开它。在触摸屏上，手指按住触发元素会打开它：在窗口宽度为常规的 iPad 上是手指处的弹出层，其他情况下是 sheet；触发元素自己的按压和周围的滚动视图照常工作，移动手指会取消这次按住。

键盘和读屏用户同样可以打开它。在浏览器和 Linux 上，触发元素获得焦点时按 Shift+F10 或菜单键即可打开。在 macOS 上，VoiceOver 的「显示菜单」操作（VO-Shift-M）可以打开它；在 Windows 上，读屏软件通过 UI Automation 的「显示上下文菜单」操作也可以打开它。这样打开时，菜单出现在触发元素下方、从它的起始边开始，键盘焦点落在第一个可用的条目上，与 WAI-ARIA 对上下文菜单的描述一致。给触发元素设置 `focusable`，键盘才能到达它。视图自己的 `onContextMenu` 可以通过 `pointerType` 区分这类打开方式：此时它为 `null`。

由你控制 `open` 并自己把它设为 `true` 时（比如你自己的快捷键，或者获得焦点的列表要打开其中某一行的菜单），菜单也这样打开：出现在触发元素下方，键盘焦点落在第一个可用的条目上，关闭后焦点回到触发元素。在 macOS 和 iOS 上，由指针打开的菜单则把焦点还回打开之前的位置：那里的按压不会把焦点交给触发元素，应用的快捷键仍能收到按键。

<a id="checkable-items"></a>

## 可勾选的条目

`checked` 让条目可以勾选：菜单显示的一项设置（「显示侧边栏」），或者在 `role="menuitemradio"` 时，一组选项中的一个（「排序方式」）。值由你持有：选择条目会调用 `onSelect`，你设置下一个值，条目就显示它。勾选时，它的 `checked:` 类和 `checkedStyle` 生效，它的指示部件（位于内容之前，`indicatorClass`、`indicatorStyle`）也一样，部件里是你给它的标记（`indicator`）。标记只创建一次并保留下来，由指示部件的 `checked:` 类显示和隐藏它；也可以在 `indicatorClass` 中加 `group`，用标记自己的 `group-checked:` 类。`closeOnSelect={false}` 让菜单保持打开，这样设置会立刻显示新的值。

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
        class="flex-row gap-2 rounded-md px-3 py-2 hover:bg-gray-100 focus:bg-gray-100"
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
            class="flex-row gap-2 rounded-md px-3 py-2 hover:bg-gray-100 focus:bg-gray-100 checked:font-semibold"
          >
            <Text>{by()}</Text>
          </MenuItem>
        )}
      </Each>
    </Menu>
  );
}
```

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

放在末端的标记则写在内容里，在条目上加 `group`，用 `group-checked:` 类设置它的样式。

<a id="entrance-and-exit"></a>

## 出现与离开

弹出层像 [Popover](./popover.md#entrance-and-exit) 一样随你的过渡出现和离开：`popupStartingClass` 是它第一帧的外观，`popupEndingClass` 是关闭后的外观，在 `popupClass` 的 `transition-*` 类播放期间它会保留，随后触发 `onClose`。离开途中它不接受按压和按键：关闭时键盘焦点就回到触发元素，所以离开途中按 Return 不会选中条目，而是再次打开菜单。条目的 `onSelect` 把焦点移到别处（比如开始编辑的输入框）时，焦点留在那里：菜单只在焦点没被别处拿走时才把它交还触发元素。子菜单使用同样的外观，并随菜单一起关闭。sheet 自带滑入和滑出的动作。

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

`Submenu` 在应用没有设置它的 `open` 时自己保存状态，并在 `onOpenChange({ open, reason })` 中报告用户引起的每次打开和关闭：`"hover"`（指针移到它的条目上，或移到所在菜单的另一个条目上）、`"focus"`（键盘焦点移到所在菜单的另一个条目上）、`"triggerPress"`（按下它的条目，或在条目上按右方向键、Return 或空格）、`"cancel"`（左方向键、Escape、返回键或它的 `back` 行），整个菜单关闭时则是菜单的原因（`"select"`、`"pressOutside"` 等）。它的条目在打开时才创建，因此应用可以在第一次打开时才开始加载条目，加载到后再显示。应用自己关闭菜单时不会报告。

```tsx
const recent = signal<string[] | null>(null);

<Submenu
  trigger={<Text>Open Recent</Text>}
  onOpenChange={({ open }) => {
    if (open && recent() === null) loadRecent().then((names) => recent.set(names));
  }}
>
  <Each of={recent() ?? []}>
    {(name) => <MenuItem onSelect={() => openFile(name())}><Text>{name()}</Text></MenuItem>}
  </Each>
</Submenu>
```

设置了 `open` 的 `Submenu` 和 `Menu` 一样是受控的：`onOpenChange` 提出请求，显示的是应用设置的值。应用按数据重新建出的条目（菜单打开时会变化的列表）也会重新建出其中的子菜单；受控的子菜单按应用的值重新打开，键盘焦点回到原来所在的条目，用户停在原处。

```tsx
const modelsOpen = signal(false);

<Submenu
  open={modelsOpen()}
  onOpenChange={({ open }) => modelsOpen.set(open)}
  trigger={<Text>Model</Text>}
>
  <Each of={models()}>{(m) => <MenuItem onSelect={() => pick(m())}><Text>{m().name}</Text></MenuItem>}</Each>
</Submenu>
```

## 长列表

条目很多、或条数由数据决定（模型、账号、最近的文件）的菜单，把它们放进 `MenuList`（Rust）：一个虚拟化列表，只建出视口附近的行。它的行是菜单的条目，与前后的条目排在一起：Up、Down、Home 和 End 在列表的每一行之间移动，先滚到某一行再聚焦它，并跳过禁用的行，然后接着走到列表前后的条目，包括 `Submenu` 的条目。Page Down 和 Page Up 每次让列表滚动一屏。字母只能跳到列表已建出的行，也就是视口附近的那些。`render_item` 按行号画出每一行，每行一个 `MenuItem` 或 `Submenu`；请给列表设一个高度。

```rust
use nsh_base::{MenuListEntry, menu, menu_item, menu_list, submenu};
use nsh_core::prelude::*;

let models = signal(vec![/* … */]);
menu()
    .trigger(text("Model"))
    .child(
        menu_list()
            .count(move || models.with(|m: &Vec<Model>| m.len() as u32))
            .render_item(move |e: &MenuListEntry| {
                let index = e.index as usize;
                menu_item()
                    .on_select(move || choose(index))
                    .child(text(move || models.with(|m| m[index].name.clone())))
            })
            .h(px(240.0)),
    )
    .child(submenu().trigger(text("Reasoning")).child(/* … */))
```

<a id="props"></a>

## 系统菜单：MenuButton

`Menu` 在每种设备上以应用自己的外观绘制菜单。应用若需要系统自己的菜单（iOS 的下拉菜单，有系统的位置、动效，在 iOS 26 上是 Liquid Glass；Android 的弹出菜单），用 `MenuButton` 从应用绘制的触发器上打开它：

```tsx
import { MenuButton } from "nsh/base";

<MenuButton
  accessibilityLabel="账户"
  title={email()}
  items={[
    { id: "settings", label: "设置", icon: "gearshape" },
    { id: "read", label: "全部已读", disabled: !unread() },
    { id: "", label: "语言", items: languages.map((l) => ({ id: l.id, label: l.label, checked: l.id === lang() })) },
    { id: "", label: "外观", inline: true, singleSelection: true, items: [
      { id: "light", label: "浅色", checked: !dark() },
      { id: "dark", label: "深色", checked: dark() },
    ] },
  ]}
  onSelect={({ id }) => choose(id)}
  style={{ flexDirection: "row", alignItems: "center", gap: 8 }}
>
  <Avatar … />
  <Text>{account()}</Text>
</MenuButton>;
```

条目是数据，每个都有应用自己的 `id`，由 `onSelect({ id })` 报告；勾选、`disabled` 和 `destructive`（在 iOS 上为红色，在 Android 上为主题的错误色）是条目的状态，由应用改变；带 `items` 的条目是子菜单，再加 `inline` 则是以 `label` 为标题、就地显示的分组。子菜单或分组加上 `singleSelection` 后，它自己的操作是一组单选（排序方式、外观），由应用勾选其中一项：iOS 显示为单选菜单，Android 显示为单选按钮，桌面显示为勾选标记；不加时各个勾选互相独立。这组单选只含该菜单自己的操作，其中的分组或子菜单各自设定。整个菜单的条目都是一组单选时，把它们放进一个不带标题、带 `singleSelection` 的 `inline` 分组（`{ id: "", label: "", inline: true, singleSelection: true, items }`）。子元素、`class` 和 `style` 构成触发器，在所有平台上都由应用绘制。

- **iOS 和 Mac Catalyst**：触发器上覆盖一个透明的 `UIButton`，它的 `UIMenu` 是主操作：点按、VoiceOver 激活或硬件键盘都会立即打开菜单，不等待 JS。`icon` 是 SF Symbol；`title` 显示在菜单顶部。菜单从触发器处长出，展开期间触发器隐藏、收起时恢复，与系统按钮一致。VoiceOver 访问的是这个按钮（名称来自 `accessibilityLabel`），而不是它下面的触发器内容。新的 `items` 在下次打开时生效。
- **桌面（macOS、Windows、Linux）**：按下时在指针处以平台的上下文菜单显示这些条目（同 `nsh/desktop` 的 `Menu.popup`），分组之间用分隔线；不显示 `icon`、`title` 和 `destructive`。
- **Android**：触发器上覆盖一个透明按钮，点按立即在触发器下方打开系统的弹出菜单；触发器在窗口靠末端的一半时，菜单与触发器末端对齐。`title` 是菜单的第一行，不能选择（TalkBack 读作已停用的条目）；`svg` 是一份 SVG 文档，作为条目的图标，在 Android 10 及以上按条目文字的颜色绘制（`icon` 是 iOS 用的）。勾选、单选按钮、子菜单和分组由系统绘制。点按菜单外面时，手指抬起才关闭菜单；返回键和返回手势都只关闭菜单，下面的对话框仍然打开。
- **Web**：视图没有系统菜单；触发器照常显示，按下不打开任何内容。在 Web 上按 `platform.os` 改用 `Menu`。

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `items` | `.items(..)` | `MenuButtonItem[]` | `[]` | 菜单的条目，按顺序。 |
| `title` | `.title(..)` | `string` | 无 | iOS 和 Android：菜单的标题，显示在条目上方。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不能按下，不打开任何内容。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 读屏软件为这个按钮朗读的内容。 |
| `accessibilityHint` | `.accessibility_hint(..)` | `string` | 无 | 向屏幕阅读器说明打开菜单后可以做什么，与视图的 `accessibilityHint` 相同。 |
| `class`、`style`、`children` | 样式方法、`.child(..)` | | 无 | 应用绘制的触发器。 |

`accessibilityHint` 跟随响应式值变化；设为 `undefined` 会移除提示。在 iOS 和 Android 上，提示传给屏幕阅读器激活的原生按钮。

`MenuButtonItem` 为 `{ id, label, icon?, svg?, checked?, disabled?, destructive?, items?, inline?, singleSelection? }`（Rust：`MenuButtonItem::new(id, label)`、`::submenu(label, items)`、`::section(label, items)`，再加 `.icon(..)`、`.svg(..)`、`.checked(..)`、`.disabled(..)`、`.destructive(..)`、`.single_selection(..)`）。唯一的事件是 `onSelect({ id })`（Rust：`.on_select(|id: &SharedString| ..)`），在菜单关闭后触发。

## iOS 和 Android 上的系统上下文菜单

在 iOS 上，手指按住一条消息、一张照片或一行列表，通常会出现系统的上下文菜单：视图在模糊的屏幕上抬起，带着系统的触感和动效，菜单显示在它旁边。在 Android 上，会在视图旁出现系统的弹出菜单。给 `ContextMenu` 传入与 `MenuButton` 相同的条目，iOS 和 Android 就显示这个菜单，而 children 仍是其他平台上的菜单：

```tsx
import { ContextMenu, MenuItem } from "nsh/base";

<ContextMenu
  title={photo.name}
  items={[
    { id: "share", label: "Share", icon: "square.and.arrow.up" },
    { id: "favorite", label: "Favorite", icon: "heart", checked: photo.favorite },
    { id: "", label: "", inline: true, items: [{ id: "delete", label: "Delete", icon: "trash", destructive: true }] },
  ]}
  onSelect={({ id }) => act(photo, id)}
  popupClass="min-w-40 rounded-lg bg-white p-1 shadow-lg"
  trigger={<PhotoTile photo={photo} />}
>
  <MenuItem onSelect={() => act(photo, "share")}><Text>Share</Text></MenuItem>
  <MenuItem onSelect={() => act(photo, "delete")}><Text>Delete</Text></MenuItem>
</ContextMenu>
```

- **iOS 和 Mac Catalyst**：由 `UIContextMenuInteraction` 原生响应按住的手指，以及 iPad 指针或 Mac 上的辅助点按。系统抬起的预览就是触发器本身，按它自己的圆角裁剪；菜单由 `items` 生成（`MenuButtonItem`，图标是 SF Symbol，`title` 在条目上方）。`onOpenChange`、`onOpen`、`onSelect({ id })`、`onCancel` 和 `onClose` 报告发生了什么，与绘制的菜单一致。这个菜单只由用户打开：把 `open` 设为 `true` 不显示任何内容，设为 `false` 会关闭它。
- **Android**：按住的手指打开系统的弹出菜单，带系统的长按触感，位于触发器下方、与其末端对齐（触发器底边不在屏幕上时，位于按住的位置下方）。`title` 是第一行，`svg` 是条目的图标，与 `MenuButton` 相同；不使用 `preview`。它报告同样的事件；与 iOS 不同，应用可以打开它：把 `open` 设为 `true` 会在触发器下方显示它。
- **桌面和 Web**：不使用 `items`、`title` 和 `onSelect`。children 就是菜单，与不传 `items` 时一样绘制，由各个 `MenuItem` 的 `onSelect` 报告选择。

触发器自己的按压在按住手指的同时照常工作。不传 `items` 时，iOS 和 Android 与其他平台一样显示绘制的菜单。

### 用预览代替触发器

系统按触发器原样抬起它。要抬起别的内容（一张显示会话最近几条消息或文档开头的卡片），给 `preview` 一个视图；按下它会关闭菜单并报告 `onPreviewPress`，应用通常在这里打开这一行代表的内容：

```tsx
<ContextMenu
  items={actions}
  onSelect={({ id }) => act(chat, id)}
  preview={<ChatCard chat={chat} />}
  onPreviewPress={() => openChat(chat)}
  trigger={<ChatRow chat={chat} />}
/>
```

预览在手指按到触发器上时创建，按它自己的尺寸在看不见的地方排版，菜单弹出时以那一刻的样子作为图片显示；菜单关闭后移除。它创建时开始加载的数据可以在手指按住期间到达。排版完成之前，系统抬起触发器。与 `items` 一样，`preview` 只在 iOS 上使用。

## 属性

### Menu

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `open` | `.open(..)` | `boolean` | 无 | 是否打开，由应用控制。 |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | 没有 `open` 时，初始是否打开。 |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"bottom"` | 以弹出层呈现时：它位于触发元素的哪一侧。 |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"start"` | 以弹出层呈现时：它如何与触发元素对齐。 |
| `offset` | `.offset(..)` | `number` | `0` | 以弹出层呈现时：触发元素与弹出层之间的间距。 |
| `margin` | `.margin(..)` | `number` | `0` | 以弹出层呈现时：它与安全区边缘保持的距离。 |
| `popupClass`、`popupStyle` | `popup_class`、`popup_style` | `string`、`StyleProp<ViewStyle>` | 无 | 弹出层或 sheet，以及子菜单的弹出层。 |
| `popupStartingClass`、`popupStartingStyle` | `popup_starting_class`、`popup_starting_style` | `string`、`StyleProp<ViewStyle>` | 无 | 以弹出层呈现时：弹出层第一帧的外观，叠加在它们自己的外观之上。 |
| `popupEndingClass`、`popupEndingStyle` | `popup_ending_class`、`popup_ending_style` | `string`、`StyleProp<ViewStyle>` | 无 | 以弹出层呈现时：弹出层关闭后的外观，过渡播放期间保留。 |
| `backdropClass`、`backdropStyle` | `backdrop_class`、`backdrop_style` | `string`、`StyleProp<ViewStyle>` | 无 | 以 sheet 呈现时：它后面的背景层。 |
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 按下时打开它的元素。菜单打开时，它的 `aria-expanded:` 类和 `expandedStyle` 生效。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 条目，每次打开时创建。 |

### ContextMenu

`open`、`popupClass` / `popupStyle`、起始与结束外观、`backdropClass` / `backdropStyle`、`trigger` 和 `children` 与 `Menu` 相同，另外还有：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | 什么都打不开它：辅助按键、按住的手指、键盘和读屏软件都不起作用。 |
| `offset` | `.offset(..)` | `number` | `0` | 以弹出层呈现时：指针与弹出层之间的间距。 |
| `margin` | `.margin(..)` | `number` | `0` | 以弹出层呈现时：它与安全区边缘保持的距离。 |
| `items` | `.items(..)` | `MenuButtonItem[]` | `[]` | iOS 和 Android：系统的上下文菜单，代替 children。其他平台不使用它，绘制 children。 |
| `title` | `.title(..)` | `string` | 无 | iOS 和 Android：系统菜单的标题，在条目上方。其他平台不使用它。 |
| `preview` | `.preview(..)` | `JSX.Element` | 无 | 仅 iOS，传入 `items` 时：系统在菜单旁代替触发器抬起的内容。手指按下时创建，菜单关闭后移除。 |

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
| `accessibilityDescription` | `.accessibility_description(..)` | `string` | 无 | 名称之外的说明，屏幕阅读器在名称之后读出：例如这个选项做什么。 |
| `children`、`class`、`style` | `.child(..)`、样式方法 | | 无 | 它的内容和外观，支持 `hover:`、`active:` 和 `checked:` 状态。 |

### Submenu

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `trigger` | `.trigger(..)` | `JSX.Element` | 无 | 打开它的条目。 |
| `open` | `.open(..)` | `boolean` | 无 | 是否打开，由应用持有（在 `onOpenChange` 中修改）；不设置时子菜单自己保存状态。 |
| `back` | `.back(..)` | `JSX.Element` | 无 | 以 sheet 呈现时：它的条目上方返回上一级条目的那一行。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 它不会打开。 |
| `offset` | `.offset(..)` | `number` | `0` | 以弹出层呈现时：它的弹出层与外层菜单之间的间距。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 它的条目。 |

### MenuList（Rust）

| Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `.count(..)` | `u32` | `0` | 行数。 |
| `.render_item(\|e: &MenuListEntry\| ..)` | `MenuListEntry { index }` | 无 | 按行号画出一行：一个 `MenuItem` 或 `Submenu`。 |
| 样式方法 | | 无 | 列表的外观；请给它一个高度（`.h(..)`）。 |

`MenuSeparator` 是一个由你设置样式（`class`、`style`）的视图，与所在层级的条目一起显示。

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onOpenChange`（`Menu`、`ContextMenu`） | `.on_open_change(\|e\| ..)` | 它打开或关闭了，附带原因。 |
| `onOpen`（`Menu`、`ContextMenu`） | `.on_open(\|\| ..)` | 它已显示；以 sheet 呈现时，在它进入之后。 |
| `onClose`（`Menu`、`ContextMenu`） | `.on_close(\|\| ..)` | 它已消失：以 sheet 呈现时在它离开之后，以弹出层呈现时在离开过渡之后。应用关闭它时也会触发。 |
| `onPosition`（`Menu`、`ContextMenu`） | `.on_position(\|e\| ..)` | 以弹出层呈现时：弹出层已放置：`placement`（它所在的一侧）、`bounds`、`available`。 |
| `onCancel`（`Menu`、`ContextMenu`） | `.on_cancel(\|\| ..)` | 用户没有选择条目就尝试关闭它（Escape 或返回键、外部按压或按下背景层）。 |
| `onSelect`（`ContextMenu`） | `.on_select(\|id: &SharedString\| ..)` | 仅 iOS，传入 `items` 时：用户在系统菜单中选择了这个 `id` 的条目。其他平台不触发它，由 `MenuItem` 报告选择。 |
| `onPreviewPress`（`ContextMenu`） | `.on_preview_press(\|\| ..)` | 仅 iOS，传入 `preview` 时：预览被按下；菜单像选择了条目一样关闭。 |
| `onSelect`（`MenuItem`） | `.on_select(\|\| ..)` | 条目被选择；可勾选的条目请求它的另一个值。 |
| `onOpenChange`（`Submenu`） | `.on_open_change(\|e\| ..)` | 它按用户的操作打开或关闭了，附带原因。 |

<a id="accessibility"></a>

## 无障碍

对屏幕阅读器而言，弹出层或 sheet 是一个菜单，其中的条目是菜单项；触发元素会告诉屏幕阅读器菜单是否已展开。可勾选的条目是复选或单选菜单项，读作已勾选或未勾选；它的标记是条目的一部分。条目的 `accessibilityDescription` 在名称之后读出，所以名称可以保持简短；子菜单的触发元素是你自己的元素，直接给它设置即可。在 TSX 中，触发元素就是你传入的元素（`Button` 或你自己的视图都可以）：按压和展开状态都在它自己身上，所以它自己的 `active:` 类和 `activeStyle` 会在按下时生效，它自己的 `onPress` 也照常运行。屏幕上只有当前显示层级的条目，所以屏幕阅读器读到的就是显示出来的内容。
