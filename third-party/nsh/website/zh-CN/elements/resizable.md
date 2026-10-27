---
title: Resizable
description: ResizablePanelGroup 与 ResizablePanel：并排或上下排列的面板，每两个面板之间有一个手柄，用户拖动它来分配空间。分组负责拖动、面板的尺寸限制、调整大小的光标以及手柄面向屏幕阅读器的角色；尺寸、手柄的外观和面板的内容都属于应用。
order: 29.5
group: base
demo: el-resizable
---

# Resizable

可调整大小的分组把面板并排或上下排列，每两个面板的边界上有一个手柄：文档旁边的侧边栏、控制台上方的编辑器、详情旁边的列表。用户拖动手柄移动边界，每个面板都保持在应用允许的尺寸范围内。`ResizablePanelGroup` 负责行为：拖动（以原生方式逐帧运行）、空间如何分配、调整大小的光标，以及为手指准备的更大触摸区域。外观由应用决定：手柄是一条没有自己的线条、颜色或握把的条带，它绘制的是应用的指示器；面板是应用自己的视图。

```rust tabs
use nsh_base::{h_resizable, resizable_panel, theme};
use nsh_core::prelude::*;

fn workspace() -> impl IntoElement {
    h_resizable()
        .handle_style(|s| s.bg(move || theme().border()))
        .handle_accessibility_label("Resize the sidebar")
        .on_resize(|sizes: &Vec<Points>| log::info!("sizes: {sizes:?}"))
        .child(
            resizable_panel()
                .size(px(240.0))
                .size_range(px(160.0)..px(480.0))
                .p_4()
                .child(text("Files").text_color(move || theme().muted_foreground())),
        )
        .child(
            resizable_panel()
                .p_4()
                .child(text("Editor").text_color(move || theme().foreground())),
        )
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { ResizablePanel, ResizablePanelGroup } from "nsh/base";

function App() {
  const sidebar = signal(240);
  return (
    <ResizablePanelGroup
      axis="horizontal"
      handleClass="bg-border group-hover:bg-ring group-active:bg-primary"
      handleAccessibilityLabel="Resize the sidebar"
    >
      <ResizablePanel size={sidebar()} minSize={160} maxSize={480} onResize={(v) => sidebar.set(v)} class="p-4">
        <Text class="text-muted-foreground">Files</Text>
      </ResizablePanel>
      <ResizablePanel class="p-4">
        <Text class="text-foreground">Editor</Text>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

mount(App);
```

`ResizablePanelGroup` 和 `ResizablePanel` 来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate。面板是分组的直接子元素。在 Rust 中，`h_resizable()` 和 `v_resizable()` 分别创建沿两个方向的分组（`resizable_panel_group().axis(..)` 把方向作为值传入），`resizable_panel()` 创建面板；每个属性对应一个设置方法，每个事件对应一个监听方法，外观用类型化的样式方法，内容用 `.child(..)`；`.size_range(min..max)` 一次设置两个限制。

<a id="sizes"></a>

## 尺寸

面板的 `size` 是它想要的尺寸，限制在 `minSize` 和 `maxSize` 之间。没有 `size` 的面板平分剩下的空间，与内容无关；所有面板都有尺寸时，多出的空间按它们的尺寸比例分配。用户拖动手柄时，分组在核心中移动面板之间的空间，途中不经过 JS：

- 放大手柄前面的面板，会从手柄后面的面板取得空间，从最近的开始，每个最多缩到它的 `minSize`，并跳过 `fixed` 面板。
- 把它缩到 `minSize` 以下，会从它前面的面板取得空间。
- 任何面板都不会超过它的 `maxSize`，所有面板加起来也不会超过分组。

