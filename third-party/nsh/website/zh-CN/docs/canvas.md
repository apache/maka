---
title: 画布
description: 用 Rust 和 TSX 在画布上绘图：2D 操作、路径与 SVG 路径数据、渐变、文字、图片、根据 signal 重绘，以及用动画值驱动绘制动画。
order: 44
group: ui
demo: guide-canvas
---

# 画布

画布是一个用 HTML Canvas 2D API 的操作绘制的视图：图表、进度环、仪表盘、签名、自定义图标，凡是画出来比用视图拼出来更容易的东西都适合。在 Rust 中，`canvas(..)` 显示一个 `Painter` 录制的内容；在 TSX 中，`nsh` 的 `Canvas` 接收一个 `draw` 函数，一次性录制整幅绘制。平台以原生方式回放（iOS 上是 Core Graphics，Android 上是 `android.graphics.Canvas`），按屏幕分辨率绘制，所以在任何像素密度下都很清晰。

```rust tabs
use std::f32::consts::TAU;

use nsh_core::prelude::*;

#[component]
pub fn App() -> impl IntoElement {
    let area = signal((0.0_f32, 0.0_f32));
    view().flex_1().p_6().pt(px(60.0)).child(
        canvas(move || {
            let (w, h) = area.get();
            Painter::new()
                .fill_color(rgb(0x0969da))
                .begin_path()
                .arc(w / 2.0, h / 2.0, 60.0, 0.0, TAU)
                .fill()
                .stroke_color(rgb(0x1f2328))
                .line_width(4.0)
                .stroke_rect(bounds(point(px(20.0), px(20.0)), size(px(w - 40.0), px(h - 40.0))))
        })
        .h(px(200.0))
        .rounded(px(12.0))
        .bg(white())
        .on_layout(move |frame: &Bounds<Points>| area.set((frame.size.width.0, frame.size.height.0))),
    )
}
```

```tsx tabs
import { Canvas, mount, View } from "nsh";

function App() {
  return (
    <View style={{ flex: 1, padding: 24, paddingTop: 60 }}>
      <Canvas
        style={{ height: 200, borderRadius: 12, backgroundColor: "#ffffff" }}
        draw={(cx, { width, height }) => {
          cx.fillStyle = "#0969da";
          cx.beginPath();
          cx.arc(width / 2, height / 2, 60, 0, Math.PI * 2);
          cx.fill();
          cx.strokeStyle = "#1f2328";
          cx.lineWidth = 4;
          cx.strokeRect(20, 20, width - 40, height - 40);
        }}
      />
    </View>
  );
}

mount(App);
```

画布接受[视图](../elements/view.md)的一切（样式、类、触摸事件、无障碍、ref），再加上它的绘制。它需要从样式或布局中得到尺寸；它的内容就是绘制结果。坐标以点为单位，原点在左上角。

## 绘制何时生成

在 Rust 中，`canvas(move || ..)` 在绑定中录制：闭包运行一次，它读取过的 [signal](./reactivity.md) 改变时再运行。依赖画布尺寸的绘制把 `.on_layout(..)` 得到的尺寸存在 signal 中并读取它，如上例所示。在 TSX 中，`draw(cx, { width, height })` 会在以下时机运行：

- 画布尺寸确定后（第一次布局之后）；
- 画布尺寸改变时；
- 它读取过的 signal 改变时。

每次运行都会替换整幅绘制。在绘制时读取 signal，画布就能跟随你的数据：

```rust tabs
let values = signal(vec![12.0_f32, 30.0, 22.0, 48.0, 36.0, 60.0]);
let width = signal(0.0_f32);
let height = 160.0;

canvas(move || {
    let w = width.get();
    values.with(|v| {
        let x = |i: usize| i as f32 / (v.len() - 1) as f32 * w;
        let y = |n: f32| height - n / 100.0 * height;
        let mut p = Painter::new().begin_path().move_to(x(0), y(v[0]));
        for (i, &n) in v.iter().enumerate().skip(1) {
            p = p.line_to(x(i), y(n));
        }
        p.stroke_color(rgb(0x3b82f6)).line_width(2.5).line_join(LineJoin::Round).stroke()
    })
})
.h(px(height))
.on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
```

