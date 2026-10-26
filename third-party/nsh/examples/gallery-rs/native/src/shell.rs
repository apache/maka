//! The gallery's two layouts (as the TSX gallery's `App.tsx`): the phone
//! layout, a native stack of the index and the demos pushed over it, and
//! the desktop layout of wide windows (`ui::desktop`), a sidebar of the demos
//! and the selected one in a pane beside it. [`crate::Gallery`] makes the
//! one the window's width calls for, again when it changes (TS remounts its
//! shell), so demos read `desktop()` and their layout once. The demo open
//! is kept in the app's storage and opened again at launch.

use std::{cell::Cell, ptr};

use nsh_base::{nav_page, nav_stack};
use nsh_core::{
    element::{AccessibilityRole, AccessibilityState, AnyElement},
    prelude::*,
    storage::Storage,
};

use crate::{
    assets::LOGO,
    demos::{self, Demo, GROUPS},
    nav::{self, Route},
    ui::{Badge, IconTile, MONO, SIDEBAR, colors, desktop, icon, radius},
};

/// The storage key of the demo open (its name).
const LAST_DEMO: &str = "lastDemo";

/// The demo the desktop layout shows.
#[derive(Clone, Copy)]
struct Selected(&'static Demo);

impl Default for Selected {
    fn default() -> Self {
        Self(&GROUPS[0].demos[0])
    }
}

/// The same demo: the same entry of [`GROUPS`].
impl PartialEq for Selected {
    fn eq(&self, other: &Self) -> bool {
        ptr::eq(self.0, other.0)
    }
}

/// Whether the desktop layout has been shown (for the switch back).
#[derive(Default, Clone, Copy, PartialEq)]
struct WasDesktop(bool);

/// The screens pushed over the stack's first one: each made when it is
/// pushed and gone when it is popped.
fn pushed() -> AnyElement {
    let routes = nav::routes();
    each(
        move || routes.with(|r| r.0.clone()),
        |route: &Route| route.key.clone(),
        |route, depth| {
            let route = route.get_untracked();
            (route.screen)()
                // The user popped it natively: it and what is above it go.
                .on_dismiss(move || nav::truncate(depth.get_untracked()))
        },
    )
    .into_element()
}

/// The demo the pushed screens show, if any.
fn pushed_demo() -> Option<&'static Demo> {
    nav::routes().with(|routes| {
        GROUPS
            .iter()
            .flat_map(|g| g.demos)
            .find(|demo| routes.0.iter().any(|r| *r.key == *demo.key()))
    })
}

/// Opens the demo open when the app last ran (selected in the desktop
/// layout, pushed over the index on phones); then keeps the one open in
/// the app's storage. A name no demo has opens none.
pub(crate) fn restore() {
    let last = Storage::get_item(LAST_DEMO).and_then(|name| {
        GROUPS
            .iter()
            .flat_map(|g| g.demos)
            .find(|demo| demo.name == name)
    });
    if let Some(demo) = last {
        global::<Selected>().set(Selected(demo));
    }
    let selected = global::<Selected>();
    let restored = Cell::new(false);
    effect(move || {
        // A window's first frame can come before its size (0 × 0, the
        // phone layout): which layout opens the demo, and what is open,
        // are known once it has one.
        if window().width.0 <= 0.0 {
            return;
        }
        if !restored.replace(true)
            && let Some(demo) = last
            && !untracked(desktop)
            && nav::depth() == 0
        {
            nav::reset(vec![demo.route()]);
        }
        // The index on phones: none.
        let open = if desktop() {
            Some(selected.get().0)
        } else {
            pushed_demo()
        };
        let kept = Storage::get_item(LAST_DEMO);
        match open {
            Some(demo) if kept.as_deref() != Some(demo.name) => {
                if let Err(full) = Storage::set_item(LAST_DEMO, demo.name) {
                    log::warn!("{full}");
                }
            }
            None if kept.is_some() => Storage::remove_item(LAST_DEMO),
            _ => {}
        }
    });
}

/// The phone layout: the index, demos pushed over it.
pub(crate) fn phone() -> AnyElement {
    // Back from the desktop layout: the demo it showed stays open.
    if global::<WasDesktop>().get_untracked().0 {
        let Selected(demo) = global::<Selected>().get_untracked();
        nav::reset(vec![demo.route()]);
    }
    nav_stack()
        .flex_1()
        .child(demos::index())
        .child(pushed())
        .into_element()
}

/// The desktop layout: a sidebar of the demos and the selected one beside
/// it, no index to go back to. What a demo pushes opens over it in the
/// content pane, with a back button.
pub(crate) fn desktop_layout() -> AnyElement {
    // From the phone layout: show the demo it had open.
    if let Some(demo) = untracked(pushed_demo) {
        global::<Selected>().set(Selected(demo));
    }
    if nav::depth() > 0 {
        nav::pop_to_top();
    }
    global::<WasDesktop>().set(WasDesktop(true));
    view()
        .flex_1()
        .flex_row()
        .bg(colors::BACKGROUND)
        .child(sidebar())
        .child(
            nav_stack()
                .flex_1()
                .child(
                    nav_page()
                        .key("pane")
                        .header_visible(false)
                        .child(demo_pane()),
                )
                .child(pushed()),
        )
        .into_element()
}

/// Shows `demo` in the desktop layout, closing what it had pushed.
fn select(demo: &'static Demo) {
    if nav::depth() > 0 {
        nav::pop_to_top();
    }
    global::<Selected>().set(Selected(demo));
}

