//! The navigation stack's state: the tasks open over the list, bottom to
//! top. Putting a route in pushes its page, taking it out pops it.

use nsh_core::prelude::*;

#[derive(Clone, Default)]
struct Routes(Vec<u32>);

fn routes() -> Signal<Routes> {
    global::<Routes>()
}

/// The routes (tracked where it is read).
pub(crate) fn open_tasks() -> Vec<u32> {
    routes().with(|routes| routes.0.clone())
}

/// Whether there is a page to go back to (tracked where it is read).
pub(crate) fn can_go_back() -> bool {
    routes().with(|routes| !routes.0.is_empty())
}

/// Opens the task `id`; a second tap on its row opens nothing more.
pub(crate) fn push(id: u32) {
    routes().update(|routes| {
        if !routes.0.contains(&id) {
            routes.0.push(id);
        }
    });
}

/// Pops the top page.
pub(crate) fn pop() {
    routes().update(|routes| {
        routes.0.pop();
    });
}

/// Leaves `depth` pages over the list: the user went back natively.
pub(crate) fn truncate(depth: usize) {
    routes().update(|routes| routes.0.truncate(depth));
}