```tsx tabs
const values = signal([12, 30, 22, 48, 36, 60]);

<Canvas
  style={{ height: 160 }}
  draw={(cx, { width, height }) => {
    const v = values();
    const x = (i: number) => (i / (v.length - 1)) * width;
    const y = (n: number) => height - (n / 100) * height;
    cx.beginPath();
    v.forEach((n, i) => (i === 0 ? cx.moveTo(x(i), y(n)) : cx.lineTo(x(i), y(n))));
    cx.strokeStyle = "#3b82f6";
    cx.lineWidth = 2.5;
    cx.lineJoin = "round";
    cx.stroke();
  }}
/>
```

绘制调用只是录制：录制完成后由平台进行绘制，所以不会读回像素。录制结果作为一个操作发送给平台。

## 2D 操作

这些操作是 HTML Canvas 2D API 的一个子集：TSX 中是 `CanvasRenderingContext2D`，Rust 中是 `Painter` 的方法，使用 Rust 风格的名称（`begin_path`、`fill_rect`、`line_width`、`set_transform`、`draw_image` 等；颜色通过 `fill_color` / `stroke_color`，渐变通过 `fill_style` / `stroke_style`）。支持的内容：

**状态**

| 成员 | Rust | 说明 |
|---|---|---|
| `save()`、`restore()` | `.save()`、`.restore()` | 压入和弹出绘制状态（样式、变换、裁剪）。 |
| `fillStyle`、`strokeStyle` | `.fill_color(..)`、`.fill_style(..)`、`.stroke_color(..)`、`.stroke_style(..)` | CSS 颜色、渐变，或插值为颜色的动画值。 |
| `lineWidth`、`lineCap`、`lineJoin`、`miterLimit` | `.line_width(..)`、`.line_cap(..)`、`.line_join(..)`、`.miter_limit(..)` | 描边形状。 |
| `setLineDash(segments)`、`getLineDash()`、`lineDashOffset` | `.line_dash(..)`、`.line_dash_offset(..)` | 虚线。 |
| `globalAlpha` | `.global_alpha(..)` | 后续绘制的不透明度，0..1。 |
| `globalCompositeOperation` | `.composite(Composite::DestinationOut)` | 合成方式：`"source-over"`、`"destination-out"`、`"multiply"`、`"screen"` 等。 |
| `shadowColor`、`shadowBlur`、`shadowOffsetX`、`shadowOffsetY` | `.shadow(color, blur, offset)` | 阴影。 |
| `font` | `.font(..)` | CSS `font` 简写：`"600 14px Inter"`（尺寸可用 px、pt 或 rem）；`small-caps` 和 `tabular-nums`、`oldstyle-nums` 等数字形式可以写在尺寸之前。 |
| `fontVariantNumeric` | `.font_variant_numeric(..)` | `"tabular-nums"` 让所有数字等宽，变化的数字（计数器、价格、坐标轴标签）不会跳动；还有 `"proportional-nums"`、`"oldstyle-nums"`、`"lining-nums"`、`"normal"`。这是 NSH 新增的（即 CSS 的 `font-variant-numeric`）；设置 `font` 时会保留它。浏览器会忽略它。 |
| `textAlign`、`textBaseline` | `.text_align(..)`、`.text_baseline(..)` | 文字位置。 |

**变换**：`translate(x, y)`、`scale(x, y)`、`rotate(angle)`（弧度，顺时针）、`transform(a, b, c, d, e, f)`、`setTransform(a, b, c, d, e, f)`、`resetTransform()`。

**路径**：`beginPath()`、`moveTo`、`lineTo`、`quadraticCurveTo`、`bezierCurveTo`、`arc`、`arcTo`、`ellipse`、`rect`、`roundRect(x, y, w, h, radii)`、`closePath()`；然后是 `fill(rule?)`、`stroke()` 和 `clip(rule?)`，它们也都接受一条路径（Rust 中的 `fill_path`、`stroke_path`、`clip_path`）。填充规则为 `"nonzero"` 和 `"evenodd"`。

