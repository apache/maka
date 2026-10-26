//! `nsh/accessibility`: the screen reader's commands.

use crate::{
    Command,
    element::{ModuleCx, NodeRef, module, task::Action},
};

/// The screen reader's commands.
#[module]
pub(crate) struct Accessibility;

#[module(flat)]
impl Accessibility {
    /// The screen reader reads `message` (a VoiceOver announcement, TalkBack).
    pub(crate) fn announce(message: String, cx: &mut ModuleCx) {
        cx.announce_for_accessibility(message);
    }

    /// Moves the screen reader's focus to `node` (a `ref`).
    pub(crate) fn set_accessibility_focus(node: NodeRef, cx: &mut ModuleCx) {
        cx.act(Action::Command(node.0, Command::AccessibilityFocus));
    }
}
