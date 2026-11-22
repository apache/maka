//! `nsh/android`: what only Android has (nothing happens elsewhere).

use crate::{
    Command, ROOT_ID,
    element::{ModuleCx, module, task::Action},
};

/// The Android back button: its listeners run after modals and before
/// stacks.
#[module]
pub(crate) struct BackHandler;

#[module]
impl BackHandler {
    /// Leaves the app.
    pub(crate) fn exit_app(cx: &mut ModuleCx) {
        cx.act(Action::Command(ROOT_ID, Command::ExitApp));
    }
}