**矩形**：`fillRect`、`strokeRect`、`clearRect`。

**文字**：`fillText(text, x, y, maxWidth?)`、`strokeText(...)`、`measureText(text)`（由平台的文字引擎按当前 `font` 同步测量；只有 `width`）。在 Rust 中，`measure_text(font, text)` 给出宽度。

**命中测试**：`isPointInPath(path?, x, y, rule?)` 和 `isPointInStroke(path?, x, y)`（`Painter` 上的 `path_contains`、`stroke_contains`、`is_point_in_path` 和 `is_point_in_stroke`）同步给出结果，依据录制的几何信息（当前变换、路径、`lineWidth` 和 `lineCap`）计算。保留绘制和画过的路径，就能找出点击位置下的形状：

```rust tabs
let slices: Rc<Vec<Path>> = Rc::new(vec![svg_path("M50 50 L100 50 A50 50 0 0 1 50 100 Z") /* , ... */]);
let draw = {
    let slices = slices.clone();
    move || slices.iter().fold(Painter::new(), |p, s| p.fill_path(s, FillRule::NonZero))
};

canvas(draw.clone())
    .size(px(100.0))
    .claim_touches(TouchClaim::on_start())
    .on_responder_release(move |e: &ResponderEvent| {
        let drawing = draw();
        if let Some(hit) = slices.iter().position(|s| drawing.path_contains(s, e.location, FillRule::NonZero)) {
            selected.set(Some(hit));
        }
    })
```

```tsx tabs
let cx: CanvasRenderingContext2D | undefined;
const slices = [new Path2D("M50 50 L100 50 A50 50 0 0 1 50 100 Z"), /* ... */];

<Canvas
  style={{ width: 100, height: 100 }}
  onStartShouldSetResponder={() => true}
  onResponderRelease={(e) => {
    const hit = slices.findIndex((p) => cx?.isPointInPath(p, e.locationX, e.locationY));
    if (hit >= 0) select(hit);
  }}
  draw={(c) => {
    cx = c;
    slices.forEach((p) => c.fill(p));
  }}
/>
```

描边按圆角连接、不带虚线进行测试；以动画值给出的坐标按 0 计算。

**渐变**：`createLinearGradient`、`createRadialGradient`、`createConicGradient`，都通过 `addColorStop(offset, color)` 添加色标（Rust 中的 `CanvasGradient::linear`、`radial`、`conic` 和 `add_color_stop`）。

**图片**：`drawImage(image, dx, dy)`、`drawImage(image, dx, dy, dw, dh)`、`drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`（Rust 中的 `draw_image(url, dest)` 和 `draw_image_part(..)`）。

在 TSX 中，`cx.canvas.width` 和 `cx.canvas.height` 给出画布以点为单位的尺寸。

**支持的范围**：绘制操作。像素由平台写入，因此 `getImageData` / `putImageData` 等像素访问不在其中，`filter` 和在 `drawImage` 中使用 SVG 图片也不在其中。与 HTML Canvas 一样，无效的颜色或字体只会让那一个操作被丢弃。

## 路径与 SVG 路径数据

构建一次的路径可以多次填充、描边或裁剪：Rust 中是 `svg_path(d)`，TSX 中是 `Path2D`。两者都接受 SVG 路径数据，在原生端解析，用来画图标很方便：

```rust tabs
use nsh_core::canvas::{FillRule, svg_path};

const HEART: &str = "M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z";

fn heart(size: f32, color: Rgba) -> impl IntoElement {
    let path = svg_path(HEART);
    canvas(
        Painter::new()
            .scale(size / 24.0, size / 24.0) // 路径画在 24 点的网格上
            .fill_color(color)
            .fill_path(&path, FillRule::NonZero),
    )
    .size(px(size))
}
```

