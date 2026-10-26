---
title: Video
description: Video, a native video player (AVPlayer, MediaPlayer), with its props, events and ref methods.
order: 2.4
---

# Video

`nsh` exports `Video`: a video player built on the platform's player (`AVPlayer` on iOS and Mac Catalyst, `MediaPlayer` on Android). Playback is controlled with props, so pausing is a signal away.

```ts
import { Video, type VideoProps } from "nsh";
```

See [Web view and video](../docs/web-view-and-video.md) for the guide and [`<Video>`](../elements/video.md) for its props.

## Video

```ts
const Video: (props: VideoProps) => YNode;

interface VideoProps extends Omit<ViewProps, "children">, VideoHostProps {
  src: string;
}
```

```tsx
import { mount, signal, Text, Video, View, type YNode } from "nsh";

function Player() {
  const paused = signal(true);
  const time = signal("");
  let video!: YNode;
  return (
    <View style={{ flex: 1, padding: 16, gap: 12 }}>
      <Video
        ref={video}
        src="https://example.com/clip.mp4"
        paused={paused()}
        muted
        repeat
        resizeMode="cover"
        style={{ height: 220, borderRadius: 8, overflow: "hidden", backgroundColor: "#000" }}
        onProgress={(e) => time.set(`${e.currentTime.toFixed(1)} / ${e.duration.toFixed(1)} s`)}
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Text onPress={() => paused.update((p) => !p)}>{paused() ? "Play" : "Pause"}</Text>
        <Text onPress={() => video.seek(0)}>Restart</Text>
        <Text>{time()}</Text>
      </View>
    </View>
  );
}

mount(Player);
```

## Props

`Video` takes the [view props](../elements/view.md) (style, classes, layout, accessibility, `ref`; no children), plus:

| Prop | Type | Default | Description |
|---|---|---|---|
| `src` | `string` | (required) | The video's URL. |
| `paused` | `boolean` | `false` | Playback is paused. |
| `muted` | `boolean` | `false` | No sound. |
| `volume` | `number` | `1` | 0..1. |
| `rate` | `number` | `1` | The playback speed. |
| `repeat` | `boolean` | `false` | Plays again from the start at the end. |
| `controls` | `boolean` | `false` | Shows the platform's playback controls. |
| `resizeMode` | `"cover" \| "contain" \| "stretch" \| "center"` | | How the video fits its box. |
| `progressUpdateInterval` | `number` | `250` | Milliseconds between `onProgress` events. |
| `audioSession` | `"default" \| "playback" \| "mixWithOthers"` | `"default"` | What the sound does to the rest of the device's audio: see [Sound and other apps](#sound-and-other-apps). |

### Sound and other apps

A video's sound follows the app's audio settings, which by default are the platform's for video: on iOS the device's silent mode silences it. An app that plays speech, as an audiobook or a language course does, sets `audioSession`:

| `audioSession` | In silent mode | Other apps' audio while it plays |
|---|---|---|
| `"default"` | the app's audio settings decide | the app's audio settings decide |
| `"playback"` | sound plays | pauses, and plays again once the video pauses, ends or goes |
| `"mixWithOthers"` | sound plays | keeps playing |

The setting takes effect while the video plays. On iOS, the first such video to play sets `AVAudioSession` to the `playback` category in the `spokenAudio` mode (mixing with other apps' audio for `"mixWithOthers"`), and once none plays the session returns to what it was and the apps it paused may play again; `"default"` leaves the session as the app, or the app embedding NSH, set it. On Android the player's sound is marked as speech, and a `"playback"` video holds audio focus while it plays: it pauses when another app takes the focus (a call, a navigation prompt) and plays on when it comes back. Changing `audioSession` on Android opens the source again. The desktops and the web play the sound as they play any video.

```tsx
<Video src="asset:/greeting.m4a" audioSession="playback" />
```

## Events

| Event | Payload | When |
|---|---|---|
| `onLoadStart` | | The video starts loading. |
| `onLoad` | `{ duration: number; size: Size }` | It is ready to play: its length in seconds and its size. |
| `onProgress` | `{ currentTime: number; duration: number }` | While playing, every `progressUpdateInterval` ms. Seconds. |
| `onBuffer` | `{ isBuffering: boolean }` | Playback waits for data, or resumes. |
| `onEnd` | | Playback reached the end. |
| `onError` | `{ message: string }` | The video could not be loaded or played. |

## Ref methods

| Method | Description |
|---|---|
| `seek(seconds)` | Jumps to `seconds`. |

```ts
const aspect = signal(16 / 9);

<Video src={url} onLoad={(e) => aspect.set(e.size.width / e.size.height)} style={{ width: "100%", aspectRatio: aspect() }} />;
```

## Capabilities

When your app declares `capabilities` in `nsh.json`, remote video sources must be allowed under `network`, like `fetch`; a refused source shows nothing. See [Sandbox and capabilities](../docs/sandbox-and-capabilities.md).
