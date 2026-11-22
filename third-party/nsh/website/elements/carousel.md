---
title: Carousel
description: "Carousel and its parts: slides shown one place at a time, moved by swiping, the wheel and the touchpad on the platform's own scrolling, by previous and next controls, a pagination and the keyboard, around the ends seamlessly. The carousel owns which slide shows, snapping, looping, the keys and accessibility; the look and every label are the app's."
group: base
demo: el-carousel
---

# Carousel

A carousel shows slides one place at a time: the photos of a product, the steps of an onboarding, a banner that moves
on by itself, a row of cards. `Carousel` owns the behavior: which slide shows, swiping between them, the previous and
next controls, a pagination, the arrow keys, going around the ends, and what screen readers hear. Its parts find it through
context, so the app arranges them freely in its own layout. The look is the app's: no colors, sizes, arrows, dots or
labels of its own.

The content is a native scroll view. A finger, the wheel and the touchpad move the slides on the platform's main
thread, in the same frame as the pointer, and on release the content snaps to the nearest slide, one slide per fling.
When it comes to rest the carousel reports the slide with `onChange`. The controls, the pagination, the keys and the
app's `index` scroll the content natively to the slide, animated.

```rust tabs
use nsh_base::{
    carousel, carousel_content, carousel_item, carousel_next, carousel_pagination,
    carousel_pagination_item, carousel_previous, theme,
};
use nsh_core::prelude::*;

fn photos() -> impl IntoElement {
    let index = signal(0u32);
    let names = ["Harbor", "Dunes", "Glacier"];
    carousel()
        .index(move || Some(index.get()))
        .on_change(move |i: &u32| index.set(*i))
        .accessibility_label("Photos")
        .gap_3()
        .child(
            carousel_content().w_full().h(px(180.0)).gap_3().child(
                names
                    .iter()
                    .enumerate()
                    .map(|(i, name)| {
                        carousel_item()
                            .accessibility_label(format!("{} of 3: {name}", i + 1))
                            .w_full()
                            .rounded(move || theme().radius)
                            .bg(move || theme().muted)
                            .items_center()
                            .justify_center()
                            .child(text(*name))
                    })
                    .collect::<Vec<_>>(),
            ),
        )
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_2()
                .child(carousel_previous().accessibility_label("Previous photo").child(text("‹")))
                .child(
                    carousel_pagination()
                        .flex_row()
                        .gap_1()
                        .child(
                            (0..3)
                                .map(|i| {
                                    carousel_pagination_item()
                                        .index(i)
                                        .accessibility_label(format!("Photo {}", i + 1))
                                        .size_2()
                                        .rounded_full()
                                        .bg(move || theme().border)
                                        .selected_style(|s| s.bg(move || theme().primary))
                                })
                                .collect::<Vec<_>>(),
                        ),
                )
                .child(carousel_next().accessibility_label("Next photo").child(text("›"))),
        )
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import {
  Carousel,
  CarouselContent,
  CarouselItem,
  CarouselNext,
  CarouselPagination,
  CarouselPaginationItem,
  CarouselPrevious,
} from "nsh/base";

const NAMES = ["Harbor", "Dunes", "Glacier"];

function App() {
  const index = signal(0);
  return (
    <Carousel index={index()} onChange={({ index: next }) => index.set(next)} accessibilityLabel="Photos" class="gap-3">
      <CarouselContent class="h-[180px] w-full gap-3">
        {NAMES.map((name, i) => (
          <CarouselItem
            accessibilityLabel={`${i + 1} of ${NAMES.length}: ${name}`}
            class="w-full items-center justify-center rounded-(--radius) bg-muted"
          >
            <Text>{name}</Text>
          </CarouselItem>
        ))}
      </CarouselContent>
      <View class="flex-row items-center gap-2">
        <CarouselPrevious accessibilityLabel="Previous photo" class="disabled:opacity-40">
          <Text>‹</Text>
        </CarouselPrevious>
        <CarouselPagination class="flex-row gap-1">
          {NAMES.map((_, i) => (
            <CarouselPaginationItem
              index={i}
              accessibilityLabel={`Photo ${i + 1}`}
              class="size-2 rounded-full bg-border selected:bg-primary"
            />
          ))}
        </CarouselPagination>
        <CarouselNext accessibilityLabel="Next photo" class="disabled:opacity-40">
          <Text>›</Text>
        </CarouselNext>
      </View>
    </Carousel>
  );
}

mount(App);
```

