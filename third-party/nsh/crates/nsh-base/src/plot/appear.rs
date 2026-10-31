//! What names a plot's appear ([`AppearKey`]) and [`PlotAppearScope`],
//! which remembers the appears that finished inside it (`gpui-base`'s
//! `plot/appear.rs`).
//!
//! A plot's appear lives with the plot, so a plot made again draws in
//! again: a list makes a row's plot again each time the row comes back
//! into its window. A scope around the list remembers which appears have
//! finished, for as long as the scope lives.

use std::{
    cell::RefCell,
    collections::{HashMap, HashSet},
    rc::Rc,
};

use nsh_core::{
    element::{JsHost, JsIn, JsKind, JsOwned, JsValue, PropError, TsTypes},
    prelude::*,
};

/// What names a plot's appear (TS `number | string`): the plot's
/// `appearGeneration` (`gpui-base`'s `Plot::appear_generation`, a number,
/// or `gpui-component`'s `appear_key`, anything hashed: a symbol, a
/// period) and a [`PlotAppearScope`]'s `id`. Two keys are the same when
/// they are the same number or the same string.
#[derive(Debug, Clone, PartialEq)]
pub enum AppearKey {
    /// A number (a row's index, a count of rows).
    Number(f64),
    /// A string (a row's key, `"AAPL.US 1D"`).
    Text(SharedString),
}

impl AppearKey {
    /// The key as a set holds it.
    fn seen(&self) -> Seen {
        match self {
            // 0 and -0 are one number.
            AppearKey::Number(n) if *n == 0.0 => Seen::Number(0),
            AppearKey::Number(n) => Seen::Number(n.to_bits()),
            AppearKey::Text(text) => Seen::Text(text.clone()),
        }
    }
}

impl From<f64> for AppearKey {
    fn from(value: f64) -> Self {
        AppearKey::Number(value)
    }
}

impl From<i32> for AppearKey {
    fn from(value: i32) -> Self {
        AppearKey::Number(f64::from(value))
    }
}

impl From<u32> for AppearKey {
    fn from(value: u32) -> Self {
        AppearKey::Number(f64::from(value))
    }
}

impl From<&str> for AppearKey {
    fn from(text: &str) -> Self {
        AppearKey::Text(SharedString::from(text.to_owned()))
    }
}

impl From<String> for AppearKey {
    fn from(text: String) -> Self {
        AppearKey::Text(text.into())
    }
}

impl From<SharedString> for AppearKey {
    fn from(text: SharedString) -> Self {
        AppearKey::Text(text)
    }
}

impl JsValue for AppearKey {
    fn ts_type(_: &mut TsTypes) -> String {
        "number | string".into()
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        match value.kind() {
            JsKind::Number => f64::from_js(value).map(AppearKey::Number),
            JsKind::String => SharedString::from_js(value).map(AppearKey::Text),
            _ => Err(value.expected("a number or a string")),
        }
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            AppearKey::Number(n) => n.to_js(host),
            AppearKey::Text(text) => text.to_js(host),
        }
    }
}

/// An [`AppearKey`] a set can hold.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
enum Seen {
    Number(u64),
    Text(SharedString),
}

/// The props of [`PlotAppearScope`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct PlotAppearScopeProps {
    /// What the scope remembers for (`gpui-base`'s `PlotAppearScope::new(id,
    /// ..)`): when it changes, the scope forgets, and the plots in it draw
    /// in afresh. Name it after the content, such as a conversation or a
    /// watchlist; none: the scope remembers for as long as it lives.
    pub id: Prop<Option<AppearKey>>,
    /// What it holds: a list of rows with plots, or whatever makes its
    /// plots again as they come and go.
    pub children: Prop<Children>,
}

/// The appears a [`PlotAppearScope`] has seen finish, for the plots in it.
#[derive(Clone)]
struct AppearScope {
    /// The keys of the appears that finished.
    finished: Rc<RefCell<HashSet<Seen>>>,
    /// The generation each pending one takes the place of: a plot moved
    /// to it from one it showed whole. When it finishes, in whichever plot
    /// made again meanwhile, the one it replaces is forgotten, as
    /// `gpui-base` overwrites the one generation it keeps per plot.
    replaces: Rc<RefCell<HashMap<Seen, Seen>>>,
    /// Moved on when the scope forgets: its plots draw in afresh.
    epoch: Signal<u64>,
}

