//! Trailing iOS navigation-bar buttons (`ios={{ headerRightItems }}`).
//!
//! Rust apps build [`HeaderItem`]s with per-item [`HeaderItem::on_press`]
//! and menus of [`super::desktop::MenuItem`]s (their
//! [`super::desktop::MenuItem::on_select`]). [`register`] turns them into
//! the platform's [`crate::HeaderItem`]s with numeric ids, keeps the
//! handlers in [`super::menus::ViewMenus`], and a cleanup drops them when
//! the binding is replaced or the page goes. The platform reports a
//! chosen id as the root's [`crate::EventKind::Menu`].

use std::{fmt, rc::Rc, sync::Arc};

use super::{cleanup, desktop, menus::MenuHandler, reactive::Owner, view_menus};
use crate::{HeaderItemContent, HeaderSystemItem};

/// A trailing iOS bar button for [`super::host::Screen::header_right_items`]:
/// what it shows, an optional native menu of [`desktop::MenuItem`]s, and
/// handlers that run when the platform reports their ids as the root's
/// `Menu` event.
///
/// ```ignore
/// HeaderItem::system(HeaderSystemItem::Edit).on_press(edit)
/// HeaderItem::symbol("ellipsis.circle")
///     .label("More")
///     .menu([
///         desktop::MenuItem::new("Share").on_select(share),
///         desktop::MenuItem::submenu("Danger", [
///             desktop::MenuItem::new("Delete").destructive(true).on_select(remove),
///         ])
///         .inline(true),
///     ])
/// ```
#[derive(Clone)]
pub struct HeaderItem {
    key: Option<Arc<str>>,
    content: HeaderItemContent,
    label: Option<Arc<str>>,
    disabled: bool,
    on_press: Option<MenuHandler>,
    menu: Option<Vec<desktop::MenuItem>>,
}

impl HeaderItem {
    fn of(content: HeaderItemContent) -> Self {
        Self {
            key: None,
            content,
            label: None,
            disabled: false,
            on_press: None,
            menu: None,
        }
    }

    /// A system-item button.
    pub fn system(item: HeaderSystemItem) -> Self {
        Self::of(HeaderItemContent::SystemItem(item))
    }

    /// An SF Symbol button.
    pub fn symbol(name: impl Into<Arc<str>>) -> Self {
        Self::of(HeaderItemContent::Symbol(name.into()))
    }

    /// A titled button (`label` is what it shows).
    pub fn new(label: impl Into<Arc<str>>) -> Self {
        Self::of(HeaderItemContent::Label(label.into()))
    }

    /// Optional key for keeping a `UIBarButtonItem` across updates; also
    /// the button's accessibility identifier, which tests name it by
    /// (`id:<key>`).
    pub fn key(mut self, key: impl Into<Arc<str>>) -> Self {
        self.key = Some(key.into());
        self
    }

    /// VoiceOver's label when the content is a system item or symbol.
    pub fn label(mut self, label: impl Into<Arc<str>>) -> Self {
        self.label = Some(label.into());
        self
    }

    /// Disables the button.
    pub fn disabled(mut self, disabled: bool) -> Self {
        self.disabled = disabled;
        self
    }

    /// Runs `f` when the button is pressed and it has no menu.
    pub fn on_press(mut self, f: impl Fn() + 'static) -> Self {
        self.on_press = Some(Rc::new(f));
        self
    }

    /// Opens this native menu on press (the button's [`Self::on_press`] is
    /// unused while a menu is set).
    pub fn menu(mut self, items: impl IntoIterator<Item = desktop::MenuItem>) -> Self {
        self.menu = Some(items.into_iter().collect());
        self
    }
}

impl fmt::Debug for HeaderItem {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HeaderItem")
            .field("key", &self.key)
            .field("content", &self.content)
            .field("label", &self.label)
            .field("disabled", &self.disabled)
            .field("menu", &self.menu.as_ref().map(|m| m.len()))
            .finish_non_exhaustive()
    }
}

