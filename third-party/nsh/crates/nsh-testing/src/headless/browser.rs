//! A web page's browser history in headless runs ([`Browser`]): the app
//! starts at a page's address ([`Headless::start_at_page`]) and the driver
//! keeps the entries the web's runtime keeps, as it keeps them.
//!
//! One entry per screen a shown stack has over its bottom one and per
//! presented modal, so that the browser's back goes back in the app; the
//! app's address (`set_app_url`, `UrlScheme.setUrl`) replaces the current
//! entry's, or with [`HistoryBehavior::Push`] makes an entry of its own at
//! the depth of the pages shown. Entries the app takes away itself (it pops
//! a page, closes a dialog) are gone back over, addresses the user typed
//! at those depths included, and the app hears only the address it lands
//! on (`quiet`). The user's moves ([`Browser::back`], [`Browser::forward`],
//! [`Browser::go`], [`Browser::type_address`]) are reported as the web
//! reports them: back to a lower depth pops the app's pages and closes its
//! dialogs (an address that then differs is a change, unless the app sets
//! one), between entries of one depth the app hears a change (`Back`,
//! `Forward`), forward to a depth the app no longer has is an `open` of the
//! entry's address, and a `#fragment` typed in the address bar is an entry
//! after the current one with the reason `Address`.
//!
//! [`HistoryBehavior::Push`]: nsh_core::url_scheme::HistoryBehavior::Push

use nsh_core::{EventKind, EventPayload, PayloadValue, ROOT_ID, platform::Os, url_scheme};

use super::Headless;

/// Why a browser step cannot be taken on an app that did not start at a
/// page.
const NOT_A_PAGE: &str = "the app did not start at a page's address (Headless::start_at_page): it has no browser history";

/// One entry of the page's history ([`Browser::entries`]).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct HistoryEntry {
    /// Its address.
    pub url: String,
    /// How many backs of the app's it stands for: the screens of the shown
    /// stacks over their bottom ones and the presented modals when it was
    /// made.
    pub depth: usize,
}

/// The page's history, as the web's runtime keeps it.
#[derive(Debug)]
pub(super) struct History {
    /// The entries of this load of the page, the app's first at 0.
    entries: Vec<HistoryEntry>,
    /// The current entry.
    index: usize,
    /// The depth the entries account for.
    depth: usize,
    /// The address the app was last told (or set).
    shown: String,
    /// What the app's relative addresses resolve against.
    base: url::Url,
    /// An address the app set, for the entry once the entries of its pages
    /// exist; `push`: as an entry of its own.
    pending: Option<String>,
    push: bool,
    /// How many addresses the app set.
    sets: u64,
    /// A back that popped the app's pages: the address is a change unless
    /// the app sets one before the step ends.
    pop_answer: Option<PopAnswer>,
}

#[derive(Debug)]
struct PopAnswer {
    sets: u64,
    url: String,
    reason: &'static str,
}

/// How the app is told the entry's address.
enum Tell {
    /// Handed from outside, as a link (`open`).
    Open,
    /// A move it did not make, by its reason (`change`).
    Change(&'static str),
    /// Only as the address.
    Quiet,
}

impl History {
    fn new(url: url::Url) -> History {
        History {
            entries: vec![HistoryEntry {
                url: url.to_string(),
                depth: 0,
            }],
            index: 0,
            depth: 0,
            shown: url.to_string(),
            base: url,
            pending: None,
            push: false,
            sets: 0,
            pop_answer: None,
        }
    }

    fn location(&self) -> &str {
        &self.entries[self.index].url
    }

    /// A new entry after the current one, at `depth`, with address `url`
    /// (the current one's when not given): those after it go.
    fn push_entry(&mut self, depth: usize, url: Option<String>) {
        let url = url.unwrap_or_else(|| self.location().to_owned());
        self.entries.truncate(self.index + 1);
        self.entries.push(HistoryEntry { url, depth });
        self.index += 1;
    }