/// Remembers which plots inside it have finished appearing
/// (`gpui-base`'s `PlotAppearScope`), so a plot made again after a gap (a
/// row a list scrolled out of its window and back) shows its marks whole
/// at once instead of drawing in again, and asks the animator for nothing.
///
/// A plot is remembered by its `appearGeneration` once its appear has
/// finished: give each row's plot its own (the row's key, with what else
/// should replay it: `${symbol} ${period}`). A new generation still
/// replays the appear, and one taken away before its appear finished draws
/// in again from the start; once a plot finishes a new generation, its
/// last one is forgotten, so going back to it replays too. The memory is
/// the scope's: it lasts while the scope lives and goes with it, and a
/// new `id` forgets it, drawing the scope's plots in afresh. The innermost
/// scope is the one a plot remembers in. Without one, a plot draws in each
/// time it is made.
///
/// It has no look and takes the app's `class` and `style` as any view
/// does (`flex-1` around a list that fills the screen).
#[component]
pub fn PlotAppearScope(props: PlotAppearScopeProps, _cx: Scope<NoEvent>) -> impl IntoElement {
    let scope = AppearScope {
        finished: Rc::default(),
        replaces: Rc::default(),
        epoch: signal(0),
    };
    provide_context(scope.clone());
    let id = props.id;
    let named = stored(id.get_untracked());
    effect(move || {
        let now = id.get();
        if named.with(|was| *was == now) {
            return;
        }
        named.replace(now);
        scope.finished.borrow_mut().clear();
        scope.replaces.borrow_mut().clear();
        scope.epoch.update(|epoch| *epoch += 1);
    });
    view().child(props.children)
}

/// A plot's part of the innermost [`PlotAppearScope`] it is in, if any.
#[derive(Clone)]
pub(super) struct AppearMemory {
    scope: Option<AppearScope>,
    /// The generation of this plot the scope holds as finished.
    held: Stored<Option<Seen>>,
}

impl AppearMemory {
    /// The memory of the plot being made.
    pub(super) fn new() -> Self {
        Self {
            scope: use_context::<AppearScope>(),
            held: stored(None),
        }
    }

    /// Whether the appear of `generation` has finished in the scope, so
    /// the plot shows whole at once; it subscribes to the scope forgetting
    /// (a new `id`), after which the plot draws in again.
    pub(super) fn finished(&self, generation: &AppearKey) -> bool {
        let Some(scope) = &self.scope else {
            return false;
        };
        scope.epoch.get();
        let seen = generation.seen();
        let finished = scope.finished.borrow().contains(&seen);
        let held = self.held.with(|held| held.clone());
        if finished {
            // Shown whole: the generation this plot holds, so the next
            // one it finishes replaces it.
            self.held.replace(Some(seen));
        } else if let Some(last) = held
            && last != seen
        {
            scope.replaces.borrow_mut().insert(seen, last);
        }
        finished
    }

    /// The appear of `generation` has finished: the scope remembers it in
    /// place of the plot's last one (`gpui-base` keeps one generation per
    /// plot).
    pub(super) fn finish(&self, generation: &AppearKey) {
        let Some(scope) = &self.scope else { return };
        let seen = generation.seen();
        let mut finished = scope.finished.borrow_mut();
        let replaced = scope.replaces.borrow_mut().remove(&seen);
        let last = self.held.replace(Some(seen.clone()));
        for old in [replaced, last].into_iter().flatten() {
            if old != seen {
                finished.remove(&old);
            }
        }
        finished.insert(seen);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Keys are the same when they are the same number or the same string.
    #[test]
    fn keys_are_numbers_or_strings() {
        assert_eq!(AppearKey::from(0.0).seen(), AppearKey::from(-0.0).seen());
        assert_eq!(AppearKey::from(2).seen(), AppearKey::from(2.0).seen());
        assert_ne!(AppearKey::from(1).seen(), AppearKey::from("1").seen());
        assert_eq!(
            AppearKey::from("AAPL 1D").seen(),
            AppearKey::from(String::from("AAPL 1D")).seen()
        );
    }
}
