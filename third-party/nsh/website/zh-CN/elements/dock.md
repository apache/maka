---
title: Dock
description: DockArea：由分栏、标签组以及左、右、下三条边上的停靠区组成的可停靠工作区，布局是应用持有的数据。区域负责标签页的拖放、调整大小、停靠区、放大和锁定，面板移动时保留它的内容，并适配手机；外观和面板的内容都属于应用。
order: 29.6
group: base
demo: el-dock
---

# Dock

停靠区域是用户自行安排的工作区：面板放在标签组里，标签组并排或上下分栏，左、右、下三条边上的停靠区可以打开、关闭和调整大小。把标签页拖到另一个标签组上，它就加入那个组；拖到一个组的边缘，就把那个组分开；面板移动时，它里面的东西都保留着。`DockArea` 负责行为：标签页的拖放（以原生方式逐帧运行）、调整分栏和停靠区的大小、打开和关闭停靠区、放大和锁定。外观由应用决定：标签页、标签栏、手柄、放置指示和每个面板的内容都由应用绘制和设置样式，区域自己什么也不画。

```rust tabs
use nsh_base::{
    dock::{DockAreaLayout, DockLayout, DockPanel, DockPlacement, DockRegion, DockTab},
    dock_area, theme,
};
use nsh_core::prelude::*;

fn workspace() -> impl IntoElement {
    let layout = signal(
        DockAreaLayout::new(
            DockLayout::h_split()
                .child(DockLayout::tabs().panel("readme").panel("main"), None)
                .child(DockLayout::tabs().panel("preview"), Some(px(320.0))),
        )
        .with_dock(DockPlacement::Left, DockRegion::new(DockLayout::tabs().panel("files")))
        .with_dock(DockPlacement::Bottom, DockRegion::new(DockLayout::tabs().panel("terminal"))),
    );
    dock_area()
        .layout(move || layout.get())
        .on_layout_change(move |next: &DockAreaLayout| layout.set(next.clone()))
        .handle_style(|s| s.bg(move || theme().border()))
        .tab_bar_style(|s| s.flex_row().border_b_1().border_color(move || theme().border()))
        .tab_style(|s| s.px_3().py_1().selected(|s| s.bg(move || theme().muted())))
        .render_tab(|tab: &DockTab| text(tab.panel.to_string()).text_sm().text_color(move || theme().foreground()))
        .render_panel(|panel: &DockPanel| {
            text(format!("{} content", panel.id)).p_4().text_color(move || theme().foreground())
        })
}
```

```tsx tabs
import { mount, signal, Text } from "nsh";
import { DockArea, type DockAreaLayout } from "nsh/base";

const titles: Record<string, string> = {
  files: "Files", readme: "README.md", main: "main.rs", preview: "Preview", terminal: "Terminal",
};

function App() {
  const layout = signal<DockAreaLayout>({
    center: {
      type: "split",
      axis: "horizontal",
      children: [
        { type: "tabs", panels: ["readme", "main"] },
        { type: "tabs", panels: ["preview"] },
      ],
      sizes: [null, 320],
    },
    left: { layout: { type: "tabs", panels: ["files"] }, size: 240 },
    bottom: { layout: { type: "tabs", panels: ["terminal"] }, size: 180 },
  });
  return (
    <DockArea
      class="size-full bg-background"
      layout={layout()}
      onLayoutChange={(v) => layout.set(v)}
      handleClass="bg-border group-active:bg-primary"
      tabBarClass="flex-row border-b border-border"
      tabClass="px-3 py-1.5 selected:bg-muted"
      renderTab={(tab) => <Text class="text-sm text-foreground">{titles[tab.panel]}</Text>}
      renderPanel={(panel) => <Text class="p-4 text-foreground">{titles[panel.id]} content</Text>}
    />
  );
}

mount(App);
```

