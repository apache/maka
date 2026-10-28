---
title: Video
description: "The Video element: native video playback with your own or the system's controls."
order: 10
group: primitives
demo: el-video
---

# Video

A video view plays a video file or stream with the platform's player: AVPlayer on iOS and Mac Catalyst, MediaPlayer on
Android. Playback is controlled with props (`paused`, `muted`, `rate`, …), so the player follows your state like any
other view. Rust makes one with `video(url)`, TSX with `<Video>` from `nsh`.

```rust tabs
use nsh_core::prelude::*;

fn player() -> impl IntoElement {
    let paused = signal(true);
    let time = signal(String::new());
    let player = element_ref();
    view()
        .gap_3()
        .child(
            video("https://example.com/clip.mp4")
                .element_ref(&player)
                .paused(paused)
                .repeat(true)
                .object_fit(ResizeMode::Contain)
                .h(px(220.0))
                .bg(black())
                .on_progress(move |p: &VideoProgress| {
                    time.set(format!("{:.1} / {:.1} s", p.current_time, p.duration))
                }),
        )
        .child(
            view()
                .flex_row()
                .gap_4()
                .child(
                    text(move || if paused.get() { "Play" } else { "Pause" })
                        .on_press(move || paused.update(|p| *p = !*p)),
                )
                .child(text("Restart").on_press(move || player.seek(0.0)))
                .child(text(move || time.get())),
        )
}
```

```tsx tabs
import { signal, Text, Video, View, type YNode } from "nsh";

function Player() {
  const paused = signal(true);
  const time = signal("");
  let video!: YNode;
  return (
    <View style={{ gap: 12 }}>
      <Video
        ref={video}
        src="https://example.com/clip.mp4"
        paused={paused()}
        repeat
        style={{ height: 220, backgroundColor: "#000000" }}
        onProgress={(e) => time.set(`${e.currentTime.toFixed(1)} / ${e.duration.toFixed(1)} s`)}
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Text onPress={() => paused.set(!paused())}>{paused() ? "Play" : "Pause"}</Text>
        <Text onPress={() => video.seek(0)}>Restart</Text>
        <Text>{time()}</Text>
      </View>
    </View>
  );
}
```

In TSX `src` is required (see the [Video API](../modules/nsh-video.md)). See the
[web view and video guide](../docs/web-view-and-video.md).

## Props

A video takes the props of a [view](./view.md) (it has no children) plus:

| Prop | Rust | Type | Default | Description |
|---|---|---|---|---|
| `src` | `video(url)` | `string` | | The video's URL (in Rust, an asset's `uri` too: `video(CLIP.uri)`). |
| `paused` | `.paused(..)` | `boolean` | `false` | Playback is paused. |
| `muted` | `.muted(..)` | `boolean` | `false` | No sound. |
| `volume` | `.volume(..)` | `number` | `1` | 0..1. |
| `rate` | `.rate(..)` | `number` | `1` | The playback speed. |
| `repeat` | `.repeat(..)` | `boolean` | `false` | Plays again from the start at the end. |
| `controls` | `.controls(..)` | `boolean` | `false` | Shows the platform's playback controls. |
| `objectFit` (style), `object-*` classes | `.object_fit(ResizeMode::Contain)` | `"cover" \| "contain" \| "fill" \| "none" \| "scale-down"` | `"contain"` | How the video fits its box, as CSS's `object-fit` (`class="object-cover"`). iOS, macOS and Android play `"none"` and `"scale-down"` as `"contain"`, Linux both as `"scale-down"`. |
| `progressUpdateInterval` | `.progress_interval(ms)` | `number` | `250` | Milliseconds between `onProgress` events. |

Give the video a size through its styles; its size is the one its styles give it. Use the size `onLoad` reports to set
an aspect ratio when you want the video's own proportions.

## Events

| Event | Rust | Payload | When |
|---|---|---|---|
| `onLoadStart` | `.on_load_start` | none | Loading began. |
| `onLoad` | `.on_load` | `{ duration, size }` (`VideoInfo`: `duration`, `size`) | The video is ready: its duration in seconds and its size in pixels. |
| `onProgress` | `.on_progress` | `{ currentTime, duration }` (`VideoProgress`: `current_time`, `duration`) | Every `progressUpdateInterval` while playing (seconds). |
| `onBuffer` | `.on_buffer` | `{ isBuffering }` (`bool`) | Playback stalled for data / resumed. |
| `onEnd` | `.on_end` | none | Playback reached the end (with `repeat`, at the end of each loop). |
| `onError` | `.on_error` | `{ message }` (`&str`) | Loading or playback failed. |

```rust tabs
let ratio = signal(16.0_f32 / 9.0);

video(url)
    .w_full()
    .aspect_ratio(ratio)
    .on_load(move |info: &VideoInfo| {
        ratio.set(info.size.width.0 as f32 / info.size.height.0 as f32)
    })
```

```tsx tabs
const ratio = signal(16 / 9);
<Video src={url} style={{ width: "100%", aspectRatio: ratio() }} onLoad={(e) => ratio.set(e.size.width / e.size.height)} />;
```

## Ref methods

| Method | Rust | Description |
|---|---|---|
| `seek(seconds)` | `seek(seconds)` | Jumps to a time. |

## Capabilities

When the app declares [capabilities](../docs/sandbox-and-capabilities.md), video sources load from the hosts `network`
allows; a source on another host shows an empty view.

## Platform notes

- iOS draws the video in an `AVPlayerLayer`, or in the system player view with `controls`; AVFoundation is loaded the
  first time a video is created.
- Android plays with MediaPlayer on a TextureView, with a MediaController for `controls`.
