---
title: Avatar
description: Avatar 与 AvatarGroup 组件：显示一个人的头像，图片加载中、加载失败或没有图片时显示后备内容，加载状态在原生侧处理；以及只显示前几个头像、用溢出部分代表其余人的一排头像。
group: base
demo: el-avatar
---

# Avatar

头像显示一个人的图片：团队成员、评论作者、标题栏里的账号。图片加载完成前、加载失败时以及没有图片时，它显示后备内容：这个人 `name` 的首字母，或者应用自己的内容（一个图标）。它负责图片的加载状态（由图片自己的加载和错误事件在原生侧驱动，不经过 JavaScript）以及屏幕阅读器读到的内容：一张以这个人名字为标签的图片。外观由应用决定：`Avatar` 没有自己的尺寸、形状、颜色或字体。`AvatarGroup` 显示一排头像中的前几个，以及代表其余人的溢出部分（“+5”）。

```rust tabs
use nsh_base::{avatar, theme};
use nsh_core::prelude::*;

fn author(name: &'static str, picture: &'static str) -> impl IntoElement {
    avatar()
        .src(picture)
        .name(name)
        .size(px(40.0))
        .image_style(|s| s.rounded_full())
        .fallback_style(|s| {
            s.rounded_full()
                .items_center()
                .justify_center()
                .bg(move || theme().muted)
                .text_color(move || theme().muted_foreground)
                .text_sm()
        })
}
```

```tsx tabs
import { mount } from "nsh";
import { Avatar } from "nsh/base";

function App() {
  return (
    <Avatar
      src="https://example.com/ada.png"
      name="Ada Lovelace"
      class="size-10"
      imageClass="rounded-full"
      fallbackClass="items-center justify-center rounded-full bg-muted text-sm text-muted-foreground"
    />
  );
}

mount(App);
```

`Avatar` 和 `AvatarGroup` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。在 Rust 中，`avatar()` 和 `avatar_group()` 创建它们，每个 prop 有一个 setter（`.src(..)`、`.fallback_delay(..)`），头像本身用带类型的样式方法设置，显示在图片之上的内容用 `.child(..)` 添加。

## Props

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `src` | `.src(..)` | `string \| ImageAsset` | 无 | 图片，取值与 [`<Image>`](./image.md) 的 `src` 相同：URL、`asset:/` 或 `data:` URI、`blob:` URL（用户选的照片：`URL.createObjectURL(file)`），或导入的图片。加载完成后显示；空字符串表示没有图片。 |
| `name` | `.name(..)` | `string` | 无 | 这个人的名字：屏幕阅读器读出的内容，以及应用没有传 `fallback` 时后备内容显示的首字母。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | `name` | 屏幕阅读器读出的内容，优先于 `name`。`""` 使头像成为装饰性的，对屏幕阅读器隐藏。 |
| `fallbackDelay` | `.fallback_delay(..)` | `number`（毫秒） | `0` | 图片加载时后备内容等待多久才显示，让很快加载完的图片直接出现，不会先闪一下后备内容。 |
| `imageClass`、`imageStyle` | `.image_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 图片：它的填充方式、圆角和动效。 |
| `fallbackClass`、`fallbackStyle` | `.fallback_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 后备内容：它的背景、文字颜色和大小，以及内容的对齐方式。 |
| `fallback` | `.fallback(..)` | `JSX.Element` | 首字母 | 代替首字母的后备内容：一个图标、没有名字的人的占位内容。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 显示在图片之上的内容：在线状态圆点、徽标。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 头像本身：它的尺寸和形状。 |

| 事件 | Rust | 参数 | 说明 |
|---|---|---|---|
| `onStatusChange` | `.on_status_change(..)` | `{ status: AvatarStatus }` | 图片的状态变化了：`"idle"`（没有 `src`）、`"loading"`、`"loaded"` 或 `"error"`。 |

## 部件

| 部件 | 位于 | 样式 |
|---|---|---|
| 头像 | | `class`、`style` |
| 后备内容 | 头像中，第一个，与头像一样大；图片加载中（`fallbackDelay` 之后）、失败或没有图片时出现 | `fallbackClass`、`fallbackStyle`；内容是首字母或 `fallback` |
| 图片 | 头像中，覆盖在后备内容之上并填满头像 | `imageClass`、`imageStyle` |
| 应用的内容 | 头像中，最后一个 | 它自己的元素（`children`） |