`DockArea` 和它使用的值来自 [`nsh/base`](../modules/nsh-base.md)，在 Rust 中是 `nsh-base` crate（`nsh_base::dock_area()`，值在 `nsh_base::dock` 中）。在 Rust 中，`dock_area()` 创建它，每个属性对应一个设置方法，每个事件对应一个监听方法，外观用类型化的样式方法；`DockLayout` 用面板的键描述布局（`h_split()`、`v_split()`、`tabs()`、`.child(layout, size)`、`.panel(key)`）。

<a id="the-layout"></a>

## 布局

布局是一个值，`DockAreaLayout`：中心区域，以及左、右、下三条边上各一个停靠区，停靠区都是可选的。每个区域是一棵由两种节点组成的树：

| 节点 | 包含 | 字段 |
|---|---|---|
| `{ type: "split" }` | 其他节点，并排（`axis: "horizontal"`）或上下排列（`"vertical"`） | `children`，以及 `sizes`：每个子节点沿方向的长度（点），`null` 表示平分剩下的空间 |
| `{ type: "tabs" }` | 按键列出的面板，一次显示一个 | `panels`（键，按标签顺序），`activeIndex`（显示的那个，默认 0） |

面板总是在一个标签组里：只有一个面板的区域就是只有一个面板的标签组。面板的键是应用为它取的字符串（`"files"`、一个文档的 id），一个键在整个布局中只出现一次。停靠区（`DockRegion`）包括它的树（`layout`）、它横跨边缘的尺寸（`size`，默认 200，至少 100）、是否打开（`open`，默认 `true`），以及把它的边缘拖到最小尺寸以下时是否关闭（`collapsible`，默认 `true`）。

每个节点都有 `id`。应用编写的布局可以省略 id：区域会分配它们，它报告的每个布局都带有 id。把报告的布局传回，就能保持每个组的身份，ref 的方法也用这个 id 指定组。区域还会整理传给它的布局：空的组或分栏被移除，只有一个子节点的分栏变成那个子节点，同方向的分栏嵌套时并入父分栏，`activeIndex` 保持在范围内，重复列出的键保留第一次出现的位置。它报告的布局总是这一种规范形式。

布局属于应用（`layout`）：用户做的每个改动（选中、拖动或关闭标签页，调整分栏或停靠区的大小，打开或关闭停靠区）都以完整的新布局报告（`onLayoutChange`），区域显示应用传回的布局。应用自己改变布局时传入新的值即可：恢复保存的布局，或执行一条重新安排工作区的命令。没有 `layout` 的区域自己保存布局，从 `defaultLayout` 开始，仍然报告每个改动。

<a id="panels-content"></a>

## 面板的内容

面板显示什么属于应用：`renderPanel` 根据面板的键（`panel.id`）绘制它。一个组的每个面板都被放置，只显示当前那个，所以切换标签页会保留每个面板的内容；面板移动时（移到另一个组、移进停靠区、放大再还原），同一份内容随它移动：它创建的信号、输入框里的文字、滚动位置、网页视图里的页面都保留着。区域在面板第一次出现时绘制它一次，在面板离开布局时释放它的内容（`onPanelRemove`）。

```tsx
<DockArea
  layout={layout()}
  onLayoutChange={(v) => layout.set(v)}
  renderPanel={(panel) => (panel.id === "terminal" ? <Terminal /> : <Editor file={panel.id} />)}
  onPanelActiveChange={(panel, active) => active && setTitle(panel)}
  onPanelRemove={(panel) => closeFile(panel)}
/>
```

`panels` 按键设置每个面板允许什么；没有列出的面板什么都允许：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `id` | | 面板的键。 |
| `closable` | `true` | 可以关闭。 |
| `zoomable` | `true` | 它显示时，它的组可以放大。 |
| `visible` | `true` | 显示。隐藏的面板保留位置，重新显示时回到原处；所有面板都隐藏的组或分栏不占空间。 |

<a id="tabs"></a>

## 标签页

