---
title: Link
description: Link 组件：按下后前往某处的内容（页面、网站或应用内的路由），负责按压、键盘激活、禁用状态以及屏幕阅读器的链接角色，样式由应用决定。
group: base
demo: el-link
---

# Link

链接把用户带到某处：一个网页、另一个应用（`mailto:`、`tel:`），或应用自己的某个页面。它负责行为：按压、获得键盘焦点时的 Return 和 Space、禁用状态，以及屏幕阅读器读到的链接角色。外观由应用决定：`Link` 没有自己的颜色、下划线或文字，显示的是它的子元素。`href` 说明它去往哪里，是打开时用的数据，不会作为文字显示。

```rust tabs
use nsh_base::{link, theme};
use nsh_core::prelude::*;

fn docs() -> impl IntoElement {
    link()
        .href("https://example.com/docs")
        .text_color(move || theme().primary)
        .underline()
        .hover(|s| s.opacity(0.8))
        .focus(|s| s.rounded_sm().outline(px(2.0)).outline_color(move || theme().ring))
        .child(text("Read the docs"))
}
```

```tsx tabs
import { mount, Text } from "nsh";
import { Link } from "nsh/base";

function App() {
  return (
    <Link
      href="https://example.com/docs"
      class="self-start text-primary underline hover:opacity-80 focus:rounded-sm focus:outline-2 focus:outline-ring"
    >
      <Text>Read the docs</Text>
    </Link>
  );
}

mount(App);
```

`Link` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`link()` 创建一个链接，每个 prop 有一个 setter（`.href(..)`、`.open_with(..)`），每个事件有一个监听方法（`.on_open(..)`、`.on_press(..)`），链接本身用类型化的样式方法，内容用 `.child(..)`。

## 打开

按压、点击，或在获得焦点的链接上按 Return 或 Space，会打开它的 `href`：

1. `onOpen({ href })` 报告它去往哪里。
2. `openWith="system"`（默认）时，另一个应用或网站的 URL，即带协议的 URL（`https:`、`mailto:`、`tel:`、其他应用注册的协议），会在应用之外打开，与 [`openUrl`](../modules/nsh.md) 打开的方式相同：先由嵌入它的应用的路由处理，再交给系统。其他 `href`，即应用自己的路径（`/orders/42`）或 `#anchor`，只报告，由应用处理。
3. `onPress()` 报告这次按压。

`openWith="app"` 时，由应用的 `onOpen` 处理函数决定如何打开：应用自己的路由、应用内 Web 视图里的页面，或者先确认一下。

```tsx
import { Link } from "nsh/base";

<Link href={`/orders/${order.id}`} openWith="app" onOpen={({ href }) => router.push(href)} class="text-primary">
  <Text>Order #{order.id}</Text>
</Link>
```

应用在 `nsh.json` 中声明了能力时，在应用之外打开 URL 需要 `openUrl` 能力（`"openUrl": true`，或 `{ "schemes": ["https", "mailto"] }`）。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `href` | `.href(..)` | `string` | 无 | 链接去往哪里：一个 URL，或应用自己的路径。由 `onOpen` 报告，不会显示。 |
| `openWith` | `.open_with(LinkOpenWith::App)` | `"system" \| "app"`（`LinkOpenWith`） | `"system"` | 由谁打开 `href`：系统打开另一个应用或网站的 URL；`"app"` 交给 `onOpen`。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不响应按压、没有按压反馈、不获得键盘焦点；应用 `disabled:` 样式，屏幕阅读器读出它不可用。 |
| `current` | `.current(..)` | `boolean` | `false` | 导航或面包屑中指向用户所在页面的链接：屏幕阅读器读出它是当前页。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 内容说明不够时（一个图标）屏幕阅读器读出的文字。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 内容：一段文字、一个图标，应用要显示的任何东西。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 链接的外观：颜色、下划线、内边距；文本属性会传给其中的文字。 |
| `activeStyle`、`hoverStyle`、`focusStyle`、`disabledStyle` | `.active(\|s\| ..)`、`.hover(..)`、`.focus(..)`、`.disabled_style(..)` | `StyleProp<ViewStyle>` | 无 | 链接在按下、悬停、获得焦点或禁用时的样式，与 `<state>:` 类相同。 |

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onOpen` | `.on_open(\|href: &SharedString\| ..)` | 链接打开 `href`：`openWith="app"` 时由处理函数打开，`"system"` 时处理函数得知系统被要求打开什么。它在 `onPress` 之前。 |
| `onPress` | `.on_press(\|\| ..)` | 链接被按下：轻点、点击，或获得键盘焦点时按 Return 或 Space。 |

禁用的链接不报告任何事件，按在它上面也不会传到它外面可按压的视图。

## 状态

应用用类或样式 prop 为每个状态设置样式：

```tsx
<Link
  href="https://example.com/changelog"
  class="self-start text-primary underline decoration-primary/40 transition-colors hover:decoration-primary active:opacity-70 focus:outline-2 focus:outline-ring disabled:text-muted-foreground disabled:no-underline"
>
  <Text>Changelog</Text>
</Link>
```

访问过的链接由应用记住：它保存打开过的 href，并按自己的状态为这些链接设置样式。

```tsx
const visited = signal(new Set<string>());

<Link
  href={href}
  onOpen={({ href }) => visited.set(new Set(visited()).add(href))}
  class={visited().has(href) ? "text-violet-600 underline" : "text-primary underline"}
>
  <Text>{label}</Text>
</Link>
```

## 在文字中

`<Text>` 里的 `Link` 是段落中的一个行内盒子，和文字里的每个视图一样：它排在行中，保留自己的状态、焦点和角色，并保持在一行内。`align-text-bottom` 让只有一行文字的链接落在段落的基线上：

```tsx
<Text class="text-[15px] text-foreground">
  By continuing you accept the{" "}
  <Link href="https://example.com/terms" class="align-text-bottom">
    <Text class="text-[15px] text-primary underline">terms of service</Text>
  </Link>
  .
</Text>
```

随段落换行的链接是带 `role="link"` 和 `onPress` 的嵌套 `<Text>`（见 [Text](./text.md)），[TextView](./text-view.md) 就是这样绘制文档中的链接的。

## 无障碍

- 链接对屏幕阅读器是一个元素，角色为 `"link"`；它的标签是子元素的文字，或 `accessibilityLabel`。`href` 只是数据：屏幕阅读器读出的是标签。
- `current` 读作当前页（ARIA 的 `aria-current="page"`），`disabled` 按平台读出不可用元素的方式读出。
- 在 macOS 和 Web 上，链接是键盘焦点的一站：Tab 到达它，Return 和 Space 打开它，`focus:` 样式显示焦点所在。

标签、角色和播报的一般说明见[无障碍](../docs/accessibility.md)。

## 平台说明

- iOS、Android 和 Mac Catalyst：按压是在链接上结束的一次轻点。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压是一次点击。在 macOS 和 Web 上，获得键盘焦点的链接也可以用 Return 和 Space 打开。
- Web 把链接渲染为带 `role="link"` 的元素。
- 每个平台绘制的都是应用设置的样式。
