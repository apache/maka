//! The app's Rust code: what `App.tsx` imports from `__SPECIFIER__`. Their
//! TypeScript declarations are generated from these types into
//! `.nsh/types/__SPECIFIER__.d.ts`.

use nsh_base::theme;
use nsh_core::prelude::*;

/// The crate's UI set (`nsh.json` `"rust"`).
#[native_module("__SPECIFIER__")]
fn native(registry: &mut Registry) {
    registry
        .register::<Badge>()
        .module::<Format>()
        .class::<Counter>();
}

// A component: `<Badge label="…" onPress={…} />`. The function's doc comment
// is the component's in TS, the fields' its props'.
/// The props of [`Badge`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct BadgeProps {
    /// The text.
    pub label: Prop<SharedString>,
}

/// The events of a [`Badge`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum BadgeEvent {
    /// The badge was pressed.
    Press,
}

/// A pill with a label; pressing it reports `onPress`.
#[component]
pub fn Badge(props: BadgeProps, cx: Scope<BadgeEvent>) -> impl IntoElement {
    view()
        .px_4()
        .py_2()
        .rounded_full()
        .bg(move || theme().primary)
        .active(|s| s.bg(move || theme().primary.opacity(0.9)))
        .on_press(move || cx.emit(BadgeEvent::Press))
        .child(text(props.label).text_color(move || theme().primary_foreground))
}

/// Text helpers.
#[module]
pub struct Format;

// A module: `Format.times(3)`. The struct's doc comment is the module's in
// TS (`#[module]` on it and on this block).
#[module]
impl Format {
    /// "once", "twice", "3 times".
    pub fn times(count: u32) -> String {
        match count {
            1 => "once".to_owned(),
            2 => "twice".to_owned(),
            n => format!("{n} times"),
        }
    }
}

/// A count kept in Rust.
#[class]
pub struct Counter {
    count: u32,
}

// A class: `new Counter()`, `counter.increment()`, `counter.count`.
#[class]
impl Counter {
    /// A counter at 0.
    pub fn new() -> Self {
        Counter { count: 0 }
    }

    /// Adds one; the new count.
    pub fn increment(&mut self) -> u32 {
        self.count += 1;
        self.count
    }

    /// The count.
    #[getter]
    pub fn count(&self) -> u32 {
        self.count
    }
}