`Carousel` and its parts come from [`nsh/base`](../modules/nsh-base.md), the `nsh-base` crate in Rust. The slide
shown is the app's `index`: a swipe, a control or a key reports the next one with `onChange`, and the
carousel scrolls to the `index` the app passes back. The slide a swipe rests on shows until the app has answered its
`onChange`: it stays when the app passes it back as `index`, and the content springs back to the app's slide,
animated, when the app keeps the `index` it had. Without `index` the carousel keeps its own, from `defaultIndex`. In Rust,
`carousel()`, `carousel_content()`, `carousel_item()`, `carousel_previous()`, `carousel_next()`,
`carousel_pagination()` and `carousel_pagination_item()` make the parts, with a setter per prop
(`.index(..)`), a listener per event (`.on_change(..)`), the typed style methods and `.child(..)` for their content.

## Props

### Carousel

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `index` | `.index(..)` | `number` | none | The slide shown, from 0, held to the slides there are. The app owns it: changes are reported with `onChange`, and a new `index` scrolls there, animated. |
| `defaultIndex` | `.default_index(..)` | `number` | `0` | The slide shown at first, while `index` is not set. |
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | The direction the slides follow each other; read when the carousel is made. A vertical carousel's arrow keys are Up and Down. |
| `looping` | `.looping(..)` | `boolean` | `false` | The slides go around: after the last comes the first, and before the first the last, seamlessly, for a swipe, previous, next, the keys and the app's `index` alike ([Looping](#looping)). Read when the carousel is made. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the carousel, a region: what its slides are (`"Featured products"`). |
| `children` | `.child(..)` | `JSX.Element` | none | The `CarouselContent`, the controls and whatever the app lays out around them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The carousel's layout: where the content and the controls go. |

### CarouselContent

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | none | The `CarouselItem`s, each a child of the content. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The viewport's size, and the track the slides make in it: a `gap` between them, padding that shows a peek of the slides beside the one in view. |

### CarouselItem

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the slide, a group: its place among the others and what it shows (`"2 of 5: Ocean view"`). |
| `children` | `.child(..)` | `JSX.Element` | none | The slide's content. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Its size along the axis (`w-full` for one slide per view, `basis-1/3` for three) and its look. In a carousel that loops, its translation is the carousel's: put a `transform` on a view inside it. |

### CarouselPrevious, CarouselNext

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | The control's name, when its children have no text that says it (an arrow icon). |
| `children` | `.child(..)` | `JSX.Element` | none | The app's icon or label. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Its look and place: beside the content, or `absolute` over its edge. |
| `activeStyle`, `hoverStyle`, `focusStyle`, `disabledStyle` | `.active(\|s\| ..)`, `.hover(..)`, `.focus(..)`, `.disabled_style(..)` | `StyleProp<ViewStyle>` | none | Its style while pressed, hovered, focused, or disabled at an end, as the `<state>:` classes. |