/// Decodes `items` into the platform's form, keeps their handlers under a
/// generation that a cleanup drops when this binding is replaced or the
/// owner goes, and returns what [`crate::ScreenConfig::right_items`] holds.
pub(crate) fn register(items: Vec<HeaderItem>) -> Vec<crate::HeaderItem> {
    let menus = view_menus();
    let owner = Owner::current();
    let mut handlers = Vec::new();
    let mac = super::os() == crate::platform::Os::MacOs;
    let decoded = items
        .into_iter()
        .map(|item| decode_item(item, mac, &owner, &mut handlers))
        .collect();
    let generation = menus.borrow_mut().push_header(handlers);
    let weak = Rc::downgrade(&menus);
    cleanup(move || {
        if let Some(menus) = weak.upgrade() {
            menus.borrow_mut().take_header(generation);
        }
    });
    decoded
}

fn decode_item(
    item: HeaderItem,
    mac: bool,
    owner: &Owner,
    handlers: &mut Vec<(u32, MenuHandler)>,
) -> crate::HeaderItem {
    let menus = view_menus();
    let press_id = match item.on_press {
        Some(f) if item.menu.is_none() => {
            let id = menus.borrow_mut().next_id();
            let owner = *owner;
            handlers.push((id, Rc::new(move || owner.run(&*f))));
            id
        }
        _ => 0,
    };
    let menu = item.menu.map(|items| {
        // Reuse the desktop menu decoder so item ids and handlers match.
        desktop::decode_for_header(items, mac, owner, handlers)
    });
    crate::HeaderItem {
        key: item.key,
        content: item.content,
        label: item.label,
        disabled: item.disabled,
        press_id,
        menu,
    }
}

/// Whether two lists keep the same trailing `UIBarButtonItem`s: count,
/// keys (or unkeyed contents), content kind that can update in place, and
/// whether each has a menu. A label's title or a symbol's image can change
/// without rebuilding; a system-item change or a content-kind change needs
/// a new button. Menus' contents, accessibility labels and `disabled` can
/// change either way.
#[doc(hidden)]
pub fn same_right_buttons(a: &[crate::HeaderItem], b: &[crate::HeaderItem]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .all(|(x, y)| keepable(x, y) && x.menu.is_some() == y.menu.is_some())
}

/// What a kept button ([`same_right_buttons`]) shows once updated to an
/// item: the platforms apply it to the button they kept, so a changed
/// label, symbol, accessibility label or `disabled` reaches the screen.
#[doc(hidden)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeptButton<'a> {
    pub content: KeptContent<'a>,
    /// VoiceOver's label; `None` clears the one set before.
    pub label: Option<&'a str>,
    pub enabled: bool,
}

/// A kept button's content after an update.
#[doc(hidden)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeptContent<'a> {
    /// This title, and no image.
    Title(&'a str),
    /// This SF Symbol, and no title; `fallback` is the title where the
    /// platform has no such symbol.
    Symbol { name: &'a str, fallback: &'a str },
    /// A system item: kept only while it is the same item, so its look
    /// stays as it is.
    Unchanged,
}

/// What the button kept for `item` shows ([`KeptButton`]).
#[doc(hidden)]
pub fn kept_button(item: &crate::HeaderItem) -> KeptButton<'_> {
    let content = match &item.content {
        HeaderItemContent::Label(title) => KeptContent::Title(title),
        HeaderItemContent::Symbol(name) => KeptContent::Symbol {
            name,
            fallback: item.label.as_deref().unwrap_or(name),
        },
        _ => KeptContent::Unchanged,
    };
    KeptButton {
        content,
        label: item.label.as_deref(),
        enabled: !item.disabled,
    }
}

