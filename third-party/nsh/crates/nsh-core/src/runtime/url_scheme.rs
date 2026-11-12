//! `nsh`'s `UrlScheme`: the links that open the app ([`crate::url_scheme`]),
//! URLs of the schemes it claims in `nsh.json`, and the app's address
//! (`url`, `setUrl`): on the web the page's. The core keeps the address
//! (Rust's `app_url`), and `url()` reads it where it is (`System::app_url`);
//! the moves of it the app did not make come as `change`. Needs no
//! capability: the app's own claim is what lets them in.

use std::{
    cell::{Cell, RefCell},
    rc::{Rc, Weak},
};

use crate::{
    element::{
        CallCx, Callback, JsError, JsHost, JsIn, JsObject, JsOwned, JsValue, Local, PropEnum,
        PropError, Stop, System, TsTypes, module,
    },
    url_scheme::{AppUrlChange, AppUrlChangeReason},
};

/// The links that open the app.
#[module]
pub(crate) struct UrlScheme;

#[module]
impl UrlScheme {
    /// Listens to `event`. `open`: the system handed the app a link of a
    /// scheme it claims (`nsh.json` `"schemes": [...]`),
    /// at launch or while it runs; links that came while nothing listened,
    /// the one that launched the app included, go to the next listener (at
    /// most 16, the oldest dropped). Nothing navigates on its own: what a
    /// link opens is the app's. Anyone can make a link of the app's scheme,
    /// so its URL is untrusted input: check it before acting on it.
    /// `change`: the app's address moved without the app moving it (on the
    /// web, the browser's back or forward to an entry its pages do not
    /// account for, `reason` `"back"` or `"forward"`, or an address the user
    /// typed, `"address"`); `url()` reads it already, and the app shows
    /// what it names. A back that pops a page is the stack's (`onChange`),
    /// and a forward to a page the stack no longer has is `open`. Moves
    /// while nothing listened are not kept. Returns a function that stops
    /// listening.
    #[overload(fn(event: UrlSchemeOpenEvent, #[args(open)] listener: Callback<UrlSchemeOpen>) -> Stop)]
    #[overload(fn(event: UrlSchemeChangeEvent, #[args(change)] listener: Callback<UrlSchemeChange>) -> Stop)]
    pub(crate) fn on(
        event: UrlSchemeEvent,
        #[args(payload)] listener: Callback<Payload>,
        sys: System,
        cx: crate::element::CallCx<'_>,
    ) -> Result<Stop, JsError> {
        let links = sys.locals.get::<Links>();
        let id = links.next.get();
        links.next.set(id.wrapping_add(1));
        match event {
            UrlSchemeEvent::Open => {
                for url in links.unheard.take() {
                    listener.post(Payload::Open(UrlSchemeOpen { url }));
                }
                links.listeners.borrow_mut().push((id, listener));
                links.start(&cx);
            }
            UrlSchemeEvent::Change => {
                links.change_listeners.borrow_mut().push((id, listener));
                links.start_changes(&cx);
            }
        }
        let links = Rc::downgrade(&links);
        Ok(Stop::new(move || {
            if let Some(links) = links.upgrade() {
                links.listeners.borrow_mut().retain(|(i, _)| *i != id);
                links
                    .change_listeners
                    .borrow_mut()
                    .retain(|(i, _)| *i != id);
            }
        }))
    }

    /// The app's address: on the web the page's; on the native platforms
    /// the last link that opened the app (the link that launched the app
    /// also comes as the first `open`); the URL `setUrl` or Rust's
    /// `set_app_url` set after it; `null` when there is none. The core's
    /// own, read as it is.
    pub(crate) fn url(sys: System) -> Option<String> {
        sys.app_url.get()
    }

    /// Sets the current page's address: on the web it replaces the
    /// current history entry's (as `history.replaceState`), or with
    /// `history: "push"` is an entry of its own after it (as
    /// `history.pushState`), which the browser's back goes back from; the
    /// native platforms keep it for `url()` either way. The app's pages
    /// stay as they are.
    pub(crate) fn set_url(
        url: String,
        options: Option<SetUrlOptions>,
        sys: System,
        cx: CallCx<'_>,
    ) -> Result<(), JsError> {
        crate::url_scheme::check_address(&url).map_err(JsError::Type)?;
        let history = match options.and_then(|o| o.history) {
            Some(SetUrlHistory::Push) => crate::url_scheme::HistoryBehavior::Push,
            _ => crate::url_scheme::HistoryBehavior::Replace,
        };
        // Written at once, so `url()` reads it back; the web's history
        // entry follows in order with what JS sent before (the stack's
        // changes).
        sys.app_url.set(url.clone());
        cx.start(async move { crate::element::set_app_url_from_js(url, history) });
        Ok(())
    }
}

/// How `UrlScheme.setUrl` sets the address.
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct SetUrlOptions {
    /// `"replace"` (when not given) replaces the current history entry's
    /// address; `"push"` makes it an entry of its own after it. Only the
    /// web has a history.
    history: Option<SetUrlHistory>,
}

