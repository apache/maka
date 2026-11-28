//! Independent hiding reasons for the system tab bar. Navigation owns the
//! visible stack's choice; the app owns `TabBar.hidden` across transitions.

use std::cell::Cell;

pub(crate) enum Update {
    AlongsideTransition,
    Settled,
}

impl Update {
    pub(crate) fn apply(self, schedule: impl FnOnce() -> bool, apply: impl FnOnce()) {
        if !matches!(self, Self::AlongsideTransition) || !schedule() {
            apply();
        }
    }
}

#[derive(Default)]
pub(crate) struct Visibility {
    navigation: Cell<bool>,
    app: Cell<bool>,
}

impl Visibility {
    pub(crate) fn set_navigation(&self, hidden: bool) {
        self.navigation.set(hidden);
    }

    pub(crate) fn set_app(&self, hidden: bool) {
        self.app.set(hidden);
    }

    pub(crate) fn hidden(&self) -> bool {
        self.navigation.get() || self.app.get()
    }
}

#[cfg(test)]
mod tests {
    use super::{Update, Visibility};

    #[test]
    fn a_settled_stack_restores_its_bar_without_the_transition_coordinator() {
        let bar = Visibility::default();
        Update::AlongsideTransition.apply(|| true, || bar.set_navigation(true));
        assert!(!bar.hidden());
        bar.set_navigation(true);
        Update::Settled.apply(
            || panic!("didShow must not queue another animation"),
            || bar.set_navigation(false),
        );
        assert!(!bar.hidden());
    }

    #[test]
    fn a_coordinator_that_refuses_animation_does_not_lose_the_update() {
        let bar = Visibility::default();
        bar.set_navigation(true);
        Update::AlongsideTransition.apply(|| false, || bar.set_navigation(false));
        assert!(!bar.hidden());
    }

    #[test]
    fn pushes_and_pops_preserve_the_apps_hidden_prop() {
        let bar = Visibility::default();
        bar.set_app(true);
        // Ordinary push, hiding page pushed, then popped back to root.
        for hides in [false, true, false] {
            bar.set_navigation(hides);
            assert!(bar.hidden());
        }
        bar.set_app(false);
        assert!(!bar.hidden());
    }

    #[test]
    fn app_updates_preserve_the_visible_stacks_choice() {
        let bar = Visibility::default();
        bar.set_navigation(true);
        bar.set_app(true);
        bar.set_app(false);
        assert!(bar.hidden());
        // Switching to a retained root stack replaces the navigation reason.
        bar.set_navigation(false);
        assert!(!bar.hidden());
        bar.set_navigation(true);
        assert!(bar.hidden());
    }
}