/// A demo in the sidebar: an accent bar and a raised fill when selected,
/// a fill under the pointer otherwise.
fn sidebar_row(demo: &'static Demo) -> AnyElement {
    let selected = global::<Selected>();
    let active = move || selected.with(|s| ptr::eq(s.0, demo));
    // TS: `bg-accent` when selected, `hover:bg-hover active:bg-accent`
    // otherwise (the gallery theme's tokens).
    let fill = AdaptiveColor::new(colors::BORDER.light, colors::RAISED.dark);
    let hover = AdaptiveColor::new(colors::SURFACE.light, colors::LINE.dark);
    view()
        .h(px(36.0))
        .flex_row()
        .items_center()
        .gap(px(10.0))
        .px(px(10.0))
        .rounded(px(radius::CONTROL))
        .cursor_pointer()
        .role(AccessibilityRole::Button)
        .label(demo.name)
        .accessibility_state(move || AccessibilityState {
            selected: active(),
            ..AccessibilityState::default()
        })
        .style_when(active, |s| s.bg(fill))
        .hover(|s| s.bg(move || if active() { fill } else { hover }))
        .active(|s| s.bg(fill))
        .on_press(move || select(demo))
        .child(
            view()
                .absolute()
                .left_0()
                .top(px(9.0))
                .w(px(3.0))
                .h(px(18.0))
                .rounded(px(1.5))
                .bg(colors::ACCENT)
                .opacity(move || if active() { 1.0_f32 } else { 0.0 }),
        )
        .child(icon().name(demo.icon).size(17.0).tint(move || {
            if active() {
                colors::ACCENT
            } else {
                colors::MUTED
            }
        }))
        .child(
            text(demo.name)
                .number_of_lines(1)
                .flex_1()
                .text_size(px(14.0))
                .style_when(active, |s| s.font_weight(FontWeight::SEMIBOLD))
                .text_color(move || {
                    if active() {
                        colors::TEXT
                    } else {
                        colors::MUTED
                    }
                }),
        )
        .into_element()
}

/// The desktop layout's sidebar: the app, the demos by group, the window.
fn sidebar() -> AnyElement {
    let groups = GROUPS.iter().map(|group| {
        view()
            .gap(px(2.0))
            .child(
                text(group.title.to_uppercase())
                    .text_size(px(11.0))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(colors::FAINT)
                    .letter_spacing(px(0.6))
                    .px(px(10.0))
                    .pt_4()
                    .pb(px(6.0)),
            )
            .children(group.demos.iter().map(sidebar_row))
    });
    view()
        .w(px(SIDEBAR))
        .bg(colors::INSET)
        .border_r_1()
        .border_r_color(colors::LINE)
        .child(
            view()
                .flex_row()
                .items_center()
                .gap_3()
                .px_5()
                .pt_5()
                .pb_3()
                .child(image(LOGO).size(px(32.0)).rounded(px(8.0)))
                .child(
                    view()
                        .flex_1()
                        .gap(px(1.0))
                        .child(
                            text("Rust Gallery")
                                .text_size(px(16.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT),
                        )
                        .child(
                            text(format!("NSH · {}", os().name()))
                                .text_size(px(12.0))
                                .text_color(colors::MUTED),
                        ),
                ),
        )
        .child(
            scroll()
                .flex_1()
                .child(view().px_3().pb_4().children(groups)),
        )
        .child(
            view()
                .px_5()
                .py_3()
                .border_t_1()
                .border_t_color(colors::LINE)
                .gap(px(2.0))
                .child(
                    text(move || {
                        let size = window();
                        format!("{} × {} pt", size.width.0.round(), size.height.0.round())
                    })
                    .text_size(px(12.0))
                    .text_color(colors::MUTED)
                    .font_family(MONO),
                )
                .child(
                    text("Narrower than 700 pt: the phone layout")
                        .text_size(px(11.0))
                        .text_color(colors::FAINT),
                ),
        )
        .into_element()
}

/// The selected demo under a toolbar with its name and what it shows.
fn demo_pane() -> AnyElement {
    let selected = global::<Selected>();
    let demo = move || selected.get().0;
    view()
        .flex_1()
        .bg(colors::BACKGROUND)
        .child(
            view()
                .h(px(64.0))
                .flex_row()
                .items_center()
                .gap(px(14.0))
                .px_6()
                .border_b_1()
                .border_b_color(colors::LINE)
                .child(dynamic(move || IconTile::new(demo().icon).size(36.0)))
                .child(
                    view()
                        .flex_1()
                        .gap(px(2.0))
                        .child(
                            text(move || demo().name)
                                .number_of_lines(1)
                                .text_size(px(18.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .text_color(colors::TEXT),
                        )
                        .child(
                            text(move || demo().detail)
                                .number_of_lines(1)
                                .text_size(px(13.0))
                                .text_color(colors::MUTED),
                        ),
                )
                .child(Badge::new(move || demo().group())),
        )
        // A new demo when another is selected.
        .child(view().flex_1().child(dynamic(move || {
            let content = demo().content;
            untracked(content)
        })))
        .into_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_first_demo_is_selected_first() {
        assert_eq!(Selected::default().0.name, "Stocks");
        assert_eq!(Selected::default().0.group(), "Apps");
    }

    #[test]
    fn demo_routes_are_apart_from_pushed_screens() {
        assert_eq!(GROUPS[1].demos[0].key(), "demo:Lists");
    }
}
