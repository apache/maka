---
title: Link
description: "The Link component: content that goes somewhere when pressed, a page, a site or a route of the app, with presses, keyboard activation, the disabled state and the link role for screen readers, styled by the app."
group: base
demo: el-link
---

# Link

A link takes the user somewhere: a web page, another app (`mailto:`, `tel:`), or a screen of the app itself. It owns
the behavior: presses, Return and Space while it has the keyboard focus, the disabled state, and the link role for
screen readers. The look is the app's: a `Link` has no color, underline or label of its own, and its children are what
shows. `href` says where it goes; it is data for the opening, and the URL the desktops show while the pointer rests on
the link ([Where it goes](#where-it-goes)).

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

`Link` comes from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. In Rust, `link()` makes one
with a setter per prop (`.href(..)`, `.open_with(..)`), a listener per event (`.on_open(..)`, `.on_press(..)`), the
typed style methods for the link and `.child(..)` for its content.

## Opening

A press, a click, or Return or Space on the focused link opens its `href`:

1. `onOpen({ href })` reports where it goes.
2. With `openWith="system"` (the default), a URL of another app or site, one with a scheme (`https:`, `mailto:`,
   `tel:`, a scheme another app registered), opens outside the app, as [`openUrl`](../modules/nsh.md) opens it: the
   embedding app's router takes it first, then the system does. Any other `href`, a path of the app's (`/orders/42`)
   or `#anchor`, is reported and stays with the app.
3. `onPress()` reports the press.

With `openWith="app"`, the app's `onOpen` handler is how the link opens: a route of its own, a page in an in-app web
view, a confirmation first.

```tsx
import { Link } from "nsh/base";

<Link href={`/orders/${order.id}`} openWith="app" onOpen={({ href }) => router.push(href)} class="text-primary">
  <Text>Order #{order.id}</Text>
</Link>
```

Opening a URL outside the app takes the `openUrl` capability when the app declares capabilities in `nsh.json`
(`"openUrl": true`, or `{ "schemes": ["https", "mailto"] }`).

## Where it goes

On the desktops (macOS, Windows, Linux, GPUI) and the web in the desktop idiom, the pointer resting on a link for half a
second shows where it goes, as a mail app or a browser's status bar does: a hint below the link with its destination,
until the pointer leaves or presses it. The keyboard moving the focus to a link (Tab) shows it too. A user checks the
destination before following it, whatever the link's text says.

- The destination is one line, left to right in a right-to-left app too. A URL shows as it is parsed: an international host in its ASCII form
  (`https://xn--mnchen-3ya.de`), so a letter of another script passing for a Latin one shows as what it is, and the
  host after a `user@`, a long `user:password@` shortened so the host stays in view.
- The scheme, the host and the port always show whole, at their full width, also for an IPv6 host
  (`http://[2001:db8::1]:8080`) or a long host. A long path and query lose their middle to an ellipsis, keeping their
  start and end (`https://docs.example.com/guides/getting-…arch=arm64#verify`); in a window too narrow for the line,
  only the path and query give way, again in their middle.
- A scheme-relative URL (`//cdn.example.com/lib.js`) shows its host the same way. A path of the app's (`/settings`,
  `docs/intro`) or an `#anchor` shows as written, with control, bidirectional and invisible characters as
  percent-escapes. A disabled link shows no hint.
- A link's `title` shows above the destination in the same hint (`<Link href="https://nsh.dev/docs" title="The
  guide">`). It is optional: without it the hint shows the destination alone. It names the page; the link's content
  and `accessibilityLabel` are still what it reads as.
- Links in text show it the same way: a [TextView](./text-view.md) document's links show their Markdown title
  (`[docs](https://example.com "The guide")`) above the destination.
- An app's [`tooltip`](./tooltip.md) on a link is a separate overlay of its own, not the link's title. It shows above by
  default and the destination below, so they usually sit apart; either can flip to the other side near a window's
  edge, and then they may overlap.

The hint draws with the theme's popover tokens (`popover`, `border`, `muted-foreground` for the URL), so every app
gives its users this check.

## Props

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `href` | `.href(..)` | `string` | none | Where the link goes: a URL, or a path of the app's. Reported with `onOpen`, and shown as the link's hint on the desktops. |
| `title` | `.title(..)` | `string` | none | What the linked page is called: shown above the destination in the link's hint. Optional. |
| `openWith` | `.open_with(LinkOpenWith::App)` | `"system" \| "app"` (`LinkOpenWith`) | `"system"` | Who opens `href`: the system opens a URL of another app or site; `"app"` leaves it to `onOpen`. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses, no press feedback, no keyboard focus; `disabled:` styles apply, and screen readers say it is dimmed. |
| `current` | `.current(..)` | `boolean` | `false` | The link to the page the user is on, in a navigation or a breadcrumb: screen readers say it is the current page. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say, when the content says too little (an icon). |
| `hitSlop` | `.hit_slop(..)` | `number \| Partial<Edges>` | none | How far outside its bounds presses still count, in points: one number for every side, or the sides named. As a view's `hitSlop`. |
| `children` | `.child(..)` | `JSX.Element` | none | The content: a label, an icon, anything the app shows. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The link's look: its color, underline, padding; text properties pass to the texts inside it. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | The link's style while pressed, hovered, focused or disabled, as the `<state>:` classes. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onOpen` | `.on_open(\|href: &SharedString\| ..)` | The link opens `href`: with `openWith="app"` the handler opens it, with `"system"` it hears what the system was asked to open. It comes before `onPress`. |
| `onPress` | `.on_press(\|\| ..)` | The link was pressed: a tap, a click, or Return or Space while it has the keyboard focus. |

A disabled link reports nothing, and a press on it reaches no pressable view around it.

## States

The app styles each state with classes or style props:

```tsx
<Link
  href="https://example.com/changelog"
  class="self-start text-primary underline decoration-primary/40 transition-colors hover:decoration-primary active:opacity-70 focus-visible:outline-2 focus-visible:outline-ring disabled:text-muted-foreground disabled:no-underline"
>
  <Text>Changelog</Text>
</Link>
```

A visited link is the app's to remember: it keeps the hrefs it opened and styles those links by its own state.

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

## Inside text

A `Link` inside a `<Text>` is an inline box of the paragraph, as every view inside a text is: it sits in the line,
keeps its own states, focus and role, and stays on one line. `align-text-bottom` places a link with one line of text on
the paragraph's baseline:

```tsx
<Text class="text-[15px] text-foreground">
  By continuing you accept the{" "}
  <Link href="https://example.com/terms" class="align-text-bottom">
    <Text class="text-[15px] text-primary underline">terms of service</Text>
  </Link>
  .
</Text>
```

A link that wraps with the paragraph's lines is a nested `<Text>` with `role="link"` and `onPress` (see
[Text](./text.md)), as [TextView](./text-view.md) draws the links of a document.

## A small target with hitSlop

A link can be smaller than a finger: an icon, a short word. `hitSlop` makes presses that land near it count, in points
past each side, without changing its layout or its look: one number for every side, or the sides named
(`{ top: 8, bottom: 8 }`), as a [view's `hitSlop`](./index.md#presses-and-feedback) takes them.

```tsx
<Link href="https://example.com/help" hitSlop={12} accessibilityLabel="Help" class="size-5 items-center justify-center">
  <Text>?</Text>
</Link>
```

## Accessibility

- A link is one element for screen readers, with the role `"link"`; its label is the text of its children, or
  `accessibilityLabel`. `href` stays data: screen readers say the label.
- `current` is said as the current page (ARIA's `aria-current="page"`), and `disabled` as the platform says a dimmed
  element.
- On macOS and the web a link is a stop of the keyboard focus: Tab reaches it, Return and Space open it, and `focus-visible:`
  styles show where the focus is.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Platform notes

- iOS, Android and Mac Catalyst: a press is a tap that ends on the link.
- Desktops (macOS, Windows, Linux, GPUI) and the web: a press is a click. On macOS and the web, Return and Space also
  open the link that has the keyboard focus. The pointer resting on a link shows its URL ([Where it
  goes](#where-it-goes)).
- The web renders a link with an `href` as an `<a href>` (crawlers follow it; a click with a modifier key or the
  middle button opens it in a new tab, and a right click shows the browser's menu for links), one without as an
  element with `role="link"`.
- Terminal: the text inside an enabled link whose `href` is a URL (not a path of the app's) is an OSC 8 hyperlink
  to it, which the terminal emulator opens itself on a modified click, outside `openWith`. The Linux console
  (`TERM=linux`) shows plain text.
- Every platform draws what the app styles.
