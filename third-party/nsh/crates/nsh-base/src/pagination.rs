//! `Pagination`: the pages of a set, a navigation landmark with no look of
//! its own (`gpui-base`'s `Pagination` and `PaginationState`, with
//! `gpui-component`'s Previous / Next and `compact`).
//!
//! - **The pages shown** (`visiblePages`, at least 5): every page while
//!   they fit, else the first and the last, the current one with as many
//!   pages on each side as fit, and an ellipsis for each run of pages left
//!   out ([`pagination_items`], `gpui-base`'s `calculate_items`).
//! - **Items**: Previous, the pages and ellipses, then the app's children
//!   and Next, each an item the app draws (`renderItem`,
//!   [`PaginationItemState`]) or styles (`itemClass`: `selected:` on the
//!   current page, `disabled:` on what takes no press). Without
//!   `renderItem` a page shows its number, an ellipsis `…`, and Previous /
//!   Next their accessibility labels, else `‹` / `›`, as `Calendar`'s.
//!   `compact` shows Previous, the children and Next only.
//! - **Places, not pages**: the row is made once, a place for each item it
//!   can hold (`visiblePages` + 2), each with a page and an ellipsis view of
//!   which it shows one; a page change changes what the places show (their
//!   numbers, their states, the one of the two they show), and makes and
//!   drops no view. `renderItem` renders each place under its own key, so
//!   only the places whose item changed render again; hidden places don't
//!   call it.
//! - **The keyboard**: each page, Previous and Next is a stop of the
//!   keyboard focus (the current page too), Return and Space press it, as
//!   `gpui-component`'s buttons. A page pressed from the keyboard keeps the
//!   focus once the app shows it, wherever it lands in the row, and so does
//!   the first or the last page when Previous or Next turns to it (and
//!   becomes disabled).

use std::ops::Range;

use nsh_core::{AccessibilityCurrent, element::TextPartStyle, prelude::*};

/// The fewest pages a pagination shows (`gpui-base`'s `visible_pages`
/// minimum).
const MIN_VISIBLE: u32 = 5;

/// A destination a pagination shows (`gpui-base`'s `PaginationItem`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PaginationItem {
    /// A page, by its number (from 1).
    Page(u32),
    /// The pages left out between two shown ones: `start` included, `end`
    /// not.
    Ellipsis(Range<u32>),
}

/// The items a pagination shows on `page` of `total_pages`, showing at
/// most `visible_pages` pages (at least 5) besides its ellipses
/// (`gpui-base`'s `calculate_items`): none for a single page, every page
/// while they fit, else the first and the last pages around the current
/// one and its neighbours, `(visible_pages - 3) / 2` on each side, with an
/// ellipsis for each run of pages left out.
pub fn pagination_items(page: u32, total_pages: u32, visible_pages: u32) -> Vec<PaginationItem> {
    let total = total_pages.max(1);
    let current = page.clamp(1, total);
    if total <= 1 {
        return Vec::new();
    }
    let visible = visible_pages.max(MIN_VISIBLE);
    if total <= visible {
        return (1..=total).map(PaginationItem::Page).collect();
    }
    let side = (visible - 3) / 2;
    let start = if current <= side + 1 {
        2
    } else if current > total - side - 1 {
        total - side - 1
    } else {
        current - side
    };
    let end = if current >= total - side {
        total - 1
    } else if current <= side + 1 {
        side + 2
    } else {
        current + side
    };
    let mut items = vec![PaginationItem::Page(1)];
    if start > 2 {
        items.push(PaginationItem::Ellipsis(2..start));
    }
    items.extend((start..=end).map(PaginationItem::Page));
    if end < total - 1 {
        items.push(PaginationItem::Ellipsis(end + 1..total));
    }
    items.push(PaginationItem::Page(total));
    items
}

/// The most items [`pagination_items`] makes for `visible_pages`: its
/// pages and two ellipses.
fn places(visible_pages: u32) -> usize {
    visible_pages.max(MIN_VISIBLE) as usize + 2
}

/// What a pagination's item is.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum PaginationItemKind {
    /// The page before the current one.
    Previous,
    /// A page.
    #[default]
    Page,
    /// The pages left out between two shown ones.
    Ellipsis,
    /// The page after the current one.
    Next,
}

