---
title: Accordion
description: Accordion 及其部件：在各自标题下展开和收起的一组分区，一次一个或同时多个，由应用的值决定哪些展开，可按需以弹簧高度展开，全部外观由应用决定。
group: base
demo: el-accordion
---

# Accordion

Accordion（手风琴）把多个分区叠在一起，每个分区在自己的标题下展开和收起：常见问题的各个问题、设置页的各组设置、结账的各个步骤。它由五个部件组成，每个部件负责一部分行为，都不带外观：

- `Accordion`：整组。持有应用的 `value`，即展开项的值，并通过 `onChange` 报告下一个值。一次只展开一项，设置 `multiple` 后可同时展开多项。
- `AccordionItem`：一个分区，以 `value` 标识。accordion 的 `value` 包含它时它就展开。
- `AccordionHeader`：分区的标题，屏幕阅读器会报告它的 `level`。
- `AccordionTrigger`：标题中的按钮，展开和收起所在分区，并报告分区是否已展开。
- `AccordionPanel`：分区的内容，分区展开时显示；设置 `reveal` 后高度以弹簧动画展开和收起。

```rust tabs
use nsh_base::{accordion, accordion_header, accordion_item, accordion_panel, accordion_trigger, theme};
use nsh_core::prelude::*;

const FAQ: [(&str, &str, &str); 2] = [
    ("shipping", "When will my order ship?", "Orders placed before 2 pm leave the same day."),
    ("returns", "How do I return an item?", "Print the label from your order within 30 days."),
];

fn faq() -> impl IntoElement {
    let open = signal(vec![SharedString::from("shipping")]);
    let mut list = accordion()
        .value(open)
        .on_change(move |value: &Vec<SharedString>| open.set(value.clone()));
    for (value, question, answer) in FAQ {
        list = list.child(
            accordion_item()
                .value(value)
                .border_b_1()
                .border_color(move || theme().border)
                .child(
                    accordion_header().child(
                        accordion_trigger()
                            .flex_row()
                            .items_center()
                            .justify_between()
                            .py_3()
                            .child(text(question).font_weight(FontWeight::MEDIUM))
                            .child(text("⌄").transition_transform().rotate(move || {
                                let open = open.get().iter().any(|v| &**v == value);
                                if open { deg(180.0) } else { deg(0.0) }
                            })),
                    ),
                )
                .child(
                    accordion_panel()
                        .reveal(true)
                        .accessibility_label(question)
                        .child(view().pb_3().child(text(answer).text_color(move || theme().muted_foreground))),
                ),
        );
    }
    list
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { Accordion, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from "nsh/base";

const FAQ = [
  { value: "shipping", question: "When will my order ship?", answer: "Orders placed before 2 pm leave the same day." },
  { value: "returns", question: "How do I return an item?", answer: "Print the label from your order within 30 days." },
];

function App() {
  const open = signal(["shipping"]);
  return (
    <Accordion value={open()} onChange={({ value }) => open.set(value)}>
      {FAQ.map((item) => (
        <AccordionItem value={item.value} class="border-b border-border">
          <AccordionHeader>
            <AccordionTrigger class="group flex-row items-center justify-between py-3 active:opacity-70">
              <Text class="font-medium">{item.question}</Text>
              <Text class="transition-transform group-aria-expanded:rotate-180">⌄</Text>
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionPanel reveal accessibilityLabel={item.question}>
            <View class="pb-3">
              <Text class="text-muted-foreground">{item.answer}</Text>
            </View>
          </AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

mount(App);
```

这些部件来自 [`nsh/base`](../modules/nsh-base.md)，Rust 中是 `nsh-base` crate。值由应用持有：按下触发器时通过 `onChange` 报告下一个 `value`，accordion 展开应用传回的值所对应的分区。每个部件自己找到外层的部件，因此应用可以自由安排它们：分区之间的分隔线、标题里的徽标、标题前的图标。Rust 中由 `accordion()`、`accordion_item()`、`accordion_header()`、`accordion_trigger()` 和 `accordion_panel()` 创建，每个属性有对应的 setter，里面的内容用 `.child(..)` 添加。

<a id="props"></a>

## 属性

### Accordion

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `string[]` | `[]` | 展开项的 `value`。由应用持有：按下触发器时通过 `onChange` 报告下一个值，accordion 显示应用传回的值。 |
| `multiple` | `.multiple(..)` | `boolean` | `false` | 可同时展开多项：展开一项时其他项保持展开。不设置时，展开一项会收起原来展开的那项。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 所有分区都禁用：触发器都不响应按压，屏幕阅读器报告它们不可用。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 各个分区，以及应用放在它们之间的内容（分隔线）。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 整组的布局和外观：包住各分区的卡片、分区之间的间距。 |

### AccordionItem

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | 必填 | 分区在 accordion 的 `value` 中的标识：应用自己的 id，不要用标题，标题会随语言改变。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 触发器不响应按压，屏幕阅读器报告它不可用。分区仍按 accordion 的 `value` 展开或收起。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 分区的标题和面板，以及应用放在其中的其他内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 分区本身：下方的分隔线、包住它的卡片。 |

### AccordionHeader

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `level` | `.level(..)` | `number` | `3` | 标题在页面各级标题中的级别，供屏幕阅读器使用（1 为最高级）。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 分区的触发器，以及标题中的其他内容（徽标、它自己的操作）。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 标题的布局。 |