    /// The newest entry before the current one at most `depth` deep: where
    /// a back of the app's own to `depth` goes.
    fn entry_at_depth(&self, depth: usize) -> usize {
        (1..self.index)
            .rev()
            .find(|i| self.entries[*i].depth <= depth)
            .unwrap_or(0)
    }
}

/// The browser around the page an app started at
/// ([`Headless::start_at_page`], [`Headless::browser`]): its history, and
/// the user's moves through it. Each move is a step: it settles as the
/// others do and fails when the app threw.
///
/// ```ignore
/// let mut app = Headless::start_at_page(config, "https://a.test/app/")?;
/// app.press("Message")?; // pushes a page, sets `?m=1`
/// assert_eq!(app.browser().url(), Some("https://a.test/app/?m=1"));
/// app.browser().back()?; // pops it
/// app.browser().type_address("#inbox")?; // a change, reason `Address`
/// ```
pub struct Browser<'a> {
    app: &'a mut Headless,
}

impl Browser<'_> {
    /// The browser's back: the entry before the current one. Fails at the
    /// app's first entry (going back from it leaves the page).
    pub fn back(&mut self) -> Result<(), String> {
        self.traverse(-1, "browser.back".into())
    }

    /// The browser's forward: the entry after the current one. Fails at
    /// the newest entry.
    pub fn forward(&mut self) -> Result<(), String> {
        self.traverse(1, "browser.forward".into())
    }

    /// `delta` entries back (negative) or forward at once, as from the back
    /// button's menu (`history.go(delta)`).
    pub fn go(&mut self, delta: isize) -> Result<(), String> {
        self.traverse(delta, format!("browser.go({delta})"))
    }

    /// The user types `url` in the address bar (resolved against the
    /// current address, `#inbox`): an address of this page that differs
    /// only in its `#fragment` is a new entry after the current one at the
    /// current depth, which the app hears as a change with the reason
    /// `Address`; its pages stay. Another address of the page's would load
    /// the page again: that fails, as does an address of another origin
    /// (start the app at it instead, [`Headless::start_at_page`]).
    pub fn type_address(&mut self, url: &str) -> Result<(), String> {
        self.app.step(format!("browser.typeAddress({url})"));
        let history = self.app.history.as_mut().ok_or(NOT_A_PAGE)?;
        let current = url::Url::parse(history.location()).map_err(|e| e.to_string())?;
        let typed = current
            .join(url)
            .map_err(|e| format!("{url} is not an address: {e}"))?;
        if typed.origin() != current.origin() {
            return Err(format!(
                "{typed} is of another site: typing it leaves the page"
            ));
        }
        let (mut page, mut typed_page) = (current.clone(), typed.clone());
        page.set_fragment(None);
        typed_page.set_fragment(None);
        if page != typed_page {
            return Err(format!(
                "{typed} loads the page again (only a #fragment keeps it): start the app at it \
                 (Headless::start_at_page)"
            ));
        }
        // The same address makes no entry.
        if typed == current {
            return self.app.done();
        }
        let typed = typed.to_string();
        history.pop_answer = None;
        if typed != history.shown {
            let depth = history.depth;
            history.push_entry(depth, Some(typed));
            self.app.tell_address(Tell::Change("address"));
        }
        self.app.done()?;
        self.app.sync_history();
        self.app.done()
    }

    /// The page's history, oldest first: those of the app's first entry
    /// and after (the current one is [`Browser::index`]). Empty for an app
    /// that did not start at a page.
    pub fn entries(&self) -> &[HistoryEntry] {
        self.app
            .history
            .as_ref()
            .map_or(&[], |history| history.entries.as_slice())
    }

    /// The current entry's place in [`Browser::entries`].
    pub fn index(&self) -> Option<usize> {
        self.app.history.as_ref().map(|history| history.index)
    }

    /// The current entry.
    pub fn current(&self) -> Option<&HistoryEntry> {
        let history = self.app.history.as_ref()?;
        history.entries.get(history.index)
    }

    /// The address in the address bar: the current entry's.
    pub fn url(&self) -> Option<&str> {
        self.current().map(|entry| entry.url.as_str())
    }

    fn traverse(&mut self, delta: isize, step: String) -> Result<(), String> {
        self.app.step(step);
        let history = self.app.history.as_ref().ok_or(NOT_A_PAGE)?;
        let to = history.index.checked_add_signed(delta);
        let Some(to) = to.filter(|to| *to < history.entries.len()) else {
            return Err(if delta < 0 {
                format!(
                    "no entry {} back: going back from the app's first entry leaves the page",
                    -delta
                )
            } else {
                format!("no entry {delta} forward")
            });
        };
        if delta != 0 {
            self.app.pop_state(to);
        }
        self.app.done()?;
        self.app.sync_history();
        self.app.settle_pop();
        self.app.done()
    }
}