给头像设置尺寸（`class="size-10"`）：后备内容和图片都填满它，所以后备内容离开时不会触发重新布局。图片从一开始就参与布局，保持透明，加载完成后变为不透明，然后后备内容离开。在 `imageClass` 中加上 `transition-opacity` 让它淡入（减少动态效果时直接显示）。给图片和后备内容分别加圆角（各自 `rounded-full`），而不是裁剪头像本身，这样放在边缘的在线状态圆点（`absolute bottom-0 right-0`）能完整显示。

首字母取名字前两个单词的首字母并转为大写（“Ada Lovelace” 是 “AL”）；只有一个单词时取它的前两个字母（“huacnlee” 是 “HU”），没有大小写之分的文字取第一个字符（“王小明” 是 “王”）。

## 头像组

```tsx
import { Text } from "nsh";
import { Avatar, AvatarGroup } from "nsh/base";

<AvatarGroup
  limit={3}
  total={members.length}
  accessibilityLabel={`${members.length} 位成员`}
  class="flex-row"
  overflowClass="-ml-2 size-8 items-center justify-center rounded-full bg-muted ring-2 ring-background"
  overflowAccessibilityLabel={`还有 ${members.length - 3} 人`}
  overflow={<Text class="text-xs">{`+${members.length - 3}`}</Text>}
>
  <Each of={members.slice(0, 3)} key={(m) => m.id}>
    {(m, i) => <Avatar src={m().picture} name={m().name} class={i() > 0 ? "-ml-2 size-8" : "size-8"} />}
  </Each>
</AvatarGroup>
```

| Prop | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `limit` | `.limit(..)` | `number` | `3` | 最多显示这么多个头像，即前面几个；其余的不创建视图。 |
| `total` | `.total(..)` | `number` | 子元素的数量 | 这一组代表多少人，用于应用只传入前几个人的情况。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 屏幕阅读器对这一组读出的内容。 |
| `overflowClass`、`overflowStyle` | `.overflow_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 溢出部件，位于显示的头像之后。 |
| `overflow` | `.overflow(..)` | `JSX.Element` | 无 | 代表未显示的人的内容（“+5”、“⋯”），组里的人比显示的头像多时出现。 |
| `overflowAccessibilityLabel` | `.overflow_accessibility_label(..)` | `string` | 无 | 屏幕阅读器读出的溢出部件内容，代替它显示的内容：例如“+5”读作“还有 5 人”。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 头像，按顺序排列。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 这一排：它的方向（`flex-row`）和间距。 |

重叠、描边和溢出部件的形状都由应用决定：在第一个之后的每个头像上加负外边距（`-ml-2`）让它们叠在一起，再用与背景同色的描边把它们分开。对于很长的列表，只传入前 `limit` 个人并设置 `total`：只会创建显示出来的头像。

## 无障碍

- 对屏幕阅读器来说，头像是一张图片，标签是 `accessibilityLabel` 或 `name`：名字只读一次。后备内容和图片对屏幕阅读器隐藏，所以首字母不会单独读出。两者都没有，或者 `accessibilityLabel=""` 时，头像是装饰性的，对屏幕阅读器隐藏，适合旁边已经显示了名字的头像。
- 头像组是一个组，标签是它的 `accessibilityLabel`（“Ada、Grace 和另外 5 人”）；显示的头像是其中的图片。溢出部件读出它的内容（“+5”），应用提供 `overflowAccessibilityLabel`（“还有 5 人”）时读出这个标签：NSH 不写任何自己的文字。
- 两者都不接受按压或键盘焦点：需要按压时把头像放进 `Button`。

关于标签、角色和播报的一般说明，见[无障碍](../docs/accessibility.md)。

## 平台说明

- 每个平台都用自己的图片加载器和缓存加载图片（见 [Image](./image.md)）；图片的加载和错误事件在 Rust 中改变头像的状态，所以图片加载中或失败时只有图片和后备内容会变化，其他内容不受影响。
- 图片有了 frame 才开始加载，所以它在透明时也保持参与布局。
