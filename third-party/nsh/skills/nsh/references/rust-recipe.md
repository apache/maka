# The Rust application recipe

The same small app as [the application recipe](tsx-recipe.md), written only in Rust: no TSX and no QuickJS on any
platform. Its files follow the [Coding Guides](coding-guides.md): `src/lib.rs` the root, `src/shell.rs` the stack,
`src/pages/` one file per page, `src/components/` what pages share, `src/store.rs` the state, `src/nav.rs` the routes,
`tests/` the user's flows. This is `examples/tasks-rs` in `longbridge/nsh`, and CI builds and tests that app; there it
inherits its versions from the workspace, while an app of your own starts from `nsh init my-app --template rust`,
whose manifest names them.

What to notice:

- `nsh.json` names the crate (`"rust": "."`) and its root component (`"root": "App"`): `nsh` mounts the root, and
  `src/main.rs` is only for `cargo run`.
- `store.rs` keeps its type and its `tasks()` signal private, so nothing outside can write a task past `add_task`,
  `set_task_done` and `remove_task`. The state is a `global`: one per surface, which also gives each test its own.
- A component runs once. A binding is a closure where a value goes (`text(move || ..)`, `.checked(move || ..)`): it
  reruns when a signal it read changes, and only that prop updates. The store's functions read the signal inside, so
  calling one in a binding tracks it. Listeners read with `get_untracked`: they react to an event, not to a signal.
- `task_detail` gets an `id`, not a `Task`, and reads the task through a closure: it follows the store, and shows
  nothing wrong once the task is gone.
- `task_row` keeps no state, because `virtual_list` makes a cell once and gives it other rows as it recycles: all it
  shows is bound to `at.index()`, and `task_at` answers `None` for a row past the end. `.keys` gives the rows their
  identities, since rows are removed from the middle.
- The draft is a signal of the page that renders it: transient view state stays out of the store. The input is
  controlled, its value given back from the signal.
- Back has two paths that meet in the routes, the only source of truth for the stack. On the desktops and the web the
  page's `header` draws a Back button that calls `nav::pop`. On iOS and Android `title` feeds the system's header; the
  system pops the page itself and `on_dismiss` truncates the routes to match.
- `alert_dialog().show()` returns a future: the listener starts it and awaits it in `spawn`, so nothing blocks while
  the system's alert is up, and the `id` of the chosen action decides (never the label). The page pops before the
  task is removed, so it leaves showing what it showed.
- Colors are `theme()` tokens read in bindings, so they follow the appearance with no render. The switch's parts take
  classes, since `checked:` has to follow the switch's state.
- The tests take a user's steps on the real engine, headless: `on_dialog` answers the alert, first with Cancel to show
  that only Remove removes, and `back` goes back as the platform does.

## `nsh.json`

```json
{
  "name": "Tasks",
  "id": "com.example.tasks.rust",
  "appearance": "system",
  "rust": ".",
  "root": "App"
}
```

## `Cargo.toml`

```toml
[package]
name = "tasks-rs"
description = "The tasks app written in Rust (examples/tasks is its TSX form)."
version.workspace = true
edition.workspace = true
license.workspace = true
publish.workspace = true

[lints]
workspace = true

[dependencies]
env_logger.workspace = true
nsh-core.workspace = true
nsh-base.workspace = true

[target.'cfg(target_os = "linux")'.dependencies]
nsh-platform-linux.workspace = true

[target.'cfg(target_os = "macos")'.dependencies]
nsh-platform-macos.workspace = true

[target.'cfg(target_os = "windows")'.dependencies]
nsh-platform-windows.workspace = true

[dev-dependencies]
nsh-engine.workspace = true
nsh-testing = { workspace = true, features = ["live"] }
```

## `src/main.rs`

