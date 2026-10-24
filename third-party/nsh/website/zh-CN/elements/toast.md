---
title: Toast
description: Toast、ToastStack 和 ToastManager：与 gpui-base 一致的无样式 toast，带过渡状态的语义根、把 toast 排成层叠的栈，以及无界面的生命周期。
order: 29.5
group: base
demo: el-toast
---

# Toast

Toast 是在应用上方显示一段时间的简短消息："已复制"、"草稿已删除 · 撤销"、"发送失败"。`nsh/base` 用三个无样式的部分提供它们的行为，与 GPUI Kit 的 `gpui-base` 一致：

- **`ToastManager`** 按顺序保存 toast 及其生命周期：每个 toast 先是 `"starting"`，经过动效时长后变为 `"present"`，在 present 且未暂停时倒计时，结束后以 `"ending"` 保留退出时长，然后被移除。
- **`ToastStack`** 测量其中的 toast，并从一侧边缘排列它们，最新的离边缘最近：收起时是重叠的层，展开时（指针停在上面，或手指按在上面）是列表，用弹簧动画移动。
- **`Toast`** 是每个 toast 的根：`alert` 角色、供应用设置样式的 `transitionStatus`、请求关闭它的滑动手势，以及在它出现时由读屏软件朗读的标签。

外观和内容属于应用，在任意位置显示 toast 的便捷函数也属于应用：应用在这些部分之上构建自己的 `toast(...)`，就像 gallery（`examples/gallery/toast.tsx`）那样，也像 GPUI Kit 的通知构建在 `gpui-base` 的 toast 之上。

```rust tabs
use std::time::Duration;

use nsh_core::{time::now, ui::prelude::*};

use nsh_base::{
    Anchor, ToastManager, ToastMotion, ToastOptions, ToastStackState, theme, toast, toast_stack,
};

fn toasts() -> impl IntoElement {
    let manager = stored(ToastManager::<u64, SharedString>::new(ToastMotion::sonner()));
    let shown = signal(Vec::new());
    let state = ToastStackState::new();
    let sync = move || {
        shown.set(manager.with(|m| {
            m.visible(3)
                .map(|(id, t, s)| (*id, t.clone(), s))
                .collect::<Vec<_>>()
        }))
    };
    // Advance the lifecycle while toasts are mounted, paused while expanded.
    set_interval(Duration::from_millis(50), move || {
        if manager.with(|m| m.advance(now(), state.is_expanded()).changed) {
            sync();
        }
    });
    manager.with(|m| {
        m.push(
            1,
            "Copied".into(),
            ToastOptions::timeout(Some(Duration::from_secs(5))),
            now(),
        )
    });
    sync();
    toast_stack()
        .placement(Anchor::BottomCenter)
        .state(state)
        .w(px(340.0))
        .child(each(
            shown,
            |(id, _, _)| *id,
            move |item, _| {
                toast()
                    .transition_status(move || item.get().2)
                    .accessibility_label(move || Some(item.get().1))
                    .on_dismiss_request(move || {
                        manager.with(|m| m.dismiss(&item.get().0, now()));
                    })
                    .rounded_xl()
                    .px_4()
                    .py_3()
                    .bg(move || theme().card)
                    .shadow_lg()
                    .transition_all()
                    .duration(200.0)
                    .starting_class("opacity-0 translate-y-4")
                    .ending_class("opacity-0 scale-95")
                    .child(text(move || item.get().1))
            },
        ))
}
```

```tsx tabs
import { Overlay, signal, Text } from "nsh";
import { safeArea, Toast, type ToastEntry, ToastManager, ToastStack } from "nsh/base";

const manager = new ToastManager();
const shown = signal<ToastEntry[]>([]);
const expanded = signal(false);
const sync = () => shown.set(manager.visible(3));
// Advance the lifecycle on a timer, paused while the stack is expanded.
setInterval(() => {
  if (manager.advance(expanded()).changed) sync();
}, 50);

export function toast(title: string) {
  manager.push(crypto.randomUUID(), { title }, { timeout: 5000 });
  sync();
}

export function Toaster() {
  return (
    <Overlay class="inset-x-0 bottom-0 items-center p-4" style={{ paddingBottom: safeArea().bottom + 16 }}>
      <ToastStack placement="bottomCenter" class="w-80" onExpandedChange={expanded.set} onCancel={() => {
        const newest = shown().filter((t) => t.status !== "ending").at(-1);
        if (newest) { manager.dismiss(newest.id); sync(); }
      }}>
        <Each of={shown()} key={(t: ToastEntry) => t.id}>
          {(t) => (
            <Toast
              transitionStatus={t().status}
              accessibilityLabel={(t().value as { title: string }).title}
              onDismissRequest={() => { manager.dismiss(t().id); sync(); }}
              class="rounded-xl bg-card px-4 py-3 shadow-lg transition-all duration-200"
              startingClass="opacity-0 translate-y-4"
              endingClass="opacity-0 scale-95"
            >
              <Text class="font-semibold text-card-foreground">{(t().value as { title: string }).title}</Text>
            </Toast>
          )}
        </Each>
      </ToastStack>
    </Overlay>
  );
}
```

`Toast`、`ToastStack` 和 `ToastManager` 来自 [`nsh/base`](../modules/nsh-base.md)。在 Rust 中请按名称导入 `toast`：prelude 中的 `toast` 是 Android 的系统 toast（[`nsh/android`](../modules/nsh-android.md) 的 `Toast.show`）。