每个组有一个标签栏，每个可见面板对应一个标签页，顺序与它的 `panels` 相同。`renderTab` 绘制标签页显示的内容（标题、图标、应用自己的关闭按钮）；没有时标签页显示面板的键。区域把它做成标签页：按下选中它，拖动移动它的面板，屏幕阅读器把它当作带选中状态的标签页，`tabClass` 的 `selected:` 类为当前显示的那个设置样式。标签页的值包含应用绘制它需要的信息：

| 字段 | 类型 | 说明 |
|---|---|---|
| `panel` | `string` | 面板的键。 |
| `group` | `number` | 它所在标签组的 id。 |
| `index` | `number` | 它在组内可见标签页中的位置。 |
| `active` | `boolean` | 它是组里当前显示的标签页。 |
| `closable` | `boolean` | 区域会关闭它：它可以关闭，区域没有锁定，它的组也可以交出它。 |
| `zoomed` | `boolean` | 它的组已放大。 |

```tsx
let area!: DockAreaRef;

<DockArea
  ref={area}
  layout={layout()}
  onLayoutChange={(v) => layout.set(v)}
  renderTab={(tab) => (
    <View class="flex-row items-center gap-2">
      <Text class="text-sm">{titles[tab.panel]}</Text>
      <If when={tab.closable}>
        <Button onPress={() => area.closePanel(tab.panel)} accessibilityLabel="Close" class="rounded-sm px-1 hover:bg-muted">
          <Text class="text-xs">×</Text>
        </Button>
      </If>
    </View>
  )}
  renderPanel={(panel) => <Editor file={panel.id} />}
/>
```

<a id="drag-and-drop"></a>

## 拖放

标签页拖到一个组上方时会显示它将落在哪里，放下就把它放到那里：

| 放在 | 面板 |
|---|---|
| 标签栏上 | 加入那个组，位于放下处两侧的标签页之间 |
| 组内容的中间 | 加入那个组 |
| 组内容的边缘（每侧外沿 35%） | 分开那个组：在那一侧新建一个只有它的组 |

拖动悬停时，区域在面板将占据的那部分组上显示放置指示（加入时是全部内容，分开时是一半）：这是由应用设置样式的部件（`dropIndicatorClass`），应用也可以绘制其中的内容（`renderDropIndicator`，它会得到 `group`、要分出的 `side` 或标签栏的 `index`）。放置指示以原生方式移到每个新位置：缓动过去，换到另一个组时淡入，上一个组的淡出（用户要求减少动态效果时直接到位）。跟随指针或手指的内容也属于应用（`renderDragPreview`）。一次放下是布局的一次改动，只报告一次；不会带来变化的放下什么也不改变。

锁定的区域、放大的区域，以及旁边没有其他内容的组里的最后一个面板，都不能拖动。

<a id="docks"></a>

## 停靠区

停靠区打开和关闭时不会丢失它的面板和尺寸：关闭时保留它的树，打开时以同样的尺寸显示同样的组。停靠区与中心区域之间的边缘是一个手柄，用户拖动它调整停靠区的大小；停靠区至少 100 点，中心区域至少保留 100 点，可折叠的停靠区在小于 50 点时松手会关闭，并保留尺寸供下次打开。区域从不超出自己的边界：停靠区按它的 `size` 显示，但不超过区域给它留下的空间；空间连这些都不够时，停靠区和其他部分一起缩小，分栏的最小尺寸也会让步。`renderDock` 在停靠区的布局之前绘制它自己的装饰（标题栏、折叠按钮），它会得到 `placement`、`open`、`size` 和 `collapsible`；`dockClass` 为它的框架设置样式。

应用可以通过 ref 打开、关闭停靠区和调整它的大小（`toggleDock`、`setDockOpen`、`setDockSize`），这些方法在两种呈现方式中都可用；也可以在传入的布局中写停靠区的 `open` 和 `size`（`open` 属于完整方式）。停靠区每次显示或隐藏时，`onDockOpenChange` 都会报告，以布局的 `open` 为基准（一开始就是紧凑方式的区域会把布局中打开的每个停靠区报告为隐藏），所以从布局的 `open` 开始、只跟随 `onDockOpenChange` 的切换按钮总能显示停靠区的状态：

