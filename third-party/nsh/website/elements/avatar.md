---
title: Avatar
description: "The Avatar and AvatarGroup components: a person's picture, or a fallback while it loads, when it fails and when there is none, with the loading state run natively; and a row of avatars that shows the first few and stands for the rest."
group: base
demo: el-avatar
---

# Avatar

An avatar shows a person's picture: a member of a team, the author of a comment, the account in a header. Until the
picture has loaded, when it fails and when there is none, it shows a fallback: the initials of the person's `name`, or
the app's own content (an icon). It owns the picture's loading state, run natively from the image's own load and error
events with no JavaScript, and what screen readers get: an image labelled with the person's name. The look is the
app's: an `Avatar` has no size, shape, colors or font of its own. An `AvatarGroup` shows the first few avatars of a
row and an overflow that stands for the others ("+5").

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

`Avatar` and `AvatarGroup` come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust,
`avatar()` and `avatar_group()` make them with a setter per prop (`.src(..)`, `.fallback_delay(..)`), the typed style
methods for the avatar itself and `.child(..)` for what sits over the picture.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `src` | `.src(..)` | `string \| ImageAsset` | none | The picture, as [`<Image>`](./image.md)'s `src` takes it: a URL, an `asset:/` or `data:` URI, a `blob:` URL (a photo the user picked: `URL.createObjectURL(file)`), or an imported image. It shows once it has loaded; an empty string is no picture. |
| `name` | `.name(..)` | `string` | none | The person's name: what screen readers say, and the initials the fallback shows when the app passes no `fallback`. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | `name` | What screen readers say, over `name`. `""` makes the avatar decorative, hidden from screen readers. |
| `fallbackDelay` | `.fallback_delay(..)` | `number` (ms) | `0` | How long the fallback waits while the picture loads, so a picture that loads quickly shows without the fallback flashing first. |
| `imageClass`, `imageStyle` | `.image_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The picture: its fit, radius and motion. |
| `fallbackClass`, `fallbackStyle` | `.fallback_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The fallback: its background, text color and size, and how it aligns its content. |
| `fallback` | `.fallback(..)` | `JSX.Element` | the initials | The fallback's content in place of the initials: an icon, a placeholder for someone without a name. |
| `children` | `.child(..)` | `JSX.Element` | none | What shows over the picture: a presence dot, a badge. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The avatar itself: its size and shape. |

| Event | Rust | Payload | Description |
|---|---|---|---|
| `onStatusChange` | `.on_status_change(..)` | `{ status: AvatarStatus }` | The picture's status changed: `"idle"` (no `src`), `"loading"`, `"loaded"` or `"error"`. |

## Parts

| Part | Inside | Styled with |
|---|---|---|
| The avatar | | `class`, `style` |
| The fallback | the avatar, first, as large as it; there while the picture loads (after `fallbackDelay`), fails or is missing | `fallbackClass`, `fallbackStyle`; its content the initials or `fallback` |
| The picture | the avatar, over the fallback, filling it | `imageClass`, `imageStyle` |
| The app's content | the avatar, last | its own elements (`children`) |

Give the avatar its size (`class="size-10"`): the fallback and the picture fill it, so the fallback leaving lays
nothing out again. The picture is laid out from the start, transparent, and turns opaque once it has loaded; the fallback then leaves.
A `transition-opacity` in `imageClass` fades it in (reduced motion shows it at once). Round the picture and the
fallback (`rounded-full` on each) rather than clipping the avatar, so a presence dot placed at its edge
(`absolute bottom-0 right-0`) stays whole.

The initials are the first letters of the name's first two words, in upper case ("Ada Lovelace" is "AL"); a single
word gives its first two letters ("huacnlee" is "HU"), and a name in a script without letter case its first character
("王小明" is "王").

## Groups

```tsx
import { Text } from "nsh";
import { Avatar, AvatarGroup } from "nsh/base";

<AvatarGroup
  limit={3}
  total={members.length}
  accessibilityLabel={`${members.length} members`}
  class="flex-row"
  overflowClass="-ml-2 size-8 items-center justify-center rounded-full bg-muted ring-2 ring-background"
  overflowAccessibilityLabel={`${members.length - 3} more people`}
  overflow={<Text class="text-xs">{`+${members.length - 3}`}</Text>}
>
  <Each of={members.slice(0, 3)} key={(m) => m.id}>
    {(m, i) => <Avatar src={m().picture} name={m().name} class={i() > 0 ? "-ml-2 size-8" : "size-8"} />}
  </Each>
</AvatarGroup>
```

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `limit` | `.limit(..)` | `number` | `3` | At most this many of its avatars show, the first ones; the others make no views. |
| `total` | `.total(..)` | `number` | the number of children | How many people the group stands for, when the app passes only the first of them. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say of the group. |
| `overflowClass`, `overflowStyle` | `.overflow_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The overflow part, after the avatars shown. |
| `overflow` | `.overflow(..)` | `JSX.Element` | none | What stands for the people not shown ("+5", "⋯"), there while more than the avatars shown are in the group. |
| `overflowAccessibilityLabel` | `.overflow_accessibility_label(..)` | `string` | none | What screen readers say of the overflow in place of its content: "5 more people" for a "+5". |
| `children` | `.child(..)` | `JSX.Element` | none | The avatars, in order. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The row: its direction (`flex-row`) and spacing. |

The overlap, the rings and the overflow's shape are the app's: a negative margin on every avatar after the first
(`-ml-2`) stacks them, and a ring of the background's color separates them. For a long list, pass the first `limit`
people and `total`: only the avatars shown are made.

## Accessibility

- An avatar is one image for screen readers, labelled with `accessibilityLabel` or `name`: the name is said once. The
  fallback and the picture are hidden from them, so the initials are not read apart. An avatar with neither, or with `accessibilityLabel=""`, is decorative: hidden from screen readers, as an
  avatar beside the name it shows should be.
- A group is a group, labelled with its `accessibilityLabel` ("Ada, Grace and 5 others"); the avatars shown are images
  inside it. The overflow is read as its content ("+5"), or as `overflowAccessibilityLabel` ("5 more people") when the
  app gives one: NSH writes no words of its own.
- Neither takes presses or keyboard focus: put an avatar in a `Button` to make it one.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- Every platform loads the picture with its own image loader and caches (see [Image](./image.md)); its load and error
  events change the avatar's state in Rust, so a loading or failed picture changes the picture and the fallback and
  nothing else.
- The picture starts loading once it has a frame, so it stays laid out while transparent.