### AccordionTrigger

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `expandedStyle` | `.expanded_style(\|s\| ..)` | `StyleProp<ViewStyle>` | 无 | 所在分区展开时触发器的样式，与 `aria-expanded:` 类相同。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的文字：子元素中没有说明它的文字时设置。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 标题和箭头；在触发器的 `class` 上加 `group` 后，里面的 `group-aria-expanded:` 类会跟随触发器。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 触发器本身：用户按下的那一行。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 触发器按下、悬停、获得焦点或禁用时的样式，与对应的 `<state>:` 类相同。 |

### AccordionPanel

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `reveal` | `.reveal(..)` | `boolean` | `false` | 与 `Collapsible` 的 `reveal` 一样带动效展开和收起：面板裁剪内容，高度从零弹到内容自身的高度再弹回，临界阻尼（约 265 毫秒，不过冲），之后的分区随之移动。系统要求减少动态效果时立即展开和收起。 |
| `keepMounted` | `.keep_mounted(..)` | `boolean` | `false` | 分区收起时内容仍留在树中，但不可见、不接收键盘焦点、屏幕阅读器也读不到：视频保持位置，网页视图保持页面。不设置时，面板收起后（动效结束后）内容离开树，再次展开时恢复原样。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对这个区域的称呼：通常是分区标题，与标题读出的一致。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 区域的布局和外观。设置 `reveal` 时，收起的面板仍在布局中、高度为零，所以内边距和边框要放在内容的视图上。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onChange({ value })`（`Accordion`） | `.on_change(\|value: &Vec<SharedString>\| ..)` | 触发器被按下：轻点、点击、获得键盘焦点时按空格或回车，或屏幕阅读器的激活操作。`value` 是按下后展开项的值：展开项的值从中移除，收起项的值追加到末尾，不设置 `multiple` 时则替换原值。它在任何变化发生之前运行：设置 `value` 以跟随它。 |

<a id="parts"></a>

## 部件

| 部件 | 位于 | 样式 | 状态 |
|---|---|---|---|
| 整组 | | `Accordion` 的 `class`、`style` | |
| 分区 | 整组内 | `AccordionItem` 的 `class`、`style` | 应用的值 |
| 标题 | 分区内 | `AccordionHeader` 的 `class`、`style` | |
| 触发器 | 标题内 | `AccordionTrigger` 的 `class`、`style` | `aria-expanded:`、`disabled:`、`active:`、`hover:`、`focus:`（或 `expandedStyle`、`disabledStyle` 等） |
| 标题文字和箭头 | 触发器内 | 它们自己的元素（`children`） | 在触发器的 `class` 上加 `group` 后使用 `group-aria-expanded:`、`group-disabled:` |
| 面板 | 分区内，标题之后 | `AccordionPanel` 的 `class`、`style` | |
| 内容 | 面板内 | 它自己的元素（`children`） | |

不设置 `reveal` 时，收起的面板不参与布局，内容也不在树中。设置 `reveal` 后，变化是改变 `value` 的那次提交的布局动画（类似 `LayoutAnimation.configureNext`，原生运行，动画过程中不运行 JavaScript）：展开的面板从零长到内容的高度，收起的面板缩回，两者使用同一个弹簧，之后的分区随之移动。应用自己的过渡也会一起运行：箭头转动（`transition-transform group-aria-expanded:rotate-180`）。

<a id="disabled"></a>

## 禁用

禁用分区的触发器不响应按压，屏幕阅读器报告它不可用；触发器上的 `disabled:` 类和里面的 `group-disabled:` 类会跟随。accordion 的 `disabled` 禁用所有分区。禁用的分区仍按应用的 `value` 显示：应用可以展开它。

<a id="accessibility"></a>

## 无障碍

- 整组是一个分组，每个标题是对应 `level` 的标题，每个触发器是标题里的按钮，并报告所在分区是否已展开。屏幕阅读器可以在标题之间跳转。
- 展开的面板是一个区域，名称来自它的 `accessibilityLabel`；收起的面板对屏幕阅读器隐藏，保留的内容也一样。
- 展开项的外观由应用决定，不要只靠颜色区分：像示例那样转动箭头。

通用的标签、角色和播报见[无障碍](../docs/accessibility.md)。

<a id="keyboard"></a>

## 键盘

在接收按压的视图会成为键盘焦点停靠点的平台（macOS 和 Web）上，每个触发器都是一个停靠点，按页面顺序排列，按空格或回车会按下它。禁用的触发器和收起面板中的内容都会被跳过。Tab 从触发器进入它展开的面板中的控件，再到下一个触发器。

<a id="platform-notes"></a>

## 平台说明

- 每个平台都在标题下显示展开分区的面板，收起的面板不参与布局（设置 `reveal` 时高度为零）。
- 设置 `reveal` 后，每个平台都在自己的动画器上以弹簧动画改变面板高度（iOS、Android、macOS、Windows、Linux、GPUI 和 Web），系统要求减少动态效果时立即展开和收起。
- 各平台的屏幕阅读器按各自读取标题的方式读出标题及其级别，并把其中的触发器读作带展开状态的按钮；在 iOS 上，VoiceOver 读的是触发器本身。
- iOS、Android 和 Mac Catalyst：按下触发器是轻点。桌面（macOS、Windows、Linux、GPUI）和 Web：点击；在 macOS 和 Web 上，也可以在触发器获得焦点时按空格或回车。
