---
title: Shader
description: Shader 元素：由 WGSL 编写的 GPU 程序绘制其区域的视图，绘制在子元素之下。
order: 70
group: primitives
demo: el-shader
---

# Shader

shader 是一个由 GPU 程序绘制其区域的视图：流动的渐变、噪点与颗粒、等离子、极光、全息箔、跟随点按扩散的波纹。你只需编写一个 WGSL 函数 `shade`，给出区域内每个点的颜色；平台以屏幕分辨率在 GPU 上运行它，绘制在视图背景之上、子元素之下。动画值逐帧在原生侧驱动它，应用代码无需参与。TSX 用从 `nsh` 导入的 `<Shader>` 创建，Rust 用 `shader().source(program)`。

```rust tabs
use nsh_core::{prelude::*, shader::Shader};

const GLOW: &str = r#"
struct Uniforms { tint: vec4f }

fn shade(uv: vec2f) -> vec4f {
  let d = distance(uv, vec2f(0.5));
  let pulse = 0.5 + 0.5 * sin(nsh.time * 2.0);
  let glow = smoothstep(0.5, 0.0, d) * (0.6 + 0.4 * pulse);
  return vec4f(uniforms.tint.rgb * glow, 1.0);
}
"#;

fn glow() -> impl IntoElement {
    let program = Shader::compile(GLOW).expect("a valid shader");
    shader()
        .source(program)
        .uniform("tint", Hsla::from(rgb(0x38bdf8)))
        .h(px(200.0))
        .rounded(px(14.0))
}
```

```tsx tabs
import { mount, Shader } from "nsh";

const GLOW = /* wgsl */ `
struct Uniforms { tint: vec4f }

fn shade(uv: vec2f) -> vec4f {
  let d = distance(uv, vec2f(0.5));
  let pulse = 0.5 + 0.5 * sin(nsh.time * 2.0);
  let glow = smoothstep(0.5, 0.0, d) * (0.6 + 0.4 * pulse);
  return vec4f(uniforms.tint.rgb * glow, 1.0);
}`;

function Glow() {
  return <Shader source={GLOW} uniforms={{ tint: "#38bdf8" }} style={{ height: 200, borderRadius: 14 }} />;
}

mount(() => <Glow />);
```

## 着色器

shader 的源码是 WGSL，即 WebGPU 的着色语言。它定义一个函数：

```wgsl
fn shade(uv: vec2f) -> vec4f
```

- `uv` 是视图区域内的点，左上角为 `(0, 0)`，右下角为 `(1, 1)`，y 向下增长，与 CSS 相同。
- 返回值是该点的颜色：0..1 的红、绿、蓝和 alpha，sRGB、非预乘 alpha，与 CSS 颜色一致。超出 0..1 的值会被截取。

在 `shade` 之外，源码可以包含它需要的辅助函数、常量和 `var<private>` 变量。入口点由 NSH 提供，shader 的输入来自两处。

### 内置值

| 内置值 | 类型 | 值 |
|---|---|---|
| `nsh.size` | `vec2f` | 视图的尺寸，单位为点。 |
| `nsh.time` | `f32` | shader 出现以来的秒数。读取它的 shader 会动起来：在屏幕上时每帧绘制。 |
| `nsh.scale` | `f32` | 当前绘制帧每点的像素数。 |

`uv * nsh.size` 是以点为单位的位置；`nsh.size.x / nsh.size.y` 是宽高比，用它可以让圆在非正方形区域里保持圆形。

### Uniform

应用设置的值放在名为 `Uniforms` 的结构体里，shader 通过 `uniforms` 读取：

```wgsl
struct Uniforms {
  colors: array<vec4f, 4>,
  speed: f32,
  center: vec2f,
}

fn shade(uv: vec2f) -> vec4f {
  let t = nsh.time * uniforms.speed;
  // …
}
```

`uniforms` 属性按名称设置其成员。各类型接受的值如下：

| WGSL 类型 | 值 |
|---|---|
| `f32`、`i32`、`u32` | 一个数（`i32` 和 `u32` 向零取整），或一个动画值 |
| `vec2f` | `[x, y]`：两个数或动画值 |
| `vec3f` | 一个颜色（取其红、绿、蓝）、一个动画颜色，或三个数 |
| `vec4f` | 一个带 alpha 的颜色、一个动画颜色，或四个数 |
| `array<vec4f, N>` | 最多 `N` 个颜色（或每项四个数）的列表：调色板、渐变的色标 |

颜色可以是任何 CSS 颜色（`"#38bdf8"`、`"rgb(56 189 248)"`、`"hsl(199 93% 60%)"`），以 0..1 的 sRGB 分量传入 shader。应用未设置的成员为零。再次设置 `uniforms` 会用新值重新绘制。

