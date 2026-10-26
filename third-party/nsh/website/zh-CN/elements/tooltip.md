---
title: Tooltip
description: Tooltip 组件：关于它所在元素的提示，在桌面上指针停留时出现，样式由应用决定。
order: 28
group: base
demo: el-tooltip
---

# Tooltip

工具提示是显示在所说明内容旁边的简短提示：图标按钮的作用、被截断的标签的完整文字。在桌面平台和桌面浏览器中，指针在触发元素上停留
`delay`（500 毫秒）后显示，指针离开或按下触发元素时隐藏。手机和平板只在应用打开它（`open`）时显示。它从不接收指针或按压，所以触发元素的行为与没有它时完全一样。

把 [`nsh/base`](../modules/nsh-base.md) 的 `Tooltip` 作为每个元素都有的 `tooltip` 属性传入（见[通用属性](index.md#tooltips)），与 GPUI 的 `.tooltip(..)` 相同：该元素就是指针停留的对象，也是它定位的参照。工具提示本身就是气泡：用 `class` / `style` 设置样式，子元素是它的内容。

```rust tabs
use nsh_base::tooltip;
use nsh_core::prelude::*;

fn save_button(on_save: impl Fn() + 'static) -> impl IntoElement {
    view()
        .on_press(on_save)
        .accessibility_label("保存")
        .p_2()
        .child(text("💾"))
        .tooltip(
            tooltip()
                .placement(Placement::Bottom)
                .rounded_md()
                .bg(rgb(0x111827))
                .px_2()
                .py_1()
                .child(text("保存文档").text_color(white())),
        )
}
```

```tsx tabs
import { Text, View } from "nsh";
import { Tooltip } from "nsh/base";

function SaveButton(props: { onSave: () => void }) {
  return (
    <View
      onPress={props.onSave}
      accessibilityLabel="保存"
      class="p-2"
      tooltip={
        <Tooltip placement="bottom" class="rounded-md bg-gray-900 px-2 py-1">
          <Text class="text-white">保存文档</Text>
        </Tooltip>
      }
    >
      <Text>💾</Text>
    </View>
  );
}
```

它默认显示在触发元素上方（`placement`），空间不够时换到另一侧，并始终位于安全区之内。设置 `open` 后由应用决定何时显示：应用跟随 `onOpenChange`（它报告指针在触发元素上停留或离开），并且可以在任何设备上显示它。

<a id="props"></a>

## 属性

| 属性 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `children` | `.child(..)` | `JSX.Element` | 无 | 提示的内容。 |
| `class`、`style` | `.app_class(..)`、`Styled` 方法 | `string`、`StyleProp<ViewStyle>` | 无 | 气泡的外观：即工具提示本身。 |
| `open` | `.open(..)` | `boolean` | 无 | 是否显示，由应用控制。 |
| `defaultOpen` | `.default_open(..)` | `boolean` | `false` | 没有 `open` 时，初始是否显示。 |
| `delay` | `.delay(..)` | `number` | `500` | 指针在触发元素上停留多少毫秒后显示。 |
| `disabled` | `.disabled(..)` | `boolean` | `false` | 它从不显示。 |
| `placement` | `.placement(..)` | `"top" \| "bottom" \| "left" \| "right"` | `"top"` | 它位于触发元素的哪一侧。 |
| `align` | `.align(..)` | `"start" \| "center" \| "end"` | `"center"` | 它沿这一侧如何与触发元素对齐。 |
| `offset` | `.offset(..)` | `number` | `4` | 触发元素与工具提示之间的间距。 |
| `margin` | `.margin(..)` | `number` | `4` | 它与安全区边缘保持的距离。 |

<a id="events"></a>

## 事件

| 事件 | Rust | 说明 |
|---|---|---|
| `onOpenChange` | `.on_open_change(\|e\| ..)` | 指针在触发元素上停留了，或离开、按下了它（`reason` 为 `"hover"`）。 |
| `onOpen` | `.on_open(\|\| ..)` | 它已显示。 |
| `onClose` | `.on_close(\|\| ..)` | 它已消失，应用隐藏它时也会触发。 |

<a id="accessibility"></a>

## 无障碍

工具提示把触发元素的说明重复给屏幕阅读器：也给触发元素设置 `accessibilityLabel`，让每个人都能得到这条提示。
