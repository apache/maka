---
title: ColorPicker
description: "The ColorPicker component and its parts: a color picked on a saturation and brightness area, on sliders of any channel of RGB, HSL, HSB or OKLCH and of the alpha, typed in any CSS form, chosen from swatches or picked on the screen with an eyedropper, with WAI-ARIA's keys and adjustable elements for screen readers, laid out and styled by the app."
group: base
demo: el-color-picker
---

# ColorPicker

A color picker holds one color, and the parts inside it show and change it: a `ColorArea` of saturation and
brightness, `ColorSlider`s of any channel of RGB, HSL, HSB or OKLCH and of the alpha, `ColorField`s that take the
color as text or one channel as a number, `ColorSwatch`es of preset colors and a `ColorEyeDropper` that picks a color
anywhere on the screen. The app lays the parts out with its
own elements in between (a row per channel with its letter, the space picked with `Tabs`, the picker in a `Popover`),
and styles each of them: the parts draw the colors of the channels, and every size, radius, border and shadow is the
app's.

```rust tabs
use nsh_base::{
    ColorChannel, ColorPickerEvent, ColorSpace, color_area, color_field, color_picker,
    color_slider, color_swatch, theme,
};
use nsh_core::prelude::*;

fn primary(color: Signal<Hsla>) -> impl IntoElement {
    // A channel of OKLCH: its letter, its slider, its number.
    let channel = move |channel: ColorChannel, letter: &'static str| {
        view()
            .flex_row()
            .items_center()
            .gap_2()
            .child(text(letter).w(px(14.0)).text_sm().text_color(move || theme().muted_foreground))
            .child(
                color_slider()
                    .color_space(ColorSpace::Oklch)
                    .channel(channel)
                    .accessibility_label(letter)
                    .flex_1()
                    .h(px(18.0))
                    .justify_center()
                    .px(px(8.0))
                    .track_style(|s| s.h(px(10.0)).rounded_full())
                    .thumb_style(|s| s.size(px(16.0)).rounded_full().border_2().border_color(white()))
                    .fill_thumb(true),
            )
            .child(
                color_field()
                    .color_space(ColorSpace::Oklch)
                    .channel(channel)
                    .accessibility_label(letter)
                    .w(px(64.0))
                    .h(px(28.0))
                    .px_2()
                    .rounded_md()
                    .border_1()
                    .border_color(move || theme().border)
                    .text_sm(),
            )
    };
    color_picker()
        .value(move || Some(color.get()))
        .on_change(move |e: &ColorPickerEvent| {
            if let ColorPickerEvent::Change(value, _) = e {
                color.set(*value);
            }
        })
        .gap_3()
        .child(
            color_area()
                .accessibility_label("Saturation and brightness")
                .h(px(160.0))
                .panel_style(|s| s.rounded_lg())
                .thumb_style(|s| s.size(px(18.0)).rounded_full().border_2().border_color(white()))
                .fill_thumb(true),
        )
        .child(channel(ColorChannel::Lightness, "L"))
        .child(channel(ColorChannel::Chroma, "C"))
        .child(channel(ColorChannel::Hue, "H"))
        .child(color_swatch().size(px(28.0)).rounded_md())
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { type ColorChannel, ColorArea, ColorField, ColorPicker, ColorSlider, ColorSwatch } from "nsh/base";

const thumb = "rounded-full border-2 border-white";

function Channel(props: { channel: ColorChannel; letter: string }) {
  return (
    <View class="flex-row items-center gap-2">
      <Text class="w-[14px] text-sm text-muted-foreground">{props.letter}</Text>
      <ColorSlider
        colorSpace="oklch"
        channel={props.channel}
        accessibilityLabel={props.letter}
        class="flex-1 h-[18px] justify-center px-2"
        trackClass="h-[10px] rounded-full"
        thumbClass={`size-4 ${thumb}`}
        fillThumb
      />
      <ColorField
        colorSpace="oklch"
        channel={props.channel}
        accessibilityLabel={props.letter}
        class="w-16 h-7 px-2 rounded-md border border-border text-sm text-right"
      />
    </View>
  );
}

function App() {
  const primary = signal("oklch(54.6% 0.215 262.9)");
  return (
    <ColorPicker value={primary()} format="oklch" onChange={({ formatted }) => primary.set(formatted)} class="gap-3">
      <ColorArea accessibilityLabel="Saturation and brightness" class="h-40" panelClass="rounded-lg" thumbClass={`size-[18px] ${thumb}`} fillThumb />
      <Channel channel="lightness" letter="L" />
      <Channel channel="chroma" letter="C" />
      <Channel channel="hue" letter="H" />
      <View class="flex-row items-center gap-2">
        <ColorSwatch class="size-7 rounded-md" />
        <Text class="font-mono text-sm">{`--primary: ${primary()}`}</Text>
      </View>
    </ColorPicker>
  );
}

mount(App);
```

