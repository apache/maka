---
title: Tabs
description: Tab 与 Tabs：标签列表中的标签页，以及这个列表。每个标签页负责按压、键盘激活、禁用状态以及屏幕阅读器的角色和选中状态；列表就是这一组，带一个原生跟随选中标签页的指示器；外观、值以及每个标签页显示的内容都属于应用。
group: base
demo: el-tabs
---

# Tabs

标签页在同一处的几个部分之间切换：一个项目的概览和动态、一份文档的几种视图。每个 `Tab` 负责一个标签页的行为：按压、键盘激活、禁用状态，以及屏幕阅读器读到的标签页角色和它的选中状态。包在外面的 `Tabs` 就是标签列表，屏幕阅读器把它当作一组播报。外观由应用决定：标签页没有自己的颜色、尺寸或文字。它的子元素是应用自己的标签，标签页上的 `selected:` 类，以及它里面元素上的 `group-selected:` 类，跟随它的状态。每个部分的内容也属于应用：应用在列表旁边显示它的值所指的那一部分。列表的指示器是应用自己设置样式的下划线或胶囊，停在选中的标签页上，并原生地移动到下一个（见[指示器](#indicator)）。

```rust tabs
use nsh_base::{tab, tabs, theme};
use nsh_core::prelude::*;

fn sections() -> impl IntoElement {
    let section = signal("overview");
    let item = move |value: &'static str, label: &'static str| {
        let selected = move || section.get() == value;
        tab()
            .selected(selected)
            .on_press(move |_: &()| section.set(value))
            .rounded(move || theme().radius)
            .px_3()
            .py_2()
            .child(text(label).text_sm().text_color(move || {
                if selected() { theme().foreground } else { theme().muted_foreground }
            }))
    };
    view()
        .gap_4()
        .child(
            tabs()
                .flex_row()
                .self_start()
                .gap_1()
                .p_1()
                .rounded(move || theme().radius)
                .bg(move || theme().muted)
                .indicator_style(|s| {
                    s.top_1()
                        .bottom_1()
                        .rounded(move || theme().radius)
                        .bg(move || theme().background)
                })
                .child(item("overview", "Overview"))
                .child(item("activity", "Activity")),
        )
        .child(text(move || {
            if section.get() == "overview" {
                "Visitors, sign-ups and conversion this week."
            } else {
                "Deploys, invoices and new members, newest first."
            }
        }).text_color(move || theme().foreground))
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Tab, Tabs } from "nsh/base";

function App() {
  const section = signal("overview");
  const item = (value: string, label: string) => (
    <Tab
      selected={section() === value}
      onPress={() => section.set(value)}
      class="group rounded-(--radius) px-3 py-2"
    >
      <Text class="text-sm text-muted-foreground group-selected:text-foreground">{label}</Text>
    </Tab>
  );
  return (
    <View class="gap-4">
      <Tabs
        class="flex-row self-start gap-1 rounded-(--radius-lg) bg-muted p-1"
        indicatorClass="inset-y-1 rounded-(--radius) bg-background"
      >
        {item("overview", "Overview")}
        {item("activity", "Activity")}
      </Tabs>
      <Text class="text-foreground">
        {section() === "overview"
          ? "Visitors, sign-ups and conversion this week."
          : "Deploys, invoices and new members, newest first."}
      </Text>
    </View>
  );
}

mount(App);
```

`Tab` 和 `Tabs` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。值由应用持有：列表本身不持有值。每个标签页被告知自己是否选中；按下时通过 `onPress` 报告，应用设置自己的值并显示对应的部分，每个标签页显示应用传回的 `selected`。列表和标签页的圆角同心：列表的内边距（`p-1`）正是 `radius.lg` 与 `radius` 之差。选中标签页的填充是列表的指示器（`indicatorClass`，位于这层内边距之内：`inset-y-1`），它以弹簧动画移到应用选中的标签页。在 Rust 中，`tab()` 和 `tabs()` 创建它们，每个属性对应一个设置方法（`.selected(..)`），每个事件对应一个监听方法（`.on_press(..)`），外观用类型化的样式方法，内容用 `.child(..)`。

<a id="props"></a>

## 属性

### Tab

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `selected` | `.selected(..)` | `boolean` | `false` | 列表中当前的标签页：屏幕阅读器报告它已选中，`selected:` 样式生效。按下时通过 `onPress` 报告；标签页显示应用传回的值。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不响应按压，也没有按压反馈；`disabled:` 样式生效，屏幕阅读器会报告它不可用。 |
| `selectedStyle` | `.selected_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 选中且未禁用时标签页自身的样式，与 `selected:` 类相同。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的文字：子元素没有说明这个标签页名称的文字时（例如只有图标）设置。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 应用的标签、图标或徽标，屏幕阅读器会读出。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 标签页自身：包住标签的那块表面。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 标签页按下、悬停、获得焦点或禁用时的样式，与对应的 `<state>:` 类相同。 |

### Tabs

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `indicatorClass` | `.indicator_class(..)` | `string` | 无 | 选中标签页上指示器的 Tailwind 类：它的外观，以及它在列表交叉方向上的位置（一行里的下划线用 `bottom-0 h-0.5`，胶囊用 `inset-y-1`）。沿列表方向，它覆盖选中的标签页，并在这个方向上留出自己的外边距。设置了 `indicatorClass` 或 `indicatorStyle`，列表就有指示器。 |
| `indicatorStyle` | `.indicator_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 指示器的样式，叠加在 `indicatorClass` 之上。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 列表中的标签页，以及应用放在它们之间的其他内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 列表的布局和外观：默认是一列，`flex-row` 排成一行。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onPress`（`Tab`） | `.on_press(\|_: &()\| ..)` | 标签页被按下：轻点、点击、拥有键盘焦点时按 Space 或 Return，或屏幕阅读器的激活；或者列表的方向键、Home 或 End 把键盘焦点移到了它上面。它在任何变化之前运行：标签页显示应用传回的 `selected`。 |

已选中的标签页同样报告按压，应用可以响应第二次按压（例如把这一部分滚动到顶部）。禁用的标签页不报告任何事件。

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 | 状态 |
|---|---|---|---|
| 列表 | | `Tabs` 的 `class`、`style` | |
| 指示器 | 列表里，在标签页后面 | `indicatorClass`、`indicatorStyle` | 在选中的标签页上 |
| 标签页 | 列表里 | `Tab` 的 `class`、`style` | `selected:`、`disabled:`、`active:`、`hover:`、`focus:`（或 `selectedStyle`、`disabledStyle` 等） |
| 标签 | 标签页里 | 它们自己的元素（`children`） | 在标签页的 `class` 上加 `group` 后，使用 `group-selected:`、`group-disabled:` 等 `group-*:` 变体 |
| 这一部分的内容 | 列表旁边 | 应用自己的元素 | 应用的值 |

用标签页自身的表面表达选中：填充、更强的标签颜色或更重的字重（见[设计指南](../docs/design-guides.md)的交互状态一节）。

<a id="indicator"></a>

## 指示器

选中标签页下的下划线、它后面的胶囊，或分段控件里凸起的那一段，就是列表的指示器：一个由应用通过 `indicatorClass` 和 `indicatorStyle` 设置样式的视图，绘制在标签页后面，在列表中绝对定位。每次布局之后，Native Shell 把它放到选中的标签页上。沿列表方向（一行的宽度、一列的高度），它覆盖这个标签页，并在这个方向上留出指示器自己的外边距（例如 `mx-3` 让下划线比标签页短一些）；在交叉方向上，由它的类决定位置：

```tsx
// 一行标签页底部的下划线。
<Tabs class="flex-row gap-4 border-b border-border" indicatorClass="bottom-0 h-0.5 bg-foreground">
  {item("overview", "Overview")}
  {item("activity", "Activity")}
</Tabs>

// 选中标签页后面的胶囊，位于列表的内边距之内。
<Tabs class="flex-row self-start gap-1 rounded-(--radius-lg) bg-muted p-1" indicatorClass="inset-y-1 rounded-(--radius) bg-background shadow-sm">
  {item("overview", "Overview")}
  {item("activity", "Activity")}
</Tabs>
```

应用选中另一个标签页时，指示器以弹簧动画原生地移过去，与 GPUI Kit 标签栏的指示器一致；开启减弱动态效果时，它立即就位。没有标签页选中时，指示器隐藏；有多个选中时，它停在第一个上。窗口缩放或标签页宽度变化时，它与标签页在同一帧移动。指示器不需要布局事件，也不需要应用写代码：选中的标签页就是 `selected` 为 true 的那个。可以滚动的列表，把滚动视图放在 `Tabs` 外面，指示器随标签页一起滚动。

<a id="disabled"></a>

## 禁用

禁用的标签页不响应按压，屏幕阅读器会报告它不可用。它的 `disabled:` 类生效并覆盖 `selected:` 类，它里面的 `group-disabled:` 类随之生效：

```tsx
<Tab
  selected={section() === "billing"}
  disabled={!isOwner()}
  onPress={() => section.set("billing")}
  class="group rounded-(--radius) px-3 py-2 selected:bg-background disabled:opacity-50"
>
  <Text class="text-sm text-muted-foreground group-selected:text-foreground">Billing</Text>
</Tab>
```

<a id="accessibility"></a>

## 无障碍

- 标签页对屏幕阅读器而言是一个元素，角色是 `"tab"`，带有它的选中状态。它的标签是子元素的文字，或 `accessibilityLabel`。
- `Tabs` 的角色是 `"tablist"`：屏幕阅读器把其中的标签页当作一组播报，每个标签页仍然是独立的元素。
- `disabled` 按平台的方式报告（VoiceOver、TalkBack、UI Automation、浏览器的无障碍树）。
- 在 macOS 和 Web 上，整个列表是键盘焦点的一站，方向键在它的标签页之间移动（见下文）。
- 指示器对屏幕阅读器隐藏，也不接收焦点：列表里的元素只有标签页。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

<a id="keyboard"></a>

## 键盘

在 macOS 和 Web 上，Tab 会到达接受按压的视图，`Tabs` 列表遵循
[WAI-ARIA 标签页模式](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/)：

| 按键 | 作用 |
|---|---|
| Tab、Shift+Tab | 从选中的标签页进入列表（没有选中时是第一个未禁用的标签页），一步离开列表。 |
| Right、Down | 把焦点移到下一个标签页，从最后一个回到第一个。 |
| Left、Up | 把焦点移到上一个标签页，从第一个回到最后一个。 |
| Home、End | 把焦点移到第一个或最后一个标签页。 |
| Space、Return | 按下拥有焦点的标签页。 |

方向键跳过禁用的标签页，焦点移到的标签页报告 `onPress`，应用随焦点移动选中它：显示的部分跟随焦点。无论列表的布局如何（布局由应用的类决定），两组方向键都会移动焦点。`focus:` 样式显示焦点所在。不在 `Tabs` 里的 `Tab` 是独立的一站。

<a id="platform-notes"></a>

## 平台说明

- iOS、Android 和 Mac Catalyst：按压是在标签页上（包括它的标签）结束的一次轻点。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压是一次点击。在 macOS 和 Web 上，Space 和 Return 也会按下拥有键盘焦点的标签页，方向键、Home 和 End 移动焦点（见[键盘](#keyboard)）。
- 每个平台都按应用的样式绘制：标签页、选中标签页的表面、指示器以及各部分的内容。指示器的移动在每个平台上都是原生的布局动画。