impl Headless {
    /// Starts `config`'s app as the web page at `url` (an `http(s)` URL):
    /// on the web ([`Os::Web`]), the app's first `app_url` /
    /// `UrlScheme.url()` reads it, Rust's `set_app_url` resolves against
    /// it, and the page's history starts with it ([`Headless::browser`]).
    pub fn start_at_page(
        mut config: nsh_engine::EngineConfig,
        url: &str,
    ) -> std::io::Result<Headless> {
        let invalid = |e: String| std::io::Error::new(std::io::ErrorKind::InvalidInput, e);
        let page = url::Url::parse(url).map_err(|e| invalid(format!("{url}: {e}")))?;
        if !matches!(page.scheme(), "http" | "https") {
            return Err(invalid(format!("a page's address is http(s): {url}")));
        }
        config.environment.os = Os::Web;
        let payload = EventPayload::Map(vec![
            (url_scheme::URL, PayloadValue::Str(page.to_string())),
            (url_scheme::PAGE, PayloadValue::Bool(true)),
            (url_scheme::QUIET, PayloadValue::Bool(true)),
            (url_scheme::BASE, PayloadValue::Str(page.to_string())),
        ]);
        let mut app = Self::launched_with(config, || nsh_core::ApproxTextEngine, Some(payload))?;
        app.history = Some(History::new(page));
        Ok(app)
    }