/// `UrlScheme.setUrl`'s `history`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum SetUrlHistory {
    /// The current entry's address.
    #[default]
    Replace,
    /// An entry of its own after the current one.
    Push,
}

/// `UrlScheme.on`'s events.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum UrlSchemeEvent {
    /// The system handed the app a link.
    #[default]
    Open,
    /// The app's address moved without the app moving it.
    Change,
}

/// The event a link comes with (`on`'s first overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum UrlSchemeOpenEvent {
    Open,
}

/// The event an address move comes with (`on`'s second overload).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PropEnum)]
pub(crate) enum UrlSchemeChangeEvent {
    Change,
}

/// A link that opened the app (the `open` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct UrlSchemeOpen {
    /// The URL, as the system handed it.
    url: String,
}

/// What moved the app's address (the `change` event's `reason`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, PropEnum)]
pub(crate) enum UrlSchemeChangeReason {
    /// The browser's back.
    #[default]
    Back,
    /// The browser's forward.
    Forward,
    /// An address of the app's the user gave the page (a `#fragment` typed
    /// in the address bar).
    Address,
}

impl From<AppUrlChangeReason> for UrlSchemeChangeReason {
    fn from(reason: AppUrlChangeReason) -> Self {
        match reason {
            AppUrlChangeReason::Back => Self::Back,
            AppUrlChangeReason::Forward => Self::Forward,
            AppUrlChangeReason::Address => Self::Address,
        }
    }
}

/// An address the app moved to without moving it (the `change` event).
#[derive(Debug, Clone, Default, PartialEq, JsObject)]
pub(crate) struct UrlSchemeChange {
    /// The address now, as `url()` reads it.
    url: String,
    /// What moved it.
    reason: UrlSchemeChangeReason,
}

impl From<AppUrlChange> for UrlSchemeChange {
    fn from(change: AppUrlChange) -> Self {
        Self {
            url: change.url,
            reason: change.reason.into(),
        }
    }
}

/// What a listener gets.
#[derive(Debug, Clone)]
pub(crate) enum Payload {
    Open(UrlSchemeOpen),
    Change(UrlSchemeChange),
}

impl JsValue for Payload {
    fn ts_type(types: &mut TsTypes) -> String {
        format!(
            "{} | {}",
            <UrlSchemeOpen as JsValue>::ts_type(types),
            <UrlSchemeChange as JsValue>::ts_type(types)
        )
    }

    fn from_js(value: JsIn<'_>) -> Result<Self, PropError> {
        Err(value.expected("no value (a payload goes to JS only)"))
    }

    fn to_js<'a>(&self, host: &'a dyn JsHost) -> Result<JsOwned<'a>, PropError> {
        match self {
            Payload::Open(open) => open.to_js(host),
            Payload::Change(change) => change.to_js(host),
        }
    }
}

/// The VM's `open` and `change` listeners.
#[derive(Default)]
struct Links {
    listeners: RefCell<Vec<(u32, Callback<Payload>)>>,
    change_listeners: RefCell<Vec<(u32, Callback<Payload>)>>,
    next: Cell<u32>,
    /// The task waiting for the core's links started; it lasts as the VM
    /// does.
    started: Cell<bool>,
    /// The task waiting for the core's address moves started.
    changes_started: Cell<bool>,
    /// Links that came while no listener was left, for the next one.
    unheard: RefCell<Vec<String>>,
}

impl Links {
    /// Starts taking the core's links, once.
    fn start(self: &Rc<Self>, cx: &CallCx<'_>) {
        if !self.started.replace(true) {
            cx.start(deliver(Rc::downgrade(self)));
        }
    }

    /// Starts taking the core's address moves, once.
    fn start_changes(self: &Rc<Self>, cx: &CallCx<'_>) {
        if !self.changes_started.replace(true) {
            cx.start(deliver_changes(Rc::downgrade(self)));
        }
    }
}

impl Local for Links {
    fn close(&self) {
        self.listeners.borrow_mut().clear();
        self.change_listeners.borrow_mut().clear();
    }
}

/// Posts the core's links to the listeners, while the VM lasts.
async fn deliver(links: Weak<Links>) {
    loop {
        let url = crate::prelude::next_url_scheme_open().await;
        let Some(links) = links.upgrade() else {
            return;
        };
        let listeners = links.listeners.borrow();
        if listeners.is_empty() {
            let mut unheard = links.unheard.borrow_mut();
            if unheard.len() == crate::url_scheme::MAX_PENDING {
                unheard.remove(0);
            }
            unheard.push(url);
            continue;
        }
        for (_, listener) in &*listeners {
            listener.post(Payload::Open(UrlSchemeOpen { url: url.clone() }));
        }
    }
}

/// Posts the core's address moves to the listeners there are, while the VM
/// lasts: one with none listening is not kept (`url()` has it).
async fn deliver_changes(links: Weak<Links>) {
    loop {
        let change = UrlSchemeChange::from(crate::prelude::next_app_url_change().await);
        let Some(links) = links.upgrade() else {
            return;
        };
        for (_, listener) in &*links.change_listeners.borrow() {
            listener.post(Payload::Change(change.clone()));
        }
    }
}