```tsx
const terminalOpen = signal(true);

<DockArea
  ref={area}
  layout={layout()}
  onLayoutChange={(v) => layout.set(v)}
  onDockOpenChange={(placement, open) => placement === "bottom" && terminalOpen.set(open)}
  renderPanel={(panel) => <Editor file={panel.id} />}
/>

<Button selected={terminalOpen()} onPress={() => area.toggleDock("bottom")} class="px-3 py-1.5 selected:bg-muted">
  <Text>Terminal</Text>
</Button>
```

<a id="zoom"></a>

## 放大

放大的组占满整个区域，直到它被还原或离开布局（`area.toggleZoom(group)`，`area.toggleZoom()` 还原），`onZoomChange` 报告它显示的面板，或 `null`。放大属于组，所以组里显示的面板关闭、下一个接替时，组仍然保持放大。`zoomable: false` 的面板显示时，它的组不能放大。

<a id="locking"></a>

## 锁定

`locked` 让布局保持不变：不能拖动、放下或关闭标签页。选中标签页、调整大小以及打开和关闭停靠区仍然可用，所以锁定的工作区依然可以照常使用。

<a id="methods"></a>

## 方法

`ref={area}` 提供区域的方法（`DockAreaRef`），供应用自己的命令、快捷键和菜单使用。每次编辑都和用户的操作一样通过 `onLayoutChange` 报告。

| 方法 | 说明 |
|---|---|
| `layout()` | `Promise<DockAreaLayout>`：当前显示的布局。 |
| `addPanel(panel, placement?, size?)` | 把面板加到一个区域（`"center"`，默认，`"left"`、`"right"`、`"bottom"`）的第一个标签组并显示它；停靠区不存在时创建它，横跨 `size`。区域里已有的面板会移到那里。 |
| `removePanel(panel)` | 移除面板，不管它的选项怎么说。 |
| `closePanel(panel)` | 像它的标签页那样关闭面板：除非区域已锁定、面板不可关闭，或者它是旁边没有其他内容的组里的最后一个面板。 |
| `movePanel(panel, target)` | 把面板移到 `target`：`{ group, side?, index?, activate?, size? }`，放进标签组 `group`（在 `index` 处），或在它的 `side` 新建一个组（沿新分栏 `size` 点）。 |
| `splitAt(group, panel, side)` | 在一个容器的某一侧（`"left"`、`"right"`、`"top"`、`"bottom"`）新建标签组放入面板。 |
| `selectPanel(panel)` | 在面板所在的组里显示它。 |
| `selectTab(group, index)` | 显示一个组的某个标签页。 |
| `toggleDock(placement)`、`setDockOpen(placement, open)` | 打开或关闭停靠区。 |
| `setDockSize(placement, size)` | 设置停靠区横跨边缘的尺寸（至少 100）。 |
| `toggleZoom(group?)` | 放大一个组，已放大时还原；不传 `group` 时还原放大的组。 |
| `zoomedGroup()` | `Promise<number \| null>`：放大的组的 id。 |
| `groupOf(panel)` | `Promise<number \| null>`：包含面板的标签组的 id。 |

在 Rust 中，`component_ref::<DockArea>()` 并在区域上调用 `.component_ref(&r)` 得到一个 ref，它的 `r.api::<DockAreaApi>()` 提供同样的方法（蛇形命名）。

<a id="saving-and-restoring"></a>

## 保存与恢复

