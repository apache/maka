---
title: Link
description: Link 组件：按下后前往某处的内容（页面、网站或应用内的路由），负责按压、键盘激活、禁用状态以及屏幕阅读器的链接角色，样式由应用决定。
group: base
demo: el-link
---

# Link

链接把用户带到某处：一个网页、另一个应用（`mailto:`、`tel:`），或应用自己的某个页面。它负责行为：按压、获得键盘焦点时的 Return 和 Space、禁用状态，以及屏幕阅读器读到的链接角色。外观由应用决定：`Link` 没有自己的颜色、下划线或文字，显示的是它的子元素。`href` 说明它去往哪里，是打开时用的数据，也是指针停在链接上时桌面平台显示的 URL（见[去往哪里](#去往哪里)）。

```rust tabs
use nsh_base::{link, theme};
use nsh_core::prelude::*;

fn docs() -> impl IntoElement {
    link()
        .href("https://example.com/docs")
        .text_color(move || theme().primary)
        .underline()
        .hover(|s| s.opacity(0.8))
        .focus_visible(|s| s.rounded_sm().outline(px(2.0)).outline_color(move || theme().ring))
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
      class="self-start text-primary underline hover:opacity-80 focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-ring"
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

## 去往哪里

在桌面平台（macOS、Windows、Linux、GPUI）和桌面形态的 Web 上，指针在链接上停留半秒，就会显示它去往哪里，就像邮件应用或浏览器状态栏那样：链接下方出现一个提示，写着它的目的地，直到指针离开或按下链接。用键盘把焦点移到链接上（Tab）时也会显示。无论链接文字写的是什么，用户都能在点开之前核对目的地。

- 目的地显示为一行，在从右到左的应用里也按从左到右排列。URL 按解析后的样子显示：国际化域名显示为 ASCII 形式（`https://xn--mnchen-3ya.de`），冒充拉丁字母的其他文字字母会显示出本来面目；`user@` 之后的主机也照实显示，过长的 `user:password@` 会缩短，让主机始终可见。
- 协议、主机和端口始终以完整宽度显示，IPv6 主机（`http://[2001:db8::1]:8080`）和很长的主机也一样。过长的路径和查询会把中间部分换成省略号，保留开头和结尾（`https://docs.example.com/guides/getting-…arch=arm64#verify`）；窗口窄到放不下这一行时，也只有路径和查询让位，同样省略中间。
- 协议相对 URL（`//cdn.example.com/lib.js`）同样显示主机。应用自己的路径（`/settings`、`docs/intro`）或 `#anchor` 按原样显示，其中的控制字符、双向文字控制字符和不可见字符显示为百分号转义。禁用的链接不显示提示。
- 链接的 `title` 显示在同一个提示里、目的地上方（`<Link href="https://nsh.dev/docs" title="The guide">`）。它是可选的：不设置时提示只显示目的地。它是所链接页面的名称；链接读出来的仍是其内容和 `accessibilityLabel`。
- 文字中的链接也一样显示：[TextView](./text-view.md) 文档里的链接会在目的地上方显示 Markdown 标题（`[docs](https://example.com "The guide")`）。
- 应用给链接设置的 [`tooltip`](./tooltip.md) 是另一个独立的浮层，不是链接的标题。它默认显示在上方，目的地显示在下方，所以通常互不遮挡；但靠近窗口边缘时任何一个都可能翻到另一侧，这时两者可能重叠。

提示使用主题的 popover 令牌绘制（`popover`、`border`，URL 用 `muted-foreground`），每个应用都会为用户提供这项核对。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `href` | `.href(..)` | `string` | 无 | 链接去往哪里：一个 URL，或应用自己的路径。由 `onOpen` 报告，并在桌面平台上作为链接的提示显示。 |
| `title` | `.title(..)` | `string` | 无 | 所链接页面的名称：显示在链接提示里、目的地上方。可选。 |
| `openWith` | `.open_with(LinkOpenWith::App)` | `"system" \| "app"`（`LinkOpenWith`） | `"system"` | 由谁打开 `href`：系统打开另一个应用或网站的 URL；`"app"` 交给 `onOpen`。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不响应按压、没有按压反馈、不获得键盘焦点；应用 `disabled:` 样式，屏幕阅读器读出它不可用。 |
| `current` | `.current(..)` | `boolean` | `false` | 导航或面包屑中指向用户所在页面的链接：屏幕阅读器读出它是当前页。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 内容说明不够时（一个图标）屏幕阅读器读出的文字。 |
| `hitSlop` | `.hit_slop(..)` | `number \| Partial<Edges>` | 无 | 按压在边界之外多远仍然算数，单位为点：一个数字表示每一边，或分别指定各边。与视图的 `hitSlop` 相同。 |
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
  class="self-start text-primary underline decoration-primary/40 transition-colors hover:decoration-primary active:opacity-70 focus-visible:outline-2 focus-visible:outline-ring disabled:text-muted-foreground disabled:no-underline"
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

## 用 hitSlop 扩大小目标

链接可能比手指还小：一个图标、一个短词。`hitSlop` 让落在它附近的按压也算数，单位为超出每一边的点数，不改变它的布局和外观：一个数字表示每一边，或分别指定各边（`{ top: 8, bottom: 8 }`），与[视图的 `hitSlop`](./index.md#按压与反馈) 取值相同。

```tsx
<Link href="https://example.com/help" hitSlop={12} accessibilityLabel="Help" class="size-5 items-center justify-center">
  <Text>?</Text>
</Link>
```

## 无障碍

- 链接对屏幕阅读器是一个元素，角色为 `"link"`；它的标签是子元素的文字，或 `accessibilityLabel`。`href` 只是数据：屏幕阅读器读出的是标签。
- `current` 读作当前页（ARIA 的 `aria-current="page"`），`disabled` 按平台读出不可用元素的方式读出。
- 在 macOS 和 Web 上，链接是键盘焦点的一站：Tab 到达它，Return 和 Space 打开它，`focus-visible:` 样式显示焦点所在。

标签、角色和播报的一般说明见[无障碍](../docs/accessibility.md)。

## 平台说明

- iOS、Android 和 Mac Catalyst：按压是在链接上结束的一次轻点。
- 桌面（macOS、Windows、Linux、GPUI）和 Web：按压是一次点击。在 macOS 和 Web 上，获得键盘焦点的链接也可以用 Return 和 Space 打开。指针停在链接上会显示它的 URL（见[去往哪里](#去往哪里)）。
- Web 把带 `href` 的链接渲染为 `<a href>`（爬虫会跟随它；按住修饰键点击或用鼠标中键点击时在新标签页中打开，右键点击显示浏览器的链接菜单），没有 `href` 的渲染为带 `role="link"` 的元素。
- 终端：启用的链接如果 `href` 是 URL（不是应用自己的路径），其中的文字会成为指向它的 OSC 8 超链接，由终端模拟器在带修饰键的点击时自己打开，不经过 `openWith`。Linux 控制台（`TERM=linux`）显示纯文本。
- 每个平台绘制的都是应用设置的样式。