### CarouselPagination

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers call the group of pagination items (`"Choose a slide"`). |
| `indicatorClass` | `.indicator_class(..)` | `string` | none | The Tailwind classes of the indicator, a view on the item of the slide shown (a pill behind the dots, an underline): its look and its place across the row (`inset-y-0`, `bottom-0 h-0.5`). Along the row it spans that item and springs to the next one natively. |
| `indicatorStyle` | `.indicator_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | The style of the indicator, over `indicatorClass`. With neither, the pagination has no indicator. |
| `children` | `.child(..)` | `JSX.Element` | none | The `CarouselPaginationItem`s, and whatever the app lays out between them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The row's layout (`flex-row gap-2`). |

### CarouselPaginationItem

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `index` | `.index(..)` | `number` | required | The slide it shows, from 0. An index past the last slide is disabled. |
| `selectedStyle` | `.selected_style(\|s\| ..)` | `StyleProp<ViewStyle>` | none | Its style while its slide shows, as `selected:` classes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | Which slide it shows (`"Slide 3"`), when its children have no text that says it (a dot). |
| `children` | `.child(..)` | `JSX.Element` | none | The app's dot, thumbnail or number. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | Its look; `group-selected:` classes inside it follow it under `group`. |

## Events

| Event | Rust | Description |
|---|---|---|
| `onChange` (`Carousel`) | `.on_change(\|index: &u32\| ..)` | The user moved to another slide: a swipe, the wheel or the touchpad came to rest on it, or a control, a pagination item or a key asked for it. `{ index }` is that slide. A new `index` from the app reports nothing. |
| `onDragStart` (`Carousel`) | `.on_drag_start(\|\| ..)` | The user started dragging the content (a finger, the touchpad). |
| `onDragEnd` (`Carousel`) | `.on_drag_end(\|\| ..)` | The content the user dragged came to rest. |
| `onFocus` (`Carousel`) | `.on_focus(\|\| ..)` | The keyboard focus came into the carousel: to its own view, its previous or next control, a pagination item or a focusable view in a slide. Moving between them reports nothing. |
| `onBlur` (`Carousel`) | `.on_blur(\|\| ..)` | The keyboard focus left the carousel: its own view, its controls, its pagination items and the slides' content. |

## Parts

| Part | Inside | Styled with | States |
|---|---|---|---|
| The carousel | | `Carousel`'s `class`, `style` | `focus:` |
| The content | the carousel | `CarouselContent`'s `class`, `style` | |
| A slide | the content | `CarouselItem`'s `class`, `style` | |
| Previous, next | the carousel | their `class`, `style` | `disabled:`, `active:`, `hover:`, `focus:` |
| The pagination | the carousel | `CarouselPagination`'s `class`, `style` | |
| The indicator | the pagination | `indicatorClass`, `indicatorStyle` | |
| A pagination item | the pagination | its `class`, `style` | `selected:`, `disabled:`, `active:`, `hover:`, `focus:` |

## Several slides per view

A slide's width is its own class's, so a row of cards is several slides in the viewport. Each slide is a snap point
where it starts: the content rests with that slide where the first one rests, so a padding before the first is kept
before each. At the end of the range the slides that cannot reach that place rest with the last one, and next stops
there. `index` names the slide in the first place; the slides that rest with the last one show the same place, and a
swipe there reports the first of them:

```tsx
<Carousel accessibilityLabel="Collections">
  <CarouselContent class="w-full gap-4 px-4">
    <Each of={collections()}>
      {(c) => (
        <CarouselItem class="basis-1/3">
          <Card collection={c()} />
        </CarouselItem>
      )}
    </Each>
  </CarouselContent>
</Carousel>
```

`basis-1/2` at a phone's width, or `basis-[85%]`, shows a peek of the next card. A vertical carousel
(`axis="vertical"`) sizes its slides by their height.

## Looping

With `looping`, the slides go around seamlessly: after the last comes the first, swiped, stepped with next or the
keys, or set by the app's `index`, with no rewind across the slides between. The content keeps room of a whole turn
of slides before and after them, and draws each slide where it is nearest the middle of the view; the animation runs
this on the platform's own frames, with the scroll. Each slide is there once: screen readers and the pagination see
it once.

The loop is seamless while the slides span the viewport and one slide more (three full-width slides, or five a
third wide). With fewer, previous, next and the keys still go around, scrolling back across the slides.

## Slides that move on by themselves

A banner that rolls on is the app's: a timer that sets `index`. The carousel reports when the user is at it, so the
timer waits then, as the [WAI-ARIA carousel pattern](https://www.w3.org/WAI/ARIA/apg/patterns/carousel/) asks:
`onDragStart` / `onDragEnd` around a drag, `onFocus` / `onBlur` while the keyboard focus is in the carousel (on it,
its controls, its pagination or the slides' content), and the pointer over a view around it. Leave it off with reduced motion, and give users a button that stops it (the rotation
control):

```tsx
import { cleanup, effect, reduceMotion, signal, Text, View } from "nsh";
import { Button, Carousel, CarouselContent } from "nsh/base";

