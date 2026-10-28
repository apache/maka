//! `AlertDialog`: the platform's alert or action sheet (UIAlertController,
//! AlertDialog, a list dialog on Android).

use nsh_core::{
    element::{Dialog, DialogButton, DialogButtonStyle},
    prelude::*,
};

/// The system's alert dialog (UIAlertController, AlertDialog).
#[module]
#[derive(Debug)]
pub struct AlertDialog;

/// What an [`AlertDialog`] shows and how it closes.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct AlertDialogOptions {
    /// Above the description.
    pub title: Option<SharedString>,
    /// Below the title.
    pub description: Option<SharedString>,
    /// Its actions, in order (at least one; at most three in an Android
    /// alert).
    pub actions: Vec<AlertDialogAction>,
    /// `"alert"` (default), or `"actionSheet"`: a sheet of actions from the
    /// bottom (a list dialog on Android).
    #[prop(default)]
    pub presentation: AlertDialogPresentation,
    /// Escape and the Android back button close it without an action
    /// (default: false for an alert, true for an action sheet).
    pub close_on_escape: Option<bool>,
    /// A press outside it closes it without an action (default: false for
    /// an alert, true for an action sheet).
    pub close_on_backdrop_press: Option<bool>,
}

/// One action of an [`AlertDialog`].
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub struct AlertDialogAction {
    /// What it says.
    pub label: SharedString,
    /// What it means: the platform places and draws it by its role.
    #[prop(default)]
    pub role: AlertDialogRole,
    /// What `show` reports when it is chosen (`{ action: id }`): the app's
    /// name for it, never the label, which changes with the app's language.
    pub id: SharedString,
}

/// What [`AlertDialog`]'s `show` resolves with.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct AlertDialogResult {
    /// The chosen action's `id`, or `null` when it closed without one.
    pub action: Option<SharedString>,
}

/// What an [`AlertDialogAction`] means.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum AlertDialogRole {
    /// A regular action.
    #[default]
    Default,
    /// Closes without doing anything.
    Cancel,
    /// Destroys or deletes something.
    Destructive,
}

impl From<AlertDialogRole> for DialogButtonStyle {
    fn from(role: AlertDialogRole) -> Self {
        match role {
            AlertDialogRole::Default => DialogButtonStyle::Default,
            AlertDialogRole::Cancel => DialogButtonStyle::Cancel,
            AlertDialogRole::Destructive => DialogButtonStyle::Destructive,
        }
    }
}

/// The native form of an [`AlertDialog`].
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum AlertDialogPresentation {
    /// An alert in the middle.
    #[default]
    Alert,
    /// A sheet of actions (UIAlertController's action sheet; a list
    /// dialog on Android).
    ActionSheet,
}

#[module]
impl AlertDialog {
    /// Shows the dialog and resolves with `{ action }`: the chosen
    /// action's `id`, or `null` when it closed without an action. Rejects
    /// without actions.
    pub async fn show(options: AlertDialogOptions) -> Result<AlertDialogResult, String> {
        options.show().await
    }
}

/// The system's alert dialog, set up by its methods and shown by
/// [`show`](AlertDialogOptions::show) (TSX: `AlertDialog.show({ … })`), its
/// answer awaited in a task:
///
/// ```ignore
/// let answer = alert_dialog()
///     .title("Delete the photo?")
///     .description("This cannot be undone.")
///     .cancel("cancel", "Cancel")
///     .destructive("delete", "Delete")
///     .show();
/// spawn(async move {
///     if answer.await.is_ok_and(|r| r.action.as_deref() == Some("delete")) { /* … */ }
/// });
/// ```
pub fn alert_dialog() -> AlertDialogOptions {
    AlertDialogOptions::default()
}

impl AlertDialogOptions {
    /// Its title, above the description.
    pub fn title(mut self, title: impl Into<SharedString>) -> Self {
        self.title = Some(title.into());
        self
    }

    /// Its description, below the title.
    pub fn description(mut self, description: impl Into<SharedString>) -> Self {
        self.description = Some(description.into());
        self
    }

