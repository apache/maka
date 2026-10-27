---
title: AlertDialog
description: AlertDialog：平台自己的警告框或操作表，在原生侧显示，并以用户选择的操作作为结果。
order: 25
group: base
demo: el-alert-dialog
---

# AlertDialog

`AlertDialog` 显示平台自己的警告框或操作表：在 iOS 和 Mac Catalyst 上是 `UIAlertController`，在 Android 上是 `AlertDialog`（操作表为列表对话框），在其他平台上是平台对话框风格的警告框。`AlertDialog.show`（Rust 中为 `alert_dialog()` 的 `.show()`）返回一个 promise（在 Rust 中是 future），以用户选择的操作作为结果。所有文字都来自应用，所以警告框说的是你的应用要说的话，用的是它的语言。

```rust tabs
use nsh_base::{alert_dialog, button};
use nsh_core::prelude::*;

fn app() -> impl IntoElement {
    let answer = signal(SharedString::from("–"));
    let confirm = move || {
        spawn(async move {
            let choice = alert_dialog()
                .title("Delete the photo?")
                .description("This cannot be undone.")
                .cancel("Cancel")
                .destructive("Delete")
                .show()
                .await;
            let deleted = matches!(choice, Ok(Some(label)) if label == "Delete");
            answer.set(if deleted { "deleted" } else { "kept" }.into());
        });
    };
    view()
        .flex_1()
        .p_4()
        .pt(px(48.0))
        .gap_3()
        .child(
            button()
                .on_press(confirm)
                .rounded_lg()
                .bg(rgb(0xdc2626))
                .px_4()
                .py_3()
                .child(text("Delete…").text_color(white()).font_weight(FontWeight::SEMIBOLD)),
        )
        .child(text(answer))
}
```

```tsx tabs
import { mount, signal, Text, View } from "nsh";
import { AlertDialog, Button } from "nsh/base";

function App() {
  const answer = signal("–");
  const confirm = async () => {
    const choice = await AlertDialog.show({
      title: "Delete the photo?",
      description: "This cannot be undone.",
      actions: [
        { label: "Cancel", role: "cancel" },
        { label: "Delete", role: "destructive", id: "delete" },
      ],
    });
    answer.set(choice === "delete" ? "deleted" : "kept");
  };
  return (
    <View style={{ flex: 1, padding: 16, paddingTop: 48, gap: 12 }}>
      <Button onPress={confirm} class="rounded-lg bg-red-600 px-4 py-3 active:bg-red-700">
        <Text class="text-center font-semibold text-white">Delete…</Text>
      </Button>
      <Text>{answer()}</Text>
    </View>
  );
}

mount(App);
```

需要自己设计外观的对话框（卡片、sheet、全屏流程），使用 [Dialog](./dialog.md)。

<a id="alertdialogshow"></a>

## AlertDialog.show

```ts
AlertDialog.show(options: AlertDialogOptions): Promise<string | null>
```

```rust
alert_dialog().title(..).description(..).action(..).cancel(..).destructive(..).show()
    -> impl Future<Output = Result<Option<SharedString>, String>>
```

结果是所选操作的 `id`（没有 `id` 时为它的 `label`；在 Rust 中总是它的 label），对话框未经操作关闭时为 `null`（`None`）：在 `closeOnBackdropPress` 和 `closeOnEscape` 允许时，点按对话框外部、Escape 或返回键。没有任何操作时是一个错误（被拒绝的 promise、一个 `Err`）。在 Rust 中，`nsh_base::alert_dialog()` 用一个方法设置一个选项或添加一个操作，操作按添加的顺序显示，`.show()` 显示对话框；在任务（`spawn`）中 await 它的结果。

<a id="action-sheets"></a>

## 操作表

操作表使用相同的选项，呈现方式为 `"actionSheet"`：

```rust tabs
use nsh_base::alert_dialog;
use nsh_core::prelude::*;

fn share() {
    spawn(async move {
        let choice = alert_dialog()
            .title("Share the photo")
            .action_sheet()
            .action("Copy link")
            .action("Save")
            .destructive("Delete")
            .cancel("Cancel")
            .show()
            .await;
        match choice.ok().flatten().as_deref() {
            Some("Copy link") => { /* … */ }
            Some("Save") => { /* … */ }
            Some("Delete") => { /* … */ }
            _ => {} // "Cancel", or closed without an action.
        }
    });
}
```

```tsx tabs
const choice = await AlertDialog.show({
  title: "Share the photo",
  presentation: "actionSheet",
  actions: [
    { label: "Copy link", id: "copy" },
    { label: "Save", id: "save" },
    { label: "Delete", role: "destructive", id: "delete" },
    { label: "Cancel", role: "cancel" },
  ],
});
```

<a id="alertdialogoptions"></a>

## AlertDialogOptions

| 字段 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `title` | `.title(..)` | `string \| null` | 无 | 位于描述上方。 |
| `description` | `.description(..)` | `string \| null` | 无 | 位于标题下方。 |
| `actions` | `.action(..)`、`.cancel(..)`、`.destructive(..)`，每个操作一次 | `AlertDialogAction[]` | 必填 | 操作，按顺序排列（至少一个；Android 警告框最多三个）。 |
| `presentation` | `.action_sheet()` | `"alert" \| "actionSheet"` | `"alert"` | 居中的警告框，或从底部弹出的操作表（Android 上为列表对话框）。 |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean \| null` | 警告框为 `false`，操作表为 `true` | Escape 和 Android 返回键不经操作关闭它。 |
| `closeOnBackdropPress` | `.close_on_backdrop_press(..)` | `boolean \| null` | 警告框为 `false`，操作表为 `true` | 点按它外部不经操作关闭它。 |

<a id="alertdialogaction"></a>

## AlertDialogAction

| 字段 | Rust | 类型 | 默认值 | 说明 |
|---|---|---|---|---|
| `label` | 方法的参数 | `string` | 必填 | 它显示的文字。 |
| `role` | `.action(..)`、`.cancel(..)`、`.destructive(..)` | `"default" \| "cancel" \| "destructive"` | `"default"` | 它的含义：平台按角色放置和绘制它（在 iOS 上破坏性操作显示为红色）。 |
| `id` | 无：由 label 作答 | `string \| null` | 它的 `label` | 选择它时 `show` 返回的值。 |

> [!TIP]
> 因为主线程从不等待 JS 或 Rust，对话框在原生侧显示和应答，结果到达时你的代码继续执行。你可以在任何事件处理函数中 await 一个警告对话框，比如用 [`popOnBack`](./nav-stack.md#leaving-a-page) 确认离开页面。

<a id="platform-notes"></a>

## 平台说明

- **iOS**：由 `UIAlertController` 布局操作。角色为 `"cancel"` 的操作放在 iOS 放置取消操作的位置，操作表把它单独显示在底部。在 iPad 和 Mac Catalyst 上，操作表是一个弹出框，带一个无标题的取消操作：点按外部会关闭它，结果为 `null`。
- **Android**：`AlertDialog` 最多显示三个操作，按位置对应：最后一个操作是确定按钮，它前面的是否定按钮，再前面的是中性按钮。操作表是对话框中的操作列表，以点按外部或返回键代替它的取消操作（此时结果为 `null`）。列表对话框显示 `title`，没有标题时显示 `description`。
- **Windows、Linux、GPUI 和 Web**：NSH 以平台的对话框风格绘制警告框或操作表。
