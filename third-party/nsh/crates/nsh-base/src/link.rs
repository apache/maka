//! `Link`: a press target that goes somewhere, with no look of its own.

use nsh_core::{AccessibilityCurrent, AccessibilityState, open_url::check_url, prelude::*};

use crate::roving::bar_item;

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
    /// opening (`openWith`, `onOpen`), never shown: the children are what
    /// shows.
    pub href: Prop<Option<SharedString>>,
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
/// the link role for screen readers) and leaves its look to the app: no
/// color, underline, cursor or label of its own. `href` is where it goes,
/// data rather than text; `openWith` says who opens it (the system, or the
/// app's `onOpen`). The app's `class` and `style` style it, its states with
/// `hover:`, `active:`, `focus:` and `disabled:` classes or `hoverStyle`,
/// `activeStyle`, `focusStyle` and `disabledStyle`, and its children are
/// its content. Inside a `<Text>` it is an inline box of the paragraph, as
/// every view there is: it stays on one line (`align-text-bottom` sits its
/// text on the paragraph's baseline). In a `Toolbar`, it is one of the
/// toolbar's items, as a `Button` there is.
#[component]
pub fn Link(props: LinkProps, cx: Scope<LinkEvent>) -> impl IntoElement {
    let (view, disabled) = bar_item(view(), None, props.disabled);
    view.disabled(disabled)
        .role(AccessibilityRole::Link)
        .optional_label(props.accessibility_label)
        .accessibility_state(move || AccessibilityState {
            current: props.current.get().then_some(AccessibilityCurrent::Page),
            ..AccessibilityState::default()
        })
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
        .child(props.children)
}