```rust
//! Runs the app directly on the machine's native backend (`cargo run`).

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use nsh_platform_linux as platform;
#[cfg(target_os = "macos")]
use nsh_platform_macos as platform;
#[cfg(target_os = "windows")]
use nsh_platform_windows as platform;

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn main() -> impl std::process::Termination {
    env_logger::init();
    platform::run_app(
        platform::AppSource::Rust(platform::Root::of::<tasks_rs::App>()),
        platform::AppOptions {
            title: "Tasks".to_owned(),
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            app_id: "com.example.tasks.rust".to_owned(),
            size: (480, 640),
            ..Default::default()
        },
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!(
    "Run this binary on macOS, Windows or Linux; use nsh run for iOS, Android and the web."
);
```

## `src/lib.rs`

```rust
//! The tasks app, written in Rust: `nsh.json` `"root"` names [`App`].

mod components;
mod nav;
mod pages;
mod shell;
mod store;

use nsh_base::theme;
use nsh_core::prelude::*;

/// The app's UI set (`nsh.json` `"rust"`).
#[native_module("tasks/native")]
fn native(registry: &mut Registry) {
    registry.register::<App>();
}

/// The app's root: the whole surface, on the theme's background.
#[component]
pub fn App() -> impl IntoElement {
    view()
        .flex_1()
        .bg(move || theme().background)
        .child(shell::shell())
}
```

## `src/store.rs`

```rust
//! The app's state: its signal stays private, pages read and change it
//! through these functions. A global is per surface, so each test has its own.

use nsh_core::prelude::*;

/// A task.
#[derive(Clone, PartialEq)]
pub(crate) struct Task {
    pub(crate) id: u32,
    pub(crate) title: SharedString,
    pub(crate) done: bool,
}

#[derive(Clone)]
struct Tasks {
    list: Vec<Task>,
    next_id: u32,
}

impl Default for Tasks {
    fn default() -> Self {
        let task = |id, title: &'static str, done| Task {
            id,
            title: title.into(),
            done,
        };
        Self {
            list: vec![
                task(1, "Read the coding guides", true),
                task(2, "Write the first page", false),
            ],
            next_id: 3,
        }
    }
}

fn tasks() -> Signal<Tasks> {
    global::<Tasks>()
}

/// How many tasks there are (tracked where it is read).
pub(crate) fn task_count() -> usize {
    tasks().with(|tasks| tasks.list.len())
}

/// The tasks' ids, in order (tracked where it is read).
pub(crate) fn task_ids() -> Vec<u32> {
    tasks().with(|tasks| tasks.list.iter().map(|task| task.id).collect())
}

/// The task at `index`, or none past the end (tracked where it is read).
pub(crate) fn task_at(index: usize) -> Option<Task> {
    tasks().with(|tasks| tasks.list.get(index).cloned())
}

/// One task, or none once it is removed (tracked where it is read).
pub(crate) fn task_by_id(id: u32) -> Option<Task> {
    tasks().with(|tasks| tasks.list.iter().find(|task| task.id == id).cloned())
}

/// Adds a task; a blank title adds nothing.
pub(crate) fn add_task(title: &str) {
    let title = title.trim();
    if title.is_empty() {
        return;
    }
    tasks().update(|tasks| {
        let id = tasks.next_id;
        tasks.next_id += 1;
        tasks.list.push(Task {
            id,
            title: title.to_owned().into(),
            done: false,
        });
    });
}

/// Sets whether a task is done.
pub(crate) fn set_task_done(id: u32, done: bool) {
    tasks().update(|tasks| {
        if let Some(task) = tasks.list.iter_mut().find(|task| task.id == id) {
            task.done = done;
        }
    });
}

/// Removes a task.
pub(crate) fn remove_task(id: u32) {
    tasks().update(|tasks| tasks.list.retain(|task| task.id != id));
}
```

## `src/nav.rs`

```rust
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
```

## `src/shell.rs`

```rust
//! The app shell: the navigation stack and its pages, no page logic.

use nsh_base::nav_stack;
use nsh_core::prelude::*;

use crate::{
    nav,
    pages::{task_detail, task_list},
};

pub(crate) fn shell() -> impl IntoElement {
    nav_stack().flex_1().child(task_list()).child(each(
        nav::open_tasks,
        |id: &u32| *id,
        |id, depth| {
            task_detail(id.get_untracked())
                // Back on iOS and Android is the system's: it pops the page
                // natively, and the route (with what is above it) follows.
                .on_dismiss(move || nav::truncate(depth.get_untracked()))
        },
    ))
}
```

