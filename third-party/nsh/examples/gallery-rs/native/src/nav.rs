//! The gallery's navigation: the screens pushed over the index (over the
//! selected demo in the desktop layout), a global every component of the
//! gallery can push to.

use std::rc::Rc;

use nsh_core::{
    element::{Screen, SharedString, Signal},
    prelude::global,
};

/// What makes a pushed screen: a `nav_page()` with its header options and
/// content, made once when it is pushed (its bindings keep it current).
pub(crate) type ScreenFn = Rc<dyn Fn() -> Screen>;

/// A screen over the index: its key (unique in the stack) and what makes
/// it.
#[derive(Clone)]
pub(crate) struct Route {
    pub(crate) key: SharedString,
    pub(crate) screen: ScreenFn,
}

/// The same route: the same key.
impl PartialEq for Route {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

/// The pushed screens, bottom to top.
#[derive(Default, Clone)]
pub(crate) struct Routes(pub(crate) Vec<Route>);

/// The pushed screens, a signal of the surface's.
pub(crate) fn routes() -> Signal<Routes> {
    global::<Routes>()
}

/// Pushes the screen `screen` makes (`key`: unique in the stack).
pub(crate) fn push(key: impl Into<SharedString>, screen: impl Fn() -> Screen + 'static) {
    push_route(Route {
        key: key.into(),
        screen: Rc::new(screen),
    });
}

/// Pushes `route`.
pub(crate) fn push_route(route: Route) {
    routes().update(|routes| {
        // A screen already in the stack (a double tap) is not pushed twice.
        if !routes.0.iter().any(|r| r.key == route.key) {
            routes.0.push(route);
        }
    });
}

/// Pops the top screen.
pub(crate) fn pop() {
    routes().update(|routes| {
        routes.0.pop();
    });
}

/// Pops every screen: back to the index.
pub(crate) fn pop_to_top() {
    routes().update(|routes| routes.0.clear());
}

/// Replaces the pushed screens with `routes`.
pub(crate) fn reset(routes: Vec<Route>) {
    self::routes().set(Routes(routes));
}

/// Pops to `depth` screens over the index.
pub(crate) fn truncate(depth: usize) {
    routes().update(|routes| routes.0.truncate(depth));
}

/// How many screens are over the index.
pub(crate) fn depth() -> usize {
    routes().with_untracked(|routes| routes.0.len())
}