/// An item as `renderItem` draws it.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
#[non_exhaustive]
pub struct PaginationItemState {
    /// What it is.
    pub kind: PaginationItemKind,
    /// The page it shows or goes to: a page's number; for Previous and
    /// Next the page before or after the current one (the current one at
    /// the ends); for an ellipsis the first page it leaves out.
    pub page: u32,
    /// An ellipsis: the first page it leaves out.
    #[prop(skip_none)]
    pub start: Option<u32>,
    /// An ellipsis: the page after the last it leaves out (the next page
    /// shown).
    #[prop(skip_none)]
    pub end: Option<u32>,
    /// The current page (screen readers hear it as the current page).
    pub current: bool,
    /// It takes no press: everything of a disabled pagination, Previous on
    /// the first page and Next on the last.
    pub disabled: bool,
}

/// The props of [`Pagination`].
#[derive(Debug, Clone, Copy, PartialEq, Props)]
pub struct PaginationProps {
    /// The current page, from 1 (controlled: the app owns it and sets it in
    /// `onChange`), held to the pages there are (`gpui-base`'s
    /// `current_page`).
    pub page: Prop<u32>,
    /// How many pages there are, at least 1 (`gpui-base`'s `total_pages`).
    pub total_pages: Prop<u32>,
    /// The most pages shown at once, the first and the last included, at
    /// least 5 (the default; `gpui-base`'s `visible_pages`): odd numbers
    /// center the current page.
    #[prop(default = 5)]
    pub visible_pages: Prop<u32>,
    /// Only Previous, the children and Next (`gpui-component`'s
    /// `compact`): a pager for a narrow screen, the page shown in the
    /// children.
    #[prop(default)]
    pub compact: Prop<bool>,
    /// No item takes a press nor the keyboard focus; `disabled:` styles
    /// apply to them and screen readers say they are dimmed.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// What screen readers call the navigation (`gpui-base`'s
    /// `accessibility_label`): what it pages through.
    pub accessibility_label: Prop<Option<SharedString>>,
    /// What screen readers say for Previous, and its content without
    /// `renderItem`.
    pub previous_accessibility_label: Prop<Option<SharedString>>,
    /// What screen readers say for Next, and its content without
    /// `renderItem`.
    pub next_accessibility_label: Prop<Option<SharedString>>,
    /// The classes of each item: `selected:` on the current page,
    /// `disabled:` while it takes no press, `focus:` with the keyboard on
    /// it.
    pub item_class: Prop<Option<SharedString>>,
    /// The inline style of each item, over its classes: its text styles
    /// too, which its content inherits.
    #[prop(default)]
    pub item_style: Prop<TextPartStyle>,
    /// Draws each item's content (`gpui-component`'s buttons): icons for
    /// Previous and Next, a menu of the pages an ellipsis leaves out, a
    /// page's number in the app's words.
    pub render_item: Prop<Option<Renderer<PaginationItemState>>>,
    /// The app's content after the pages, before Next: the page shown in
    /// words while `compact` ("3 of 12"), a field to go to a page.
    pub children: Prop<Children>,
}

/// The events of a [`Pagination`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum PaginationEvent {
    /// The user picked a page (`gpui-base`'s `on_change`): a page, Previous
    /// or Next. The current page is never reported.
    #[args(page)]
    Change(u32),
}

/// What every item reads: the props as the pagination holds them, and
/// where the keyboard focus is.
#[derive(Clone, Copy)]
struct Pager {
    props: PaginationProps,
    /// The pages there are, at least 1.
    total: Memo<u32>,
    /// The current page, held to the pages there are.
    current: Memo<u32>,
    /// What the places show.
    items: Memo<Vec<PaginationItem>>,
    /// The item with the keyboard focus.
    focused: Stored<Option<Focus>>,
    /// A press from the keyboard asked for this page: the focus goes to the
    /// place that shows it, once it is the current page (`from` the page
    /// it was pressed on: another change forgets it).
    follow: Signal<Option<(u32, u32)>>,
}

/// Which item has the keyboard focus.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Focus {
    Previous,
    Place(usize),
    Next,
}

impl Pager {
    /// Reports `page` as the user's pick, when it is one: another page,
    /// one there is, of a pagination that is not disabled (`gpui-base`'s
    /// `request_page`). `from` the item pressed, which keeps the keyboard
    /// focus on the page it brings.
    fn request(self, page: u32, from: Focus, cx: Scope<PaginationEvent>) {
        let (current, total) = (self.current.get_untracked(), self.total.get_untracked());
        if self.props.disabled.get_untracked() || page == current || !(1..=total).contains(&page) {
            return;
        }
        if self.focused.get() == Some(from) {
            // A page lands at another place, Previous and Next go
            // disabled at the ends: the focus follows the page there.
            let follows = match from {
                Focus::Place(_) => true,
                Focus::Previous | Focus::Next => page == 1 || page == total,
            };
            if follows {
                self.follow.set(Some((current, page)));
            }
        }
        cx.emit(PaginationEvent::Change(page));
    }

