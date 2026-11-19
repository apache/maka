---
title: Canvas
description: Canvas、2D 绘图上下文、Path2D 与渐变，以及 NSH 支持的 HTML Canvas 2D 子集。
order: 2.3
demo: mod-canvas
---

# Canvas

`Canvas` 提供与 HTML Canvas 2D 风格一致的绘图上下文。你的 `draw` 函数**记录**绘图操作，平台随后以屏幕分辨率在原生侧回放（iOS 上是 Core Graphics，Android 上是 `android.graphics.Canvas`）。绘图中的数字和颜色可以是[动画值](./nsh.md#animation)：它们做动画时，平台会自行重绘，无需再次运行 `draw`。

```ts
import { Canvas, CanvasGradient, CanvasRenderingContext2D, OffscreenCanvas, Path2D } from "nsh";
```

教程见[画布](../docs/canvas.md)，属性见 [`<Canvas>`](../elements/canvas.md)。

## Canvas

```ts
function Canvas(props: CanvasProps): JSX.Element;

interface CanvasProps extends ViewProps {
  draw: (cx: CanvasRenderingContext2D, size: CanvasSize) => void;
}

interface CanvasSize {
  width: number;   // 点
  height: number;
}
```

用 2D 上下文绘制的视图。它接受所有[视图属性](../elements/view.md)（样式、class、触摸处理、无障碍、`ref`），另外还有：

| 属性 | 类型 | 说明 |
|---|---|---|
| `draw` | `(cx, { width, height }) => void` | 绘制画布。尺寸确定后运行一次，之后在它读取的 signal 变化时、以及画布尺寸改变时再次运行。作为数字或颜色传入的动画值做动画时不会触发它。 |

通过样式给画布设置尺寸（`width` / `height`、`flex: 1`、`aspectRatio` 等）。坐标单位为点，原点在左上角。

```tsx
import { Canvas, mount, signal, Text, View } from "nsh";

function App() {
  const values = signal([12, 30, 22, 48, 36, 60, 52, 75]);
  return (
    <View style={{ flex: 1, padding: 24 }}>
      <Canvas
        style={{ height: 160 }}
        draw={(cx, { width, height }) => {
          const v = values();
          const step = width / (v.length - 1);
          cx.strokeStyle = "#6366f1";
          cx.lineWidth = 3;
          cx.lineJoin = "round";
          cx.beginPath();
          v.forEach((n, i) => (i ? cx.lineTo(i * step, height - n * 2) : cx.moveTo(0, height - n * 2)));
          cx.stroke();
        }}
      />
      <Text onPress={() => values.update((v) => [...v.slice(1), Math.random() * 80])}>Next</Text>
    </View>
  );
}

mount(App);
```

## 不重绘的动画

所有类型为 `CanvasNumber` 的参数和所有填充/描边样式（`fillStyle`、`strokeStyle`）都接受 `AnimatedNode`。画布在绘制时读取该节点，并在其动画的每一帧在原生侧重绘：

```tsx
import { createAnimatedValue, Easing } from "nsh";
import { Canvas } from "nsh";

const progress = createAnimatedValue(0);

<Canvas
  style={{ width: 120, height: 120 }}
  draw={(cx, { width }) => {
    const c = width / 2;
    cx.lineWidth = 12;
    cx.lineCap = "round";
    cx.strokeStyle = "#6366f1";
    cx.beginPath();
    // 终止角是动画节点：`progress` 做动画时在原生侧重绘。
    cx.arc(c, c, c - 10, -Math.PI / 2, progress.mul(Math.PI * 2).sub(Math.PI / 2));
    cx.stroke();
  }}
/>;

progress.timing(0.75, { duration: 900, easing: Easing.inOut(Easing.cubic) });
```

```ts
type CanvasNumber = number | AnimatedNode;
type CanvasPaint = string | CanvasGradient | AnimatedNode;
```

## CanvasRenderingContext2D

`draw` 收到的上下文。调用只会记录操作；`draw` 返回后由平台绘制。

### 状态与变换

```ts
readonly canvas: { readonly width: number; readonly height: number };
save(): void;
restore(): void;
translate(x: CanvasNumber, y: CanvasNumber): void;
scale(x: CanvasNumber, y: CanvasNumber): void;
rotate(angle: CanvasNumber): void;
transform(a: CanvasNumber, b: CanvasNumber, c: CanvasNumber, d: CanvasNumber, e: CanvasNumber, f: CanvasNumber): void;
setTransform(a: CanvasNumber, b: CanvasNumber, c: CanvasNumber, d: CanvasNumber, e: CanvasNumber, f: CanvasNumber): void;
resetTransform(): void;
```

| 成员 | 说明 |
|---|---|
| `canvas` | 画布尺寸（点）。 |
| `save()` / `restore()` | 保存 / 恢复绘图状态（变换、裁剪、样式）。 |
| `translate(x, y)` | 移动原点。 |
| `scale(x, y)` | 缩放坐标轴。 |
| `rotate(angle)` | 旋转坐标轴；弧度，顺时针。 |
| `transform(a, b, c, d, e, f)` | 用矩阵 `[a c e; b d f]` 乘以当前变换。 |
| `setTransform(a, b, c, d, e, f)` | 替换当前变换。 |
| `resetTransform()` | 恢复为单位矩阵。 |

### 属性

| 属性 | 类型 | 说明 |
|---|---|---|
| `fillStyle` | `CanvasPaint` | `fill`、`fillRect`、`fillText` 使用的颜色、渐变或原生颜色节点。 |
| `strokeStyle` | `CanvasPaint` | 描边使用的同类样式。 |
| `lineWidth` | `CanvasNumber` | 线宽（点）。 |
| `lineCap` | `"butt" \| "round" \| "square"` | 线条端点样式。 |
| `lineJoin` | `"miter" \| "round" \| "bevel"` | 线段连接样式。 |
| `miterLimit` | `number` | 尖角连接超过该长度（以线宽计）时改为斜角。 |
| `lineDashOffset` | `CanvasNumber` | 虚线模式的起始偏移。 |
| `globalAlpha` | `CanvasNumber` | 接下来绘制内容的不透明度，0..1。 |
| `globalCompositeOperation` | `string` | 接下来绘制的内容如何与画布合成（`"source-over"`、`"multiply"` 等）。 |
| `shadowColor` | `string` | 阴影颜色（透明即无阴影）。 |
| `shadowBlur` | `number` | 阴影模糊半径（点）。 |
| `shadowOffsetX`、`shadowOffsetY` | `number` | 阴影偏移（点）。 |
| `font` | `string` | CSS `font` 简写，例如 `"600 14px Inter"`（尺寸单位可以是 `px`、`pt` 或 `rem`）。 |
| `textAlign` | `"start" \| "end" \| "left" \| "right" \| "center"` | 文本相对于 x 的水平位置。 |
| `textBaseline` | `"alphabetic" \| "top" \| "hanging" \| "middle" \| "ideographic" \| "bottom"` | 文本相对于 y 的垂直位置。 |

虚线：`setLineDash(segments: number[])` 和 `getLineDash(): number[]`。

### 路径

上下文有一条当前路径，用与 [`Path2D`](#path2d) 相同的方法构建：

```ts
beginPath(): void;
moveTo(x, y): void;
lineTo(x, y): void;
quadraticCurveTo(cpx, cpy, x, y): void;
bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y): void;
arc(x, y, radius, startAngle, endAngle, counterclockwise?: boolean): void;
arcTo(x1, y1, x2, y2, radius): void;
ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, counterclockwise?: boolean): void;
rect(x, y, w, h): void;
roundRect(x, y, w, h, radii?: CanvasNumber | CanvasNumber[]): void;
closePath(): void;
```

所有坐标都是 `CanvasNumber`。角度以弧度为单位，从 x 轴顺时针计算。`roundRect` 的 `radii` 是一个半径，或像 CSS `border-radius` 那样的 2–4 个半径（从左上角开始）。

### 绘制

```ts
fill(path?: Path2D | "nonzero" | "evenodd", rule?: "nonzero" | "evenodd"): void;
stroke(path?: Path2D): void;
clip(path?: Path2D | "nonzero" | "evenodd", rule?: "nonzero" | "evenodd"): void;
fillRect(x, y, w, h): void;
strokeRect(x, y, w, h): void;
clearRect(x, y, w, h): void;
```

| 方法 | 说明 |
|---|---|
| `fill(path?, rule?)` | 用 `fillStyle` 填充当前路径（或 `path`），按非零（默认）或奇偶规则。 |
| `stroke(path?)` | 用 `strokeStyle` 描边当前路径（或 `path`）。 |
| `clip(path?, rule?)` | 把之后的绘制限制在路径范围内。 |
| `fillRect`、`strokeRect` | 绘制矩形，不影响当前路径。 |
| `clearRect` | 把矩形区域变为透明。 |

### 文本

```ts
fillText(text: string, x: CanvasNumber, y: CanvasNumber, maxWidth?: number): void;
strokeText(text: string, x: CanvasNumber, y: CanvasNumber, maxWidth?: number): void;
measureText(text: string): TextMetrics; // { width: number }
```

`measureText` 是同步的：它用平台的文本引擎和当前 `font` 测量。只返回 `width`。

```ts
cx.font = "11px system-ui";
const label = "100";
cx.fillText(label, 40 - cx.measureText(label).width, 20);
```

### 渐变

```ts
createLinearGradient(x0: number, y0: number, x1: number, y1: number): CanvasGradient;
createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): CanvasGradient;
createConicGradient(startAngle: number, x: number, y: number): CanvasGradient;

class CanvasGradient {
  addColorStop(offset: number, color: string): void; // offset 0..1，任意 CSS 颜色
}
```

```ts
const g = cx.createLinearGradient(0, 0, 0, height);
g.addColorStop(0, "rgba(99, 102, 241, 0.4)");
g.addColorStop(1, "rgba(99, 102, 241, 0)");
cx.fillStyle = g;
cx.fillRect(0, 0, width, height);
```

### 图片

```ts
drawImage(image: string | ImageAsset, ...args: CanvasNumber[]): void;
```

绘制一张图片，可以是 URL 或导入的资源（`import logo from "./logo.png"`）。图片在原生侧加载，加载完成后画布会重新绘制。导入的资源绘制导入的文件本身；要在所有屏幕上绘制清晰，请导入 `@3x` 文件。与 HTML 一样有三种形式：

- `drawImage(image, dx, dy)`：按原始尺寸绘制。
- `drawImage(image, dx, dy, dw, dh)`：缩放到矩形内。
- `drawImage(image, sx, sy, sw, sh, dx, dy, dw, dh)`：绘制图片的一部分（源区域以图片像素计）。

图片的原始尺寸（单位为点）是它的像素数除以文件名声明的密度，与 `Image` 相同：300 像素宽的 `logo@3x.png` 绘制为 100 点宽，没有 `@2x` / `@3x` 的文件每个像素一个点，在任何屏幕上都一样。只给出源区域时，按源区域的像素除以同一密度绘制；导入的资源按导入时的尺寸绘制。

## Path2D

```ts
class Path2D {
  constructor(path?: Path2D | string);
  addPath(path: Path2D): void;
  // 以及所有路径方法：moveTo、lineTo、quadraticCurveTo、bezierCurveTo、
  // arc、arcTo、ellipse、rect、roundRect、closePath
}
```

可复用的路径，用于填充、描边或裁剪。构造函数可以复制另一个 `Path2D`，或在原生侧解析 SVG 路径数据：

```ts
const heart = new Path2D("M12 21s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6a5.5 5.5 0 0 1 9.5 6c-2.5 4.5-9.5 9-9.5 9z");
cx.save();
cx.scale(4, 4);
cx.fillStyle = "#ef4444";
cx.fill(heart);
cx.restore();
```

## OffscreenCanvas

```ts
class OffscreenCanvas {
  constructor(width: number, height: number);
  readonly width: number;
  readonly height: number;
  getContext(contextId: "2d"): CanvasRenderingContext2D;
  convertToBlob(options?: { type?: string; scale?: number }): Promise<Blob>;
}
```

一块有自己尺寸、不在屏幕上显示的画布，用来生成应用要保存、分享或放进剪贴板的图片：完整尺寸的整张图、图表、分享卡片。用它的 2D 上下文绘制（与 `<Canvas draw>` 拿到的 `CanvasRenderingContext2D` 相同，包括 `measureText`），再调用 `convertToBlob()`：平台以原生方式渲染绘制内容，与同样尺寸的 `<Canvas>` 在屏幕上绘制的一致，得到一个 PNG `Blob`。`scale` 设定每点的像素数（默认为屏幕的倍率）；动画值按初始值 0 绘制。

```ts
const canvas = new OffscreenCanvas(1200, 800);
const cx = canvas.getContext("2d");
cx.fillStyle = "#0f172a";
cx.font = "600 24px sans-serif";
cx.fillText("orders → customers", 40, 60);
const png = await canvas.convertToBlob({ scale: 2 });
url.set(URL.createObjectURL(png)); // <Image src={url()} />, or its bytes: await png.arrayBuffer()
```

一块画布可以生成多张图片：在没有设置变换和裁剪时整块清除它（`cx.clearRect(0, 0, canvas.width, canvas.height)`），绘制会重新开始，上下文的状态（样式、字体、当前路径）保持不变，每张图片只渲染清除之后绘制的内容。

图片单边最多 16384 像素、总共最多 6400 万像素，一个应用同时最多渲染 16 张；超出任一限制时 `convertToBlob` 以 `ERR_NSH_QUOTA_EXCEEDED` 拒绝。平台 30 秒内没有完成的渲染以 `ETIMEDOUT` 拒绝。iOS、Android、macOS、Windows、Linux、GPUI 后端和 Web 都渲染离屏画布，画法与各自屏上的画布相同；其他平台上（包括 `nsh test` 的 headless 运行），`convertToBlob` 以 `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` 拒绝（`nsh test --target` 在它指定的平台上渲染）。

在 Web 上，图片还要在浏览器的画布上限之内（iOS 和 iPadOS 上的 Safari 总共 16,777,216 像素，即 4096 × 4096）；更大的图片以 `ERR_NSH_QUOTA_EXCEEDED` 拒绝。绘制中的图片来自页面的同源地址或允许 CORS 的服务器；其他图片会被跳过并给出警告，与各平台跳过加载失败的图片一样。

## 不支持的功能

不支持像素访问（`getImageData`、`putImageData`）、`filter`、`isPointInPath` 和 SVG 图片。与 HTML Canvas 一样，无效的颜色或字体只会让那一个操作被丢弃。