`ColorPicker`, `ColorArea`, `ColorSlider`, `ColorField`, `ColorSwatch` and `ColorEyeDropper` come from [`nsh/base`](../modules/nsh-base.md),
the `nsh-base` crate in Rust. In Rust, `color_picker()` and its parts' functions make them with a setter per prop
(`.channel(..)`, `.thumb_style(..)`), a listener method per event (`.on_change(..)`) and the typed style methods; the
color is an `Hsla`, the spaces, channels and formats are `ColorSpace`, `ColorChannel` and `ColorFormat`.

## Value

The color is a CSS color: hex (`#3b82f6`, `#3b82f680` with its alpha), `rgb()`, `hsl()`, `hsb()`, `oklch()` or a CSS
name; in Rust an `Hsla`. The app owns it with `value` and sets the one `onChange` reports, as for every control of
`nsh/base`; or it leaves the color to the picker with `defaultValue` and hears the changes all the same.

- `onChange({ value, formatted })` reports each color the user asks for: at each step of a drag on the area or a slider,
  for each key, a field's number as it is typed, a swatch pressed. `value` is the color, `formatted` the same color
  written as `format` says (`"hex"`, `"rgb"`, `"hsl"`, `"hsb"` or `"oklch"`), ready to save or to set as a token.
- `onChangeEnd({ value, formatted })` reports the color the change ended at, once: when the pointer lifts, after each key,
  when a field is left or submitted, when a swatch is pressed.
- The picker keeps the color in each space as the user set it. A gray keeps its hue and saturation, so the hue slider
  stays where the user left it; a color edited in OKLCH keeps its lightness, chroma and hue as typed, also past what
  sRGB shows (the color reported is the nearest one sRGB shows, and `formatted` in `"oklch"` keeps the channels).
- A `value` the app sets that the picker did not report replaces the color in every space.

## Spaces and channels

| `colorSpace` | Channels (`channel`) | Ranges |
|---|---|---|
| `"rgb"` | `"red"`, `"green"`, `"blue"` | 0 to 255 |
| `"hsl"` | `"hue"`, `"saturation"`, `"lightness"` | hue 0 to 360, the others 0 to 100 |
| `"hsb"` | `"hue"`, `"saturation"`, `"brightness"` | hue 0 to 360, the others 0 to 100 |
| `"oklch"` | `"lightness"`, `"chroma"`, `"hue"` | lightness 0 to 100 (by 0.1), chroma 0 to 0.4 (by 0.001), hue 0 to 360 (by 0.1) |
| any | `"alpha"` | 0 to 100 |

A slider's track draws its channel's colors with the other channels held, so it shows where each value leads. A
channel its space does not have is the space's first (a warning says so).

## Props