<a id="toastmanager"></a>

## ToastManager

Manager 没有界面：它不渲染任何东西，也不运行计时器。应用 push toast，用 `visible(limit)` 返回的 toast 及其状态进行渲染，并在有 toast 挂载期间用计时器调用 `advance`，在栈展开时传入 `paused`。在 Rust 中它是基于应用自己的 id 和值的 `ToastManager<I, T>`，每次调用传入一个 `Instant`；在 TS 中它是基于字符串 id 和任意 JSON 值的类，使用引擎的时钟（包括测试的手动时钟）。

- `push(id, value, options)` 添加最新的 toast，替换 id 相同的 toast（并返回其值）；`options.timeout` 是它以毫秒计的显示时长（不设置时一直保留到被关闭）。
- `dismiss(id)` 开始一个 toast 的退出；`dismissAll()` 开始所有 toast 的退出，并返回它们的 id。
- `advance(paused)` 推进生命周期并报告变化：`presented`、`ending`（计时结束）、`removed`（带其值）以及 `changed`。
- `visible(limit)` 是最新的 `limit` 个未处于 ending 的 toast 加上所有 ending 的 toast，从旧到新；`entries()`（Rust 的 `iter()`）是全部 toast；还有 `get(id)`、`len()`、`isEmpty()`。

`ToastMotion` 保存两者共用的参数：`duration`（400 毫秒：进入的期限和栈的弹簧响应时间）、`exitDuration`（200 毫秒）、`collapsedPeek`（14）、`expandedGap`（14）、`collapsedScaleStep`（0.05）和 `collapsedVisible`（3），即 Sonner 的取值（Rust 中为 `ToastMotion::sonner()`；TS 中省略的字段保持这些值）。

<a id="toaststack"></a>

## ToastStack

栈的子元素就是它的 toast，从旧到新。从 `placement` 指定的边缘（默认 `"topRight"`；底部的锚点向上排列）开始，收起时 toast 以 `collapsedPeek` 的间距重叠，越靠后的每层窄 `collapsedScaleStep`，只显示 `collapsedVisible` 层；展开时它们是间距为 `expandedGap` 的列表。toast 的出现、离开和栈的展开都以临界阻尼弹簧移动它们。指针停在栈上或手指按在栈上时它是展开的（`onExpandedChange(expanded)`；Rust 的 `ToastStackState` 用 `is_expanded()` 读取），这样应用可以在用户阅读或触摸 toast 时暂停计时。

栈由应用放置：放在边缘的 [Overlay](./overlay.md) 中，并位于安全区域之内。它的 `class` 和 `style` 决定宽度。只要它包含 toast，它就会收到 Escape 和 Android 返回键（`onCancel`；`closeOnEscape={false}` 把它们留给应用的其他部分）：关闭最新的 toast。

<a id="toast-root"></a>

## Toast

Toast 是包裹应用内容的 `alert` 角色。它的 `transitionStatus` 来自 manager，状态类随之叠加在它的 `class` 之上：`startingClass` 在 `"starting"` 时只作用于它的第一帧，它的 `transition` 类从这里开始动画（Tailwind 的 `starting:`、CSS 的 `@starting-style`）；`endingClass` 在 `"ending"` 期间、退出时长内生效；`swipingClass` 在指针滑动它时生效（`transition-none` 让它紧跟手指）。

手指或鼠标朝 `swipeDirection`（默认 `"right"`；`null` 关闭滑动）拖动时，它会在指针移动之后跟随，因此它的按钮仍是按钮；松开时超过 `swipeThreshold` 点（50）或快速甩动，它会继续移出并请求关闭（`onDismissRequest`），不足则回到原位。读屏软件会在它出现时朗读它的 `accessibilityLabel`。

<a id="toast-props"></a>

## Toast 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `transitionStatus` | `.transition_status(..)` | `"starting" \| "present" \| "ending"` | `"starting"` | 它的生命周期阶段。 |
| `startingClass`、`endingClass`、`swipingClass` | `.starting_class(..)`、... | `string` | 无 | 它在第一帧、ending 期间、滑动期间的类。 |
| `swipeDirection` | `.swipe_direction(..)` | `"right" \| "left" \| "up" \| "down" \| null` | `"right"` | 滑走它的方向。 |
| `swipeThreshold` | `.swipe_threshold(..)` | `number` | `50` | 松开时请求关闭所需的滑动距离。 |
| `accessibilityLabel` | `.accessibility_label(..)` | `string` | 无 | 它出现时读屏软件朗读的内容。 |
| `onDismissRequest` | `.on_dismiss_request(..)` | `() => void` | 无 | 用户把它滑走了。 |

<a id="toaststack-props"></a>

## ToastStack 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `motion` | `.motion(..)` | `ToastMotion` | Sonner 的 | 它的动效参数。 |
| `placement` | `.placement(..)` | `"topLeft" \| "topCenter" \| "topRight" \| "bottomLeft" \| "bottomCenter" \| "bottomRight" \| "leftCenter" \| "rightCenter"` | `"topRight"` | 它从哪一侧边缘开始排列。 |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean` | `true` | 包含 toast 时它会收到 Escape 和返回键。 |
| `onExpandedChange` | `.on_expanded_change(..)`、`.state(..)` | `(expanded: boolean) => void` | 无 | 交互使它展开或收起。 |
| `onCancel` | `.on_cancel(..)` | `() => void` | 无 | Escape 或返回键：关闭最新的 toast。 |