    /// The browser around the page the app started at
    /// ([`Headless::start_at_page`]): its history and the user's moves
    /// through it.
    pub fn browser(&mut self) -> Browser<'_> {
        Browser { app: self }
    }

    /// The app's address (`SetAppUrl`, `PushAppUrl`): resolved as
    /// `history.replaceState` resolves it; one of another origin is
    /// dropped.
    pub(super) fn set_page_url(&mut self, url: &str, push: bool) {
        let Some(history) = &mut self.history else {
            return;
        };
        let resolved = match history.base.join(url) {
            Ok(resolved) if resolved.origin() == history.base.origin() => resolved,
            Ok(resolved) => {
                log::warn!("the app's address is not of the page's origin: {resolved}");
                return;
            }
            Err(_) => {
                log::warn!("the app's address is not a URL: {url}");
                return;
            }
        };
        history.pending = Some(resolved.into());
        history.push |= push;
        history.sets += 1;
    }

    /// Brings the entries to the depth the screen holds and puts the
    /// address the app set on the current one, as the web's runtime does
    /// after each turn of the app's.
    pub(super) fn sync_history(&mut self) {
        let depth = self.screen.back_depth();
        let Some(history) = &mut self.history else {
            return;
        };
        let have = history.depth;
        for level in have + 1..=depth {
            history.push_entry(level, None);
        }
        if depth < have {
            // Back over the entries above `depth`, the addresses the user
            // typed at those depths included.
            let to = history.entry_at_depth(depth);
            history.index = to;
            history.depth = depth.min(history.entries[to].depth);
            // Landed: the address the app set goes to the entry, else the
            // app takes the entry's; levels the entry lacks get theirs.
            let pending = history.pending.is_some();
            let again = history.depth < depth;
            if !pending {
                self.tell_address(Tell::Quiet);
            }
            if pending || again {
                self.sync_history();
            }
            return;
        }
        history.depth = depth;
        if let Some(url) = history.pending.take() {
            // An entry of its own when the turn pushed no page's and the
            // address is not the one shown.
            let push =
                std::mem::take(&mut history.push) && depth <= have && url != history.location();
            if push {
                history.push_entry(depth, Some(url.clone()));
            } else {
                let index = history.index;
                history.entries[index].url = url.clone();
            }
            history.shown = url;
        }
    }

    /// The user moved to entry `index` (the browser's `popstate`).
    fn pop_state(&mut self, index: usize) {
        let Some(history) = &mut self.history else {
            return;
        };
        history.pop_answer = None;
        let have = history.depth;
        let at = history.entries[index].depth;
        let reason = if index < history.index {
            "back"
        } else {
            "forward"
        };
        history.index = index;
        let url = history.location().to_owned();
        if at > have {
            // Forward to a screen the app no longer has: an address it is
            // handed from outside; its pages' entries go on from here.
            history.depth = at;
            self.tell_address(Tell::Open);
            return;
        }
        if at == have {
            let how = if url != history.shown {
                Tell::Change(reason)
            } else {
                Tell::Quiet
            };
            self.tell_address(how);
            return;
        }
        // Back to a lower depth: the app's pages pop and its dialogs close;
        // what it does not let go back gets its entry again.
        let (sets, before) = (history.sets, history.shown.clone());
        history.depth = at;
        let mut popped = 0;
        while at + popped < have && self.go_back(true) {
            popped += 1;
        }
        let kept = at + popped < have;
        let Some(history) = &mut self.history else {
            return;
        };
        if kept {
            // The app kept its page: its entry keeps the address it showed.
            if popped == 0 && history.pending.is_none() {
                history.pending = Some(history.shown.clone());
            }
            return;
        }
        if history.sets != sets {
            history.shown = url;
            return;
        }
        self.tell_address(Tell::Quiet);
        // An app whose pages do not set the address hears the entry's when
        // it differs from the one it had, unless it sets one meanwhile.
        if let Some(history) = &mut self.history
            && url != before
        {
            history.pop_answer = Some(PopAnswer { sets, url, reason });
        }
    }

    /// After a back that popped the app's pages settled: the address is a
    /// change unless the app set one.
    fn settle_pop(&mut self) {
        let Some(history) = &mut self.history else {
            return;
        };
        let Some(popped) = history.pop_answer.take() else {
            return;
        };
        if history.sets == popped.sets && history.location() == popped.url {
            self.tell_address(Tell::Change(popped.reason));
        }
    }

    /// Tells the app the current entry's address, `how`.
    fn tell_address(&mut self, how: Tell) {
        let Some(history) = &mut self.history else {
            return;
        };
        history.shown = history.location().to_owned();
        let mut fields = vec![
            (url_scheme::URL, PayloadValue::Str(history.shown.clone())),
            (url_scheme::PAGE, PayloadValue::Bool(true)),
        ];
        match how {
            Tell::Open => {}
            Tell::Change(reason) => {
                fields.push((url_scheme::CHANGE, PayloadValue::Str(reason.into())))
            }
            Tell::Quiet => fields.push((url_scheme::QUIET, PayloadValue::Bool(true))),
        }
        self.engine.control().dispatch_event(
            ROOT_ID,
            EventKind::UrlScheme,
            EventPayload::Map(fields),
        );
    }
}

#[cfg(test)]
mod tests {
    use nsh_core::{element::Root, prelude::*, url_scheme::HistoryBehavior};
    use nsh_engine::EngineConfig;