```tsx tabs
import { Canvas, Path2D } from "nsh";

const heart = new Path2D("M12 21s-7-4.35-9.5-8.5C.5 8.5 3 4 7 4c2 0 3.5 1 5 3 1.5-2 3-3 5-3 4 0 6.5 4.5 4.5 8.5C19 16.65 12 21 12 21z");

function Heart(props: { size: number; color: string }) {
  return (
    <Canvas
      style={{ width: props.size, height: props.size }}
      draw={(cx) => {
        cx.scale(props.size / 24, props.size / 24); // 路径画在 24 点的网格上
        cx.fillStyle = props.color;
        cx.fill(heart);
      }}
    />
  );
}
```

`Path2D` 拥有与上下文相同的路径方法（`moveTo`、`arc`、`roundRect` 等）以及 `addPath(other)`。`new Path2D(other)` 复制一条路径。

## 渐变

```rust tabs
canvas(move || {
    let (w, h) = (width.get(), 120.0);
    let linear = CanvasGradient::linear(point(px(0.0), px(0.0)), point(px(w), px(0.0)))
        .add_color_stop(percentage(0.0), rgb(0x22d3ee))
        .add_color_stop(percentage(1.0), rgb(0x6366f1));
    let center = point(px(w / 2.0), px(h * 0.75));
    let radial = CanvasGradient::radial(center, px(4.0), center, px(40.0))
        .add_color_stop(percentage(0.0), rgb(0xfde68a))
        .add_color_stop(percentage(1.0), rgb(0xf97316));
    Painter::new()
        .fill_style(linear)
        .fill_rect(0.0, 0.0, w, h / 2.0)
        .fill_style(radial)
        .begin_path()
        .arc(w / 2.0, h * 0.75, 28.0, 0.0, TAU)
        .fill()
})
.h(px(120.0))
.on_layout(move |frame: &Bounds<Points>| width.set(frame.size.width.0))
```

```tsx tabs
<Canvas
  style={{ height: 120 }}
  draw={(cx, { width, height }) => {
    const linear = cx.createLinearGradient(0, 0, width, 0);
    linear.addColorStop(0, "#22d3ee");
    linear.addColorStop(1, "#6366f1");
    cx.fillStyle = linear;
    cx.fillRect(0, 0, width, height / 2);

    const radial = cx.createRadialGradient(width / 2, height * 0.75, 4, width / 2, height * 0.75, 40);
    radial.addColorStop(0, "#fde68a");
    radial.addColorStop(1, "#f97316");
    cx.fillStyle = radial;
    cx.beginPath();
    cx.arc(width / 2, height * 0.75, 28, 0, Math.PI * 2);
    cx.fill();
  }}
/>
```

锥形渐变（`createConicGradient(startAngle, x, y)`、`CanvasGradient::conic(start_angle, center)`）让颜色绕一个点旋转过渡；起始角以弧度表示，从 x 轴顺时针计算。把锥形渐变用在描边的圆弧上，就是渐变色的进度环。

## 文字

```rust tabs
Painter::new()
    .font("600 20px system-ui")
    .fill_color(rgb(0x1f2328))
    .text_align(CanvasTextAlign::Center)
    .text_baseline(CanvasTextBaseline::Middle)
    .fill_text("72%", width / 2.0, height / 2.0)
    .font("11px system-ui")
    .fill_text("100", 32.0 - 6.0 - measure_text("11px system-ui", "100").0, 16.0)
```

```tsx tabs
cx.font = "600 20px system-ui";
cx.fillStyle = "#1f2328";
cx.textAlign = "center";
cx.textBaseline = "middle";
cx.fillText("72%", width / 2, height / 2);

cx.font = "11px system-ui";
const label = "100";
cx.fillText(label, 32 - 6 - cx.measureText(label).width, 16);
```

字体族与样式中的相同：系统字体族以及应用发布的字体名称（见[字体](./fonts.md)）。

## 图片

在 Rust 中，绘制图片接受 URL（资源的 URL 是 `LOGO.url`）；在 TSX 中接受 URL 或导入的资源（`import logo from "./logo.png"`）。图片在原生端加载，加载完成后画布会重新绘制，你不需要自己跟踪加载状态。远程 URL 受应用的[网络能力声明](./sandbox-and-capabilities.md)约束。