### ColorPicker

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `value` | `.value(..)` | `string` | none | The color (controlled). The app sets the one `onChange` reports. |
| `defaultValue` | `.default_value(..)` | `string` | `"#000000"` | The color at first while `value` is not set; the picker then keeps its own. |
| `format` | `.format(..)` | `"hex" \| "rgb" \| "hsl" \| "hsb" \| "oklch"` | `"hex"` | How `formatted` writes the color. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No changes from any part; `disabled:` classes apply to the picker and its parts. |
| `children` | `.child(..)` | `JSX.Element` | none | The parts and the app's elements between them. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The picker itself: the column (or row) around its parts. |

### ColorArea

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `panelClass`, `panelStyle` | `.panel_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The panel, filling the area: the hue's colors, saturation from left to right and brightness from bottom to top, clipped to its corners. |
| `thumbClass`, `thumbStyle` | `.thumb_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The thumb, centered on the color. |
| `fillThumb` | `.fill_thumb(..)` | `boolean` | `false` | The thumb's background is the color. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No pointer, keyboard or screen reader changes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say for the thumb. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The area: its size is the app's. |

### ColorSlider

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `colorSpace` | `.color_space(..)` | `"rgb" \| "hsl" \| "hsb" \| "oklch"` | `"hsb"` | The space of the channel. |
| `channel` | `.channel(..)` | `ColorChannel` | `"hue"` | The channel it changes: one of the space's, or `"alpha"`. |
| `axis` | `.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | The track's direction: the smallest value at the left, or at the bottom. Read when the slider is made. |
| `trackClass`, `trackStyle` | `.track_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The track: the channel's colors along it, clipped to its corners; the thumb is placed on it. |
| `thumbClass`, `thumbStyle` | `.thumb_style(\|s\| ..)` | `string`, `StyleProp<ViewStyle>` | none | The thumb, centered on the value. |
| `fillThumb` | `.fill_thumb(..)` | `boolean` | `false` | The thumb's background is the color (with its alpha on an alpha slider). |
| `checkerboardColor` | `.checkerboard_color(..)` | `string` | none | The color of a checkerboard under the track, which shows through an alpha slider's colors. |
| `checkerboardSize` | `.checkerboard_size(..)` | `number` | `4` | The side of the checkerboard's squares. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No pointer, keyboard or screen reader changes. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say for the thumb. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The slider: the band around the track that takes presses and drags. |

### ColorField

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `channel` | `.channel(..)` | `ColorChannel` | none | The channel it takes as a number. Without it, the field takes the whole color as text. |
| `colorSpace` | `.color_space(..)` | `ColorSpace` | `"hsb"` | The space of `channel`. |
| `format` | `.format(..)` | `ColorFormat` | `"hex"` | How the field writes the whole color. It reads any CSS form. |
| `placeholder` | `.placeholder(..)` | `string` | none | Shown while the field is empty. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No typing. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say for the field. |
| `class`, `style` | style methods | `string`, `StyleProp<TextStyle>` | none | The field, a text input. |

A channel's field changes the color as a number is typed, held to the channel's range; the whole color's field changes
it when the field is left or submitted, if the text reads as a color. Leaving a field writes its value again in its
form.

### ColorSwatch

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `color` | `.color(..)` | `string` | none | The color it shows; a press picks it in the picker around it. Without it, the picker's own color: a preview. |
| `selectedStyle` | `.selected_style(..)` | `StyleProp<ViewStyle>` | none | The style while it is the picker's color, as `selected:` classes. |
| `checkerboardColor` | `.checkerboard_color(..)` | `string` | none | A checkerboard under a translucent color. |
| `checkerboardSize` | `.checkerboard_size(..)` | `number` | `4` | The side of its squares. |
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | the color in hex | What screen readers say. |
| `children` | `.child(..)` | `JSX.Element` | none | Content over the color: a check on the selected swatch (`group-selected:`). |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The swatch: its size, shape and border; its corners clip the color. |

### ColorEyeDropper

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `disabled` | `.disabled(..)` | `boolean` | `false` | No presses. It is disabled too where the platform has no eyedropper. |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | none | What screen readers say. |
| `children` | `.child(..)` | `JSX.Element` | none | Its content: the app's icon or label. |
| `class`, `style` | style methods | `string`, `StyleProp<ViewStyle>` | none | The button. |