/// Whether UIKit can keep `a`'s `UIBarButtonItem` and apply `b` in place.
fn keepable(a: &crate::HeaderItem, b: &crate::HeaderItem) -> bool {
    match (a.key.as_deref(), b.key.as_deref()) {
        (Some(ka), Some(kb)) if ka == kb => content_keeps_button(&a.content, &b.content),
        (None, None) => a.content == b.content,
        _ => false,
    }
}

/// Label and symbol content update in place; a system item only when it is
/// the same item (UIKit cannot change a system item on an existing button).
fn content_keeps_button(a: &HeaderItemContent, b: &HeaderItemContent) -> bool {
    match (a, b) {
        (HeaderItemContent::Label(_), HeaderItemContent::Label(_)) => true,
        (HeaderItemContent::Symbol(_), HeaderItemContent::Symbol(_)) => true,
        (HeaderItemContent::SystemItem(x), HeaderItemContent::SystemItem(y)) => x == y,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::{HeaderItem as PlatformHeaderItem, HeaderSystemItem};

    fn keyed(key: &str, content: HeaderItemContent) -> PlatformHeaderItem {
        PlatformHeaderItem {
            key: Some(Arc::from(key)),
            content,
            label: None,
            disabled: false,
            press_id: 0,
            menu: None,
        }
    }

    #[test]
    fn keyed_label_change_keeps_button() {
        let a = keyed("edit", HeaderItemContent::Label(Arc::from("Edit")));
        let b = keyed("edit", HeaderItemContent::Label(Arc::from("Done")));
        assert!(
            same_right_buttons(&[a], &[b]),
            "same key + Label→Label: update title in place"
        );
    }

    #[test]
    fn keyed_symbol_change_keeps_button() {
        let a = keyed("star", HeaderItemContent::Symbol(Arc::from("star")));
        let b = keyed("star", HeaderItemContent::Symbol(Arc::from("star.fill")));
        assert!(
            same_right_buttons(&[a], &[b]),
            "same key + Symbol→Symbol: update image in place"
        );
    }

    #[test]
    fn a_kept_button_shows_the_new_title_symbol_label_and_state() {
        // Edit → Done: the same key, a new title.
        let done = keyed("edit", HeaderItemContent::Label(Arc::from("Done")));
        assert_eq!(kept_button(&done).content, KeptContent::Title("Done"));
        // star → star.fill: a new image; the label is the fallback title.
        let mut filled = keyed("fav", HeaderItemContent::Symbol(Arc::from("star.fill")));
        filled.label = Some(Arc::from("Favorite"));
        assert_eq!(
            kept_button(&filled).content,
            KeptContent::Symbol {
                name: "star.fill",
                fallback: "Favorite"
            }
        );
        // An accessibility label taken away is cleared, not kept.
        filled.label = None;
        filled.disabled = true;
        let kept = kept_button(&filled);
        assert_eq!(kept.label, None);
        assert!(!kept.enabled);
        assert_eq!(
            kept.content,
            KeptContent::Symbol {
                name: "star.fill",
                fallback: "star.fill"
            }
        );
        // A system item keeps its look.
        let system = keyed("x", HeaderItemContent::SystemItem(HeaderSystemItem::Edit));
        assert_eq!(kept_button(&system).content, KeptContent::Unchanged);
    }

    #[test]
    fn keyed_system_item_change_rebuilds() {
        let a = keyed("x", HeaderItemContent::SystemItem(HeaderSystemItem::Edit));
        let b = keyed("x", HeaderItemContent::SystemItem(HeaderSystemItem::Done));
        assert!(
            !same_right_buttons(&[a], &[b]),
            "UIKit cannot change a system item in place"
        );
    }

    #[test]
    fn keyed_content_kind_change_rebuilds() {
        let a = keyed("x", HeaderItemContent::Label(Arc::from("Edit")));
        let b = keyed("x", HeaderItemContent::Symbol(Arc::from("pencil")));
        assert!(
            !same_right_buttons(&[a], &[b]),
            "Label→Symbol needs a new UIBarButtonItem"
        );
    }
}
