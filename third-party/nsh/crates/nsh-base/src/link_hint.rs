//! Where a link goes, shown while the pointer rests on it: the hint
//! `Link` and `TextView`'s links give themselves, so a user can check a
//! link's destination before following it (a mail app's, a chat app's or a
//! browser's status bar do the same; a title-only tooltip hides the URL,
//! which is what phishing relies on).
//!
//! A hint overlay of the core (`nsh_core::element::Overlay::hint`, the
//! machinery an element's `tooltip` uses): shown on the desktops and the
//! web after the pointer rested on the link, hidden when it leaves or
//! presses it, never on touch screens (there the link's long press and
//! preview are the platform's). Its two lines are the link's title, when it
//! has one, and the destination ([`nsh_core::open_url::hint_url`]), in the
//! theme's secondary text color. Every link with an `href` shows one: a
//! URL, a scheme-relative URL, a path of the app's or an `#anchor`.
//!
//! The destination is one line of two texts in a row, laid out left to
//! right whatever the app's direction: the head (scheme, host and port, in
//! the host's ASCII form) at its own width, never shrinking, wrapping or
//! cut, and the rest (path, query, fragment), whose middle `hint_url`
//! already cut to a budget of characters and which alone shrinks, on one
//! line with an ellipsis in its middle, when the bubble is held narrower
//! than the line (a window narrower than a long host). The bubble has no
//! width limit of its own, so a long host widens it; the title (a
//! Markdown link's, an HTML `<a title>`'s, a `Link`'s `title`), above the
//! destination, is limited and cut on its own. Its look is the theme's popover tokens, as
//! `TextView`'s reading typography is the theme's: every app gets the
//! check, whatever its own look.

use nsh_core::{
    EllipsizeMode,
    element::Overlay,
    open_url::hint_url,
    overlay::{HINT_DELAY, Placement},
    prelude::*,
};

use crate::theme;

/// The characters of a destination line a hint fits its path, query and
/// fragment in, after its head: about 420 points at 12 points. A head
/// longer than that (a long host) is still shown whole.
const URL_CHARS: usize = 64;

/// The widest a title grows before it is cut: about the line of a URL of
/// [`URL_CHARS`].
const TITLE_WIDTH: f32 = 480.0;

/// What a link's hint is placed against.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HintAt {
    /// Below the link's own box (a `Link`, a view): an app's `tooltip` on
    /// the link shows above it by default, so the two usually sit apart
    /// (either may flip to the other side near a window's edge, and a
    /// tooltip placed below can then overlap it).
    Link,
    /// Below where the pointer came over the link, clear of the cursor (a
    /// link of a text: a span, whose lines the core has no frame of).
    Pointer,
}

/// The hint of a link to `href`, titled `title` (both tracked: a change
/// while it shows updates it, and an `href` gone hides it): a child of the
/// link's element. It shows nothing while `href` is empty or absent.
pub(crate) fn link_hint(
    href: impl Fn() -> Option<SharedString> + Clone + 'static,
    title: impl Fn() -> Option<SharedString> + Clone + 'static,
    at: HintAt,
) -> Overlay {
    let shown = move || href().and_then(|href| hint_url(&href, URL_CHARS));
    let open = shown.clone();
    let head = shown.clone();
    let rest = shown;
    let (placement, offset) = match at {
        HintAt::Link => (Placement::Bottom, px(4.0)),
        // Below the cursor's arrow, as the systems' tooltips are.
        HintAt::Pointer => (Placement::Bottom, px(20.0)),
    };
    let title = move || title().filter(|t| !t.trim().is_empty());
    let has_title = title.clone();
    overlay()
        .hint(HINT_DELAY)
        // Nowhere to go: never shown.
        .hint_open(move || open().is_none().then_some(false))
        .placement(placement)
        .offset(offset)
        .margin(px(4.0))
        .pointer_events(PointerEvents::None)
        .child(
            view()
                .px(px(8.0))
                .py(px(6.0))
                .gap_1()
                .bg(move || theme().popover)
                .border_1()
                .border_color(move || theme().border)
                .rounded(move || Length::from((theme().radius - px(2.0)).max(px(0.0))))
                .shadow_md()
                .child(
                    text(move || title().unwrap_or_default())
                        .max_w(px(TITLE_WIDTH))
                        .text_xs()
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(move || theme().popover_foreground)
                        .truncate()
                        // No title: no line for it (nor the gap).
                        .style_when(move || has_title().is_none(), |s| s.hidden()),
                )
                .child(
                    view()
                        .flex_row()
                        // A URL reads left to right in every language: the
                        // head first, then the rest, in an RTL app too.
                        .direction(LayoutDirection::Ltr)
                        .child(
                            // Scheme, host and port: never shrinks or wraps.
                            text(move || head().map(|(head, _)| head).unwrap_or_default())
                                .flex_shrink_0()
                                .number_of_lines(1u32)
                                .writing_direction(WritingDirection::Ltr)
                                .text_xs()
                                .text_color(move || theme().muted_foreground),
                        )
                        .child(
                            // The rest: the only part that gives way, cut in
                            // its middle (the path's start and the query's
                            // end stay), on one line.
                            text(move || rest().map(|(_, rest)| rest).unwrap_or_default())
                                .flex_shrink(1.0)
                                .min_w(px(0.0))
                                .number_of_lines(1u32)
                                .text_overflow(EllipsizeMode::Middle)
                                .writing_direction(WritingDirection::Ltr)
                                .text_xs()
                                .text_color(move || theme().muted_foreground),
                        ),
                ),
        )
}
