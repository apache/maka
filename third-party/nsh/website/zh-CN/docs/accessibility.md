---
title: 无障碍
description: 让应用配合 VoiceOver 和 TalkBack 使用：标签、角色、状态、值、自定义操作、分组与隐藏、播报与焦点、文字大小以及减少动态效果。
order: 48
group: ui
---

# 无障碍

NSH 用原生视图渲染，所以平台的辅助技术（iOS 和 Mac Catalyst 上的 VoiceOver、Android 上的 TalkBack、切换控制、语音控制等）看到的是应用真实的视图层级。你需要补充的是这些技术无法推断的描述：元素是什么、说什么、处于什么状态、能做什么。所有元素都接受下面的方法（Rust）和属性（TSX）。

## 无需任何操作就能得到的

- **文本会被朗读。** 文本元素是一个无障碍元素，标签就是它的文字。没有标签的视图会朗读其内部的文字。
- **可按压视图是元素。** 带按压或长按处理函数（`.on_press`、`onPress`）的视图默认是无障碍元素，激活它（在 VoiceOver 或 TalkBack 下双击）就会按下它。
- **输入框是文本框**，带有占位文字、值和键盘。
- **文字跟随用户的大小设置。** 见[文字大小](#文字大小)。

## 标签、提示与角色

```rust tabs
view()
    .on_press(play)
    .role(AccessibilityRole::Button)
    .label("Play")
    .hint("Starts the song")
    .size(px(44.0))
    .items_center()
    .justify_center()
    .child(text("▶"))
```

```tsx tabs
<View
  onPress={play}
  role="button"
  accessibilityLabel="Play"
  accessibilityHint="Starts the song"
  style={{ width: 44, height: 44, alignItems: "center", justifyContent: "center" }}
>
  <Text>▶</Text>
</View>
```

| Rust | TSX | 类型 | 说明 |
|---|---|---|---|
| `.accessible(..)` | `accessible` | `boolean` | 视图作为一个整体元素提供给辅助技术；子元素不单独暴露。 |
| `.label(..)` | `accessibilityLabel` | `string` | 屏幕阅读器朗读的内容，代替内部的文字。 |
| `.hint(..)` | `accessibilityHint` | `string` | 激活元素会发生什么，在停顿后朗读。 |
| `.role(..)` | `role` | `AccessibilityRole` | 元素是什么。 |
| `.accessibility_state(..)` | `accessibilityState` | `AccessibilityState` | 它的状态：禁用、选中、勾选、忙碌、展开。`selected` 同时让选中样式生效，`checked` 为 true 时让勾选样式生效，为 `"mixed"` 时让半选样式生效。 |
| `.accessibility_value(..)` | `accessibilityValue` | `{ min?, max?, now?, text? }` | 范围类或文本类元素的值。 |
| | `accessibilityActions` | `{ name, label? }[]` | 提供给辅助技术的操作。 |
| `.on_accessibility_action(..)` | `onAccessibilityAction` | `(e: { actionName }) => void` | 执行了某个操作（Rust：操作名称）。 |
| `.accessibility_elements_hidden(..)` | `accessibilityElementsHidden` | `boolean` | 对辅助技术隐藏该视图及其子树。 |
| | `importantForAccessibility` | `"auto" \| "yes" \| "no" \| "no-hide-descendants"` | 视图（及其子树）是否暴露。 |
| | `android={{ accessibilityLiveRegion }}` | `"none" \| "polite" \| "assertive"` | Android：视图的变化如何播报给 TalkBack。 |
| `.test_id(..)` | `testID` | `string` | UI 测试用的标识（iOS 上的 accessibility identifier，Android 上的 resource id）；不会被朗读。 |

给每个只有图标的控件加上标签：屏幕阅读器无法朗读一个符号或一张图片。标签保持简短，不要包含角色（写 "Play"，不要写 "Play button"）：角色会单独播报。

### 角色

角色（`.role(AccessibilityRole::Header)`、`role="header"`）告诉用户这是哪一类元素、如何操作。在 Rust 中它是 `AccessibilityRole` 的一个变体（`Button`、`Header`、`Switch` 等）；TSX 的取值有 `"none"`、`"button"`、`"link"`、`"search"`、`"image"`、`"imagebutton"`、`"keyboardkey"`、`"text"`、`"adjustable"`、`"header"`、`"summary"`、`"alert"`、`"checkbox"`、`"combobox"`、`"menu"`、`"menubar"`、`"menuitem"`、`"progressbar"`、`"radio"`、`"radiogroup"`、`"scrollbar"`、`"spinbutton"`、`"switch"`、`"tab"`、`"tablist"`、`"timer"`、`"toolbar"`、`"list"`、`"grid"`、`"table"`、`"rowgroup"`、`"row"`、`"columnheader"`、`"cell"`（[`Table`](../elements/table.md) 各部件的角色），以及 `"listbox"` 和 `"option"`（一组可供选择的选项，例如选择框弹出的列表，及其中的选项，选中的那项由 `accessibilityState.selected` 标出）。

最常用的几个：

- `"button"` 用于不是链接的可按压元素；`"link"` 用于跳转到内容。
- `"header"` 用于分区标题：屏幕阅读器用户会在标题之间跳转来快速浏览页面。
- `"switch"`、`"checkbox"`、`"radio"` 配合 `accessibilityState.checked`。
- `"adjustable"` 用于滑块和步进器，配合 `accessibilityValue` 以及 `increment` / `decrement` 操作（[`Slider`](../elements/slider.md) 的每个滑块都是）。
- `"image"` 用于有意义的图片，并加上标签；装饰性图片应当隐藏。

```rust tabs
text("Settings")
    .role(AccessibilityRole::Header)
    .text_size(px(22.0))
    .font_weight(FontWeight::BOLD)
```

```tsx tabs
<Text role="header" style={{ fontSize: 22, fontWeight: "700" }}>Settings</Text>
```

### 状态与值

应用里的开关用 `nsh/base` 的 [`Switch`](../elements/switch.md)，角色和状态由它自己设置。下面的例子展示在视图上设置角色和状态的效果。

```rust tabs
use nsh_core::{Checked, prelude::*};

// 用视图画出来的开关。
view()
    .on_press(move || on.update(|v| *v = !*v))
    .role(AccessibilityRole::Switch)
    .label("Wi-Fi")
    .accessibility_state(move || AccessibilityState {
        checked: Some(if on.get() { Checked::True } else { Checked::False }),
        ..AccessibilityState::default()
    })
    .hit_slop(EdgeInsets::all(px(8.0)))
    .w(px(51.0))
    .h(px(31.0))
    .rounded_full()
    .p(px(2.0))
    .bg(move || if on.get() { rgb(0x22c55e) } else { rgb(0xd4d4d8) })
    .child(
        view()
            .size(px(27.0))
            .rounded_full()
            .bg(white())
            .style_with(move |s| s.translate_x(px(if on.get() { 20.0 } else { 0.0 }))),
    )
```

```tsx tabs
// 用视图画出来的开关。
<View
  onPress={() => on.set(!on())}
  role="switch"
  accessibilityLabel="Wi-Fi"
  accessibilityState={{ checked: on() }}
  hitSlop={8}
  class="h-[31px] w-[51px] rounded-full p-0.5 transition-colors"
  classList={{ "bg-green-500": on(), "bg-zinc-300": !on() }}
>
  <View class="size-[27px] rounded-full bg-white transition-transform" classList={{ "translate-x-5": on() }} />
</View>
```

状态在 Rust 中是 `AccessibilityState { disabled, selected, checked: Option<Checked>, busy, expanded }`，在 TSX 中是 `{ disabled?, selected?, checked?: boolean | "mixed", busy?, expanded? }`。禁用视图（`.disabled(..)`、`disabled`）也意味着禁用状态。带 `min`、`max` 和 `now` 的 `accessibilityValue` 以百分比朗读；带 `text` 时按原文朗读（"3 of 10"、"Medium"）。

## 操作

可按压视图已经支持激活。其他操作用 `accessibilityActions` 声明，用 `onAccessibilityAction` 处理；Rust 组件用 `.on_accessibility_action(|name: &str| ..)` 收到所执行操作的名称：

```tsx
function Quantity() {
  const n = signal(1);
  return (
    <View
      accessible
      role="adjustable"
      accessibilityLabel="Quantity"
      accessibilityValue={{ text: String(n()) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => {
        if (e.actionName === "increment") n.update((v) => v + 1);
        if (e.actionName === "decrement") n.update((v) => Math.max(0, v - 1));
      }}
      style={{ flexDirection: "row", alignItems: "center", gap: 12 }}
    >
      <View onPress={() => n.update((v) => Math.max(0, v - 1))}><Text>−</Text></View>
      <Text>{n()}</Text>
      <View onPress={() => n.update((v) => v + 1)}><Text>+</Text></View>
    </View>
  );
}
```

有些操作名称是标准的，对应平台自己的手势：

| 名称 | iOS（VoiceOver） | Android（TalkBack） |
|---|---|---|
| `activate` | 双击 | 双击（点击） |
| `increment`、`decrement` | 向上 / 向下轻扫，随后 VoiceOver 读出新值 | 向前 / 向后滚动 |
| `longpress` | | 双击并按住 |
| `expand`、`collapse` | | 展开 / 收起 |
| `magicTap` | 双指双击 | |
| `escape` | 双指 Z 字形擦除 | |

带有 `increment` 或 `decrement` 的元素，不论角色如何都是可调整的：图表保持 `"image"` 角色，同样能用 VoiceOver 的轻扫和 TalkBack 的滚动逐个切换数据点，每一步之后读出它的 `accessibilityValue`。

其他名称都成为自定义操作，以 `label`（或名称）列在 VoiceOver 的操作转子和 TalkBack 的操作菜单中。自定义操作是滑动删除之类手势的无障碍替代：

```tsx
<View
  accessibilityActions={[{ name: "archive", label: "Archive" }, { name: "delete", label: "Delete" }]}
  onAccessibilityAction={(e) => (e.actionName === "archive" ? archive(mail.id) : remove(mail.id))}
>
  …
</View>
```

## 分组与隐藏

让视图成为无障碍元素（`.accessible(true)`、`accessible`）会让一个视图成为一个整体元素：带标题、副标题和价格的卡片会一次读完，而不需要用户在三段文字之间来回轻扫。

```rust tabs
view()
    .accessible(true)
    .on_press(open)
    .role(AccessibilityRole::Button)
    .p(px(16.0))
    .child(text("Blue jacket"))
    .child(text("Size M"))
    .child(text("$120"))
```

```tsx tabs
<View accessible onPress={open} role="button" style={{ padding: 16 }}>
  <Text>Blue jacket</Text>
  <Text>Size M</Text>
  <Text>$120</Text>
</View>
```

隐藏没有信息量的东西：装饰性图片、分隔线、旁边文字已经表达了同样意思的图标。

```tsx
<Image src={decoration} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
```

`accessibilityElementsHidden`（iOS 的叫法）和 `importantForAccessibility="no-hide-descendants"`（Android 的叫法）在两个平台上都会隐藏子树；两者同时设置也没有坏处。

## 屏幕阅读器与用户的设置

在 Rust 中，prelude 报告用户的设置并与屏幕阅读器交互：`screen_reader()` 和 `reduce_motion()` 是响应式的，`announce_for_accessibility(message)` 让屏幕阅读器朗读一条消息，元素的 `element_ref()` 用 `set_accessibility_focus()` 把屏幕阅读器的焦点移到它上面。在 TSX 中，`nsh` 的无障碍 API 报告用户的设置，并让你与屏幕阅读器交互。

| 成员 | 说明 |
|---|---|
| `screenReaderEnabled()` | VoiceOver 或 TalkBack 是否在运行（响应式）。 |
| `reduceMotion()` | 用户是否要求减少动态效果（响应式）。 |
| `announce(message)` | 屏幕阅读器朗读 `message`。 |
| `setAccessibilityFocus(ref)` | 把屏幕阅读器的焦点移到某个视图。 |

这些设置是访问器：在绑定或 effect 中读取它们，用户更改设置时读取它们的地方随之更新，而且不需要清理。

```rust tabs
use nsh_core::prelude::*;

fn upload() -> impl IntoElement {
    let done = signal(false);
    let result = element_ref();
    let finish = move || {
        done.set(true);
        announce_for_accessibility("Upload complete");
        result.set_accessibility_focus();
    };
    view()
        .gap(px(12.0))
        // 自动轮播在屏幕阅读器下很难使用：改为显示列表。
        .child(when(move || !screen_reader(), photo_carousel).otherwise(photo_list))
        .child(
            text(move || if done.get() { "Uploaded 3 photos" } else { "Uploading…" })
                .element_ref(&result),
        )
}
```

```tsx tabs
import { signal, Text, View, type YNode } from "nsh";
import { announce, screenReaderEnabled, setAccessibilityFocus } from "nsh";

function Upload() {
  const done = signal(false);
  let result!: YNode;
  const finish = () => {
    done.set(true);
    announce("Upload complete");
    setAccessibilityFocus(result);
  };
  return (
    <View style={{ gap: 12 }}>
      {/* 自动轮播在屏幕阅读器下很难使用：改为显示列表。 */}
      <If when={!screenReaderEnabled()} else={<PhotoList />}>
        <PhotoCarousel />
      </If>
      <Text ref={result}>{done() ? "Uploaded 3 photos" : "Uploading…"}</Text>
    </View>
  );
}
```

播报那些用户否则会错过的变化：后台保存完成、在焦点之外出现的错误、计时结束。在 Android 上，给视图设置 `android={{ accessibilityLiveRegion: "polite" }}`，TalkBack 就会自动播报它的变化。

## 文字大小

除非关闭它（`.allow_font_scaling(false)`、`allowFontScaling={false}`），文本和输入框都会跟随系统文字大小（iOS 的动态字体，Android 的字体大小）。与其关闭它，不如为它设计：

- 让文字可以换行：包含文字的视图不要设置固定高度。
- 对特别大的标题用 `.max_font_size_multiplier(..)` / `maxFontSizeMultiplier` 设置上限，而不是禁用缩放。
- 文字很大时切换布局：读取 `font_scale()`（Rust）或 `nsh` 中的 `fontScale()`（TSX）（例如超过 1.3 时把标签和值上下排列）。

见[设备与环境](./device-and-environment.md#文字大小)。

## 减少动态效果

当用户打开 iOS 的"减弱动态效果"或 Android 的"移除动画"时，`reduce_motion()`（Rust）和 `reduceMotion()`（TSX）为 `true`。你的动画按你编写的方式运行，所以用它，或 Tailwind 的 `motion-reduce:` 和 `motion-safe:` 变体，把大幅度的运动替换为淡入淡出或直接切换：

```rust tabs
use nsh_core::{element::LayoutAnimation, prelude::*};

let toggle = move || {
    if !reduce_motion() {
        animate_layout(LayoutAnimation::SPRING);
    }
    expanded.update(|e| *e = !*e);
};

view()
    .on_press(toggle)
    .when(!reduce_motion(), |v| v.active(|s| s.scale(0.95)))
```

```tsx tabs
import { View } from "nsh";
import { reduceMotion } from "nsh";
import { LayoutAnimation } from "nsh";

const toggle = () => {
  if (!reduceMotion()) LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
  expanded.set(!expanded());
};

<View onPress={open} class="transition active:scale-95 motion-reduce:transition-none" />
<View class="motion-safe:animate-bounce" />
```

## 触摸目标

可按压元素至少要有 44 × 44 点。控件必须看起来更小时，用点击区域扩展（`.hit_slop(..)`、`hitSlop`）扩大触摸区域，而不是放大它的尺寸；见[触摸与手势](./touch-and-gestures.md#点击区域hitslop)。

## 检查你的应用

- 打开 VoiceOver（iOS 设置中的辅助功能，或设置好后三击侧边按钮）或 TalkBack，不看屏幕使用应用：每个控件都应该说明它是什么、做什么。
- 在 iOS 模拟器上，Xcode 的 Accessibility Inspector 可以查看每个元素的标签、特征和值。
- 试试最大的文字大小和深色模式。
- 测试标识（`.test_id(..)`、`testID`）为 UI 测试提供一个稳定的标识，不会随标签的语言变化。

## 相关内容

- [`nsh` 的无障碍 API](../modules/nsh.md#accessibility)：参考。
- [`View`](../elements/view.md)：所有无障碍属性。
- [动画](./animation.md#减少动态效果) 与 [设备与环境](./device-and-environment.md)。