    /// Notes that `item` took or left the keyboard focus.
    fn focus(self, item: Focus, focused: bool) {
        match (focused, self.focused.get()) {
            (true, _) => {
                self.focused.replace(Some(item));
            }
            (false, Some(held)) if held == item => {
                self.focused.replace(None);
            }
            _ => {}
        }
    }
}

/// An item's content: the app's `renderItem` with `state` under `key`
/// (nothing while `shown` says the item is hidden), else `default`.
fn content(
    pager: Pager,
    key: SharedString,
    state: Memo<PaginationItemState>,
    shown: Option<Memo<bool>>,
    default: impl Fn() -> SharedString + 'static,
) -> AnyElement {
    let render_item = pager.props.render_item;
    let custom = computed(move || render_item.with(Option::is_some));
    let default = std::rc::Rc::new(default);
    dynamic(move || {
        if custom.get() {
            let key = key.clone();
            return dynamic(move || {
                if !shown.is_none_or(|shown| shown.get()) {
                    return None;
                }
                let render = render_item.get()?;
                Some(render.render(key.clone(), state.get()))
            })
            .into_element();
        }
        let default = default.clone();
        text(move || default()).into_element()
    })
    .into_element()
}

/// Previous or Next.
fn step(pager: Pager, previous: bool, cx: Scope<PaginationEvent>) -> AnyElement {
    let props = pager.props;
    let (current, total) = (pager.current, pager.total);
    let item = if previous {
        Focus::Previous
    } else {
        Focus::Next
    };
    let at_end = computed(move || {
        if previous {
            current.get() <= 1
        } else {
            current.get() >= total.get()
        }
    });
    let target = computed(move || match (previous, at_end.get()) {
        (_, true) => current.get(),
        (true, false) => current.get() - 1,
        (false, false) => current.get() + 1,
    });
    let disabled = computed(move || props.disabled.get() || at_end.get());
    let state = computed(move || PaginationItemState {
        kind: if previous {
            PaginationItemKind::Previous
        } else {
            PaginationItemKind::Next
        },
        page: target.get(),
        disabled: disabled.get(),
        ..PaginationItemState::default()
    });
    let label = if previous {
        props.previous_accessibility_label
    } else {
        props.next_accessibility_label
    };
    let key: SharedString = if previous { "previous" } else { "next" }.into();
    view()
        .role(AccessibilityRole::Button)
        .disabled(move || disabled.get())
        .optional_label(label)
        .app_class(props.item_class)
        .inline_style(move || props.item_style.get())
        .on_focus(move || pager.focus(item, true))
        .on_blur(move || pager.focus(item, false))
        .on_press(move || {
            if !disabled.get_untracked() {
                pager.request(target.get_untracked(), item, cx);
            }
        })
        .child(content(pager, key, state, None, move || {
            label
                .get()
                .unwrap_or_else(|| if previous { "‹" } else { "›" }.into())
        }))
        .into_element()
}