拖动结束且尺寸发生了变化时，分组按布局顺序报告每个可见面板的尺寸（分组上的 `onResize`），尺寸有变化的面板报告自己的尺寸（面板上的 `onResize`）。被拖动过的面板保持用户给出的尺寸，直到应用传入新的 `size`；应用把报告的尺寸作为 `size` 传回，就能在分组的生命周期之外保留它们，于是从[存储](../modules/nsh.md#storage)恢复的布局会以用户离开时的尺寸打开。只有拖动和屏幕阅读器的调整才会报告：窗口调整大小、显示或隐藏面板都不会报告。

分组变大或变小时（窗口调整大小），有尺寸的面板保持尺寸，没有尺寸的面板承担差值。分组小到放不下这些尺寸时，面板会缩小（`fixed` 面板，如侧边栏、检查器，除外），空间恢复后再回到各自的尺寸。`visible={false}` 的面板不占空间：其他面板分摊它的空间，它重新显示时回到自己的尺寸。

```tsx
<ResizablePanelGroup axis="vertical" handleClass="bg-border">
  <ResizablePanel>
    <Editor />
  </ResizablePanel>
  <ResizablePanel size={180} minSize={120} fixed visible={consoleOpen()}>
    <Console />
  </ResizablePanel>
</ResizablePanelGroup>
```

<a id="handles"></a>

## 手柄

每两个可见面板之间的边界上都有一个手柄：一条横跨方向 9 点粗的条带，居中于边界，带有对应方向的调整大小光标。在触摸屏上，它的触摸区域在两侧各再延伸 10 点，所以一点粗的线也很容易抓住。手柄是一个 `group`：它绘制的是应用的指示器，用 `handleClass` / `handleStyle` 设置样式：它横跨方向 1 点粗、与边界等长，所以只写 `bg-border` 在两个方向上都是一条细线，`w-[3px]` 或 `h-[3px]` 可以加粗；指示器的 `group-hover:` 和 `group-active:` 类跟随指针悬停在条带上以及按下或拖动。需要比一条线更多的内容时（一排圆点握把、一个图标），`renderHandle` 绘制指示器里的内容，它会得到手柄的 `index`、`axis` 和 `state`；状态变化时重新绘制，每次拖动只有几次，不会在每次移动时绘制。带动画的握把用手柄的 thumb（`handleThumbClass` / `handleThumbStyle`）：一个居中在线上的视图，竖着绘制，在横线上转四分之一圈，所以一个类在两个方向上都适用；`group-hover:` 和 `group-active:` 类让它显示并以过渡动画变化；整个拖动过程中手柄都保持按下，无论指针移到哪里。

```tsx
<ResizablePanelGroup
  handleClass="w-[3px] items-center justify-center bg-border"
  renderHandle={(handle) => (
    <View class={handle.state === "dragging" ? "h-8 w-1 rounded-full bg-primary" : "h-6 w-1 rounded-full bg-muted-foreground"} />
  )}
>
  {/* 面板 */}
</ResizablePanelGroup>
```

`disabled` 让所有手柄保持不动（锁定的布局）。

<a id="props"></a>

## 属性

### ResizablePanelGroup

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `axis` | `h_resizable()`、`v_resizable()`、`.axis(..)` | `"horizontal" \| "vertical"` | `"horizontal"` | 并排（手柄左右拖动）或上下排列（上下拖动）。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 不能拖动：手柄保持不动。 |
| `handleClass`、`handleStyle` | `.handle_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个手柄的指示器，位于手柄条带中的边界上：除非另有指定（`w-[3px]`、`h-[3px]`），它横跨方向 1 点粗、与边界等长；`group-hover:` 和 `group-active:` 跟随条带。 |
| `handleThumbClass`、`handleThumbStyle` | `.handle_thumb_class(..)`、`.handle_thumb_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个手柄的握把：居中在线上，按竖线的方向竖着绘制，在横线上转四分之一圈，所以一个类在两个方向上都适用。手柄悬停、按下和拖动时它始终是同一个视图，所以 `group-hover:` 和 `group-active:` 类会以过渡动画改变它（`h-11 w-[3px] rounded-full bg-muted-foreground opacity-0 scale-y-0 transition group-hover:opacity-40 group-hover:scale-y-[0.45] group-active:opacity-90 group-active:scale-y-100`）。 |
| `renderHandle` | `.render_handle(\|handle\| ..)` | `(handle: ResizeHandleContext) => JSX.Element` | 无 | 每个指示器里的内容，手柄的 `state` 变化时重新绘制。 |
| `handleAccessibilityLabel` | `.handle_accessibility_label(..)` | `string` | 无 | 屏幕阅读器为每个手柄读出的文字：它调整的是什么。屏幕阅读器每次调整 10 点。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | `ResizablePanel`，分组的直接子元素。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | `size-full` | 分组自身；除非它的类另有指定，否则填满父元素。 |

### ResizablePanel

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `size` | `.size(..)` | `number` | 无 | 它想要的沿分组方向的长度（点），限制在 `minSize` 和 `maxSize` 之间；传入新值会调整它的大小。没有时它分享剩下的空间。 |
| `minSize` | `.min_size(..)`、`.size_range(..)` | `number` | `100` | 它最小的尺寸。 |
| `maxSize` | `.max_size(..)`、`.size_range(..)` | `number` | 不限 | 它最大的尺寸。 |
| `fixed` | `.fixed(..)` | `boolean` | `false` | 分组小到放不下各面板时保持尺寸；拖动它自己的手柄仍然可以调整。需要设置 `size`。 |
| `visible` | `.visible(..)` | `boolean` | `true` | 隐藏时不占空间，其他面板分摊它的空间。 |
| `children` | `.child(..)` | `JSX.Element` | 无 | 它的内容。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 面板自身的表面。它沿方向的尺寸由分组决定。 |

### ResizeHandleContext

| 字段 | 类型 | 说明 |
|---|---|---|
| `index` | `number` | 第 `index` 个可见面板之后的边界。 |
| `axis` | `"horizontal" \| "vertical"` | 它调整的方向。 |
| `state` | `"idle" \| "hovered" \| "pressed" \| "dragging"` | 指针或手指对它操作到了哪一步。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onResize`（`ResizablePanelGroup`） | `.on_resize(\|sizes: &Vec<Points>\| ..)` | 一次拖动结束并移动了手柄，或屏幕阅读器调整了手柄：按布局顺序（从左到右、从上到下）给出每个可见面板的尺寸。 |
| `onResize`（`ResizablePanel`） | `.on_resize(\|size: &Points\| ..)` | 一次拖动结束并改变了这个面板的尺寸：新的尺寸，作为它的 `size` 传回。 |

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 | 状态 |
|---|---|---|---|
| 分组 | | `ResizablePanelGroup` 的 `class`、`style` | |
| 面板 | 分组里 | `ResizablePanel` 的 `class`、`style` | |
| 手柄的指示器 | 手柄条带里、边界上 | `handleClass`、`handleStyle`、`renderHandle` | 指针悬停时 `group-hover:`，按下或拖动时 `group-active:`；`renderHandle` 里的 `state` |
| 手柄的握把 | 居中在手柄的线上 | `handleThumbClass`、`handleThumbStyle` | `group-hover:`、`group-active:`（直到拖动结束都保持按下） |

<a id="accessibility"></a>

## 无障碍

- 每个手柄对屏幕阅读器来说是一个可调节的元素，`handleAccessibilityLabel` 是它的标签。它的值是它前面那个面板的尺寸，范围是那个面板的 `minSize` 到 `maxSize`。
- 用 VoiceOver 在手柄上向上或向下轻扫，或使用 TalkBack 的音量键，会让它移动 10 点，与拖动效果相同；分组通过 `onResize` 报告。`disabled` 分组的手柄保持不动。
- 面板的内容属于应用，和其他地方一样被读出。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

<a id="platform-notes"></a>

## 平台说明

- 桌面平台（macOS、Windows、Linux、GPUI）和 Web：指针在手柄上时显示列或行的调整大小光标，用鼠标或触控板拖动即可移动边界。
- iOS、Android 和 Mac Catalyst：手指拖动手柄，触摸区域比条带两侧各宽 10 点。
- 在从右到左的布局中，面板和它们的尺寸按布局顺序排列。
- 各平台绘制的都是应用设置的样式：指示器和面板。
- [Dock](./dock.md) 的分栏就是可调整大小的分组，调整方式相同。
