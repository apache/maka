---
title: 动画
description: 动效（现成的入场、退场、吸引注意和循环动效，或你自己的关键帧），样式过渡与关键帧动画，动画值的 timing、spring、decay 和关键帧，插值，组合动画，缓动，布局动画，以及哪些部分运行在 UI 线程上，用 Rust 和 TSX 编写。
order: 43
group: ui
demo: guide-animation
---

# 动画

NSH 中的所有动画都运行在 UI 线程上。你用 Rust 或 TSX 描述一次，平台就逐帧播放（iOS 上是 Core Animation 和 display link，Android 上是 UI 线程的动画器），不再回调你的代码。繁忙的引擎线程不会让动画卡顿，动画运行期间也不消耗你的任何代码。

共有六种工具，从最现成到最灵活：

| 工具 | 适用场景 |
|---|---|
| [动效](#动效) | 视图的入场、退场、吸引注意或循环：现成的动效（`fadeInUp`、`shake`、`pulse`……）或你自己的关键帧，作用于它的不透明度和变换。 |
| [过渡](#过渡) | 样式变化时以动画代替跳变：颜色、不透明度、变换。 |
| [关键帧动画](#关键帧动画) | 加载指示器、闪烁的占位块、跳动的提示。 |
| [关键帧](#关键帧) | 让任意动画值像 CSS 那样走过一组关键帧：offset、每段的缓动、迭代次数和方向。 |
| [动画值](#动画值) | 任何由随时间变化的值驱动的效果：弹簧、手势、滚动位置、动画序列。 |
| [布局动画](#layoutanimation) | 更新后尺寸与位置的变化：条目插入、删除、重新排序，面板展开。 |

## 动效

动效（motion）以原生方式让视图的不透明度和变换走过一组关键帧。在拥有该视图的组件中创建它（Rust 中的 `motion()`，TSX 中 `nsh/animated` 的 `createMotion()`），绑定到视图上，再在它上面播放现成的动效或你自己的动效。`enter` 让视图从某个动效的起点开始，并立即播放它，于是视图从第一帧起就在入场。

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    let card = motion().entering(MotionPreset::FadeInUp);
    view().flex_1().items_center().justify_center().child(
        view()
            .size(px(120.0))
            .rounded(px(16.0))
            .bg(rgb(0x0969da))
            .bind_motion(&card)
            .on_press(move || {
                card.play(MotionPreset::Shake);
            }),
    )
}
```

```tsx tabs
import { mount, View } from "nsh";
import { createMotion } from "nsh/animated";

function App() {
  const card = createMotion({ enter: "fadeInUp" });
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <View
        onPress={() => card.play("shake")}
        style={{ width: 120, height: 120, borderRadius: 16, backgroundColor: "#0969da", ...card.style }}
      />
    </View>
  );
}

mount(App);
```

动效的每个通道都有一个动画值：`opacity`（0..1）、`translateX` 和 `translateY`（点）、`rotate`、`rotateX` 和 `rotateY`（度）、`scale`、`scaleX` 和 `scaleY`。它们从静止状态开始（不透明度和缩放为 1，其余为 0），并按这个顺序作用：先平移，再旋转，最后缩放，都绕视图的变换原点进行。动效本身没有外观：它只移动你设置好样式的东西。

动效只移动不透明度和变换。展开 `m.style` 会设置视图的 `opacity`；想保留你自己的不透明度，就只绑定变换（`transform: m.transform`）。颜色用动画值和 [`interpolate`](#插值) 来驱动。

| TSX | Rust | 说明 |
|---|---|---|
| `createMotion(options?)` | `motion()` | 所有通道处于静止状态的动效。 |
| `createMotion({ initial: { opacity: 0 } })` | `m.value(MotionChannel::Opacity).set(0.0)` | 各通道的起始值；未指定的通道从静止状态开始。 |
| `createMotion({ enter, delay, duration, ... })` | `motion().entering(spec)` | 从 `enter` 的起点开始并立即播放它；其余选项修改它的时间参数。`enter` 设置它所移动的通道，优先于 `initial`。 |
| `style={m.style}`、`m.transform` | `.bind_motion(&m)` | 绑定各通道：`m.style` 是 `{ opacity, transform }`；把 `m.transform` 展开到带有你自己一个步骤的变换中。一个动效占用视图 8 个变换步骤中的 7 个（`scale` 合并进 `scaleX` 和 `scaleY`），留下一个给你，例如 3D 翻转用的 `[{ perspective: 600 }, ...m.transform]`。Rust 中动效的变换作用在视图自身的变换之后。 |
| `m.opacity`、`m.translateX`、... | `m.value(MotionChannel::Opacity)`、... | 单个通道的动画值，可用于插值或手动驱动。 |
| `m.play(motion, options?)` | `m.play(spec)` | 播放预设或你自己的动效；新的动效会打断正在播放的那个。播放完成时以 `true` 兑现（Rust 中为 `AnimationEnd`）。 |
| `m.animation(motion, options?)` | `m.animation(spec)` | 同一个动效，作为尚未启动的[组合动画](#组合动画)，可与其他动画串联、错开或循环。 |
| `play(motion, { ignoreReduceMotion: true })` | `m.play_ignoring_reduce_motion(spec)` | 即使用户要求减少动态效果也照常播放。 |
| `m.stop()` | `m.stop()` | 停在当前位置。 |
| `m.reset()` | `m.reset()` | 停止，并把所有通道放回静止状态。 |

### 预设

现成的动效就是数据：`nsh/animated` 的 `motions`（`play("fadeInUp")` 播放的就是 `motions.fadeInUp`），以及 Rust 中的 `MotionPreset`（`MotionPreset::FadeInUp.spec()`）。距离以点为单位，按控件和卡片的尺寸设定；对更大的视图，可以按比例放大动效的数值，或者编写自己的关键帧。`swing` 等旋转都绕视图的变换原点进行：给摇摆的挂牌加上 `transformOrigin: "top"`（`.origin_top()`）。

**入场（enter）**：从隐藏或偏离的位置开始，在静止状态结束。

| TSX | Rust | 时长 | 说明 |
|---|---|---|---|
| `fadeIn` | `MotionPreset::FadeIn` | 300 ms | 淡入。 |
| `fadeInUp` | `MotionPreset::FadeInUp` | 450 ms | 淡入，同时向上升到位。 |
| `fadeInDown` | `MotionPreset::FadeInDown` | 450 ms | 淡入，同时向下落到位。 |
| `fadeInLeft` | `MotionPreset::FadeInLeft` | 450 ms | 淡入，从左侧进入。 |
| `fadeInRight` | `MotionPreset::FadeInRight` | 450 ms | 淡入，从右侧进入。 |
| `zoomIn` | `MotionPreset::ZoomIn` | 350 ms | 淡入，从 90 % 放大。 |
| `popIn` | `MotionPreset::PopIn` | 450 ms | 弹出：从一半大小长大，略超过原尺寸后回落。 |
| `bounceIn` | `MotionPreset::BounceIn` | 650 ms | 弹跳入场，两次越过目标。 |
| `slideInUp` | `MotionPreset::SlideInUp` | 400 ms | 从下方滑上来，不淡入（面板、提示条）。 |
| `slideInDown` | `MotionPreset::SlideInDown` | 400 ms | 从上方滑下来，不淡入。 |
| `flipInX` | `MotionPreset::FlipInX` | 600 ms | 绕水平轴翻转入场。 |
| `flipInY` | `MotionPreset::FlipInY` | 600 ms | 绕垂直轴翻转入场。 |

**退场（exit）**：从静止状态开始，在隐藏或偏离的位置结束。

| TSX | Rust | 时长 | 说明 |
|---|---|---|---|
| `fadeOut` | `MotionPreset::FadeOut` | 250 ms | 淡出。 |
| `fadeOutUp` | `MotionPreset::FadeOutUp` | 300 ms | 淡出，同时向上离开。 |
| `fadeOutDown` | `MotionPreset::FadeOutDown` | 300 ms | 淡出，同时向下离开。 |
| `fadeOutLeft` | `MotionPreset::FadeOutLeft` | 300 ms | 向左淡出。 |
| `fadeOutRight` | `MotionPreset::FadeOutRight` | 300 ms | 向右淡出。 |
| `zoomOut` | `MotionPreset::ZoomOut` | 250 ms | 淡出，缩小到 90 %。 |
| `popOut` | `MotionPreset::PopOut` | 300 ms | 弹走：先微微鼓起，再缩小消失。 |
| `slideOutDown` | `MotionPreset::SlideOutDown` | 300 ms | 向下滑出视野，不淡出。 |
| `slideOutUp` | `MotionPreset::SlideOutUp` | 300 ms | 向上滑出视野，不淡出。 |

**吸引注意（attention）**：在静止状态开始，也在静止状态结束。

| TSX | Rust | 时长 | 说明 |
|---|---|---|---|
| `shake` | `MotionPreset::Shake` | 500 ms | 左右摇晃：密码错误、字段无效。 |
| `headShake` | `MotionPreset::HeadShake` | 800 ms | 摇头：更温和的“不”。 |
| `wiggle` | `MotionPreset::Wiggle` | 600 ms | 绕中心扭动：提示有东西值得注意。 |
| `swing` | `MotionPreset::Swing` | 900 ms | 像挂牌一样从上边缘摆动。 |
| `pulse` | `MotionPreset::Pulse` | 500 ms | 稍稍变大再恢复：轻微的强调。 |
| `heartbeat` | `MotionPreset::Heartbeat` | 900 ms | 像心跳一样跳两下：点赞、收藏。 |
| `rubberBand` | `MotionPreset::RubberBand` | 800 ms | 像橡皮筋一样压扁又拉伸。 |
| `jello` | `MotionPreset::Jello` | 800 ms | 像果冻一样晃动。 |
| `tada` | `MotionPreset::Tada` | 900 ms | 先缩小，再边放大边扭动：一份奖励。 |
| `jump` | `MotionPreset::Jump` | 700 ms | 跳起，落地时压扁一下。 |
| `flash` | `MotionPreset::Flash` | 800 ms | 闪烁两次。 |

**循环（loop）**：一直重复，直到被停止。

| TSX | Rust | 时长 | 说明 |
|---|---|---|---|
| `spin` | `MotionPreset::Spin` | 1000 ms | 一圈接一圈地旋转。 |
| `float` | `MotionPreset::Float` | 1500 ms | 上下漂浮。 |
| `breathe` | `MotionPreset::Breathe` | 1800 ms | 呼吸：微微变大、变淡，循环往复。 |
| `sway` | `MotionPreset::Sway` | 1600 ms | 绕中心来回摇摆。 |
| `bob` | `MotionPreset::Bob` | 1000 ms | 像弹跳的球一样上下起伏。 |
| `glow` | `MotionPreset::Glow` | 2000 ms | 明暗交替地闪烁。 |

`play` 的时间选项会覆盖预设的设置（`m.play("shake", { duration: 300 })`），预设也可以展开到你自己的动效中（`m.play({ ...motions.fadeInUp, duration: 600 })`）。在 Rust 中修改预设的 spec：`MotionPreset::FadeInUp.spec().timing(|t| t.delay(100.0))`。

### 自定义动效

自定义动效由每个通道的关键帧和一套时间参数（即[关键帧](#关键帧)的选项）组成。在 TSX 中，可以按通道写关键帧（`{ opacity: [0, 1] }`），也可以像 Web Animations API 那样写一组帧（`[{ opacity: 0, translateY: 24 }, { opacity: 1, translateY: 0 }]`），每帧可带 `offset` 和 `easing`。在帧列表中，没有 offset 的帧按它在列表中的位置排布，每个通道只跟随写到它的那些帧。角度可以写成字符串（`"45deg"`、`"0.5turn"`）。在 Rust 中构建一个 `MotionSpec`。

```rust tabs
let rise = MotionSpec::new(KeyframeTiming::new(400.0))
    .values(MotionChannel::Opacity, [0.0, 1.0])
    .track(
        MotionChannel::TranslateY,
        [Keyframe::at(0.0, 24.0).ease(Easing::EaseOut), Keyframe::at(1.0, 0.0)],
    );
card.play(rise);

let flip = MotionSpec::new(KeyframeTiming::new(600.0).infinite())
    .values(MotionChannel::RotateY, [0.0, 180.0, 360.0]);
card.play(flip);
```

```tsx tabs
// 按通道写的关键帧。
card.play({
  duration: 400,
  keyframes: { opacity: [0, 1], translateY: [{ value: 24, easing: "easeOut" }, 0] },
});

// 一组帧。
card.play({
  duration: 400,
  keyframes: [
    { opacity: 0, translateY: 24, easing: "easeOut" },
    { opacity: 1, translateY: 0 },
  ],
});

card.play({ duration: 600, iterations: "infinite", keyframes: { rotateY: ["0deg", "180deg", "360deg"] } });
```

### 入场与列表的错开

给每一行一个入场动效，延迟随行号增长：同时出现的行会依次进入。给延迟设个上限，这样加在列表靠后位置的行不必久等。

```rust tabs
each(items, |item: &Item| item.id, |item, index| {
    let delay = index.get_untracked().min(10) as f32 * 60.0;
    let row = motion().entering(MotionPreset::FadeInUp.spec().timing(|t| t.delay(delay)));
    view()
        .rounded_xl()
        .bg(ZINC.shade(100))
        .p_4()
        .bind_motion(&row)
        .child(text(move || item.get().title))
})
```

```tsx tabs
function Row(props: { title: string; index: number }) {
  const row = createMotion({ enter: "fadeInUp", delay: Math.min(props.index, 10) * 60 });
  return (
    <View class="rounded-xl bg-zinc-100 p-4" style={row.style}>
      <Text>{props.title}</Text>
    </View>
  );
}

<Each of={items()} key={(item) => item.id}>
  {(item, index) => <Row title={item().title} index={index()} />}
</Each>
```

动效也可以组合：`m.animation(..)` 把动效变成尚未启动的[组合动画](#组合动画)，于是 `Animated.stagger` 能以原生方式运行一组动效，从第一项、最后一项、中间一项或任意下标开始计数。给它们一个隐藏的 `initial`（或让它们从动效的起点开始），这样轮到之前什么都不会显示。

```rust tabs
let cards: Vec<Motion> = (0..5)
    .map(|_| {
        let m = motion();
        m.value(MotionChannel::Opacity).set(0.0);
        m
    })
    .collect();
Animation::stagger_from(60.0, StaggerFrom::Center, cards.iter().map(|m| m.animation(MotionPreset::FadeInUp))).start();
```

```tsx tabs
const cards = [0, 1, 2, 3, 4].map(() => createMotion({ initial: { opacity: 0 } }));
Animated.stagger(60, cards.map((m) => m.animation("fadeInUp")), { from: "center" }).start();
```

### 退场

播放退场动效，等它结束，再移除视图。[布局动画](#layoutanimation)让周围的视图补上空位。

```rust tabs
let remove = move || {
    spawn(async move {
        row.play(MotionPreset::FadeOutLeft).await;
        animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
        items.update(|items| items.retain(|i| i.id != id));
    });
};
```

```tsx tabs
const remove = async () => {
  await row.play("fadeOutLeft");
  LayoutAnimation.easeInEaseOut();
  items.set(items().filter((i) => i.id !== id));
};
```

动效会自动遵循用户的[减少动态效果](#减少动态效果)设置：当用户要求减少动态效果时，动效会立即落在它的终点，不产生移动。

## 过渡

指明要动画的属性和时长（Rust 中的 `.transition_all().duration(400.0)`，TSX 中的 `transitionProperty` 和 `transitionDuration`），之后这些属性的变化就会从屏幕上的当前值以原生动画过渡到新值。

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    let on = signal(false);
    view().flex_1().items_center().justify_center().child(
        view()
            .on_press(move || on.update(|on| *on = !*on))
            .size(px(100.0))
            .rounded(move || px(if on.get() { 50.0 } else { 16.0 }))
            .bg(move || if on.get() { rgb(0x8250df) } else { rgb(0x0969da) })
            .rotate(move || deg(if on.get() { 45.0 } else { 0.0 }))
            .scale(move || if on.get() { 1.2_f32 } else { 1.0 })
            .transition_all()
            .duration(400.0)
            .ease_in_out(),
    )
}
```

```tsx tabs
import { mount, signal, View } from "nsh";

function App() {
  const on = signal(false);
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <View
        onPress={() => on.set(!on())}
        style={{
          width: 100,
          height: 100,
          borderRadius: on() ? 50 : 16,
          backgroundColor: on() ? "#8250df" : "#0969da",
          transform: [{ rotate: on() ? "45deg" : "0deg" }, { scale: on() ? 1.2 : 1 }],
          transitionProperty: "all",
          transitionDuration: 400,
          transitionTimingFunction: "ease-in-out",
        }}
      />
    </View>
  );
}

mount(App);
```

| 样式 | Rust | 类型 | 说明 |
|---|---|---|---|
| `transitionProperty` | `.transition()`、`.transition_all()`、`.transition_colors()`、`.transition_opacity()`、`.transition_transform()`、`.transition_shadow()` | `string` | 参与动画的属性，用逗号分隔：`"all"`、`"colors"`、`"opacity"`、`"transform"`、`"box-shadow"`、`"border-radius"` 等。 |
| `transitionDuration` | `.duration(ms)` | `number \| "150ms" \| "0.2s"` | 数字表示毫秒，或 CSS 时间。 |
| `transitionDelay` | `.delay(ms)` | `number \| "150ms" \| "0.2s"` | 开始前的延迟。 |
| `transitionTimingFunction` | `.ease_linear()`、`.ease_in()`、`.ease_out()`、`.ease_in_out()`、`.ease_bezier(..)` | `"linear" \| "ease" \| "ease-in" \| "ease-out" \| "ease-in-out" \| "cubic-bezier(…)"` | 缓动曲线。 |

可过渡的属性按组划分：**颜色**（背景、边框、轮廓、阴影和文字的颜色，渐变色标）、**不透明度**、**变换**、**阴影**（`box-shadow`）以及**形状**（圆角和边框宽度）。CSS 名称及其驼峰形式都可以用（`background-color`、`backgroundColor`、`transform`、`scale` 等）。布局的变化用[布局动画](#layoutanimation)来呈现。

用 Tailwind 时对应的是 `transition`（颜色、不透明度、阴影和变换）、`transition-all`、`transition-colors`、`transition-opacity`、`transition-transform`、`transition-shadow`，再配合 `duration-*`、`delay-*` 和 `ease-*`。与按下状态（`.active(..)`、`active:`）结合，就得到带动画的按下状态：

```rust tabs
view()
    .on_press(save)
    .rounded_xl()
    .bg(BLUE.shade(600))
    .px_5()
    .py_3()
    .transition()
    .duration(150.0)
    .active(|s| s.scale(0.95).bg(BLUE.shade(800)))
    .child(text("Save").font_weight(FontWeight::SEMIBOLD).text_color(white()))
```

```tsx tabs
<View onPress={save} class="rounded-xl bg-blue-600 px-5 py-3 transition duration-150 active:scale-95 active:bg-blue-800">
  <Text class="font-semibold text-white">Save</Text>
</View>
```

过渡从屏幕上的当前值开始，所以中途再次改变目标时，动画会平滑地转向。

## 关键帧动画

内置四种以原生方式运行、默认无限循环的关键帧动画：`spin`（顺时针转一圈）、`ping`（放大到 2 倍并淡出）、`pulse`（淡到一半不透明度再恢复）和 `bounce`（向上跳起自身高度的四分之一再落下）。

```rust tabs
view()
    .size_8()
    .rounded_full()
    .border(px(4.0))
    .border_color(ZINC.shade(300))
    .border_t_color(BLUE.shade(600))
    .animate_spin()
view().h_4().w_40().rounded(px(4.0)).bg(ZINC.shade(200)).animate_pulse()
```

```tsx tabs
<View class="size-8 rounded-full border-4 border-zinc-300 border-t-blue-600 animate-spin" />
<View class="h-4 w-40 rounded bg-zinc-200 animate-pulse" />
```

| 样式 | Rust | 类型 | 说明 |
|---|---|---|---|
| `animationName` | `.animate_spin()`、`.animate_ping()`、`.animate_pulse()`、`.animate_bounce()`、`.animate_none()`，或 `.animation(KeyframeAnimation::new(Keyframes::Spin))` | `"none" \| "spin" \| "ping" \| "pulse" \| "bounce"` | 动画名称。 |
| `animationDuration` | `KeyframeAnimation::duration(ms)` | `number \| "1s" \| …` | 一次迭代的时长。 |
| `animationDelay` | `KeyframeAnimation::delay(ms)` | `number \| "200ms" \| …` | 开始前的延迟。 |
| `animationTimingFunction` | `KeyframeAnimation::easing([x1, y1, x2, y2])` | 同 `transitionTimingFunction` | 缓动曲线。 |
| `animationIterationCount` | `KeyframeAnimation::iterations(n)` | `number \| "infinite"` | 默认 `"infinite"`。 |

Tailwind：`animate-spin`、`animate-ping`、`animate-pulse`、`animate-bounce`、`animate-none`。

## 动画值

动画值是一个存在于 UI 线程上的数字。创建它（Rust 中用 `animated_value(..)`，TSX 中用 `nsh/animated` 的 `createAnimatedValue`），把它绑定到样式，再让它动起来；绑定它的视图每一帧都跟随它，而无需更新。

```rust tabs
#[component]
pub fn App() -> impl IntoElement {
    let x = animated_value(0.0);
    let opacity = animated_value(1.0);
    let play = move || {
        spawn(async move {
            x.timing(240.0, 600.0, Easing::Curve(Curve::Cubic, EaseMode::Out)).await;
            opacity.timing(0.3, 200.0, Easing::EaseInOut).await;
            x.spring(0.0, Spring::default());
            opacity.timing_with(1.0, Timing::default());
        });
    };
    view()
        .flex_1()
        .justify_center()
        .p_6()
        .gap_6()
        .child(
            view()
                .size(px(60.0))
                .rounded(px(12.0))
                .bg(rgb(0x0969da))
                .bind_opacity(&opacity)
                .bind_translate_x(&x),
        )
        .child(view().on_press(play).child(text("Play").text_color(rgb(0x0969da))))
}
```

```tsx tabs
import { mount, Text, View } from "nsh";
import { createAnimatedValue, Easing } from "nsh/animated";

function App() {
  const x = createAnimatedValue(0);
  const opacity = createAnimatedValue(1);
  return (
    <View style={{ flex: 1, justifyContent: "center", padding: 24, gap: 24 }}>
      <View style={{ width: 60, height: 60, borderRadius: 12, backgroundColor: "#0969da", opacity, transform: [{ translateX: x }] }} />
      <View
        onPress={async () => {
          await x.timing(240, { duration: 600, easing: Easing.out(Easing.cubic) });
          await opacity.timing(0.3, { duration: 200 });
          x.spring(0);
          opacity.timing(1);
        }}
      >
        <Text style={{ color: "#0969da" }}>Play</Text>
      </View>
    </View>
  );
}

mount(App);
```

**可以绑定的属性：** 不透明度（`.bind_opacity(..)`）；背景色、边框颜色（所有边）和文字颜色（整段文字），通过插值得到颜色（`.bind_background(..)`、`.bind_border_color(..)`、`.bind_color(..)`）；阴影的颜色、不透明度和半径（`.bind_shadow_color(..)` 等）；以及变换步骤 `translateX`、`translateY`、`scale`、`scaleX`、`scaleY`、`rotate`、`rotateX`、`rotateY` 和 `rotateZ`（`.bind_translate_x(..)`、`.bind_translate_y(..)`、`.bind_scale(..)`、以度为单位的 `.bind_rotate(..)`、`.bind_transform(kind, ..)`）。聚焦环或闪绿的价格就是绑定到边框或文字颜色的颜色插值：

```rust tabs
let flash = animated_value(0.0);
let color = flash.interpolate_colors(&[0.0, 1.0], &[rgb(0x1f2328), rgb(0x1a7f37)]);

text(move || price.get().to_string()).bind_color(&color)
// 价格更新时：flash.set(1.0); flash.timing(0.0, 600.0, Easing::EaseInOut);
```

```tsx tabs
const flash = createAnimatedValue(0);
const color = flash.interpolate({ inputRange: [0, 1], outputRange: ["#1f2328", "#1a7f37"] });

<Text style={{ color }}>{price()}</Text>
// 价格更新时：flash.set(1); flash.timing(0, { duration: 600 });
```

动画值还可以驱动[画布绘制](./canvas.md#用动画值驱动绘制)，接收滚动偏移（[`scrollValue`](./scrolling.md#滚动联动效果scrollvalue)）和手势（[`pan`、`pinch`、`rotation`](./touch-and-gestures.md#原生手势拖动捏合与旋转)）。

动画值由绑定它的视图和创建它的组件保持存活，所以无论你的变量如何出入作用域，绑定都保持连接。在拥有它的组件中创建动画值（如果每个实例都需要自己的值，就不要放在模块顶层）。

### AnimatedValue 的方法

| TSX | Rust | 说明 |
|---|---|---|
| `set(value)` | `set(value)` | 跳到 `value`，停止正在进行的动画。 |
| `stop()` | `stop()` | 让正在运行的动画停在原处；在 TSX 中会以停下时的值 resolve。 |
| `getValue()` | `value()` | 当前值，在它运动所在的 UI 线程上读取（一帧之内给出结果）：TSX 中是 promise，Rust 中是可 await 的结果。 |
| `setOffset(offset)` | `set_offset(offset)` | 在显示值上加上 `offset`：绑定看到的是值 + 偏移，而 `set`、动画和拖动改变的是值本身。 |
| `flattenOffset()` | `flatten_offset()` | 把偏移加到值上，并把偏移设为 0。 |
| `extractOffset()` | `extract_offset()` | 把值移入偏移并把值设为 0：下一次拖动就从 0 开始，叠加在上一次停下的位置上。 |
| `timing(to, { duration?, easing?, delay? })` | `timing(to, ms, easing)`、`timing_with(to, Timing { .. })` | 在 `duration` 毫秒内动画到 `to`（默认 300 毫秒，缓动 `"easeInOut"`）。 |
| `spring(to, { stiffness?, damping?, mass?, velocity? })` | `spring(to, Spring { .. })` | 以弹簧运动到 `to`（默认 stiffness 170、damping 26、mass 1）。 |
| `decay({ velocity?, deceleration?, clamp?, bounce? })` | `decay(velocity, deceleration)`、`decay_within(velocity, deceleration, (min, max), bounce)` | 以 `velocity`（每秒单位数）开始滑行并逐渐减速（默认每毫秒 deceleration 0.998）。设置范围 `[min, max]` 时，它停在边界上，或以 `bounce`（0..1）保留的速度从边界反弹。 |

每个动画都给出一个可以 await 的结果：完成时为 `true`，被打断时（`stop()`、`set()`，或同一个值上启动了新动画）为 `false`。在 TSX 中它是 `Promise<boolean>`，在 Rust 中是 `AnimationEnd`。在运动中的值上启动新动画会平滑地接替旧动画：没有指定速度的弹簧或衰减会沿用该值当前的速度。

```rust tabs
// 弹簧参数：damping 越小越容易过冲，stiffness 越大越快。
x.spring(200.0, Spring { stiffness: 180.0, damping: 8.0, ..Spring::default() });   // 晃动
x.spring(200.0, Spring { stiffness: 400.0, damping: 30.0, ..Spring::default() });  // 干脆，不过冲

// 以拖动的松手速度滑行到停止。
view().pan_values(Some(&x), None).on_pan_end(move |e: &PanEvent| {
    x.decay(Some(e.velocity_x), 0.998);
})

// 留在轨道上、在两端柔和反弹的滑行。
x.decay_within(Some(e.velocity_x), 0.998, (0.0, 300.0), 0.3);

// 值现在在哪里（它在 UI 线程上运动，所以结果是异步的）。
let at = x.value().await;
```

```tsx tabs
// 弹簧参数：damping 越小越容易过冲，stiffness 越大越快。
x.spring(200, { stiffness: 180, damping: 8 });   // 晃动
x.spring(200, { stiffness: 400, damping: 30 });  // 干脆，不过冲

// 以拖动的松手速度滑行到停止。
<View pan={{ x }} onPanEnd={(e) => x.decay({ velocity: e.velocityX })} />

// 留在轨道上、在两端柔和反弹的滑行。
x.decay({ velocity: e.velocityX, clamp: [0, 300], bounce: 0.3 });

// 值现在在哪里（它在 UI 线程上运动，所以结果是异步的）。
const where = await x.getValue();
```

### 关键帧

`keyframes` 像 CSS 关键帧那样让一个值走过一组关键帧：TSX 中是 `value.keyframes(frames, options)`，Rust 中是 `value.keyframes(frames, KeyframeTiming)`（作为[组合动画](#组合动画)的一步时用 `Animated.keyframes(value, { keyframes, ... })` 和 `Animation::keyframes(..)`）。关键帧可以是一个数字（或 `"90deg"` 这样的角度字符串），与其他关键帧均匀分布；也可以是 `{ offset, value, easing }`（Rust 中为 `Keyframe::new(value)`、`Keyframe::at(offset, value)`、`.ease(easing)`）。

```rust tabs
let y = animated_value(0.0);
y.keyframes(
    [Keyframe::new(0.0), Keyframe::at(0.3, -20.0).ease(Easing::EaseIn), Keyframe::new(0.0)],
    KeyframeTiming::new(600.0).easing(Easing::EaseOut).iterations(Some(3)),
);

// 每秒跳一格的时钟指针。
let hand = animated_value(0.0);
hand.keyframes(
    [Keyframe::new(0.0), Keyframe::new(360.0)],
    KeyframeTiming::new(60_000.0).easing(Easing::Steps(60, StepPosition::JumpEnd)).infinite(),
);
```

```tsx tabs
const y = createAnimatedValue(0);
y.keyframes([0, { offset: 0.3, value: -20, easing: "easeIn" }, 0], { duration: 600, easing: "easeOut", iterations: 3 });

// 每秒跳一格的时钟指针。
const hand = createAnimatedValue(0);
hand.keyframes([0, 360], { duration: 60_000, easing: Easing.steps(60), iterations: "infinite" });
```

| 选项 | Rust（`KeyframeTiming`） | 默认值 | 说明 |
|---|---|---|---|
| `duration` | `KeyframeTiming::new(ms)` | 300 | 一次迭代的时长，单位毫秒。 |
| `delay` | `.delay(ms)` | 0 | 第一次迭代前的等待。 |
| `easing` | `.easing(easing)` | CSS `ease` | 没有自带缓动的每一段所用的曲线。 |
| `iterations` | `.iterations(Some(n))`、`.infinite()` | 1 | 迭代次数，或 `"infinite"`。 |
| `direction` | `.direction(PlaybackDirection::Alternate)` | `"normal"` | `"normal"`、`"reverse"`、`"alternate"` 或 `"alternate-reverse"`。 |

它们的播放方式与 CSS 和 Web Animations API 一致：

- 缓动作用于每一段，而不是整体：关键帧的 `easing` 决定从它开始的那一段，时间参数的 `easing` 决定其余各段。
- 没有 offset 的关键帧在相邻关键帧之间均匀分布；第一个默认为 0，最后一个默认为 1。
- 每次迭代都先跳到它的第一个关键帧。没有 offset 为 0 的关键帧时，值从它当前的位置出发。
- 在 `delay` 期间，值已经停在第一个关键帧上（CSS `animation-fill-mode: backwards`），因此延迟的入场显示的是它的第一帧，而不是静止状态的视图。动效同样如此。
- `reverse` 以及 `alternate` 中反向的迭代会倒着播放各段，每段的曲线也随之反转。
- 值停在最后一次迭代结束的位置。播放完成时结果为 `true`，被打断时为 `false`。

### 插值

`interpolate` 通过分段线性映射把值转换为数字、颜色或角度，并返回一个可以绑定的新节点。一个值可以驱动多个属性。在 Rust 中，`interpolate(&input, &output)` 映射为数字，`interpolate_colors(&input, &colors)` 映射为颜色，`interpolate_with(&input, output, Interpolation { .. })` 接受外推和缓动；在 TSX 中，`value.interpolate({ inputRange, outputRange })` 接受全部选项。

```rust tabs
let t = animated_value(0.0);

view()
    .bind_background(&t.interpolate_colors(&[0.0, 1.0, 2.0], &[rgb(0x54aeff), rgb(0x8250df), rgb(0xcf222e)]))
    .bind_opacity(&t.interpolate(&[0.0, 1.0], &[0.4, 1.0]))
    .bind_rotate(&t.interpolate(&[0.0, 1.0], &[0.0, 180.0]))
    .bind_scale(&t.interpolate_with(
        &[0.0, 1.0],
        AnimationOutput::Numbers(vec![0.6, 1.2]),
        Interpolation {
            easing: Easing::Curve(Curve::Back(1.70158), EaseMode::Out),
            ..Interpolation::default()
        },
    ))
```

```tsx tabs
const t = createAnimatedValue(0);

<View
  style={{
    backgroundColor: t.interpolate({ inputRange: [0, 1, 2], outputRange: ["#54aeff", "#8250df", "#cf222e"] }),
    opacity: t.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
    transform: [
      { rotate: t.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] }) },
      { scale: t.interpolate({ inputRange: [0, 1], outputRange: [0.6, 1.2], easing: Easing.out(Easing.back()) }) },
    ],
  }}
/>
```

| 选项 | Rust | 说明 |
|---|---|---|
| `inputRange` | 输入切片 | 递增的输入节点。 |
| `outputRange` | 输出切片，或 `AnimationOutput` | 每个节点对应一个输出：数字、颜色（`"#rrggbb"`、`"rgba(…)"`、颜色名）或角度（`"45deg"`、`"1rad"`）。 |
| `extrapolate` | `Interpolation::extrapolate(Extrapolate::Extend)` | 输入范围之外：`"clamp"`（默认，截断）、`"extend"`（延续两端的线段）或 `"identity"`（直接输出输入值）。 |
| `extrapolateLeft`、`extrapolateRight` | `extrapolate_left`、`extrapolate_right` | 同上，只作用于一侧。 |
| `easing` | `easing` | 塑造每一段的曲线。 |

> [!IMPORTANT]
> 插值默认会**截断**：超出输入范围时，输出停留在最近的端点。因此把滚动视图拉过顶部时，与滚动联动的标题栏停在它的终止状态。想让曲线继续延伸时，传入 `extrapolate: "extend"`（`Extrapolate::Extend`）。

### 算术运算与 diffClamp

节点之间也可以做算术运算，同样在原生端执行：`a.add(b)`、`a.sub(b)`、`a.mul(b)`、`a.div(b)`、`a.mod(b)`（Rust 中为 `a.modulo(b)`；当 `b` 为正时结果不为负，例如 0..360 的角度），其中 `b` 可以是节点或数字。在 TSX 中，`Animated.add`、`subtract`、`multiply`、`divide` 和 `modulo` 是对应的函数形式。

`diffClamp(min, max)`（`diff_clamp`）跟随节点的*变化量*，同时把结果限制在 `min..max` 之内。把它用在滚动偏移上，就得到内容上滑时隐藏、一往下滑就重新出现的标题栏：

```rust tabs
let offset = animated_value(0.0);
let header = offset.diff_clamp(0.0, 56.0);

scroll().flex_1().scroll_value(&offset)
view().absolute().top_0().left_0().right_0().h(px(56.0)).bind_translate_y(&header.mul(-1.0))
```

```tsx tabs
const scroll = createAnimatedValue(0);
const header = scroll.diffClamp(0, 56);

<Scroll style={{ flex: 1 }} scrollValue={scroll}>…</Scroll>
<View style={{ position: "absolute", top: 0, left: 0, right: 0, height: 56, transform: [{ translateY: header.mul(-1) }] }}>…</View>
```

加上 `{ snap: true }`（Rust 中为 `diff_clamp_with(min, max, DiffClamp::snapping())`）后，滚动停止时只显示了一部分的标题栏会把移动做完：它在 UI 线程上用 200 ms 停到完全显示或完全隐藏，取较近的一端。只有当页面滚动的距离至少达到标题栏的高度时它才会隐藏，因此滚动距离不足的页面会显示整个标题栏。移动过程中再次滚动，标题栏会从当前位置继续跟随滚动。

```rust tabs
let header = offset.diff_clamp_with(0.0, 56.0, DiffClamp::snapping());
```

```tsx tabs
const header = scroll.diffClamp(0, 56, { snap: true });
```

## 组合动画

动画由步骤搭建（Rust 中的 `Animation`，TSX 中 `nsh/animated` 的 `Animated`），整棵动画树在原生端运行：每个步骤在上一步结束的那一刻就在 UI 线程上开始，没有间隙，中间也不运行你的代码。

```rust tabs
let ys: Vec<AnimatedValue> = (0..5).map(|_| animated_value(0.0)).collect();
let fade = animated_value(1.0);

let hop = Animation::stagger(
    80.0,
    ys.iter().map(|y| {
        Animation::sequence([
            Animation::timing(y, -30.0, Timing::new(200.0, Easing::Curve(Curve::Quad, EaseMode::Out))),
            Animation::spring(y, 0.0, Spring { stiffness: 300.0, damping: 12.0, ..Spring::default() }),
        ])
    }),
);

let breathe = Animation::sequence([
    Animation::timing(&fade, 0.3, Timing::new(400.0, Easing::EaseInOut)),
    Animation::timing(&fade, 1.0, Timing::new(400.0, Easing::EaseInOut)),
])
.looped(None);

let landed = hop.start();
spawn(async move {
    status.set(if landed.await { "landed" } else { "stopped" });
});
```

```tsx tabs
import { Animated, createAnimatedValue, Easing } from "nsh/animated";

const ys = [0, 1, 2, 3, 4].map(() => createAnimatedValue(0));
const fade = createAnimatedValue(1);

const hop = Animated.stagger(
  80,
  ys.map((y) =>
    Animated.sequence([
      Animated.timing(y, { toValue: -30, duration: 200, easing: Easing.out(Easing.quad) }),
      Animated.spring(y, { toValue: 0, stiffness: 300, damping: 12 }),
    ]),
  ),
);

const breathe = Animated.loop(
  Animated.sequence([
    Animated.timing(fade, { toValue: 0.3, duration: 400 }),
    Animated.timing(fade, { toValue: 1, duration: 400 }),
  ]),
);

hop.start(({ finished }) => console.log(finished ? "landed" : "stopped"));
```

| TSX | Rust | 说明 |
|---|---|---|
| `Animated.timing(value, { toValue, duration?, easing?, delay? })` | `Animation::timing(&value, to, Timing { .. })` | 一个 timing 步骤。 |
| `Animated.spring(value, { toValue, stiffness?, damping?, mass?, velocity? })` | `Animation::spring(&value, to, Spring { .. })` | 一个弹簧步骤。 |
| `Animated.decay(value, { velocity?, deceleration?, clamp?, bounce? })` | `Animation::decay(&value, velocity, deceleration)`、`Animation::decay_within(..)` | 一个衰减步骤。 |
| `Animated.sequence(list)` | `Animation::sequence(list)` | 依次执行。 |
| `Animated.parallel(list, { stopTogether? })` | `Animation::parallel(list)`、`.stop_together(..)` | 同时执行。 |
| `Animated.stagger(ms, list, { from? })` | `Animation::stagger(ms, list)`、`Animation::stagger_from(ms, StaggerFrom::Center, list)` | 同时执行，但每个比前一个晚 `ms` 毫秒开始，从 `from` 开始计数：`"first"`（默认）、`"last"`、`"center"`（从中间向两侧扩散）或一个下标（`StaggerFrom::First`、`Last`、`Center`、`Index(i)`）。 |
| `Animated.keyframes(value, { keyframes, ...timing })` | `Animation::keyframes(&value, frames, KeyframeTiming)` | 一步[关键帧](#关键帧)。 |
| `Animated.delay(ms)` | `Animation::delay(ms)` | 等待。 |
| `Animated.loop(animation, { iterations?, resetBeforeIteration? })` | `.looped(iterations)`、`.reset_before_iteration(..)` | 重复（默认无限次；Rust 中为 `None`）。 |

组合动画提供 `start()`（在 TSX 中也可以带回调，并返回表示是否完成的 promise；在 Rust 中返回可 await 的 `bool`；再次调用会重新运行）、`stop()`（停在原处）和 `reset()`（停止，并把各个值恢复到开始时的状态）。回调对整棵动画树只调用一次。

正在运行的动画不会让它的值保持存活：拥有这些值的组件（它的视图和变量）消失时，无限循环的动画随之停止，结果为 `false`。

## 缓动

缓动曲线是在原生端求值的数据：TSX 中是 `nsh/animated` 的 `Easing`，Rust 中是 `Easing` 枚举。

| TSX | Rust | 说明 |
|---|---|---|
| `Easing.linear`、`Easing.ease` | `Easing::Linear`、`Easing::Bezier(0.25, 0.1, 0.25, 1.0)` | 匀速；CSS 的 `ease`。 |
| `Easing.quad`、`Easing.cubic`、`Easing.poly(n)` | `Curve::Quad`、`Curve::Cubic`、`Curve::Poly(n)` | `t²`、`t³`、`tⁿ`。 |
| `Easing.sin`、`Easing.circle`、`Easing.exp` | `Curve::Sin`、`Curve::Circle`、`Curve::Exp` | 正弦、圆形、指数。 |
| `Easing.back(s?)` | `Curve::Back(s)` | 先回拉再前进（过冲量 `s`，默认 1.70158）。 |
| `Easing.elastic(bounciness?)` | `Curve::Elastic(bounciness)` | 弹性过冲。 |
| `Easing.bounce` | `Curve::Bounce` | 结尾处弹跳。 |
| `Easing.bezier(x1, y1, x2, y2)` | `Easing::Bezier(x1, y1, x2, y2)` | 三次贝塞尔曲线，与 CSS 相同。 |
| `Easing.steps(count, position?)` | `Easing::Steps(count, StepPosition::JumpEnd)` | 在 `count` 个级别之间跳变而不连续移动，与 CSS `steps()` 相同：逐帧的精灵图、跳动的指针。`position` 为 `"jump-end"`（默认，也可写 `"end"`）、`"jump-start"`（`"start"`）、`"jump-none"` 或 `"jump-both"`。 |
| `Easing.in(e)`、`Easing.out(e)`、`Easing.inOut(e)` | `Easing::Curve(curve, EaseMode::In)`、`EaseMode::Out`、`EaseMode::InOut` | 曲线本身都是 "in" 形式；`out` 和 `inOut` 把它们反转。 |

在 TSX 中，凡是接受缓动的地方，也可以传入名称（`"linear"`、`"ease"`、`"easeIn"`、`"easeOut"`、`"easeInOut"`）或贝塞尔数组 `[x1, y1, x2, y2]`；在 Rust 中，`Easing::EaseIn`、`Easing::EaseOut` 和 `Easing::EaseInOut` 就是 CSS 的对应曲线。

```rust tabs
x.timing(1.0, 300.0, Easing::Curve(Curve::Back(1.70158), EaseMode::Out));
x.timing(1.0, 300.0, Easing::EaseOut);
x.timing(1.0, 300.0, Easing::Bezier(0.2, 0.8, 0.2, 1.0));
```

```tsx tabs
x.timing(1, { easing: Easing.out(Easing.back()) });
x.timing(1, { easing: "easeOut" });
x.timing(1, { easing: [0.2, 0.8, 0.2, 1] });
```

`Easing.sample(easing, count)`（Rust 中的 `sample_easing`）返回曲线在 0 到 1 之间 `count` 个等距点上的值，`Animated.sampleSpring(config, fps?)` / `Animated.sampleDecay(config, fps?)`（`sample_spring`、`sample_decay`）返回弹簧或衰减经过的值，每帧一个（默认每秒 60 帧），从 `config.from`（0）开始直到结束。它们由运行动画的同一套原生代码计算，所以画出的曲线与动画的实际运动完全一致：

```rust tabs
use nsh_core::ui::{sample_easing, sample_spring};

let curve = sample_easing(Easing::Curve(Curve::Back(1.70158), EaseMode::Out), 50); // 50 个进度值
let spring = sample_spring(0.0, 1.0, Spring { stiffness: 180.0, damping: 8.0, ..Spring::default() }, 60.0);
```

```ts tabs
const curve = Easing.sample(Easing.out(Easing.back()), 50); // 50 个进度值
const spring = Animated.sampleSpring({ toValue: 1, stiffness: 180, damping: 8 });
```

## LayoutAnimation

布局动画以原生动画呈现**下一次**更新中的布局变化：移动或改变尺寸的视图平滑地到达新位置，新视图淡入（或缩放）出现，被删除的视图淡出。在改变状态之前调用它：Rust 中是 `animate_layout(..)`，TSX 中是 `LayoutAnimation.configureNext(config)`。

```rust tabs
use nsh_core::ui::LayoutAnimation;

let items = signal(vec![1, 2, 3]);
let next = stored(4);

let add = move || {
    animate_layout(LayoutAnimation::SPRING);
    let n = next.with(|n| {
        *n += 1;
        *n - 1
    });
    items.update(|i| i.insert(0, n));
};
let remove = move || {
    animate_layout(LayoutAnimation::EASE_IN_EASE_OUT);
    items.update(|i| {
        i.remove(0);
    });
};
```

```tsx tabs
import { signal } from "nsh";
import { LayoutAnimation } from "nsh/animated";

const items = signal([1, 2, 3]);
let next = 4;

const add = () => {
  LayoutAnimation.configureNext(LayoutAnimation.Presets.spring);
  items.set([next++, ...items()]);
};
const remove = () => {
  LayoutAnimation.easeInEaseOut();
  items.set(items().slice(1));
};
```

| TSX | Rust | 说明 |
|---|---|---|
| `configureNext(config, onEnd?)` | `animate_layout(config)` | 为下一次提交的变化添加动画；在 TSX 中，完成后调用 `onEnd`。 |
| `create(duration, type?, property?)` | `LayoutAnimation::all(LayoutTransition::new(curve, ms))` | 三个阶段使用同一曲线的配置。 |
| `Presets.easeInEaseOut`、`Presets.linear`、`Presets.spring` | `LayoutAnimation::EASE_IN_EASE_OUT`、`LINEAR`、`SPRING` | 现成的配置。 |
| `easeInEaseOut(onEnd?)`、`linear(onEnd?)`、`spring(onEnd?)` | 用预设调用 `animate_layout` | 使用预设调用 `configureNext`。 |
| `Types`、`Properties` | `LayoutCurve`、`LayoutProperty` | 构造配置时用的名称。 |

配置为 `{ duration, create?, update?, delete? }`（Rust 中为 `LayoutAnimation { create, update, delete }`）：`create` 用于插入的视图，`update` 用于移动或改变尺寸的视图，`delete` 用于删除的视图。每个阶段为 `{ type?, property?, duration?, delay?, springDamping? }`（`LayoutTransition { curve, property, duration_ms, delay_ms }`），其中 `type` 为 `"easeInEaseOut"`、`"spring"`、`"linear"`、`"easeIn"`、`"easeOut"` 或 `"keyboard"`（软键盘自己的曲线，从键盘开始移动时算起，让为它让位的内容与它一起移动；`LayoutCurve::Keyboard`）；`property` 是出现和消失的视图做什么动画（`"opacity"`、`"scaleXY"`、`"scale"`）；`springDamping`（0..1，默认 0.7；`LayoutCurve::Spring { damping }`）决定弹簧的过冲程度。

```rust tabs
use nsh_core::ui::{LayoutAnimation, LayoutCurve, LayoutProperty, LayoutTransition};

animate_layout(LayoutAnimation {
    create: Some(LayoutTransition::new(LayoutCurve::EaseOut, 300.0)),
    update: Some(LayoutTransition::new(LayoutCurve::Spring { damping: 0.8 }, 300.0)),
    delete: Some(LayoutTransition {
        property: LayoutProperty::Scale,
        ..LayoutTransition::new(LayoutCurve::EaseIn, 300.0)
    }),
});
```

```tsx tabs
LayoutAnimation.configureNext({
  duration: 300,
  create: { type: "easeOut", property: "opacity" },
  update: { type: "spring", springDamping: 0.8 },
  delete: { type: "easeIn", property: "scaleXY" },
});
```

## 各部分运行在哪里

| | 运行于 | 每帧运行你的代码 |
|---|---|---|
| 过渡、关键帧动画 | UI 线程 | 无 |
| 动效、关键帧、`timing` / `spring` / `decay`、组合动画 | UI 线程 | 无；结束时通知你的代码 |
| `interpolate`、算术运算、`diffClamp` | UI 线程 | 无 |
| `scrollValue`、`pan` / `pinch` / `rotation` | UI 线程 | 无；开始和结束时通知你的代码 |
| 布局动画 | UI 线程 | 无 |
| `requestAnimationFrame` 循环（Rust 中的 `request_animation_frame`）、`onScroll` 处理函数、`PanResponder` | 你的代码，然后更新 | 每一帧 |

`requestAnimationFrame`（TSX 中跟随屏幕刷新的全局函数）只用于无法事先描述的情况，例如在你的代码中运行的物理模拟。凡是能用动画值表达的，都应该用动画值。

## 减少动态效果

当用户要求减少动态效果时（iOS 的"减弱动态效果"、Android 的"移除动画"），Rust 中的 `reduce_motion()` 和 TSX 中 `nsh/accessibility` 的 `reduceMotion()` 为 `true`，Tailwind 的 `motion-reduce:` / `motion-safe:` 变体随之生效。

[动效](#动效)会自动遵循这一设置：`play` 和 `enter` 会立即落在动效的终点，不产生移动，结果与正常播放完一样为 `true`。退场依然以隐藏结束，入场依然以静止结束。对承载用户所需信息的动效（例如表示进度的旋转指示器），传入 `ignoreReduceMotion: true`（Rust 中用 `play_ignoring_reduce_motion`）。

过渡、关键帧动画、动画值、关键帧和组合动画按原样播放；用它们来选择更平和的替代方案：

```rust tabs
let open = move || {
    if reduce_motion() {
        panel.set(0.0);
    } else {
        panel.spring(0.0, Spring::default());
    }
};

view().style_when(|| !reduce_motion(), |s| s.animate_bounce())
```

```tsx tabs
import { View } from "nsh";
import { reduceMotion } from "nsh/accessibility";

const open = () => (reduceMotion() ? panel.set(0) : panel.spring(0));

<View class="motion-safe:animate-bounce" />
```

见[无障碍](./accessibility.md#减少动态效果)。

## 相关内容

- [`nsh/animated`](../modules/nsh-animated.md)：TSX 参考。
- [触摸与手势](./touch-and-gestures.md)：用手指驱动动画值。
- [滚动](./scrolling.md#滚动联动效果scrollvalue)：`scrollValue`。
- [画布](./canvas.md#用动画值驱动绘制)：在绘制中使用动画值。
- [样式参考](../modules/style-reference.md)：`transition*` 与 `animation*` 键。