const index = signal(0);
const playing = signal(true);
const held = signal(0);
const hold = (on: boolean) => held.set(held() + (on ? 1 : -1));

effect(() => {
  index();
  if (!playing() || held() > 0 || reduceMotion()) return;
  const timer = setInterval(() => index.set((index() + 1) % SLIDES.length), 4000);
  cleanup(() => clearInterval(timer));
});

<View onMouseEnter={() => hold(true)} onMouseLeave={() => hold(false)}>
  <Carousel
    looping
    index={index()}
    onChange={({ index: next }) => index.set(next)}
    onDragStart={() => hold(true)}
    onDragEnd={() => hold(false)}
    onFocus={() => hold(true)}
    onBlur={() => hold(false)}
    accessibilityLabel="Highlights"
  >
    <CarouselContent class="w-full">{/* the slides */}</CarouselContent>
    <Button onPress={() => playing.set(!playing())} class="self-start px-3 py-1">
      <Text>{playing() ? "Pause slides" : "Play slides"}</Text>
    </Button>
  </Carousel>
</View>
```

Reading `index()` in the effect starts a whole interval again after each change, the user's included. With
`looping`, going from the last slide to the first moves forward across the seam.

## Accessibility

- The carousel is a region named by `accessibilityLabel`; each slide is a group named by its own (its place among the
  others and what it shows).
- Previous and next are buttons, disabled at the ends unless the carousel loops; each pagination item is a button,
  selected while its slide shows.
- Every label is the app's, in the app's language.
- A looping carousel's slides are each there once, wherever they are drawn.

See [Accessibility](../docs/accessibility.md) for labels, roles and announcements in general.

## Keyboard

On macOS and the web, where Tab reaches the views that take presses, the carousel is a stop of the keyboard focus,
and so are its controls and pagination items. While one of them has the focus:

| Key | What it does |
|---|---|
| Left, Right (Up, Down when vertical) | Moves to the previous or the next slide, around the ends while looping. |
| Home, End | Moves to the first or the last slide. |
| Space, Return | Presses the focused control or pagination item. |

In a right-to-left layout a horizontal carousel's slides run from the right, so Left moves to the next slide and Right
to the previous; a vertical carousel keeps Up and Down. A control that turns disabled while it has the focus (next on
the last slide) hands the focus to the carousel, so the keys go on working there. Focusable views of the app's in the
slides keep their own keys: an input's arrows move its caret.

## Motion

- A swipe, the wheel and the touchpad move the slides with the pointer, in the same frame: the platform scrolls them.
- On release the content glides to the nearest slide, one slide per fling, as the platform snaps.
- Previous, next, a pagination item, a key and the app's `index` scroll the content to the slide, animated;
  with reduced motion, at once.
- The pagination's indicator springs to the item of the slide shown; with reduced motion it moves at once.
- `looping` goes from the last slide to the first one step forward, across the seam; once the content rests, it
  moves back by a whole turn without animation, which changes nothing on screen.

## Platform notes

- iOS, Android and Mac Catalyst: a finger swipes the slides; a tap presses a control.
- Desktops (macOS, Windows, Linux, GPUI) and the web: the wheel and the touchpad scroll the slides, and a click
  presses a control. A mouse drag over the content is the app's, as on every scroll view there.
- Every platform draws what the app styles: the slides, the controls, the pagination and its indicator.