A press shows the system's eyedropper: AppKit's color sampler on macOS, the browser's `EyeDropper` on the web (Chrome
and Edge). The color picked becomes the picker's (`onChange`, then `onChangeEnd`); Escape picks none. Where the platform
has no eyedropper the button is disabled, and `disabled:hidden` hides it there.

## Events

| Event | Of | Rust | Payload | When |
|---|---|---|---|---|
| `onChange` | `ColorPicker` | `.on_change(\|e: &ColorPickerEvent\| ..)` | `({ value: string, formatted: string })` | The user changed the color. |
| `onChangeEnd` | `ColorPicker` | `.on_change_end(\|e: &ColorPickerEvent\| ..)` | `({ value: string, formatted: string })` | The change ended. Once per change. |
| `onPress` | `ColorSwatch` | `.on_press(\|color: &Hsla\| ..)` | `({ color: string })` | The swatch was pressed; it works alone too, as a palette's chip. |
| `onPick` | `ColorEyeDropper` | `.on_pick(\|color: &Hsla\| ..)` | `({ color: string })` | The user picked a color on the screen; it works alone too. |

In Rust, `ColorPickerEvent::Change(Hsla, SharedString)` and `ColorPickerEvent::ChangeEnd(Hsla, SharedString)` carry the
color and its `formatted` text.

## Parts

| Part | Inside | Styled with |
|---|---|---|
| `ColorArea` | the picker | `class`, `style` |
| The area's panel | the area, filling it | `panelClass`, `panelStyle` |
| The area's thumb | the area, centered on the color | `thumbClass`, `thumbStyle` |
| `ColorSlider` | the picker | `class`, `style` |
| The slider's track | the slider | `trackClass`, `trackStyle` |
| The slider's thumb | the slider, centered on the value on the track | `thumbClass`, `thumbStyle` |
| `ColorField` | the picker | `class`, `style` |
| `ColorSwatch` | the picker, or alone | `class`, `style`, `selectedStyle` |
| `ColorEyeDropper` | the picker, or alone | `class`, `style` |

A slider's thumb is centered on the track's ends at the channel's ends. Padding on the slider of half the thumb's
width (`h-6 justify-center px-2.5` around an `h-3` track) keeps the whole thumb inside the slider, where it takes
presses at both ends. States the parts show: a thumb's `active:` while it is dragged and `focus:` with the keyboard
focus, a swatch's `selected:`, and every part's `disabled:`.

## Keyboard

On macOS and the web each thumb is a stop of the keyboard focus (Tab):

| Key | On a slider | On the area |
|---|---|---|
| Right, Up | One step up | Right: more saturation; Up: more brightness |
| Left, Down | One step down | Left: less saturation; Down: less brightness |
| Shift with an arrow | Ten steps | Ten steps |
| Page Up, Page Down | Ten steps | Ten steps of brightness |
| Home, End | The channel's ends | |

A swatch takes Space and Return. Each key reports `onChange` and then `onChangeEnd`; arrows repeat while held.

## Accessibility

- The area's and each slider's thumb are adjustable elements (`"adjustable"`, a slider in the browser) with their
  label, value and range; screen readers' increment and decrement step them.
- Each field is a text field with its label; each swatch a button, selected while it is the picker's color, named by
  its color in hex unless `accessibilityLabel` names it. The eyedropper is a button with the app's label.
- While disabled, screen readers say the parts are dimmed, and they take no actions.

See [Accessibility](../docs/accessibility.md) for labels, roles and actions in general.

## Platform notes

- Every platform draws what the app styles; the tracks' and the panel's colors are gradients drawn by the platform.
  Presses and drags are followed in the core, for a mouse, a pen or a finger, and a scroll view around the picker
  keeps its scrolling to drags that start elsewhere.
- `ColorEyeDropper` picks with AppKit's color sampler on macOS and the browser's `EyeDropper` on the web; the color
  arrives in sRGB.
