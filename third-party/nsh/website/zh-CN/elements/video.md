---
title: Video
description: Video 元素：原生视频播放，可使用自定义控件或系统控件。
order: 10
group: primitives
demo: el-video
---

# Video

视频视图用平台自带的播放器播放视频文件或视频流：iOS 和 Mac Catalyst 上是 AVPlayer，Android 上是 MediaPlayer。播放通过属性控制（`paused`、`muted`、`rate` 等），因此播放器会像其他视图一样跟随你的状态。Rust 用 `video(url)` 创建，TSX 用从 `nsh` 导入的 `<Video>`。

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
                .resize_mode(ResizeMode::Contain)
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
                    text(move || if paused.get() { "播放" } else { "暂停" })
                        .on_press(move || paused.update(|p| *p = !*p)),
                )
                .child(text("重新播放").on_press(move || player.seek(0.0)))
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
        resizeMode="contain"
        style={{ height: 220, backgroundColor: "#000000" }}
        onProgress={(e) => time.set(`${e.currentTime.toFixed(1)} / ${e.duration.toFixed(1)} s`)}
      />
      <View style={{ flexDirection: "row", gap: 16 }}>
        <Text onPress={() => paused.set(!paused())}>{paused() ? "播放" : "暂停"}</Text>
        <Text onPress={() => video.seek(0)}>重新播放</Text>
        <Text>{time()}</Text>
      </View>
    </View>
  );
}
```

在 TSX 中 `src` 必填（参见 [Video API](../modules/nsh-video.md)）。另见 [Web view 与视频指南](../docs/web-view-and-video.md)。

## 属性

视频接受 [view](./view.md) 的属性（它没有子元素），另外还有：

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `src` | `video(url)` | `string` | | 视频的 URL（在 Rust 中也可以是资源的 `uri`：`video(CLIP.uri)`）。 |
| `paused` | `.paused(..)` | `boolean` | `false` | 暂停播放。 |
| `muted` | `.muted(..)` | `boolean` | `false` | 静音。 |
| `volume` | `.volume(..)` | `number` | `1` | 0..1。 |
| `rate` | `.rate(..)` | `number` | `1` | 播放速度。 |
| `repeat` | `.repeat(..)` | `boolean` | `false` | 播放到结尾后从头再播。 |
| `controls` | `.controls(..)` | `boolean` | `false` | 显示平台的播放控件。 |
| `resizeMode` | `.resize_mode(ResizeMode::Contain)` | `"cover" \| "contain" \| "stretch" \| "center" \| "scale-down"` | | 视频如何适配其区域。iOS、macOS 和 Android 将 `"center"` 和 `"scale-down"` 按 `"contain"` 播放，Linux 将两者都按 `"scale-down"` 播放。 |
| `progressUpdateInterval` | `.progress_interval(ms)` | `number` | `250` | `onProgress` 事件之间的毫秒数。 |

请通过样式给视频一个尺寸，它的尺寸由样式决定。如果需要视频本身的比例，可以用 `onLoad` 报告的尺寸设置宽高比。

## 事件

| 事件 | Rust | 载荷 | 时机 |
|---|---|---|---|
| `onLoadStart` | `.on_load_start` | 无 | 开始加载。 |
| `onLoad` | `.on_load` | `{ duration, size }`（`VideoInfo`：`duration`、`size`） | 视频已就绪：时长（秒）和尺寸。 |
| `onProgress` | `.on_progress` | `{ currentTime, duration }`（`VideoProgress`：`current_time`、`duration`） | 播放期间每隔 `progressUpdateInterval` 触发（秒）。 |
| `onBuffer` | `.on_buffer` | `{ isBuffering }`（`bool`） | 因等待数据而卡顿 / 恢复播放。 |
| `onEnd` | `.on_end` | 无 | 播放到结尾（设置了 `repeat` 时，每轮结束都会触发）。 |
| `onError` | `.on_error` | `{ message }`（`&str`） | 加载或播放失败。 |

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

## ref 方法

| 方法 | Rust | 说明 |
|---|---|---|
| `seek(seconds)` | `seek(seconds)` | 跳转到某个时间点。 |

## 能力声明

应用声明了[能力](../docs/sandbox-and-capabilities.md)时，视频源从 `network` 允许的主机加载；指向其他主机的视频源显示为空视图。

## 平台说明

- iOS 在 `AVPlayerLayer` 中绘制视频，设置 `controls` 时使用系统播放器视图；AVFoundation 在第一次创建视频时才加载。
- Android 用 MediaPlayer 在 TextureView 上播放，`controls` 使用 MediaController。