    /// Adds a regular action saying `label`, which [`show`](Self::show)
    /// reports as `id` when it is chosen. Actions show in the order they
    /// are added.
    pub fn action(self, id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        self.push_action(id.into(), label.into(), AlertDialogRole::Default)
    }

    /// Adds the action that closes without doing anything (role
    /// `"cancel"`).
    pub fn cancel(self, id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        self.push_action(id.into(), label.into(), AlertDialogRole::Cancel)
    }

    /// Adds an action that destroys or deletes something (role
    /// `"destructive"`).
    pub fn destructive(self, id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        self.push_action(id.into(), label.into(), AlertDialogRole::Destructive)
    }

    fn push_action(mut self, id: SharedString, label: SharedString, role: AlertDialogRole) -> Self {
        self.actions.push(AlertDialogAction { label, role, id });
        self
    }

    /// A sheet of actions from the bottom (a list dialog on Android)
    /// instead of an alert (TSX: `presentation: "actionSheet"`).
    pub fn action_sheet(mut self) -> Self {
        self.presentation = AlertDialogPresentation::ActionSheet;
        self
    }

    /// Whether Escape and the Android back button close it without an
    /// action (default: false for an alert, true for an action sheet).
    pub fn close_on_escape(mut self, close: bool) -> Self {
        self.close_on_escape = Some(close);
        self
    }

    /// Whether a press outside it closes it without an action (default:
    /// false for an alert, true for an action sheet).
    pub fn close_on_backdrop_press(mut self, close: bool) -> Self {
        self.close_on_backdrop_press = Some(close);
        self
    }

    /// Shows the dialog now; the answer, to await in a task, is
    /// `{ action }`: the chosen action's `id`, or `None` when it closed
    /// without an action. An error without actions.
    pub fn show(self) -> impl Future<Output = Result<AlertDialogResult, String>> + 'static {
        let shown = (!self.actions.is_empty()).then(|| {
            let sheet = self.presentation == AlertDialogPresentation::ActionSheet;
            let cancelable = self.close_on_escape.unwrap_or(sheet)
                || self.close_on_backdrop_press.unwrap_or(sheet);
            nsh_core::element::dialog(Dialog {
                id: 0,
                title: self.title.as_ref().map(|t| t.to_string()),
                message: self.description.as_ref().map(|m| m.to_string()),
                buttons: self
                    .actions
                    .iter()
                    .map(|a| DialogButton {
                        text: a.label.to_string(),
                        style: a.role.into(),
                    })
                    .collect(),
                cancelable,
                sheet,
            })
        });
        async move {
            let index = shown.ok_or("AlertDialog.show: `actions` is empty")?.await;
            Ok(AlertDialogResult {
                action: usize::try_from(index)
                    .ok()
                    .and_then(|i| self.actions.get(i))
                    .map(|a| a.id.clone()),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_builder_sets_the_options_tsx_passes() {
        let options = alert_dialog()
            .title("Share")
            .description("The photo")
            .action_sheet()
            .cancel("cancel", "Cancel")
            .action("save", "Save")
            .destructive("delete", "Delete")
            .close_on_escape(false);
        let action = |label: &'static str, role| AlertDialogAction {
            label: label.into(),
            role,
            id: label.to_lowercase().into(),
        };
        assert_eq!(
            options,
            AlertDialogOptions {
                title: Some("Share".into()),
                description: Some("The photo".into()),
                actions: vec![
                    action("Cancel", AlertDialogRole::Cancel),
                    action("Save", AlertDialogRole::Default),
                    action("Delete", AlertDialogRole::Destructive),
                ],
                presentation: AlertDialogPresentation::ActionSheet,
                close_on_escape: Some(false),
                close_on_backdrop_press: None,
            }
        );
    }

    #[test]
    fn showing_without_actions_is_an_error() {
        let mut shown = std::pin::pin!(alert_dialog().title("Nothing to choose").show());
        let mut cx = std::task::Context::from_waker(std::task::Waker::noop());
        assert_eq!(
            shown.as_mut().poll(&mut cx),
            std::task::Poll::Ready(Err("AlertDialog.show: `actions` is empty".to_owned()))
        );
    }
}