## `src/components/mod.rs`

```rust
//! What the pages share.

mod header;

pub(crate) use header::header;
```

## `src/components/header.rs`

```rust
//! The page's header on the desktops and the web; iOS and Android show the
//! system's, from the page's `title`.

use nsh_base::{button, theme};
use nsh_core::prelude::*;

use crate::nav;

pub(crate) fn header(title: &'static str) -> impl IntoElement {
    view()
        .flex_row()
        .items_center()
        .gap_3()
        .p_3()
        .border_b_1()
        .border_b_color(move || theme().border)
        .child(when(nav::can_go_back, || {
            button()
                .active(|s| s.opacity(0.6))
                .on_press(nav::pop)
                .child(text("Back").text_color(move || theme().primary))
        }))
        .child(
            text(title)
                .font_weight(FontWeight::SEMIBOLD)
                .text_color(move || theme().foreground),
        )
}
```

## `src/pages/mod.rs`

```rust
//! One file per page of the stack.

mod task_detail;
mod task_list;

pub(crate) use task_detail::task_detail;
pub(crate) use task_list::task_list;
```

## `src/pages/task_list.rs`

```rust
//! A page: a native text input and a virtualized list over the store's tasks.

use nsh_base::{button, input, nav_page, theme};
use nsh_core::{
    element::{Position, Screen},
    prelude::*,
};

use crate::{components::header, nav, store};

pub(crate) fn task_list() -> Screen {
    // Transient view state belongs to the page that renders it.
    let draft = signal(String::new());
    let submit = move || {
        store::add_task(&draft.get_untracked());
        draft.set(String::new());
    };
    nav_page().title("Tasks").header(header("Tasks")).child(
        view()
            .flex_1()
            .gap_3()
            .p_4()
            .pb_safe_area_plus(px(16.0))
            .child(
                view()
                    .flex_row()
                    .items_center()
                    .gap_2()
                    .child(
                        input()
                            .value(move || draft.get())
                            .on_change(move |value: &str| draft.set(value.to_owned()))
                            .on_submit(move |_: &str| submit())
                            .placeholder("New task")
                            .flex_1()
                            .px_3()
                            .py_2()
                            .border_1()
                            .border_color(move || theme().input)
                            .rounded(move || theme().radius)
                            .text_color(move || theme().foreground),
                    )
                    .child(
                        button()
                            .disabled(move || draft.with(|draft| draft.trim().is_empty()))
                            .on_press(submit)
                            .px_4()
                            .py_2()
                            .rounded(move || theme().radius)
                            .bg(move || theme().primary)
                            .active(|s| s.opacity(0.6))
                            .disabled_style(|s| s.opacity(0.4))
                            .child(text("Add").text_color(move || theme().primary_foreground)),
                    ),
            )
            .child(
                virtual_list(store::task_count, task_row)
                    .keys(store::task_ids)
                    .estimated_item_size(px(48.0))
                    .flex_1(),
            ),
    )
}

/// A cell, made once and given other rows as it is reused: it keeps no
/// state, and its bindings read the row where it is now.
fn task_row(at: Position) -> impl IntoElement {
    let task = computed(move || store::task_at(at.index()));
    button()
        .flex_row()
        .items_center()
        .justify_between()
        .p_3()
        .active(|s| s.bg(move || theme().muted))
        .on_press(move || {
            if let Some(task) = task.get_untracked() {
                nav::push(task.id);
            }
        })
        .child(
            text(move || task.get().map(|task| task.title).unwrap_or_default())
                .text_color(move || theme().foreground),
        )
        .child(
            text(move || match task.get() {
                Some(task) if task.done => "Done",
                _ => "Open",
            })
            .text_color(move || theme().muted_foreground),
        )
}
```

## `src/pages/task_detail.rs`