```tsx
const palettes = { Sunset: ["#ff6b6b", "#ffb86b", "#7b5cff", "#ff4fa3"], Lagoon: ["#00c2a8", "#2f80ed", "#a0f0ff", "#0b3d91"] };
const palette = signal<keyof typeof palettes>("Sunset");

<Shader source={MESH} uniforms={{ colors: palettes[palette()], speed: 0.5 }} style={{ height: 200 }} />;
```

## 动画 uniform

uniform 可以是一个[原生动画值](../modules/nsh.md#animation)，或由它派生的节点（`interpolate`、算术运算）。平台在它变化的每一帧把值写入 shader 并重新绘制，全部在 UI 线程上完成：无论应用代码多忙，动画都以满帧率运行。数值驱动 `f32`、`i32`、`u32` 成员以及 `vec2f` 的分量；插值到颜色的节点驱动 `vec3f` 或 `vec4f`。

```rust tabs
use nsh_core::{prelude::*, shader::Shader};

fn ripple(program: Shader) -> impl IntoElement {
    let wave = animated_value(0.0);
    wave.timing(1.0, 2200.0, Easing::Linear);
    shader()
        .source(program)
        .uniform("wave", &wave)
        .uniform("center", [0.5_f32, 0.5])
        .h(px(200.0))
}
```

```tsx tabs
import { Animated, cleanup, createAnimatedValue, Easing, Shader } from "nsh";

const RIPPLE = /* wgsl */ `
struct Uniforms { center: vec2f, wave: f32, tint: vec4f }
fn shade(uv: vec2f) -> vec4f {
  let d = distance(uv * nsh.size, uniforms.center * nsh.size) / max(nsh.size.x, nsh.size.y);
  let ring = exp(-pow((d - uniforms.wave * 0.75) * 28.0, 2.0)) * (1.0 - uniforms.wave);
  return vec4f(vec3f(0.03, 0.03, 0.06) + uniforms.tint.rgb * ring * 1.6, 1.0);
}`;

function Ripple() {
  const wave = createAnimatedValue(0);
  const tint = wave.interpolate({ inputRange: [0, 1], outputRange: ["#38bdf8", "#c084fc"] });
  const loop = Animated.loop(Animated.timing(wave, { toValue: 1, duration: 2200, easing: Easing.out(Easing.quad) }));
  loop.start();
  cleanup(() => loop.stop());
  return <Shader source={RIPPLE} uniforms={{ center: [0.5, 0.5], wave, tint }} style={{ height: 200, borderRadius: 14 }} />;
}
```

## 暂停

`paused` 让 shader 的时钟停下：`nsh.time` 保持当前值，shader 保持当前画面。设回 `false` 后时钟从停下的地方继续。暂停的 shader 在 uniform 或尺寸变化时仍会重新绘制。

```tsx
const paused = signal(false);

<Shader source={AURORA} paused={paused()} style={{ height: 200 }} onPress={() => paused.set(!paused())} />;
```

不读取 `nsh.time` 的 shader 在尺寸或 uniform 变化时绘制，其余时间保持画面。

## 子元素与裁剪

shader 是一个容器：它接受 [view](./view.md) 的全部属性（样式、子元素的内边距与布局、点按与手势属性、`onLayout`、无障碍属性、`ref`），子元素绘制在 shader 之上。shader 像背景一样填满视图区域，位于圆角（`borderRadius`）之内、`backgroundColor` 之上。

```tsx
<Shader source={HOLO} uniforms={{ tilt }} style={{ height: 200, borderRadius: 18, padding: 20, justifyContent: "space-between" }}>
  <Text style={{ color: "#ffffff", fontSize: 13, fontWeight: "600" }}>NATIVE SHELL</Text>
  <Text style={{ color: "#ffffff", fontSize: 26, fontWeight: "700" }}>4242 0000 1717</Text>
</Shader>
```

请通过样式给 shader 一个尺寸（宽 / 高、`flex`、宽高比），或由子元素撑开。

## 效果、过渡与整个屏幕

shader 也可以绘制其他视图绘制的内容。此时它的 WGSL 通过四个函数读取画面，每个函数接受区域中的一点 `uv`，返回带 alpha 的直通（非预乘）sRGB 颜色，画面之外为透明：

| 函数 | 读取 |
|---|---|
| `sample_content(uv)` | 效果的子元素；屏幕效果则是整个界面 |
| `sample_backdrop(uv)` | 视图后面的内容（任何 shader 都可以读取） |
| `sample_from(uv)` | 过渡离开的一侧 |
| `sample_to(uv)` | 过渡到达的一侧 |

`nsh.progress` 是效果的 `progress`，或过渡进行到的程度（0 到 1）；`nsh.overflow` 是 shader 超出区域绘制的距离（点）。

**`ShaderEffect`** 让子元素经过 shader 绘制：子元素保留点按、焦点和无障碍，显示的是 shader 的结果。`progress` 是一个数或一个动画值，动画值在原生侧驱动效果。`maxSampleOffset` 让 shader 超出区域绘制这么多点（光晕、模糊的边缘），此时 `uv` 会小于 0、大于 1。没有 `source` 时子元素按原样绘制。

```tsx
import { createAnimatedValue, ShaderEffect, Text } from "nsh";

const WIPE_OUT = `
fn shade(uv: vec2f) -> vec4f {
  let c = sample_content(uv);
  let edge = smoothstep(nsh.progress - 0.05, nsh.progress + 0.05, uv.x);
  return vec4f(c.rgb, c.a * edge);
}`;

const gone = createAnimatedValue(0);

<ShaderEffect source={WIPE_OUT} progress={gone} style={{ padding: 16 }}>
  <Text>随 `gone` 变为 1 被擦除</Text>
</ShaderEffect>
```

**`ShaderTransition`** 在 `value`（字符串、数或布尔值）变化时让子元素经过 shader 变化，第一个值不触发：`sample_from` 是子元素之前绘制内容的画面，`sample_to` 是它们现在绘制的内容，`nsh.progress` 在 `duration` 毫秒（300）内从 0 变到 1。没有 `source` 时运行 `fallback`：`"fade"`（淡入淡出，默认）或 `"none"`。

```tsx
<ShaderTransition source={WIPE} value={card()} duration={450}>
  <Card name={card()} />
</ShaderTransition>
```

**`ScreenEffect`** 和 **`ScreenTransition`** 对整个界面（它的页面、对话框和浮层）做同样的事。它们不占空间，也没有子元素，可以放在应用中的任何位置。最后挂载且带 `source` 的屏幕效果生效。

页面和对话框可以通过 **`transitionShader`** 经过 shader 出现和离开：在 `NavPage` 或 `Dialog` 上设置 `{ source, uniforms, duration }`（Rust：在 `nav_page()` 或 `dialog()` 上调用 `.transition_shader(TransitionShader::new(program))`）。页面入栈或出栈、对话框显示或关闭时，下层一侧（下面的页面、没有对话框的应用）是 `sample_from`，上层是 `sample_to`；页面或对话框出现时 `nsh.progress` 从 0 走到 1，离开时从 1 走到 0，因此一个 shader 就能画出两个方向。

```rust tabs
use std::time::Duration;

use nsh_base::nav_page;
use nsh_core::{prelude::*, shader::{Shader, TransitionShader}};

fn details() -> impl IntoElement {
    let ripple = Shader::compile(RIPPLE).expect("a valid shader");
    nav_page()
        .title("详情")
        .transition_shader(TransitionShader::new(ripple).duration(Duration::from_millis(500)))
        .child(text("…"))
}
```

```tsx tabs
<NavPage title="详情" transitionShader={{ source: RIPPLE, duration: 500 }}>…</NavPage>
```

shader 取代页面或对话框的 `animation`，无论它是什么（包括 `"none"`）。在没有 GPU 的设备上、用户要求减少动态效果时（减弱动态效果、移除动画），以及源码无法编译时，运行的是 `animation`；若为 `"none"`，变化会立即显示。一次切换进行中又开始新的入栈、出栈、显示或关闭时，先完成正在进行的那一次：它的页面或对话框到达或离开，`onShow` 或 `onDismiss` 触发，新的切换从那里开始。

平台在画面内容变化时重新获取画面，每个显示帧最多一次。画面由平台自己的渲染器绘制，因此它无法画进画面的内容（视频、网页、其他应用的视图）在画面中是透明的。

## 属性

shader 接受 [view](./view.md) 的属性，另外还有：

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `source` | `.source(program)` | `string` | 定义 `fn shade(uv: vec2f) -> vec4f` 的 WGSL 源码。Rust 用 `Shader::compile(source)` 编译。 |
| `uniforms` | `.uniform(name, value)` | `Record<string, ShaderUniform>` | `struct Uniforms` 各成员的值，按名称：数、颜色、动画值以及它们的列表。 |
| `paused` | `.paused(bool)` | `boolean` | 停止 `nsh.time` 的时钟。默认 `false`。 |

`ShaderEffect` 和 `ScreenEffect` 接受上述属性（`source` 可省略），另外还有：

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `progress` | `.progress(n)`、`.animated_progress(&value)` | `number \| AnimatedNode` | `nsh.progress`。默认 0。 |
| `maxSampleOffset` | `.max_sample_offset(px(n))` | `number` | shader 超出区域绘制、画面延伸的距离（点）（`ShaderEffect` 和 `ShaderTransition`）。默认 0。 |

`ShaderTransition` 和 `ScreenTransition` 接受 `source`、`uniforms` 和 `paused`，另外还有：

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `value` | `.value(key)` | `string \| number \| boolean` | 变化时运行过渡（第一个值不触发）。 |
| `duration` | `.duration(Duration)` | `number` | 运行时长（毫秒）。默认 300。 |
| `fallback` | `.fallback(TransitionFallback)` | `"fade" \| "none"` | 没有 `source` 时运行的内容。默认 `"fade"`。 |

`NavPage` 和 `Dialog` 接受：

| 属性 | Rust | 类型 | 说明 |
|---|---|---|---|
| `transitionShader` | `.transition_shader(TransitionShader::new(program))`、`.uniform(name, value)`、`.duration(Duration)` | `{ source: string; uniforms?: Record<string, ShaderUniform>; duration?: number }` | 页面或对话框出现和离开时经过的 shader，取代它的 `animation`。`duration` 以毫秒为单位，默认 350。 |

## 错误

NSH 在设置源码时检查每个 shader，然后才交给 GPU。无法编译的 shader 会输出一条警告，给出源码中的行号、列号和问题，例如：

```text
the shader of node 12: 2:1: `shade` takes the point's `uv: vec2f` and returns its color, a `vec4f`
```

此时视图显示它的背景和子元素。结构体中不存在的 uniform，或其类型不接受的值，会输出一条指明该 uniform 的警告，其他 uniform 照常生效。

每份源码只编译一次：共享同一源码的视图，以及再次设置的同一源码，都使用已编译的 shader。

## 规则与限制

- `shade` 的签名必须是 `fn shade(uv: vec2f) -> vec4f`。源码声明自己的函数、常量、结构体和 `var<private>` 变量；入口点和绑定由 NSH 提供。
- 源码最多 64 KiB。
- `struct Uniforms` 最多 4096 字节，成员类型为上表中的类型。
- 每帧每边最多 4096 像素：更大的视图以较低的缩放绘制 shader。

生成噪声时，对点所在的整数格子做哈希（`bitcast<vec2u>(vec2i(floor(p)))` 再配合乘法和异或移位），而不是 `fract(sin(…) * 43758.5)`：整数哈希在每处计算同一格子时得到相同的值，因此值噪声在每种 GPU 上都无缝。示例库的 shader 中有一个这样的实现。

## 平台

在 iOS、Android、macOS、Windows、Linux 以及 GPUI 应用中，NSH 用 wgpu 在 GPU 上以屏幕缩放渲染 shader（Apple 平台上是 Metal，其他平台上是 Vulkan、Direct3D 12 或 OpenGL），并把每一帧显示在视图的子元素之下。渲染与 UI 并行：一帧在绘制后一到两个显示帧内出现，GPU 工作时 UI 保持流畅。在 web 上，NSH 把 shader 转换为 GLSL，用 WebGL 2 绘制。

shader 每个显示帧最多绘制一次，并且只在显示的内容变化时绘制：uniform 固定的 shader 只绘制一次，读取 `nsh.time` 的 shader 每帧绘制，带动画 uniform 的 shader 在动画进行时绘制。

## Rust

`shader()`（来自 `nsh_core::element`）创建 shader 视图，`.source(program)` 给它一个已编译的 `Shader`（`nsh_core::shader::Shader::compile(source)`，返回与上文相同的错误）。程序编译一次即可共享：克隆的开销很小。程序也可以绑定，`.source(move || …)`，用来切换程序。

| 方法 | 说明 |
|---|---|
| `.uniform(name, value)` | 设置 `struct Uniforms` 的一个成员：一个数、一个 `Color` 或 `Hsla`、`[f32; 2]` / `[f32; 3]` / `[f32; 4]`，或一个 `Vec<UniformValue>`。绑定的值（`move \|\| …`）变化时重新设置；动画值（`&wave`：一个数，或用于 `vec3f` / `vec4f` 的颜色）在原生侧逐帧驱动它。 |
| `.paused(bool)` | 停止 `nsh.time` 的时钟；可绑定。 |

子元素用 `.child(..)` 添加，样式用常用的类型化方法。`shader_effect()`、`shader_transition()`、`screen_effect()` 和 `screen_transition()` 创建其他元素，方法见上表。
