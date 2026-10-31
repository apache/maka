---
title: nsh/base
description: 应用界面的无样式基础组件：按钮、链接、复选框、单选框、开关、标签页、开关按钮、工具栏、选择框、组合框、日历、日期选择器、时间输入框、可调整大小的面板、可停靠的工作区、Markdown 与 HTML 文档、代码编辑器、diff、文本输入框、导航栈与对话框、系统警告对话框，以及页面和对话框的状态栏。
order: 2.5
demo: ui-navigation
---

# nsh/base

`nsh/base` 是应用界面的基础组件层：不带样式、负责行为、状态、焦点和无障碍的组件，各平台通用。它位于基础元素（`nsh`、`nsh/mobile` 和 `nsh/desktop`）与应用自己的组件库之间，就像 GPUI Kit 中 `gpui-base` 位于 `gpui` 与带样式的组件库之间（见[模块](./index.md#three-layers)）。它提供头像（`Avatar`、`AvatarGroup`）、控件（`Button`、`Link`、`Checkbox`、带 `ColorArea`、`ColorSlider`、`ColorField`、`ColorSwatch` 和 `ColorEyeDropper` 部件的 `ColorPicker`、`NumberInput`、放在 `RadioGroup` 里的 `Radio`、`Slider`、`Switch`、放在 `Tabs` 里的 `Tab`、放在 `ToggleGroup` 里的 `Toggle`、`Select`、`Combobox`、`Calendar`、`TimeField`、`DatePicker`）、控件栏（带 `ToolbarGroup` 和 `ToolbarSeparator` 的 `Toolbar`）、应用自己外观的滚动条（`Scrollbar`）、可展开和收起的区域（`Collapsible`，以及带 `AccordionItem`、`AccordionHeader`、`AccordionTrigger` 和 `AccordionPanel` 部件的 `Accordion`）、进度条（`Progress`）、一次性验证码（`OtpInput`）、一组内容的分页（`Pagination`）、构建图表的部件（`nsh/base/plot` 中的 `Plot` 及 `Line`、`Area`、`Bar`、`Grid`、`Pie`、`Arc`）、由用户自行安排的工作区（放在 `ResizablePanelGroup` 里的 `ResizablePanel`，以及 `DockArea` 的分栏、标签组和停靠区）、Markdown 或 HTML 文档（`TextView`）、代码编辑器（`Editor`）、文本之间的改动（`DiffView`）、表格（`Table` 及其部件、`DataTable`）、文本输入框（`Input`）、显示在一切之上的弹出层（`Popover`，`Menu` 和 `ContextMenu` 及其 `MenuItem`、`MenuSeparator` 和 `Submenu`，`Tooltip`，`Sheet`）、toast（放在 `ToastStack` 中的 `Toast`，生命周期由 `ToastManager` 管理）、导航（由 `createNavStack` 创建的状态驱动、由多个 `NavPage` 组成的 `NavStack`，以及在所有内容之上展示内容的 `Dialog`）和系统警告对话框（`AlertDialog`）。页面和对话框还决定状态栏（`statusBar`）。

外观由应用决定：页面、对话框或标题栏里的内容都是你自己的 JSX，用基础元素配合样式、[Tailwind](../docs/tailwind.md) 类和主题绘制；或者是[你自己的 crate](../docs/rust.md) 中的 Rust 组件；也可以是社区基于 `nsh/base` 构建的组件库。每个宿主都提供 `nsh/base`；Rust 应用通过 `nsh-base` crate 使用同一套 API（`nsh_base::{button, dialog, …}`）。

```rust tabs
use nsh_base::{
    MarkdownExtension, MarkdownOptions, accordion, accordion_header, accordion_item, accordion_panel, accordion_trigger,
    alert_dialog, button, checkbox, color_area, color_field, color_picker,
    color_slider, color_swatch, dialog, diff_view, dock_area, editor, link,
    calendar, combobox, date_picker, h_resizable, nav_page, nav_stack, radio, radio_group, resizable_panel, select, switch, tab, tabs, text_view, theme, time_field, toast, toast_stack, toggle, toggle_group, toolbar, toolbar_group, toolbar_separator, v_resizable,
};
```

```tsx tabs
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
  AlertDialog,
  Avatar,
  AvatarGroup,
  Button,
  Checkbox,
  Collapsible,
  ColorArea,
  ColorEyeDropper,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ContextMenu,
  createNavStack,
  DataTable,
  Dialog,
  DiffView,
  DockArea,
  Editor,
  Link,
  Menu,
  OtpInput,
  Pagination,
  Progress,
  MenuItem,
  MenuSeparator,
  NavPage,
  NavStack,
  Popover,
  Radio,
  RadioGroup,
  ResizablePanel,
  ResizablePanelGroup,
  Scrollbar,
  Select,
  Combobox,
  Calendar,
  TimeField,
  DatePicker,
  Sheet,
  NumberInput,
  Slider,
  Submenu,
  Switch,
  Tab,
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TextView,
  Toast,
  ToastManager,
  ToastStack,
  Toggle,
  ToggleGroup,
  Toolbar,
  ToolbarGroup,
  ToolbarSeparator,
  Tooltip,
} from "nsh/base";
import type {
  AccordionHeaderProps,
  AccordionItemProps,
  AccordionPanelProps,
  AccordionProps,
  AccordionTriggerProps,
  AlertDialogAction,
  AlertDialogOptions,
  AlertDialogPresentation,
  AlertDialogResult,
  AlertDialogRole,
  AvatarGroupProps,
  AvatarProps,
  AvatarStatus,
  ButtonProps,
  CheckboxProps,
  CollapsibleProps,
  ColorAreaProps,
  ColorChannel,
  ColorFieldProps,
  ColorFormat,
  ColorPickerProps,
  ColorSliderProps,
  ColorSpace,
  ColorSwatchProps,
  DialogChangeReason,
  DataTableColumn,
  DataTableProps,
  DataTableRef,
  DataTableSelection,
  DataTableSort,
  DialogProps,
  DiffAnnotation,
  DiffFile,
  DiffHunk,
  DiffLineRange,
  DiffSeparator,
  DiffStats,
  DiffViewProps,
  DiffViewRef,
  DockAreaLayout,
  DockNode,
  DockRegion,
  EditorDecoration,
  EditorDiagnostic,
  EditorProps,
  EditorRef,
  EditorReplaceAll,
  EditorSearch,
  EditorSearchResult,
  EditorSelection,
  Edges,
  HeaderStyle,
  LinkOpenWith,
  LinkProps,
  NavPageProps,
  NavStackProps,
  NavStackState,
  OtpInputProps,
  PaginationItemState,
  PaginationProps,
  ProgressProps,
  StatusBar,
  RadioGroupProps,
  RadioProps,
  SelectGroup,
  SelectItem,
  SelectItemState,
  SelectProps,
  ComboboxProps,
  CalendarProps,
  TimeFieldProps,
  DatePickerProps,
  NumberInputProps,
  ScrollbarEntrance,
  ScrollbarLook,
  ScrollbarMode,
  ScrollbarMotion,
  ScrollbarProps,
  ScrollbarTheme,
  SliderProps,
  SliderScale,
  SliderValue,
  StatusBarForeground,
  SwitchProps,
  TabProps,
  TabsProps,
  TextViewProps,
  TextViewDocument,
  MarkdownExtension,
  MarkdownOptions,
  ToastEntry,
  ToastMotion,
  ToastOptions,
  ToastProps,
  ToastStackProps,
  ToastTransitionStatus,
  ToggleGroupProps,
  ToggleProps,
  ToolbarProps,
} from "nsh/base";
```

本页是模块的索引：每个组件都有自己的元素页面，包含示例、属性和平台说明。完整的上手讲解见[导航指南](../docs/navigation.md)和[表单与键盘](../docs/forms-and-keyboard.md)。

| TSX | Rust | 是什么 |
|---|---|---|
| [`Button`](../elements/button.md) | `button()` | 带禁用和选中状态、面向屏幕阅读器有角色的按压目标。 |
| [`Link`](../elements/link.md) | `link()` | 指向某处的按压目标：由系统打开它的 `href`，或由应用打开（`openWith="app"`、`onOpen`）。 |
| [`Avatar`](../elements/avatar.md)、[`AvatarGroup`](../elements/avatar.md) | `avatar()`、`avatar_group()` | 一个人的头像，加载中、失败或没有图片时显示后备内容（首字母、应用的图标）；以及显示前 `limit` 个和溢出部分的一排头像。加载状态在原生侧处理。 |
| [`Checkbox`](../elements/checkbox.md) | `checkbox()` | 勾选 / 未勾选 / 半选控件，指示器及其中的标记由应用设置。 |
| [`Radio`](../elements/radio.md)、[`RadioGroup`](../elements/radio.md) | `radio()`、`radio_group()` | 一组只能选一个的选项中的一项，以及这一组；勾选哪一个由应用持有。 |
| [`Switch`](../elements/switch.md) | `switch()` | 开 / 关控件，轨道和滑块由应用设置样式。 |
| [`Tab`](../elements/tabs.md)、[`Tabs`](../elements/tabs.md) | `tab()`、`tabs()` | 标签列表中的一个标签页，以及这个列表；选中哪一个由应用持有，内容也由应用显示。 |
| [`Toggle`](../elements/toggle.md)、[`ToggleGroup`](../elements/toggle.md) | `toggle()`、`toggle_group()` | 一个处于开或关的按钮，以及由它们组成的工具栏；哪些按下由应用持有。 |
| [`Toolbar`](../elements/toolbar.md)、[`ToolbarGroup`](../elements/toolbar.md)、[`ToolbarSeparator`](../elements/toolbar.md) | `toolbar()`、`toolbar_group()`、`toolbar_separator()` | 由按钮、开关按钮和链接组成的一栏：在键盘焦点里只占一站，方向键沿着它移动；相关项目的分组，以及它们之间的分隔线。 |
| [`Select`](../elements/select.md) | `select()` | 从一组条目中选出一个值：桌面上是触发元素处的弹出层，手机上是 sheet；`value` 由应用持有，触发元素由应用绘制。 |
| [`Combobox`](../elements/combobox.md) | `combobox()` | 从可搜索的一组条目中选出一个或多个（`multiple`）值，列表与选择框的相同；`value` 由应用持有，触发元素由应用绘制。 |
| [`Calendar`](../elements/calendar.md) | `calendar()` | 从按周排列的月份中选出一个日期或一段日期，带月份和年份视图与键盘操作；`value` 由应用持有，条目由应用绘制。 |
| [`TimeField`](../elements/time-field.md) | `time_field()` | 逐段编辑一天中的时间（时、分、秒、上午/下午）；`value` 由应用持有。 |
| [`DatePicker`](../elements/date-picker.md) | `date_picker()` | 从日历中选出一个日期、一段日期或一个日期和时间：桌面上是触发元素处的弹出层，手机上是 sheet；`value` 由应用持有，触发元素由应用绘制。 |
| [`Collapsible`](../elements/collapsible.md) | `collapsible()` | 内容可展开和收起的区域；`open` 和触发它的控件由应用持有。 |
| [`Accordion`](../elements/accordion.md)、[`AccordionItem`](../elements/accordion.md)、[`AccordionHeader`](../elements/accordion.md)、[`AccordionTrigger`](../elements/accordion.md)、[`AccordionPanel`](../elements/accordion.md) | `accordion()`、`accordion_item()`、`accordion_header()`、`accordion_trigger()`、`accordion_panel()` | 在各自标题下展开和收起的一组分区，一次一个或同时多个（`multiple`）；`value`（展开项）由应用持有。 |
| [`OtpInput`](../elements/otp-input.md) | `otp_input()` | 显示在应用设置样式的格子里的一次性验证码；`value` 由应用持有，填满时 `onComplete` 通知应用。 |
| [`Pagination`](../elements/pagination.md) | `pagination()` | 一组内容的各页：上一页、当前页附近的页码与省略号、应用的子元素和下一页；`page` 由应用持有。 |
| [`Progress`](../elements/progress.md) | `progress()` | 进度条；`value`（0 到 100）和 `indeterminate` 由应用持有。 |
| [`NumberInput`](../elements/number-input.md) | `number_input()` | 在输入框里输入、或用按钮和按键步进的数字；`value` 由应用持有（或由输入框从 `defaultValue` 起自己保存）。 |
| [`Scrollbar`](../elements/scrollbar.md) | `scrollbar()` | 为它指明的滚动视图或列表（`scroll`）提供应用自己外观的滚动条；滑块跟随内容，拖动和按压会滚动内容。 |
| [`Slider`](../elements/slider.md) | `slider()` | 沿轨道选取一个值或两个值组成的范围；`value` 由应用持有（或由滑块从 `defaultValue` 起自己保存）。 |
| [`ColorPicker`、`ColorArea`、`ColorSlider`、`ColorField`、`ColorSwatch`、`ColorEyeDropper`](../elements/color-picker.md) | `color_picker()`、`color_area()`、`color_slider()`、`color_field()`、`color_swatch()`、`color_eye_dropper()` | 颜色选择器及其部件：饱和度与明度区域、RGB、HSL、HSB 或 OKLCH 任一通道及透明度的滑块、颜色或通道的输入框、色板、吸管；应用持有 `value`（或由选择器从 `defaultValue` 自己保存）。 |
| [`ResizablePanelGroup`、`ResizablePanel`](../elements/resizable.md) | `h_resizable()`、`v_resizable()`、`resizable_panel()` | 并排或上下排列的面板，用户拖动它们之间的手柄调整大小。 |
| [`DockArea`](../elements/dock.md) | `dock_area()` | 由分栏、标签组和边缘停靠区组成、用户自行安排的工作区；它的布局是应用的数据。 |
| [`NavStack`、`NavPage`、`createNavStack`](../elements/nav-stack.md) | `nav_stack()`、`nav_page()` | 原生导航栈及其页面。 |
| [`Dialog`](../elements/dialog.md) | `dialog()` | 在所有内容之上呈现的内容：sheet、全屏流程、对话框。 |
| [`AlertDialog`](../elements/alert-dialog.md) | `alert_dialog()` | 平台的警告框或操作表。 |
| [`TextView`](../elements/text-view.md) | `text_view()` | 用文字和视图绘制的 Markdown、HTML 或文档块组成的文档，适用于流式输出的 AI 回复。 |
| [`Editor`](../elements/editor.md) | `editor()` | 代码编辑器：语法高亮、多光标、折叠、查找与替换、诊断。 |
| [`DiffView`](../elements/diff-view.md) | `diff_view()` | 两段文本之间或一个补丁中的改动，并排或合并显示，带针对每处改动的操作。 |
| [`Table`、`TableHeader`、`TableBody`、`TableFooter`、`TableRow`、`TableHead`、`TableCell`、`TableCaption`](../elements/table.md) | `table()`、`table_row()` 等 | 由应用写出行和单元格的表格，为屏幕阅读器提供表格的角色。 |
| [`DataTable`](../elements/data-table.md) | `data_table()` | 行列数量不限的表格：选择、排序，列可固定、调整宽度和移动，行由应用分页提供。 |
| [`Input`](../elements/input.md) | `nsh_base::input()` | 平台原生的文本输入框，单行或多行。 |
| [`Popover`](../elements/popover.md) | `popover()` | 锚定在触发元素上、显示在一切之上的内容。 |
| [`Menu`、`ContextMenu`、`MenuItem`、`MenuSeparator`、`Submenu`](../elements/menu.md) | `menu()`、... | 菜单：桌面上是带级联子菜单的弹出层，手机上是 sheet；支持可勾选的条目和单选的一组选项。 |
| [`Tooltip`](../elements/tooltip.md) | `tooltip()` | 显示在触发元素旁的提示。 |
| [`Sheet`](../elements/sheet.md) | `sheet()` | 位于屏幕一侧边缘、覆盖在背景层之上的面板。 |
| [`Toast`、`ToastStack`、`ToastManager`](../elements/toast.md) | `toast()`、`toast_stack()`、`ToastManager` | 无样式的 toast：语义根、层叠的栈、它们的生命周期。 |
| 页面和对话框的 `statusBar` | `.status_bar(..)` | 页面或对话框显示期间的状态栏。见[状态栏](#status-bar)。 |

在 Rust 中，`theme()` 以设计 token 的形式读取应用的主题（`theme().primary`、`theme().radius`），与 TSX 的[主题类](../docs/tailwind.md#主题-token)使用同样的 token。

<a id="controls"></a>

## 控件

<a id="button"></a>

### Button

一个只负责行为、没有外观的按压目标：处理按压、禁用和选中状态，并向屏幕阅读器报告它的角色。它的外观是应用的 `class` 和 `style` 加上状态变体，内容是它的子元素。见 [Button](../elements/button.md)。

<a id="link"></a>

### Link

一个指向某处、没有外观的按压目标：处理按压、获得键盘焦点时的 Return 和 Space、禁用状态，并向屏幕阅读器报告链接角色和导航中的当前页（`current`）。`href` 是它指向的地方，不会显示出来：按压先报告它（`onOpen`），再在应用之外打开网页或其他应用的链接；设置 `openWith="app"` 时，由应用用自己的路由打开。见 [Link](../elements/link.md)。

<a id="checkbox"></a>

### Checkbox

一个只负责行为、没有外观的勾选 / 未勾选 / 半选控件：处理按压、键盘激活、禁用状态，并向屏幕阅读器报告复选框角色和它的值（半选时为部分选中）；值由应用持有（`checked`、`indeterminate`、`onChange`）。应用为复选框和它的指示器设置样式，指示器上的 `checked:`、`indeterminate:` 和 `disabled:` 类跟随复选框，应用自己的标记放在指示器里（`indicator`）。见 [Checkbox](../elements/checkbox.md)。

<a id="radio"></a>

### Radio 与 RadioGroup

一组只能恰好选一个的选项中的一项，以及包住它们的分组。单选框只负责行为、没有外观：处理按压、键盘激活、禁用状态，并向屏幕阅读器报告单选框角色和勾选状态。分组是屏幕阅读器播报的单选框组，本身不持有值：应用告诉每个单选框是否勾选（`checked`），按下未勾选的单选框时它请求被勾选（`onChange`）。应用的指示器和标签是单选框的子元素，它们的 `group-checked:` 类跟随单选框。见 [Radio](../elements/radio.md)。

<a id="switch"></a>

### Switch

一个只负责行为、没有外观的开 / 关控件：处理按压、键盘激活、禁用状态，并向屏幕阅读器报告开关角色和它的值；值由应用持有（`checked`、`onChange`）。应用为开关、它的轨道和滑块设置样式，轨道和滑块上的 `checked:` 和 `disabled:` 类跟随开关。见 [Switch](../elements/switch.md)。

<a id="tabs"></a>

### Tab 与 Tabs

标签列表中的标签页，以及包住它们的列表。标签页只负责行为、没有外观：处理按压、键盘激活、禁用状态，并向屏幕阅读器报告标签页角色和选中状态。列表是屏幕阅读器播报的标签列表，本身不持有值：应用告诉每个标签页是否选中（`selected`），接收按压（`onPress`），并自己显示选中部分的内容。应用的标签是标签页的子元素，它们的 `group-selected:` 类跟随标签页。列表的指示器（`indicatorClass`、`indicatorStyle`）是应用设置样式的下划线或胶囊，停在选中的标签页上，并以弹簧动画原生地移到下一个。见 [Tabs](../elements/tabs.md)。

<a id="toggle-and-togglegroup"></a>

### Toggle 与 ToggleGroup

一个处于开或关的按钮（加粗、收藏、一个视图选项），以及由它们组成的工具栏。开关按钮只负责行为、没有外观：处理按压、键盘激活、禁用状态，并向屏幕阅读器报告按钮角色和它的按下状态。这一组是屏幕阅读器播报的工具栏，在键盘焦点里只占一站，方向键在其中的开关按钮之间移动而不按下它们，本身不持有值：应用告诉每个开关按钮是否按下（`pressed`），接收它想要的值（`onChange`），并让任意多个或恰好一个保持按下。组上的 `disabled` 禁用其中每个开关按钮。应用的图标或标签是开关按钮的子元素，它们的 `group-aria-pressed:` 类跟随开关按钮。见 [Toggle](../elements/toggle.md)。

### Toolbar、ToolbarGroup 与 ToolbarSeparator

一栏控件：文本编辑器的格式栏、媒体播放器的播放控制、竖排的工具面板。工具栏是屏幕阅读器播报的那一个（名字来自 `accessibilityLabel`），在键盘焦点里只占一站，覆盖其中的 `Button`、`Toggle` 和 `Link`：Tab 从上次离开的项目进入，沿 `axis` 的方向键在其中移动，Home 和 End 跳到两端，都不会按下任何东西。`ToolbarGroup` 是一段有名字的相关项目（撤销与重做、对齐方式），放在工具栏里的 `ToggleGroup` 是它的一个分组，其中的开关按钮就是工具栏的项目。`ToolbarSeparator` 是应用在各段之间画的一条线。工具栏或分组上的 `disabled` 禁用其中每个项目。工具栏不持有值、没有外观：每个控件保留自己的状态，栏、分组和分隔线的样式由应用决定。见 [Toolbar](../elements/toolbar.md)。

### Select

从以数据形式给出的一组条目（`items`：每个条目有值和标题，可以禁用或归入分组）中选出一个值，本身没有外观。应用的触发元素打开列表：在桌面平台上是触发元素处的弹出层，在手机和平板上是屏幕底部的 sheet。选择框负责键盘（Up、Down、Home、End、Page Up 和 Page Down、输入跳转、Return 和 Escape）、搜索（`searchable`）、高亮的行（`itemClass` 上的 `focus:`，`renderItem` 中的 `highlighted`），以及屏幕阅读器读到的组合框、列表框和选项角色。值由应用持有（`value`、`onChange`），或交给选择框自己保存（`defaultValue`）；应用为每个部件设置样式，或者自己绘制行。见 [Select](../elements/select.md)。

### Combobox

从一组条目中选出值，列表与选择框的相同，本身没有外观：选一个，或者在 `multiple` 时选多个，这时一次选择会切换该条目，列表保持打开。值是一个数组，由应用持有（`value`、`onChange`），或交给组合框自己保存（`defaultValue`）；`onConfirm` 在列表关闭时告知它。搜索词可以由应用持有（`query`、`onQueryChange`），行下方可以显示底部区域，清除按钮会清空值。见 [Combobox](../elements/combobox.md)。

### Calendar

从按周排列的月份中选出一个日期，或在 `range` 时选出一段日期，本身没有外观。并排显示一个或几个月（`numberOfMonths`）；头部翻月，并能打开月份视图或一页年份。值是一个 ISO 日期（`"2026-10-28"`）或 `[start, end]`，由应用持有（`value`、`onChange`），或交给日历自己保存（`defaultValue`）；`disabledMatcher` 让某些日期不能被选中，所有日期作为 Tab 的一站接受键盘操作。应用为各部件设置样式并绘制条目（`renderItem`）。见 [Calendar](../elements/calendar.md)。

### TimeField

逐段编辑一天中的时间，本身没有外观：小时、分钟、秒（`precision`）和上午/下午（`hourCycle="h12"`），通过步进、输入或手机的数字键盘。值是 24 小时制的 `"HH:MM"`（`"HH:MM:SS"`），由应用持有（`value`、`onChange`），或交给输入框自己保存（`defaultValue`）。见 [TimeField](../elements/time-field.md)。

### DatePicker

从应用的触发元素打开的日历中选出日期，打开方式与选择框的列表相同：桌面上是弹出层，手机上是 sheet。值采用 HTML 输入框的格式，一个 ISO 日期、在 `range` 时为 `[start, end]`、在 `timePrecision` 时为日期和时间（日历下方有时间输入框），由应用持有（`value`、`onChange`），或交给选择器自己保存（`defaultValue`）。预设设置值，清除按钮清除值，`Calendar` 的每个属性都会传入。见 [DatePicker](../elements/date-picker.md)。

### Collapsible

内容可展开和收起的区域，没有外观：子元素始终显示（摘要、触发控件），`content` 在 `open` 时显示在它们之后。`open` 和切换它的触发控件由应用持有，应用也在触发控件上向屏幕阅读器报告展开状态。内容只创建一次，收起时保留，所以里面的状态不会丢。设置 `reveal` 后，它以原生运行的弹簧高度展开和收起。见 [Collapsible](../elements/collapsible.md)。

### Accordion

在各自标题下展开和收起的一组分区，没有外观：`Accordion` 包含多个 `AccordionItem`，每个分区由包住 `AccordionTrigger` 的 `AccordionHeader` 和一个 `AccordionPanel` 组成。`value`（展开项的值）由应用持有，按下触发器时应用设置 `onChange` 报告的值：一次一项，或设置 `multiple` 后同时多项。屏幕阅读器读到一组标题，其中的按钮报告分区是否已展开，展开的面板是一个区域。设置 `reveal` 后，面板以原生运行的弹簧高度展开和收起；设置 `keepMounted` 后，收起时内容仍留在树中。见 [Accordion](../elements/accordion.md)。

### Avatar

一个人的头像，没有外观：后备内容（`name` 的首字母，或应用的 `fallback`）和覆盖在它之上的图片（加载完成前保持透明），两者都与头像一样大，然后是应用的子元素（在线状态圆点）。图片自己的加载和错误事件在原生侧改变它的状态（`onStatusChange`），`fallbackDelay` 让后备内容在图片加载时晚一点出现。屏幕阅读器读到一张以名字为标签的图片。`AvatarGroup` 显示前 `limit` 个头像，其余的不创建视图，`total` 更多时显示 `overflow`。见 [Avatar](../elements/avatar.md)。

### Progress

线性进度条，没有外观：轨道里有一个指示条，指示条的宽度是轨道宽度的 `value` 百分比。`value`（0 到 100）和 `indeterminate`
由应用持有；屏幕阅读器得到进度条角色、范围和数值，不确定时没有数值，此时指示条的宽度和动效由应用决定。见
[Progress](../elements/progress.md)。

### NumberInput

在输入框里输入或步进的数字，没有外观：输入框（`Input`）、它前面的减少按钮和后面的增加按钮（或用 `controlsRight` 把两个按钮竖着放在右边）。`value`（一个数字或
`null`；也可以由输入框从 `defaultValue` 起自己保存）由应用持有，输入框读出的数字通过 `onChange` 报告。输入框只接受数字或正在输入成数字的文本，其他键盘的数字和符号
也算；按钮、Up / Down 和 Page Up / Page Down 按 `step` 步进并保留小数位，止于 `min` 和 `max`，离开输入框时输入的值会被限制在这个范围内。输入框对屏幕阅读器是
一个数值调节框（spin button），它的增加和减少操作会步进数值。见 [NumberInput](../elements/number-input.md)。

### Slider

沿轨道选取一个值或两个值组成的范围，没有外观：接收按压和拖动的轨道、轨道里映射数值的指示条，以及指示条上的范围和每个值一个的滑块。`value`（一个数字或
`[start, end]`；也可以由滑块从 `defaultValue` 起自己保存）由应用持有，每个新值触发 `onChange`（从 `min` 起按 `step` 对齐），每次修改结束触发一次
`onChangeEnd`；`scale` 让数值线性分布或按数量级分布，`axis` 决定轨道水平还是垂直。每个滑块对屏幕阅读器都是带自己数值的可调节元素，是键盘焦点的一站，
并按 WAI-ARIA 的滑块按键移动。见 [Slider](../elements/slider.md)。

### Scrollbar

为滚动视图或列表提供应用自己外观的滚动条，放在应用想放的位置，没有外观：轨道（滚动条的 `class`）和其中的滑块（`thumbClass`）。它指明自己的
滚动视图（`scroll`，即它的 `ref`），跟随其偏移、内容和视口；拖动滑块会滚动内容，按压轨道会让滑块中点移到那里。`mode` 让它在内容滚动时（直到
之后的 `motion.idle`）、指针在滚动条上时或始终显示；`axis` 让它变成横向。`Scrollbar.setTheme` 让每个滚动视图和列表在视口上显示应用外观的
滚动条，无需逐个放置；单个视图可以通过 `scrollbar` 属性使用自己的主题。见 [Scrollbar](../elements/scrollbar.md)。
### ColorPicker

不带外观的颜色选择器：根组件持有颜色，内部部件显示并修改它，布局由应用决定。`ColorArea` 是 HSB 的饱和度与明度，`ColorSlider` 调节 RGB、HSL、HSB 或 OKLCH 的任一通道或透明度（水平或垂直），`ColorField` 以任意 CSS 形式接受颜色或以数字接受一个通道，`ColorSwatch` 是按下即选中的预设颜色或当前颜色的预览，`ColorEyeDropper` 是在屏幕上取色的按钮（macOS、Web）。应用持有 `value`（或由选择器从 `defaultValue` 自己保存），`onChange` 和 `onChangeEnd` 报告颜色及按 `format` 写出的文本；颜色在每个空间中的通道值按用户设置保留。滑块和区域的拇指是屏幕阅读器的可调节元素，也是键盘焦点的一站。见 [ColorPicker](../elements/color-picker.md)。

### OtpInput

定长的数字一次性验证码，没有外观：一个原生文本框覆盖在格子之上接收键盘输入，因此打字、粘贴、数字键盘和系统的验证码自动填充
都是平台自己的，屏幕阅读器也只看到一个文本框。只有数字能输入，最多 `length` 位；退格键删除最后一位。`value` 由应用持有（或给
`defaultValue`），应用接收 `onChange` 和 `onComplete`，并为格子（接收下一位数字的格子带 `focus:`）、分组和光标设置样式。见
[OtpInput](../elements/otp-input.md)。

### Pagination

一组内容的各页之间的导航，是一个没有外观的导航地标：上一页、第一页和最后一页、当前页及其相邻页（`visiblePages`）、每段被省略的页
一个省略号、应用的子元素和下一页；`compact` 只保留上一页、子元素和下一页。`page` 由应用持有，应用接收 `onChange({ page })`；
当前页带 `selected:`，屏幕阅读器读作当前页。应用为各项设置样式（`itemClass`）或自己绘制（`renderItem`）。见
[Pagination](../elements/pagination.md)。

### Plot（`nsh/base/plot`）

构建图表的部件，对应 `gpui-base` 的 `plot`，位于单独的模块中：`import { Plot, Line, Area, Bar, Grid, Pie, Arc, Sankey } from "nsh/base/plot"`。`Plot` 持有应用的数据行（`data`，对行的类型是泛型的，所以 `x` 和 `y` 是经过检查的键名或行的函数）、坐标轴的 `point`、`linear` 或 `band` 比例尺、指针下的行（`onHoverChange`）以及动效（`motion`：出现动效、悬停的淡入淡出和滑动）；它的图形根据数据行原生绘制，不为每个点运行 JS，使用 SVG 绘制属性（`stroke-*`、`fill-*`）着色，没有设置时使用 `currentColor`；`Area` 和 `Bar` 可以在形状内显示背景（渐变，`bg-linear-*`）。柱子立在 `band` 比例尺的条带里，并排或用 `stack` 堆叠，随 plot 出现时长出，指针下那一行以外的柱子会变淡，每根柱子末端可以有 `label` 部件。悬停的十字线、圆点（每个图形可用 `hoverDotClass` 设置自己的圆点）和提示框（`tooltipPlacement`，留在 plot 内）是由应用设置样式和内容的部件，原生移动；坐标轴标签是应用自己的元素。`Pie` 按每一行把一整圈分成扇区（设置 `innerRadius` 即为环形图），每个扇区用自己的类着色（`sliceClass`，行的函数）；`Arc` 绘制两个角度之间的一段扇形（仪表的轨道和数值）；在饼图上，plot 报告指针下的扇区，它会抬起（`hoverLift`），其他扇区变淡（`hoverDim`）。`Sankey` 绘制各行之间的流（`links`），按 d3-sankey 的方式布局，每个节点和流带用自己的类着色；节点可以带标签、可以悬停，流变化时平滑移动。见 [Plot](../elements/plot.md)。

<a id="workspaces"></a>

## 工作区

<a id="resizablepanelgroup-and-resizablepanel"></a>

### ResizablePanelGroup 与 ResizablePanel

并排或上下排列的面板，每两个面板之间有一个手柄，用户拖动它来分配空间。分组负责拖动（以原生方式运行）、每个面板的限制（`minSize`、`maxSize`）和调整大小的光标；尺寸由应用持有（`size`，通过 `onResize` 报告），手柄的外观和面板的内容也属于应用。见 [Resizable](../elements/resizable.md)。

<a id="dockarea"></a>

### DockArea

可停靠的工作区：面板放在标签组里，标签组并排或上下分栏，左、右、下三条边上各有一个停靠区。布局是应用持有的数据（`layout`，通过 `onLayoutChange` 报告）；区域负责标签页的拖放、调整大小、停靠区、放大和锁定，面板移动时保留它的内容，在区域较窄时用抽屉和底部面板呈现同一份布局。标签页、手柄、放置指示和面板内容都属于应用。见 [Dock](../elements/dock.md)。

<a id="documents"></a>

## 文档

<a id="textview"></a>

### TextView

`TextView` 用 [`Text`](../elements/text.md) 元素和视图显示 Markdown、HTML 或应用自己构建的文档块：标题、列表、代码、表格、图片、公式、脚注以及应用自己的语法。它为流式输出的 AI 聊天回复而设计，自带一套采用主题颜色的阅读排版，应用可按部件重新设定样式，渲染函数则把应用自己的内容放进文档。见 [TextView](../elements/text-view.md)。

<a id="code"></a>

## 代码

<a id="editor"></a>

### Editor

`Editor` 是支持五十多种语言的代码编辑器：语法高亮、行号、多光标、折叠、软换行、查找与替换、诊断和装饰，以及代码编辑器的按键。文本属于应用（`value` 和 `onChange`），查找栏也属于应用，由它驱动编辑器的 `search`。它带有一套由主题令牌构成的外观，应用可按部件重新设定样式。见 [Editor](../elements/editor.md)。

<a id="diffview"></a>

### DiffView

`DiffView` 像代码评审工具那样显示两段文本之间或补丁中各个文件的改动：并排或合并显示，高亮行内改动的单词，未改动的行折叠成可以展开的分隔行，使用 `Editor` 的语法颜色。应用的操作可以保留或撤销每处改动。见 [DiffView](../elements/diff-view.md)。

<a id="datatable"></a>

### Table

`Table` 及其部件排布应用作为子元素写出的少量行，并为屏幕阅读器提供表格：行组、行、列标题和单元格。每个部件的外观都由应用决定。见 [Table](../elements/table.md)。

### DataTable

`DataTable` 显示行和列，并向两个方向滚动，行数和列数不限，只创建视野中的单元格。行、列或单元格可以选择；列可以调整宽度、移动、固定和排序（由应用排序）；行由应用分页提供，单元格和标题可以由应用绘制。见 [DataTable](../elements/data-table.md)。

<a id="selection"></a>

<a id="navigation"></a>

## 导航

由 `NavPage` 组成的 `NavStack` 在 iOS 上是 `UINavigationController`，在 Android 上是带工具栏和预测性返回的页面栈；在桌面平台和 Web 上，每个页面显示应用自己的 `header`。见 [NavStack](../elements/nav-stack.md)，其中也介绍了 `createNavStack` 和离开页面。

<a id="dialog"></a>

### Dialog

`Dialog` 在所有内容之上（包括栈的标题栏）、在它自己的原生窗口层中呈现内容。它的弹出层和背景层由应用设定样式。见 [Dialog](../elements/dialog.md)。

<a id="alert-dialogs"></a>

## 警告对话框

<a id="alertdialog"></a>

### AlertDialog

`AlertDialog.show(options)` 显示平台自己的警告框或操作表，结果是 `{ action }`：用户所选操作的 `id`。见 [AlertDialog](../elements/alert-dialog.md)。

<a id="input"></a>

## Input

`Input` 是平台原生的文本输入框：单行或多行，输入、光标、选区、自动更正和自动填充都由平台处理。值和外观归应用所有。它的属性类型 `InputProps`（`ios={{…}}` 的为 `IOSInputProps`）与它一起导出。见 [Input](../elements/input.md)。

<a id="status-bar"></a>

## 状态栏

状态栏属于屏幕上正在显示的内容，和 UIKit 一样：在 UIKit 中，每个视图控制器声明自己的 `preferredStatusBarStyle`，由最上层的那个决定。在 NSH 中，页面和对话框就是这些视图控制器：`NavPage` 或 `Dialog` 用 `statusBar` 声明它需要的状态栏，应用则在 `nsh.json` 中声明默认值。

```rust tabs
use nsh_base::nav_page;
use nsh_core::prelude::*;

fn photo_viewer() -> Screen {
    nav_page().header_visible(false).status_bar(
        StatusBarSetting::default()
            .foreground(StatusBarStyle::Light)
            .hidden(true)
            .animated(true),
    )
}
```

```tsx tabs
import { NavPage } from "nsh/base";

function PhotoViewer() {
  return (
    <NavPage headerVisible={false} statusBar={{ foreground: "light", hidden: true, animated: true }}>
      …
    </NavPage>
  );
}
```

`statusBar` 接受以下字段，每个都可省略（在 Rust 中可以只传一个 `StatusBarStyle`，或用 `StatusBarSetting` 的同名构建方法）：

| 字段 | 类型 | 说明 |
|---|---|---|
| `foreground` | `"auto" \| "light" \| "dark"`（Rust：`StatusBarStyle::Default`、`Light`、`Dark`） | 内容（时间、电量、信号）的颜色：`"light"` 用于深色背景，`"dark"` 用于浅色背景，`"auto"` 为平台针对当前外观的颜色。 |
| `hidden` | `boolean` | 隐藏状态栏。 |
| `animated` | `boolean` | 页面或对话框出现和离开时，以动画呈现变化。 |

这个值是响应式的：`statusBar={{ foreground: dark() ? "light" : "dark" }}` 会跟随信号变化，读取信号的 Rust 闭包也一样。

<a id="which-one-applies"></a>

### 哪个生效

**最近显示**的页面或对话框决定状态栏，并且**逐个字段**生效：推入栈的页面位于它下面的页面之上，打开的对话框位于页面之上。它省略的字段取自下面那个，最终取自应用的默认值。页面被弹出或对话框关闭时，下面那个重新生效。

```rust tabs
nav_page()
    .title("Inbox")
    .status_bar(StatusBarStyle::Dark);

// Pushed over it: hidden, with the inbox's dark content when it shows again.
nav_page()
    .title("Photo")
    .status_bar(StatusBarSetting::default().hidden(true));
```

```tsx tabs
<NavPage title="Inbox" statusBar={{ foreground: "dark" }}>…</NavPage>

// 推入在它之上：隐藏状态栏；再次显示时沿用收件箱的深色内容。
<NavPage title="Photo" statusBar={{ hidden: true }}>…</NavPage>
```

<a id="the-apps-default"></a>

### 应用的默认值

`nsh.json` 的 `"statusBar"` 是所有页面和对话框之下的设置，就像 UIKit 应用中 Info.plist 的 `UIStatusBarStyle` 和 `UIStatusBarHidden`：

```json
{
  "statusBar": { "foreground": "light", "hidden": false }
}
```

两个字段都可省略。不设置时，内容为 `"auto"`，状态栏显示。打包的 iOS 应用在启动屏上也会使用它。

<a id="the-status-bar-on-each-platform"></a>

### 各平台上的状态栏

- **iOS**：隐藏和显示以淡入淡出呈现。在[嵌入](../docs/ios.md)原生应用的场景下，状态栏的外观由宿主应用的视图控制器决定。宿主可以在其视图控制器中返回 `NshAppView.preferredStatusBarStyle`、`NshAppView.prefersStatusBarHidden` 和 `NshAppView.preferredStatusBarUpdateAnimation`，以应用 NSH 的设置。
- **Android**：应用以 edge-to-edge 方式绘制到状态栏之下（Android 15，即 API 35）：应用自己的背景就是状态栏的背景，`foreground` 让状态栏的内容在其上保持清晰。
- **桌面平台与 Web**：窗口标题栏和浏览器的栏属于系统和浏览器；`statusBar` 和 `nsh.json` 的 `"statusBar"` 用于手机。

> [!IMPORTANT]
> 如果你的 `nsh.json` 声明了 `"capabilities"`，只有其中包含 `"statusBar": true` 时状态栏才会改变，其他更改会被拒绝并记录日志。参见[沙箱与权限](../docs/sandbox-and-capabilities.md)。

```json
{
  "capabilities": {
    "statusBar": true
  }
}
```

<a id="related"></a>

## 相关内容

- [导航指南](../docs/navigation.md)。
- [表单与键盘](../docs/forms-and-keyboard.md)。
- [Avatar](../elements/avatar.md)、[Button](../elements/button.md)、[Link](../elements/link.md)、[Checkbox](../elements/checkbox.md)、[Radio](../elements/radio.md)、[Switch](../elements/switch.md)、[Tabs](../elements/tabs.md)、[Toggle](../elements/toggle.md)、[Toolbar](../elements/toolbar.md)、[Select](../elements/select.md)、[Combobox](../elements/combobox.md)、[Calendar](../elements/calendar.md)、[TimeField](../elements/time-field.md)、[DatePicker](../elements/date-picker.md)、[Collapsible](../elements/collapsible.md)、[Accordion](../elements/accordion.md)、[Progress](../elements/progress.md)、[Slider](../elements/slider.md)、[NumberInput](../elements/number-input.md)、[OtpInput](../elements/otp-input.md)、[Pagination](../elements/pagination.md)、[Plot](../elements/plot.md)、[NavStack](../elements/nav-stack.md)、[Dialog](../elements/dialog.md)、[AlertDialog](../elements/alert-dialog.md)、[TextView](../elements/text-view.md)、[Editor](../elements/editor.md)、[DiffView](../elements/diff-view.md)、[Table](../elements/table.md)、[DataTable](../elements/data-table.md)、[Text](../elements/text.md)[Button](../elements/button.md)、[Checkbox](../elements/checkbox.md)、[Radio](../elements/radio.md)、[Switch](../elements/switch.md)、[Tabs](../elements/tabs.md)、[Select](../elements/select.md)、[Combobox](../elements/combobox.md)、[Collapsible](../elements/collapsible.md)、[Progress](../elements/progress.md)、[Slider](../elements/slider.md)、[ColorPicker](../elements/color-picker.md)、[Scrollbar](../elements/scrollbar.md)、[NumberInput](../elements/number-input.md)、[OtpInput](../elements/otp-input.md)、[Plot](../elements/plot.md)、[NavStack](../elements/nav-stack.md)、[Dialog](../elements/dialog.md)、[AlertDialog](../elements/alert-dialog.md)、[TextView](../elements/text-view.md)、[Editor](../elements/editor.md)、[DiffView](../elements/diff-view.md)、[Table](../elements/table.md)、[DataTable](../elements/data-table.md)、[Text](../elements/text.md) 与 [Input](../elements/input.md)。
- [设备与环境](../docs/device-and-environment.md)。
- [`BackHandler`](./nsh-mobile.md#backhandler)：`BackHandler` 及其他 Android 专用 API。