iOS、macOS、Android、Windows、Linux 和 GPUI 上的画布绘制位图（PNG、JPEG、GIF、WebP 等）：在这些平台上，SVG 来源按加载失败的图片处理，日志会指出它。SVG 图片请用 [`<Image>`](./images-and-assets.md#svg-图片) 显示，或把它们的形状作为 `Path2D` 路径绘制。在 Web 上，画布绘制浏览器能绘制的内容，包括 SVG。

```rust tabs
const LOGO: ImageAsset = asset!("logo.png");

canvas(
    Painter::new()
        .save()
        .begin_path()
        .arc(60.0, 60.0, 56.0, 0.0, TAU)
        .clip() // 圆形头像
        .draw_image(LOGO.url, bounds(point(px(4.0), px(4.0)), size(px(112.0), px(112.0))))
        .restore(),
)
.size(px(120.0))
```

```tsx tabs
import { Canvas } from "nsh";
import logo from "./logo.png";

<Canvas
  style={{ width: 120, height: 120 }}
  draw={(cx) => {
    cx.save();
    cx.beginPath();
    cx.arc(60, 60, 56, 0, Math.PI * 2);
    cx.clip(); // 圆形头像
    cx.drawImage(logo, 4, 4, 112, 112);
    cx.restore();
  }}
/>
```

九个参数的形式（`draw_image_part`）中，源矩形以图片的像素为单位。

## 用动画值驱动绘制

绘制调用中的任何数字参数，以及填充和描边的颜料，都可以是[动画值](./animation.md#动画值)或由它派生的节点。这类参数在平台绘制时才被读取；当动画值在动画中时，平台会自行逐帧重绘，无需重新录制绘制，也不运行你的任何代码。

```rust tabs
use std::f32::consts::{FRAC_PI_2, TAU};

use nsh_core::{
    canvas::{CanvasTextAlign, CanvasTextBaseline, LineCap},
    prelude::*,
};

pub fn ring() -> impl IntoElement {
    let progress = animated_value(0.3);
    let label = signal(30_u32);
    let go = move |to: f32| {
        label.set((to * 100.0).round() as u32);
        progress.timing(to, 900.0, Easing::Curve(Curve::Cubic, EaseMode::InOut));
    };
    let (center_x, cy, r) = (70.0, 70.0, 60.0);
    view()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_4()
        .child(
            canvas(move || {
                // 终止角在每一帧读取动画值。
                let end = progress.mul(TAU).sub(FRAC_PI_2);
                Painter::new()
                    .line_width(12.0)
                    .line_cap(LineCap::Round)
                    .stroke_color(rgb(0xe5e7eb))
                    .begin_path()
                    .arc(center_x, cy, r, 0.0, TAU)
                    .stroke()
                    .stroke_color(rgb(0x6366f1))
                    .begin_path()
                    .arc(center_x, cy, r, -FRAC_PI_2, &end)
                    .stroke()
                    .fill_color(rgb(0x1f2328))
                    .font("600 22px system-ui")
                    .text_align(CanvasTextAlign::Center)
                    .text_baseline(CanvasTextBaseline::Middle)
                    .fill_text(&format!("{}%", label.get()), center_x, cy)
            })
            .size(px(140.0)),
        )
        .child(
            text("Animate")
                .text_color(rgb(0x0969da))
                .on_press(move || go(if label.get_untracked() < 50 { 0.85 } else { 0.2 })),
        )
}
```

```tsx tabs
import { Canvas, mount, signal, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh";

function Ring() {
  const progress = createAnimatedValue(0.3);
  const label = signal(30);
  const go = (to: number) => {
    label.set(Math.round(to * 100));
    progress.timing(to, { duration: 900, easing: Easing.inOut(Easing.cubic) });
  };
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 16 }}>
      <Canvas
        style={{ width: 140, height: 140 }}
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
          // 终止角在每一帧读取动画值。
          cx.arc(centerX, cy, r, -Math.PI / 2, progress.mul(Math.PI * 2).sub(Math.PI / 2));
          cx.stroke();
          cx.fillStyle = "#1f2328";
          cx.font = "600 22px system-ui";
          cx.textAlign = "center";
          cx.textBaseline = "middle";
          cx.fillText(`${label()}%`, centerX, cy);
        }}
      />
      <View onPress={() => go(Math.random())}>
        <Text style={{ color: "#0969da" }}>Animate</Text>
      </View>
    </View>
  );
}

mount(Ring);
```

圆弧的终止角是 `progress.mul(2π).sub(π/2)`：它是一个节点，所以进度环会在 900 毫秒内以原生方式扫过，而绘制只录制了一次（标签读取了 signal，因此再录制一次）。时钟的秒针也是同样的做法：`rotate(seconds.mul(π / 30))`，其中 `seconds` 做线性动画。

颜色也可以这样动起来：Rust 中为 `.fill_style(&t.interpolate_colors(&[0.0, 1.0], &[rgb(0x54aeff), rgb(0xcf222e)]))`，TSX 中为 `cx.fillStyle = t.interpolate({ inputRange: [0, 1], outputRange: ["#54aeff", "#cf222e"] })`。

## 画布上的触摸

画布是一个视图，因此接受按压事件和[手势响应者系统](./touch-and-gestures.md#手势响应者系统)。手写绘图就是把点记录到 signal 中再画出来：

```rust tabs
let strokes = signal(Vec::<Vec<(f32, f32)>>::new());

canvas(move || {
    strokes.with(|strokes| {
        let mut p = Painter::new().line_width(3.0).line_cap(LineCap::Round).line_join(LineJoin::Round);
        for stroke in strokes {
            p = p.begin_path();
            for (i, &(x, y)) in stroke.iter().enumerate() {
                p = if i == 0 { p.move_to(x, y) } else { p.line_to(x, y) };
            }
            p = p.stroke();
        }
        p
    })
})
.h(px(240.0))
.claim_touches(TouchClaim::on_start())
.keep_touches(true) // 外层的滚动视图不能接管触摸
.on_responder_grant(move |e: &ResponderEvent| {
    strokes.update(|s| s.push(vec![(e.location.x.0, e.location.y.0)]))
})
.on_responder_move(move |e: &ResponderEvent| {
    strokes.update(|s| {
        if let Some(stroke) = s.last_mut() {
            stroke.push((e.location.x.0, e.location.y.0));
        }
    })
})
```

```tsx tabs
const strokes = signal<[number, number][][]>([]);

<Canvas
  style={{ height: 240 }}
  onStartShouldSetResponder={() => true}
  onResponderGrant={(e) => {
    strokes.set([...strokes(), [[e.locationX, e.locationY]]]);
    return true; // 外层的滚动视图不能接管触摸
  }}
  onResponderMove={(e) => {
    const all = strokes();
    strokes.set([...all.slice(0, -1), [...all[all.length - 1], [e.locationX, e.locationY]]]);
  }}
  draw={(cx) => {
    cx.lineWidth = 3;
    cx.lineCap = "round";
    cx.lineJoin = "round";
    for (const s of strokes()) {
      cx.beginPath();
      s.forEach(([x, y], i) => (i === 0 ? cx.moveTo(x, y) : cx.lineTo(x, y)));
      cx.stroke();
    }
  }}
/>
```

## 性能

- 绘制在 Rust 中录制（在 TSX 中是 JS 调用上下文时），并作为一个操作发送给平台；不存在每次调用都跨越一次桥的开销。
- 每次绘制都重新录制全部内容。让工作量与显示的内容相称，把每帧都变化的数据放在动画值而不是 signal 中。
- 如果一幅绘制既有静态部分又有频繁变化的部分，把它拆成上下叠放的两个画布，这样只有一个需要重绘。
- 在可缩放的滚动视图中，缩放结束后画布会按缩放后的分辨率重新绘制。

## 相关内容

- [`Canvas` 元素](../elements/canvas.md)：参考。
- [动画](./animation.md)：动画值、`interpolate` 和 `Easing`。
- [图片与资源](./images-and-assets.md)：应用的图片。