/// Place `at` of the row: a page view and (past the first place, which
/// always holds page 1) an ellipsis view, which show the item the place
/// holds, if any.
fn place(pager: Pager, at: usize, cx: Scope<PaginationEvent>) -> Vec<AnyElement> {
    let props = pager.props;
    let item = computed(move || pager.items.with(|items| items.get(at).cloned()));
    let compact = props.compact;
    let number = computed(move || match item.get() {
        Some(PaginationItem::Page(page)) => Some(page),
        _ => None,
    });
    let page_shown = computed(move || number.get().is_some() && !compact.get());
    let current = computed(move || number.get() == Some(pager.current.get()));
    let state = computed(move || PaginationItemState {
        kind: PaginationItemKind::Page,
        page: number.get().unwrap_or(0),
        current: current.get(),
        disabled: props.disabled.get(),
        ..PaginationItemState::default()
    });
    let me = element_ref();
    // The keyboard comes here when a press from it asked for the page
    // shown here, once the app made it the current one.
    effect(move || {
        let Some((_, to)) = pager.follow.get() else {
            return;
        };
        if !page_shown.get() || number.get() != Some(to) || pager.current.get() != to {
            return;
        }
        untracked(|| {
            pager.follow.set(None);
            if pager.focused.get().is_some() && pager.focused.get() != Some(Focus::Place(at)) {
                me.focus();
            }
        });
    });
    let page = view()
        .role(AccessibilityRole::Button)
        .disabled(props.disabled)
        .accessibility_state(move || {
            let current = current.get();
            AccessibilityState {
                selected: current,
                current: current.then_some(AccessibilityCurrent::Page),
                ..AccessibilityState::default()
            }
        })
        .app_class(props.item_class)
        .inline_style(move || props.item_style.get())
        .style_when(move || !page_shown.get(), |s| s.hidden())
        .element_ref(&me)
        .on_focus(move || pager.focus(Focus::Place(at), true))
        .on_blur(move || pager.focus(Focus::Place(at), false))
        .on_press(move || {
            if let Some(page) = number.get_untracked() {
                pager.request(page, Focus::Place(at), cx);
            }
        })
        .child(content(
            pager,
            format!("page-{at}").into(),
            state,
            Some(page_shown),
            // Empty while hidden: no page a place does not show stays
            // in the tree.
            move || match (page_shown.get(), number.get()) {
                (true, Some(page)) => page.to_string().into(),
                _ => SharedString::default(),
            },
        ))
        .into_element();
    if at == 0 {
        return vec![page];
    }
    let hidden = computed(move || match item.get() {
        Some(PaginationItem::Ellipsis(range)) => Some(range),
        _ => None,
    });
    let ellipsis_shown = computed(move || hidden.with(Option::is_some) && !compact.get());
    let state = computed(move || {
        let range = hidden.get();
        PaginationItemState {
            kind: PaginationItemKind::Ellipsis,
            page: range.as_ref().map_or(0, |r| r.start),
            start: range.as_ref().map(|r| r.start),
            end: range.map(|r| r.end),
            disabled: props.disabled.get(),
            ..PaginationItemState::default()
        }
    });
    let ellipsis = view()
        .app_class(props.item_class)
        .inline_style(move || props.item_style.get())
        .style_when(move || !ellipsis_shown.get(), |s| s.hidden())
        .child(content(
            pager,
            format!("ellipsis-{at}").into(),
            state,
            Some(ellipsis_shown),
            || "…".into(),
        ))
        .into_element();
    vec![page, ellipsis]
}

/// The pages of a set to move among (`gpui-base`'s `Pagination`): search
/// results, a table's rows, a feed's archive. A navigation landmark named by
/// `accessibilityLabel`, a row of Previous, the pages around the current
/// one (`visiblePages` of them, the first and the last always, ellipses
/// for the runs left out), the app's children and Next; `compact` keeps
/// Previous, the children and Next. The page is `page` and `onChange` (the
/// app's): a press on a page, Previous or Next reports the page it goes
/// to; Previous on the first page and Next on the last take no press, and
/// `disabled` makes every item inert. Screen readers hear the current page
/// as the current one (ARIA's `aria-current="page"`). It looks like
/// nothing: the app styles the items (`itemClass`, `selected:` on the
/// current page) or draws them (`renderItem`), and lays the row out with
/// its `class` (a row by default).
#[component]
pub fn Pagination(props: PaginationProps, cx: Scope<PaginationEvent>) -> impl IntoElement {
    let total = computed(move || props.total_pages.get().max(1));
    let current = computed(move || props.page.get().clamp(1, total.get()));
    let visible = props.visible_pages;
    let items = computed(move || pagination_items(current.get(), total.get(), visible.get()));
    let pager = Pager {
        props,
        total,
        current,
        items,
        focused: stored(None),
        follow: signal(None),
    };
    // A press the app answered with another page than the one asked for
    // leaves the focus where it is.
    effect(move || {
        let current = current.get();
        untracked(|| {
            if let Some((from, to)) = pager.follow.get()
                && current != from
                && current != to
            {
                pager.follow.set(None);
            }
        });
    });
    // Made again only when the number of places changes: a page change
    // changes what the places show.
    let count = computed(move || places(visible.get()));
    let pages = dynamic(move || {
        (0..count.get())
            .flat_map(|at| place(pager, at, cx))
            .collect::<Vec<_>>()
    });
    view()
        .role(AccessibilityRole::Navigation)
        .optional_label(props.accessibility_label)
        .flex_row()
        .child(step(pager, true, cx))
        .child(pages)
        .child(props.children)
        .child(step(pager, false, cx))
}
