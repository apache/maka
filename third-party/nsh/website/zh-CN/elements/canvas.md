---
title: Canvas
description: Canvas 元素：用 2D 上下文自定义绘制，并在原生侧回放。
order: 60
group: primitives
demo: el-canvas
---

# Canvas

canvas 是一个由你自己用 2D 绘图 API（即 HTML Canvas 2D API）绘制的视图：图表、仪表盘、圆环、签名、自定义形状都可以用它来画。绘制代码记录操作，平台在原生侧以屏幕分辨率回放这些操作（iOS 和 Mac Catalyst 上是 Core Graphics，Android 上是 `android.graphics.Canvas`）。Rust 用 `canvas(painter)` 创建，`Painter` 记录绘制内容；TSX 用从 `nsh` 导入的 `<Canvas>` 及其 `draw` 函数。

```rust tabs
use std::f32::consts::{FRAC_PI_2, TAU};

use nsh_core::{canvas::LineCap, prelude::*};

/// 一个进度圆环，120 点见方。
fn ring(progress: f32) -> impl IntoElement {
    let (center, radius) = (60.0, 50.0);
    canvas(
        Painter::new()
            .line_width(12.0)
            .line_cap(LineCap::Round)
            .stroke_color(rgb(0xe5e7eb))
            .begin_path()
            .arc(center, center, radius, 0.0, TAU)
            .stroke()
            .stroke_color(rgb(0x6366f1))
            .begin_path()
            .arc(center, center, radius, -FRAC_PI_2, -FRAC_PI_2 + progress * TAU)
            .stroke(),
    )
    .size(px(120.0))
}
```

```tsx tabs
import { Canvas, mount } from "nsh";

function Ring(props: { progress: number }) {
  return (
    <Canvas
      style={{ width: 120, height: 120 }}
      draw={(cx, { width, height }) => {
        const centerX = width / 2, cy = height / 2, r = width / 2 - 10;
        cx.lineWidth = 12;
        cx.lineCap = "round";
        cx.strokeStyle = "#e5e7eb";
        cx.beginPath();
        cx.arc(centerX, cy, r, 0, Math.PI * 2);
        cx.stroke();
        cx.strokeStyle = "#6366f1";
        cx.beginPath();
        cx.arc(centerX, cy, r, -Math.PI / 2, -Math.PI / 2 + props.progress * Math.PI * 2);
        cx.stroke();
      }}
    />
  );
}

mount(() => <Ring progress={0.7} />);
```

在 TSX 中，`Canvas` 会创建原生画布视图、测量它的尺寸，再把上下文和尺寸传给你的 `draw` 函数（参见 [Canvas API](../modules/nsh-canvas.md)）。在 Rust 中，`canvas(..)` 接收一个 `Painter`，或返回 `Painter` 的闭包：闭包读取的内容变化时会重新绘制；绘制依赖尺寸时，尺寸来自 `on_layout`。

## 属性

画布接受 [view](./view.md) 的属性（样式、点按与手势属性、`onLayout`、无障碍属性、`ref` 等），另外还有：

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `draw` | `canvas(painter)` | `(cx: CanvasRenderingContext2D, size: { width: number; height: number }) => void` | 绘制画布。尺寸确定后执行一次，画布尺寸变化时、读取的 signal 变化时再次执行。 |

请通过样式给画布一个尺寸（宽 / 高、`flex`、宽高比）：它的尺寸由样式决定。

## 何时重绘

绘制会像 effect 一样被追踪：在里面读取某个 signal，绘制就会订阅它。

```rust tabs
let values = signal(vec![12.0_f32, 40.0, 28.0, 64.0]);
let width = signal(0.0_f32);
let height = 160.0;

canvas(move || {
    let data = values.get(); // values 变化时重绘
    let step = width.get() / data.len() as f32;
    data.iter().enumerate().fold(Painter::new().fill_color(rgb(0x0969da)), |p, (i, v)| {
        p.fill_rect(i as f32 * step + 4.0, height - v, step - 8.0, *v)
    })
})
.h(px(height))
.on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
```

```tsx tabs
const values = signal([12, 40, 28, 64]);

<Canvas
  style={{ height: 160 }}
  draw={(cx, { width, height }) => {
    const data = values(); // values() 变化时重绘
    const step = width / data.length;
    cx.fillStyle = "#0969da";
    data.forEach((v, i) => cx.fillRect(i * step + 4, height - v, step - 8, v));
  }}
/>;
```

数字和颜色也可以是[原生动画值](../modules/nsh.md#animation)（`CanvasNumber`、`CanvasPaint`；在 Rust 中，凡是数字的位置都可以传 `&AnimatedValue`）：这些值动画时，平台会自行重绘，每帧都不经过应用代码。

```rust tabs
use std::f32::consts::TAU;

let angle = animated_value(0.0);
angle.timing(TAU, 1000.0, Easing::Linear);

canvas(
    Painter::new()
        .translate(40.0, 40.0)
        .rotate(&angle) // 在原生侧动画
        .fill_color(rgb(0xcf222e))
        .fill_rect(-20.0, -4.0, 40.0, 8.0),
)
.size(px(80.0))
```

```tsx tabs
import { Canvas } from "nsh";
import { Animated, createAnimatedValue } from "nsh";

const angle = createAnimatedValue(0);
Animated.timing(angle, { toValue: Math.PI * 2, duration: 1000 }).start();

<Canvas
  style={{ width: 80, height: 80 }}
  draw={(cx) => {
    cx.translate(40, 40);
    cx.rotate(angle); // 在原生侧动画
    cx.fillStyle = "#cf222e";
    cx.fillRect(-20, -4, 40, 8);
  }}
/>;
```

## 上下文

`CanvasRenderingContext2D` 是浏览器版本的一个子集，`Painter` 以 snake case 方法提供同样的操作（`move_to`、`line_to`、`fill_rect`、`fill_text`、`stroke_color` 等）：状态栈（`save`、`restore`）、变换、路径（`moveTo`、`lineTo`、`arc`、`arcTo`、`ellipse`、`rect`、`roundRect`、贝塞尔曲线）、`fill` / `stroke` / `clip`（也可作用于 `Path2D`，后者接受 SVG 路径数据；Rust 中为 `fill_svg` / `stroke_svg`）、矩形、文字（`fillText`、`strokeText`、`measureText`）、线性 / 径向 / 锥形渐变、虚线、阴影、`globalAlpha`、`globalCompositeOperation` 以及 `drawImage`（图片可以是 URL 或资源）。所有成员见 [Canvas API 参考](../modules/nsh-canvas.md)；[画布指南](../docs/canvas.md)介绍了如何绘制图表和动画图形。

坐标单位是点，原点在左上角。`measureText` 是同步的，返回 `width`。Rust 的 `Painter` 也能做命中测试（`is_point_in_path`、`is_point_in_stroke`）。

上下文绘制矢量操作和图片：像素读写（`getImageData` / `putImageData`）、`filter` 和 SVG 图片不在其中。

## 事件

与 [view 的事件](./view.md#事件)相同：`onPress`、`onLayout`、手势和触摸。如果要处理相对于画面的点击，可以在 `onTouchEnd` 中读取 `locationX` / `locationY`，或用 `onResponderMove`（Rust 中为 `.on_responder_move(..)`，读取 `e.location`）跟踪拖动。

## ref 方法

没有自己的方法。
