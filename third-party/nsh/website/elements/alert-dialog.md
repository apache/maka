---
title: AlertDialog
description: "AlertDialog: the platform's own alert or action sheet, shown natively and answered with the action the user chose."
order: 25
group: base
demo: el-alert-dialog
---

# AlertDialog

`AlertDialog` shows the platform's own alert or action sheet: `UIAlertController` on iOS and Mac Catalyst, an
`AlertDialog` (or a list dialog for an action sheet) on Android, and an alert in the platform's dialog look on the
other platforms. `AlertDialog.show` (`alert_dialog()`'s `.show()` in Rust) returns a promise (a future in Rust) that resolves with the action the user chose.
Every label comes from the app, so an alert says what your app says, in its language.

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

For dialogs with a look of your own (a card, a sheet, a full-screen flow), use [Dialog](./dialog.md).

## AlertDialog.show

```ts
AlertDialog.show(options: AlertDialogOptions): Promise<string | null>
```

```rust
alert_dialog().title(..).description(..).action(..).cancel(..).destructive(..).show()
    -> impl Future<Output = Result<Option<SharedString>, String>>
```

The result is the chosen action's `id` (its `label` when it has no `id`; in Rust always its label), or `null`
(`None`) when the dialog closed without an action: a press outside it, Escape or the back button, where
`closeOnBackdropPress` and `closeOnEscape` allow it. It is an error (a rejected promise, an `Err`) when there are no
actions. In Rust, `nsh_base::alert_dialog()` sets the dialog up with a method per option and per action, in the order
the actions show, and `.show()` shows it; await its answer in a task (`spawn`).

## Action sheets

An action sheet takes the same options with the `"actionSheet"` presentation:

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

## AlertDialogOptions

| Field | Rust | Type | Default | Description |
|---|---|---|---|---|
| `title` | `.title(..)` | `string \| null` | none | Above the description. |
| `description` | `.description(..)` | `string \| null` | none | Below the title. |
| `actions` | `.action(..)`, `.cancel(..)`, `.destructive(..)`, one per action | `AlertDialogAction[]` | required | The actions, in order (at least one; at most three in an Android alert). |
| `presentation` | `.action_sheet()` | `"alert" \| "actionSheet"` | `"alert"` | An alert in the middle, or a sheet of actions from the bottom (a list dialog on Android). |
| `closeOnEscape` | `.close_on_escape(..)` | `boolean \| null` | `false` for an alert, `true` for an action sheet | Escape and the Android back button close it without an action. |
| `closeOnBackdropPress` | `.close_on_backdrop_press(..)` | `boolean \| null` | `false` for an alert, `true` for an action sheet | A press outside it closes it without an action. |

## AlertDialogAction

| Field | Rust | Type | Default | Description |
|---|---|---|---|---|
| `label` | the method's argument | `string` | required | What it says. |
| `role` | `.action(..)`, `.cancel(..)`, `.destructive(..)` | `"default" \| "cancel" \| "destructive"` | `"default"` | What it means: the platform places and draws it by its role (a destructive action is red on iOS). |
| `id` | none: the label answers | `string \| null` | its `label` | What `show` resolves with when it is chosen. |

> [!TIP]
> Because the main thread never waits for JS or Rust, the dialog is shown and answered natively, and your code
> continues when the result arrives. You can await an alert dialog inside any event handler, for example to confirm
> leaving a page with [`popOnBack`](./nav-stack.md#leaving-a-page).

## Platform notes

- **iOS**: `UIAlertController` lays out the actions. An action with the `"cancel"` role is placed where iOS puts
  cancel actions, and an action sheet shows it separately at its bottom. On iPad and Mac Catalyst the action sheet is
  a popover, with an untitled cancel action: a tap outside it closes it, and the result is `null`.
- **Android**: an `AlertDialog` shows up to three actions, mapped by position: the last action is the positive
  button, the one before it the negative button, and the one before that the neutral button. An action sheet is a
  list of the actions in a dialog, with a tap outside or the back button in place of its cancel action (the result is
  then `null`). The list dialog shows the `title`, or the `description` when the sheet has no title.
- **Windows, Linux, GPUI and the web**: NSH draws the alert or action sheet in the platform's dialog look.