    use super::*;

    const PAGE: &str = "https://a.test/app/";

    /// A mail page: an inbox at the bottom of a stack, a message page it
    /// pushes with its address, a filter pushed as an address alone, a
    /// dialog over either. What the app hears of its address is listed at
    /// the top; an `#inbox` address shows the inbox.
    #[component]
    fn Mail() -> impl IntoElement {
        let pages = signal(vec![0_u32]);
        let open = signal(false);
        let heard = signal(Vec::<String>::new());
        spawn(async move {
            loop {
                let change = next_app_url_change().await;
                heard.update(|h| h.push(format!("{:?} {}", change.reason, change.url)));
                if change.url.ends_with("#inbox") {
                    pages.set(vec![0]);
                    let _ = set_app_url(change.url);
                }
            }
        });
        spawn(async move {
            loop {
                let url = next_url_scheme_open().await;
                heard.update(|h| h.push(format!("Open {url}")));
                if url.contains("?m=") {
                    pages.set(vec![0, 1]);
                }
            }
        });
        let button = |id: &'static str, press: Box<dyn Fn()>| {
            view().test_id(id).on_press(press).child(text(id))
        };
        view()
            .flex_1()
            .child(text(move || format!("heard: {}", heard.get().join(" | "))))
            .child(nsh_base::nav_stack().flex_1().child(each(
                move || pages.get(),
                |&page: &u32| page,
                move |page, _| {
                    let page = page.get_untracked();
                    let content = if page == 0 {
                        view()
                            .child(button(
                                "message",
                                Box::new(move || {
                                    pages.update(|p| p.push(1));
                                    set_app_url("?m=1").unwrap();
                                }),
                            ))
                            .child(button(
                                "filter",
                                Box::new(|| {
                                    set_app_url_with("?f=1", HistoryBehavior::Push).unwrap();
                                }),
                            ))
                            .child(button("settings", Box::new(move || open.set(true))))
                    } else {
                        view()
                            .child(text(format!("message {page}")))
                            .child(button("reply", Box::new(move || open.set(true))))
                    };
                    nsh_base::nav_page()
                        .on_dismiss(move |_: &()| pages.update(|p| p.retain(|p| *p < page)))
                        .child(content)
                },
            )))
            .child(dynamic(move || {
                open.get().then(|| {
                    nsh_base::dialog()
                        .on_cancel(move || open.set(false))
                        .child(text("Settings"))
                        .child(button("done", Box::new(move || open.set(false))))
                })
            }))
    }

    fn open_mail() -> Headless {
        let mut app = Headless::start_at_page(EngineConfig::new(Root::of::<Mail>()), PAGE).unwrap();
        app.first_render().unwrap();
        app
    }

    fn entries(app: &mut Headless) -> Vec<(String, usize)> {
        let browser = app.browser();
        browser
            .entries()
            .iter()
            .map(|e| {
                (
                    e.url.strip_prefix(PAGE).unwrap_or(&e.url).to_owned(),
                    e.depth,
                )
            })
            .collect()
    }

    fn entry(url: &str, depth: usize) -> (String, usize) {
        (url.to_owned(), depth)
    }

    #[test]
    fn a_page_is_an_entry_the_browsers_back_pops_and_forward_opens_again() {
        let mut app = open_mail();
        assert_eq!(entries(&mut app), [entry("", 0)]);
        app.press("message").unwrap();
        app.wait_for("text:message 1").unwrap();
        // The page's entry takes the address the turn set.
        assert_eq!(entries(&mut app), [entry("", 0), entry("?m=1", 1)]);
        assert_eq!(app.browser().index(), Some(1));

        // Back pops the page; the app set no address for it, so it hears
        // the entry's.
        app.browser().back().unwrap();
        app.wait_for("text:heard: Back https://a.test/app/")
            .unwrap();
        assert!(!app.shows("message 1"));
        assert_eq!(app.browser().index(), Some(0));

        // Forward to the page it no longer has: the entry's address opens it.
        app.browser().forward().unwrap();
        app.wait_for("text:message 1").unwrap();
        app.wait_for("text:heard: Back https://a.test/app/ | Open https://a.test/app/?m=1")
            .unwrap();
        assert_eq!(entries(&mut app), [entry("", 0), entry("?m=1", 1)]);
        assert_eq!(app.browser().index(), Some(1));
    }

    #[test]
    fn a_pushed_address_is_an_entry_the_app_moves_between() {
        let mut app = open_mail();
        app.press("filter").unwrap();
        assert_eq!(entries(&mut app), [entry("", 0), entry("?f=1", 0)]);
        app.browser().back().unwrap();
        app.wait_for("text:heard: Back https://a.test/app/")
            .unwrap();
        app.browser().forward().unwrap();
        app.wait_for("text:heard: Back https://a.test/app/ | Forward https://a.test/app/?f=1")
            .unwrap();
        assert_eq!(app.browser().url(), Some("https://a.test/app/?f=1"));
    }

    #[test]
    fn a_dialog_is_an_entry_and_the_apps_own_moves_are_quiet() {
        let mut app = open_mail();
        app.press("message").unwrap();
        app.press("reply").unwrap();
        app.wait_for("text:Settings").unwrap();
        assert_eq!(
            entries(&mut app),
            [entry("", 0), entry("?m=1", 1), entry("?m=1", 2)]
        );
        // The browser's back closes the dialog, the page under it stays.
        app.browser().back().unwrap();
        app.wait_for_gone("text:Settings", std::time::Duration::from_secs(2))
            .unwrap();
        assert!(app.shows("message 1"));
        assert_eq!(app.browser().index(), Some(1));

        // The app's own back goes back over the page's entry, and its own
        // close over the dialog's: the app hears no change.
        app.back().unwrap();
        app.wait_for("settings").unwrap();
        app.press("settings").unwrap();
        app.wait_for("text:Settings").unwrap();
        assert_eq!(entries(&mut app), [entry("", 0), entry("", 1)]);
        app.press("done").unwrap();
        app.wait_for_gone("text:Settings", std::time::Duration::from_secs(2))
            .unwrap();
        assert_eq!(app.browser().index(), Some(0));
        assert_eq!(app.browser().url(), Some(PAGE));
        // Nothing moved the address that the app did not move.
        assert!(app.screen().texts().contains(&"heard: "));
    }

    #[test]
    fn a_typed_fragment_is_an_address_change_and_the_apps_pops_go_back_over_it() {
        let mut app = open_mail();
        app.press("message").unwrap();
        app.browser().type_address("#inbox").unwrap();
        app.wait_for("text:heard: Address https://a.test/app/?m=1#inbox")
            .unwrap();
        // The app showed the inbox: back over the typed entry and the
        // page's, to the first, which takes the address the app set.
        assert!(!app.shows("message 1"));
        assert_eq!(app.browser().index(), Some(0));
        assert_eq!(app.browser().url(), Some("https://a.test/app/?m=1#inbox"));
        assert_eq!(entries(&mut app)[0], entry("?m=1#inbox", 0));

        // Another address of the page's loads it again.
        assert!(app.browser().type_address("/other").is_err());
        assert!(app.browser().type_address("https://b.test/").is_err());
    }

    #[test]
    fn the_first_entry_is_where_going_back_leaves_the_page() {
        let mut app = open_mail();
        assert!(app.browser().back().is_err());
        assert!(app.browser().forward().is_err());

        let mut app = Headless::start(EngineConfig::new(Root::of::<Mail>())).unwrap();
        app.first_render().unwrap();
        assert!(app.browser().entries().is_empty());
        assert!(app.browser().back().is_err());
    }
}