报告的布局是普通数据，所以保存它就是把 `JSON.stringify(layout)` 写进[存储](../modules/nsh.md#storage)，恢复它就是把解析出的值作为 `layout` 传入。`onLayoutChange` 报告每个改动，包括调整大小和选中标签页，所以等改动稳定后再写入存储（每次报告时重置一个短计时器）。

在 Rust 中，`DockAreaLayout::to_state` 和 `from_state` 读写 `DockAreaState`，也就是 `gpui-base` 的停靠区使用的布局文件格式。

<a id="phones-and-narrow-windows"></a>

## 手机与窄窗口

停靠区域根据自己的宽度适配。600 点及以上宽度的区域（在桌面、Web、平板、全屏的 iPad、展开的折叠屏的窗口中）是完整的工作区：分栏、标签组和停靠区并排显示，就像平板上的多窗格应用。在手机或平板上用手指操作时，标签页的拖动从长按开始，和 iPadOS 的拖放一样，所以在标签栏上滑动仍然是滚动；手柄的触摸区域更宽，外观不变。

窄于 600 点的区域（在手机上、侧拉（Slide Over）中的 iPad 上、窄的桌面或浏览器窗口中，或宽窗口里的一个窄栏中）以单屏的方式呈现同一份布局，就像 iPad 的分栏视图会收起它的列、Material Design 的辅助窗格会变成底部面板：

- 中心区域一次显示一个组，占满全部空间。它的标签栏列出中心区域的每个可见面板，选中另一个组的面板时，那个组成为显示的组。
- 左、右停靠区是从各自边缘覆盖在中心区域之上的抽屉，宽度与停靠区相同；底部停靠区是与停靠区同高的底部面板。同一时间只显示一个，由应用呈现（`toggleDock`、`setDockOpen`，同时收起另一个）；它滑入滑出，按下背景层、按 Escape 或返回时收起。进入紧凑方式时不显示任何一个。
- 拖动标签页（手指先长按，指针直接拖），可以在标签栏内调整它的顺序。

两种呈现方式中每个面板都一直被放置，所以切换时保留它的内容。显示哪个抽屉或底部面板属于紧凑方式自己：布局的 `open` 属于完整方式，呈现或收起抽屉不会报告 `onLayoutChange`，所以区域重新变宽时，停靠区和之前完全一样。`onDockOpenChange` 两者都报告：完整方式中布局的 `open` 改变的停靠区，紧凑方式中显示或收起的抽屉或底部面板，以及切换呈现方式时显示状态改变的每个停靠区。在 `renderDock` 中，`open` 表示停靠区在当前呈现方式中是否显示。布局也是同一个值，所以跨过 600 点的区域（折叠屏展开、iPad 进入分屏、窗口或分栏调整大小）会让每个面板留在原处，应用只需保存一份布局。区域完成布局后由它的宽度决定（在此之前以窗口宽度代替），`compact` 代替宽度选择呈现方式。抽屉、底部面板和背景层是由应用设置样式的部件（`drawerClass`、`sheetClass`、`backdropClass`），和区域的其他部分一样。

```tsx
<DockArea
  layout={layout()}
  onLayoutChange={(v) => layout.set(v)}
  drawerClass="bg-background border-r border-border"
  sheetClass="rounded-t-(--radius-lg) bg-background"
  backdropClass="bg-black/40"
  renderTab={(tab) => <Text>{titles[tab.panel]}</Text>}
  renderPanel={(panel) => <Editor file={panel.id} />}
/>
```

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `layout` | `.layout(..)` | `DockAreaLayout` | 无 | 显示的布局（受控）：把 `onLayoutChange` 报告的布局传回。 |
| `defaultLayout` | `.default_layout(..)` | `DockAreaLayout` | 空的中心区域 | 没有设置 `layout` 时的初始布局；此后区域自己保存布局。 |
| `locked` | `.locked(..)` | `boolean` | `false` | 不能拖动、放下或关闭标签页。 |
| `compact` | `.compact(..)` | `boolean` | 按宽度 | 手机呈现方式（`true`）或完整方式（`false`）；不设置时，区域宽度小于 600 点为紧凑方式。 |
| `panels` | `.panels(..)` | `DockPanelOptions[]` | `[]` | 按键设置每个面板允许什么：`closable`、`zoomable`、`visible`。 |
| `renderPanel` | `.render_panel(\|panel\| ..)` | `(panel: DockPanel) => JSX.Element` | 无 | 面板的内容，按它的键（`panel.id`）。 |
| `renderTab` | `.render_tab(\|tab\| ..)` | `(tab: DockTab) => JSX.Element` | 面板的键 | 标签页显示的内容。 |
| `renderDropIndicator` | `.render_drop_indicator(\|drop\| ..)` | `(drop: DockDropIndicator) => JSX.Element` | 无 | 放置指示里的内容：`group`、`side`、`index`。 |
| `renderDock` | `.render_dock(\|dock\| ..)` | `(dock: DockInfo) => JSX.Element` | 无 | 停靠区自己的装饰，位于它的布局之前：`placement`、`open`（在当前呈现方式中是否显示）、`size`、`collapsible`。 |
| `renderEmpty` | `.render_empty(\|placement\| ..)` | `(placement: DockPlacement) => JSX.Element` | 无 | 中心区域为空时显示的内容。 |
| `renderDragPreview` | `.render_drag_preview(\|tab\| ..)` | `(tab: DockTab) => JSX.Element` | 无 | 拖动标签页时跟随指针或手指的内容。 |
| `groupClass`、`groupStyle` | `.group_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个标签组的框架。 |
| `tabBarClass`、`tabBarStyle` | `.tab_bar_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个标签栏（`flex-row` 排成一行）。 |
| `tabClass`、`tabStyle` | `.tab_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个标签页；`selected:` 用于当前显示的那个。 |
| `contentClass`、`contentStyle` | `.content_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个组的内容框架，面板显示在其中。 |
| `dropIndicatorClass`、`dropIndicatorStyle` | `.drop_indicator_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 放置指示。 |
| `handleClass`、`handleStyle` | `.handle_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个手柄的指示器，位于分栏的组之间以及每个停靠区的边缘；`group-hover:` 和 `group-active:` 跟随手柄。除非另有指定，它横跨手柄 1 点粗、与手柄等长，所以 `bg-border` 在两个方向上都是一条细线；`w-[3px]` / `h-[3px]` 可以加粗。 |
| `handleThumbClass`、`handleThumbStyle` | `.handle_thumb_class(..)`、`.handle_thumb_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个手柄的握把：居中在线上，按竖线的方向竖着绘制，在横线上转四分之一圈，所以一个类在两个方向上都适用。手柄悬停、按下和拖动时它始终是同一个视图，所以 `group-hover:` 和 `group-active:` 类会以过渡动画改变它（`h-11 w-[3px] rounded-full bg-muted-foreground opacity-0 scale-y-0 transition group-hover:opacity-40 group-hover:scale-y-[0.45] group-active:opacity-90 group-active:scale-y-100`）。 |
| `dockClass`、`dockStyle` | `.dock_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 每个停靠区的框架。 |
| `drawerClass`、`drawerStyle` | `.drawer_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 紧凑方式：左右停靠区的抽屉。 |
| `sheetClass`、`sheetStyle` | `.sheet_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 紧凑方式：底部停靠区的底部面板。 |
| `backdropClass`、`backdropStyle` | `.backdrop_style(\|s\| ..)` | `string`、`StyleProp<ViewStyle>` | 无 | 紧凑方式：打开的抽屉或底部面板后面的背景层，按下它会关闭。 |
| `handleAccessibilityLabel` | `.handle_accessibility_label(..)` | `string` | 无 | 屏幕阅读器为每个手柄（分栏之间和停靠区边缘的）读出的文字。 |
| `ref` | `.component_ref(&r)`（`component_ref::<DockArea>()`） | `DockAreaRef` | | 区域的[方法](#methods)。 |
| `class`、`style` | 样式方法 | `string`、`StyleProp<ViewStyle>` | 无 | 区域自身：它在父元素中的尺寸（如 `flex-1`）、它的背景。它不会超出自己的边界，也不从内容取得最小尺寸。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onLayoutChange` | `.on_layout_change(\|layout: &DockAreaLayout\| ..)` | 布局改变了（拖动、选中、调整大小、打开或关闭停靠区、调用方法）：完整的新布局，带有每个 id。 |
| `onPanelActiveChange` | `.on_panel_active_change(\|e: &DockAreaEvent\| ..)`（`PanelActiveChange(panel, active)`） | 面板成为或不再是它所在组当前显示的标签页（关闭的停靠区不显示任何面板）。每次变化报告一次；离开的面板不会收到 `false`：`onPanelRemove` 就是它的结束。 |
| `onPanelRemove` | `.on_panel_remove(\|panel: &PanelId\| ..)` | 面板永久离开了区域：被关闭、被移除，或不在新的布局中。移动的面板不会收到它。 |
| `onZoomChange` | `.on_zoom_change(\|panel: &Option<PanelId>\| ..)` | 一个组放大（它显示的面板）或还原（`null`）。 |
| `onDockOpenChange` | `.on_dock_open_change(\|e: &DockAreaEvent\| ..)`（`DockOpenChange(placement, open)`） | 停靠区显示或隐藏了：完整方式中它布局的 `open` 改变，紧凑方式中它的抽屉或底部面板被显示或收起，或者呈现方式切换了。 |

<a id="parts"></a>

## 部件

| 部件 | 位置 | 样式 | 状态 |
|---|---|---|---|
| 区域 | | `class`、`style` | |
| 标签组 | 区域里 | `groupClass`、`groupStyle` | |
| 标签栏 | 组里 | `tabBarClass`、`tabBarStyle` | |
| 标签页 | 标签栏里 | `tabClass`、`tabStyle`；`renderTab` | `selected:`、`active:`、`hover:` |
| 组的内容 | 组里 | `contentClass`、`contentStyle`；`renderPanel` | |
| 手柄的指示器 | 分栏的组之间、停靠区的边缘 | `handleClass`、`handleStyle` | `group-hover:`、`group-active:` |
| 手柄的握把 | 居中在手柄的线上 | `handleThumbClass`、`handleThumbStyle` | `group-hover:`、`group-active:`（直到拖动结束都保持按下） |
| 停靠区 | 边缘 | `dockClass`、`dockStyle`；`renderDock` | |
| 放置指示 | 拖动时位于组上方 | `dropIndicatorClass`、`dropIndicatorStyle`；`renderDropIndicator` | |
| 拖动预览 | 指针或手指下方 | `renderDragPreview` | |
| 空的中心区域 | 中心区域 | `renderEmpty` | |
| 抽屉、底部面板、背景层 | 中心区域之上，紧凑方式 | `drawerClass`、`sheetClass`、`backdropClass`（及对应的样式） | |

<a id="accessibility"></a>

## 无障碍

- 每个标签页对屏幕阅读器来说是带选中状态的标签页，和 [`Tab`](./tabs.md) 一样，激活它就会选中。它的标签是 `renderTab` 绘制的文字。
- 每个手柄（分栏之间和停靠区边缘的）都是可调节的元素，标签是 `handleAccessibilityLabel`。分栏中组之间的手柄就是 [Resizable](./resizable.md) 的手柄：屏幕阅读器每次把它移动 10 点，通过 `onLayoutChange` 报告。
- 在紧凑方式中，Escape 和返回会收起显示的抽屉或底部面板。

标签、角色和播报的一般用法见[无障碍](../docs/accessibility.md)。

<a id="platform-notes"></a>

## 平台说明

- 指针（鼠标、触控板、悬停在屏幕上方的笔）按住按键移动 4 点后即开始拖动标签页，各平台都一样：连着触控板的 iPad、用鼠标操作的窄浏览器窗口都和桌面一样拖动。在 macOS、Windows、Linux 和 GPUI 上，每次按下都算作指针的按下，包括触摸屏笔记本上的手指。
- iOS、iPadOS 和 Android 上的手指：长按后才开始拖动标签页，和 iPadOS 的拖放一样，所以在标签栏上滑动是滚动。
- 桌面平台和 Web：手柄显示对应方向的调整大小光标。
- 手机和窄区域：紧凑方式，使用抽屉和底部面板。
- 各平台绘制的都是应用设置的样式：标签页、标签栏、手柄、放置指示、停靠区、抽屉和底部面板。
