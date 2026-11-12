//! `Link`: a press target that goes somewhere, with no look of its own.

use nsh_core::{AccessibilityCurrent, AccessibilityState, open_url::check_url, prelude::*};

use crate::{
    link_hint::{HintAt, link_hint},
    roving::bar_item,
};

/// How a [`Link`] opens its `href` (`openWith`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, PropEnum)]
pub enum LinkOpenWith {
    /// A URL of another app or site (with a scheme: `https:`, `mailto:`,
    /// `tel:`, ...) opens outside the app (`openUrl`: the embedding app
    /// first, then the system, under the app's `openUrl` capability); any
    /// other `href` (a path of the app's, `#anchor`) is only reported.
    #[default]
    System,
    /// Nothing opens: the app's `onOpen` handler is how (a route of its
    /// own, an in-app web view).
    App,
}

/// The props of [`Link`].
#[derive(Debug, Clone, PartialEq, Props)]
pub struct LinkProps {
    /// Where the link goes: a URL or a path of the app's. Data for the
    /// opening (`openWith`, `onOpen`) and the hover hint. The children
    /// provide the link's visible content.
    pub href: Prop<Option<SharedString>>,
    /// What the link's page is called, shown above the destination in
    /// the hint that shows while the pointer rests on the link (as a
    /// Markdown link's title is). Optional: without it the hint shows the
    /// destination alone. It is not the link's content nor its accessible
    /// name (the children and `accessibilityLabel` are), and not a
    /// `tooltip`, which stays the app's own.
    pub title: Prop<Option<SharedString>>,
    /// How `href` opens when the link is pressed: `"system"` (the default)
    /// opens a URL of another app or site outside the app, `"app"` leaves
    /// it to the app's `onOpen`. `onOpen` reports it either way.
    #[prop(default)]
    pub open_with: Prop<LinkOpenWith>,
    /// No presses (none reach a pressable around it either), no press
    /// feedback, not a stop of the keyboard focus; `disabled:` styles
    /// apply and screen readers say it is dimmed. A link in a disabled
    /// `Toolbar` is disabled too.
    #[prop(default)]
    pub disabled: Prop<bool>,
    /// The link to the page the user is on (a navigation's, a
    /// breadcrumb's last): screen readers say it is the current page
    /// (ARIA's `aria-current="page"`). The app owns the value and styles
    /// it.
    #[prop(default)]
    pub current: Prop<bool>,
    /// What screen readers say, when its content is not enough (an icon).
    pub accessibility_label: Prop<Option<SharedString>>,
    /// How far outside its bounds presses still count, as a view's
    /// `hitSlop`: one number for every side, or the sides named (each left
    /// out 0). A small link (an icon, a short word) takes presses a finger
    /// lands near it, with no change to its layout or look.
    #[prop(default)]
    pub hit_slop: Prop<EdgeInsets>,
    /// The content: a label, an icon, anything the app shows.
    pub children: Prop<Children>,
}

/// The events of a [`Link`].
#[derive(Debug, Clone, PartialEq, Event)]
pub enum LinkEvent {
    /// The link opens its `href` (a press, a click, Return or Space): with
    /// `openWith="app"` the handler is how it opens, with `"system"` it
    /// hears what the system was asked to open. Before `onPress`.
    #[args(href)]
    Open(SharedString),
    /// The link was pressed, after it opened its `href` (or with none).
    Press,
}

/// A link: content that goes somewhere when pressed (a page, a site, a
/// route of the app). It owns its behavior (presses, keyboard activation
/// with Return or Space, a stop of the keyboard focus, the disabled state,
/// the link role for screen readers, the pointing hand over it while it is
/// enabled, as a web `<a href>` has) and leaves its look to the app: no
/// color, underline or label of its own; a `cursor-*` class of the app's
/// replaces the hand. `href` is where it goes,
/// data rather than text; while the pointer rests on the link a hint shows
/// it (its `title`, when given, above it); `openWith` says who opens it (the system, or the
/// app's `onOpen`). The app's `class` and `style` style it, its states with
/// `hover:`, `active:`, `focus-visible:` (the keyboard's ring) and
/// `disabled:` classes or `hoverStyle`, `activeStyle`, `focusVisibleStyle`
/// and `disabledStyle`, and its children are
/// its content. `hitSlop` widens where presses count past its bounds, as a
/// view's does. Inside a `<Text>` it is an inline box of the paragraph, as
/// every view there is: it stays on one line (`align-text-bottom` sits its
/// text on the paragraph's baseline). In a `Toolbar`, it is one of the
/// toolbar's items, as a `Button` there is. A terminal draws the text
/// inside an enabled link as a hyperlink to `href`, which the terminal
/// opens on its own (a Cmd- or Ctrl-click), outside `openWith`.
#[component]
pub fn Link(props: LinkProps, cx: Scope<LinkEvent>) -> impl IntoElement {
    let (view, disabled) = bar_item(view(), None, props.disabled);
    view.disabled(disabled)
        .style_when(move || !disabled.get(), |s| s.cursor(Cursor::Pointer))
        .role(AccessibilityRole::Link)
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            current: props.current.get().then_some(AccessibilityCurrent::Page),
            ..AccessibilityState::default()
        })
        .hit_slop(props.hit_slop)
        // Where it goes, for a platform that links its text (a terminal's
        // hyperlink, the web's `<a href>`); a disabled link goes nowhere.
        .__link_href(Prop::bind(move || {
            if disabled.get() {
                None
            } else {
                props.href.get()
            }
        }))
        .on_press(move |_: &()| {
            if let Some(href) = props.href.get_untracked() {
                cx.emit(LinkEvent::Open(href.clone()));
                if props.open_with.get_untracked() == LinkOpenWith::System
                    && check_url(&href).is_ok()
                {
                    // Whether it opened is the platform's to show; a
                    // capability that does not grant it is reported there.
                    drop(open_url(href.to_string()));
                }
            }
            cx.emit(LinkEvent::Press);
        })
        // Where it goes, shown while the pointer rests on it, below the
        // link, with its `title` above the destination in the same bubble
        // (a terminal links its text to it instead). An app's `tooltip` is
        // a separate overlay, placed on its own side.
        .when(!crate::terminal::is_terminal(), |view| {
            view.child(link_hint(
                move || {
                    if disabled.get() {
                        None
                    } else {
                        props.href.get()
                    }
                },
                move || props.title.get(),
                HintAt::Link,
            ))
        })
        .child(props.children)
}