```rust
//! A page: a controlled switch, and a system alert before a removal that
//! cannot be undone.

use nsh_base::{alert_dialog, button, nav_page, switch, theme};
use nsh_core::{element::Screen, prelude::*};

use crate::{components::header, nav, store};

pub(crate) fn task_detail(id: u32) -> Screen {
    // A closure, so the task is read where it is used and follows the store.
    let task = move || store::task_by_id(id);
    nav_page().title("Task").header(header("Task")).child(
        view()
            .flex_1()
            .gap_4()
            .p_4()
            .pb_safe_area_plus(px(16.0))
            .child(
                text(move || task().map(|task| task.title).unwrap_or_default())
                    .text_lg()
                    .text_color(move || theme().foreground),
            )
            .child(
                switch()
                    .checked(move || task().is_some_and(|task| task.done))
                    .on_change(move |&done: &bool| store::set_task_done(id, done))
                    .flex_row()
                    .items_center()
                    .gap_3()
                    // Its parts follow its state: `checked:` is theirs.
                    .track_class("w-11 rounded-full bg-muted p-0.5 transition-colors checked:bg-primary")
                    .thumb_class("size-5 rounded-full bg-background transition-transform checked:translate-x-5")
                    .child(text("Done").text_color(move || theme().foreground)),
            )
            .child(
                button()
                    .on_press(move || confirm_remove(id))
                    .self_start()
                    .px_4()
                    .py_2()
                    .border_1()
                    .border_color(move || theme().destructive)
                    .rounded(move || theme().radius)
                    .active(|s| s.opacity(0.6))
                    .child(text("Remove").text_color(move || theme().destructive)),
            ),
    )
}

/// Asks first; the alert's answer arrives in a task. The page pops before
/// the task goes, so it leaves showing what it showed.
fn confirm_remove(id: u32) {
    let answer = alert_dialog()
        .title("Remove this task?")
        .cancel("cancel", "Cancel")
        .destructive("remove", "Remove")
        .show();
    spawn(async move {
        if answer
            .await
            .is_ok_and(|answer| answer.action.as_deref() == Some("remove"))
        {
            nav::pop();
            store::remove_task(id);
        }
    });
}
```

## `tests/flows.rs`

```rust
//! The app's flows, with the steps a user takes.

use std::time::Duration;

use nsh_engine::{EngineConfig, Root};
use nsh_testing::{DialogAnswer, Headless};

fn start() -> Headless {
    let mut app = Headless::start(EngineConfig::new(Root::of::<tasks_rs::App>())).unwrap();
    app.wait_for("Write the first page").unwrap();
    app
}

const GONE: Duration = Duration::from_secs(5);

#[test]
fn adds_a_task_and_a_blank_title_cannot_be_added() {
    let mut app = start();
    assert!(!app.screen().enabled("role:button[Add]").unwrap());
    app.type_text("text:New task", "Ship it").unwrap();
    app.press("role:button[Add]").unwrap();
    app.wait_for("Ship it").unwrap();
    assert_eq!(app.screen().input_text("text:New task").unwrap(), Some(""));
}

#[test]
fn a_tasks_switch_changes_the_list_behind_it() {
    let mut app = start();
    app.press("Write the first page").unwrap();
    app.wait_for("role:switch").unwrap();
    app.press("role:switch").unwrap();
    app.back().unwrap();
    app.wait_for("role:button[Write the first page Done]")
        .unwrap();
}

#[test]
fn removing_asks_first_and_only_remove_removes() {
    let mut app = start();
    app.press("Read the coding guides").unwrap();
    app.wait_for("role:button[Remove]").unwrap();

    app.on_dialog(|_| DialogAnswer::Press("Cancel".to_owned()));
    app.press("role:button[Remove]").unwrap();
    app.wait_for("role:button[Remove]").unwrap();
    assert!(app.screen().shows("Read the coding guides"));

    app.on_dialog(|dialog| {
        assert_eq!(dialog.title.as_deref(), Some("Remove this task?"));
        DialogAnswer::Press("Remove".to_owned())
    });
    app.press("role:button[Remove]").unwrap();
    app.wait_for_gone("Read the coding guides", GONE).unwrap();
    assert_eq!(app.screen().dialogs().len(), 2);
}
```
