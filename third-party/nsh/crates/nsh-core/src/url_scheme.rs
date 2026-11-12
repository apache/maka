//! Links that open the app (`nsh`'s `UrlScheme`): URLs of the schemes the
//! app claims (`nsh.json` `"schemes": [...]`), which the
//! system hands the app when the user opens one — at launch or while it
//! runs.
//!
//! The packages tell the system which schemes the app claims; the app's
//! runner gives the core the same list ([`Core::set_url_schemes`],
//! from the app's own resources, never from its code). The platform reports
//! every URL the system hands it as the root's
//! [`EventKind::UrlScheme`](crate::EventKind::UrlScheme); the core keeps only
//! those [`check_url`] accepts and holds them until the app listens
//! ([`crate::element::next_url_scheme_open`]), at most [`MAX_PENDING`]. Nothing
//! navigates on its own: what a link opens is the app's.
//!
//! The core also keeps the app's address ([`AppUrlCell`]); the platform
//! reports moves of it the app did not make (the web's back and forward,
//! [`CHANGE`]) as [`AppUrlChange`]s
//! ([`crate::element::next_app_url_change`]).
//!
//! [`Core::set_url_schemes`]: crate::Core::set_url_schemes

/// The longest URL taken, in bytes (as [`crate::open_url::MAX_URL_LEN`]).
pub const MAX_URL_LEN: usize = crate::open_url::MAX_URL_LEN;

/// The most links kept while no listener takes them: past it the oldest
/// goes.
pub const MAX_PENDING: usize = 16;

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme):
/// the URL.
pub const URL: &str = "url";

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme)
/// marking the address of the page the app is (the web): an `http(s)` URL
/// of the page's own, which needs no scheme the app claims. Only the
/// platform sends root events.
pub(crate) const PAGE: &str = "page";

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme)
/// that, `true`, only takes the URL as the app's address (the page's
/// address at start), with no `open` event.
pub(crate) const QUIET: &str = "quiet";

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme)
/// with the page's base URL (the web: its `document.baseURI`).
pub(crate) const BASE: &str = "base";

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme)
/// that makes the URL an address the app moved to without making the move
/// itself, and says how ([`AppUrlChangeReason::parse`]: the web's back or
/// forward to an entry, or an address the user typed): the app hears it as
/// a change ([`crate::element::next_app_url_change`]), not as `open`.
pub(crate) const CHANGE: &str = "change";

/// How the app's address it sets meets the history (TS: `UrlScheme.setUrl`'s
/// `history`, Rust: [`set_app_url_with`](crate::element::set_app_url_with)):
/// only the web has one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum HistoryBehavior {
    /// The current entry's address (`history.replaceState`).
    #[default]
    Replace,
    /// An entry of its own after the current one (`history.pushState`),
    /// with the app's pages as they are, so the browser's back goes back to
    /// the address before it. An entry the same turn pushes for a page
    /// takes the address instead, and the address shown makes none.
    Push,
}

/// An address the app moved to without making the move itself (TS:
/// `UrlScheme.on("change", ...)`, Rust:
/// [`next_app_url_change`](crate::element::next_app_url_change)): on the
/// web, the browser's back or forward to an entry the app's pages do not
/// account for, or an address the user typed. The app shows what it names.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct AppUrlChange {
    /// The address now, as [`app_url`](crate::element::app_url) reads it.
    pub url: String,
    /// What moved it.
    pub reason: AppUrlChangeReason,
}

/// What moved the app's address ([`AppUrlChange`]).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
#[non_exhaustive]
pub enum AppUrlChangeReason {
    /// The browser's back (or a step back from its menu).
    #[default]
    Back,
    /// The browser's forward.
    Forward,
    /// The user gave the page an address of the app's (a `#fragment`
    /// typed in the address bar): a new entry after the current one.
    Address,
}

impl AppUrlChangeReason {
    /// The reason called `name` in [`CHANGE`] and in TS (`"back"`,
    /// `"forward"`, `"address"`); `None` for another.
    pub(crate) fn parse(name: &str) -> Option<Self> {
        match name {
            "back" => Some(Self::Back),
            "forward" => Some(Self::Forward),
            "address" => Some(Self::Address),
            _ => None,
        }
    }
}

/// The app's address, kept once: the core writes it (links, the page's
/// address, Rust's `set_app_url`) and every VM's `System` reads it
/// (`UrlScheme.url()`), on the engine's thread. `UrlScheme.setUrl` writes
/// it too, at once, so `url()` reads it back.
#[doc(hidden)]
#[derive(Debug, Clone, Default)]
pub struct AppUrlCell(std::rc::Rc<std::cell::RefCell<AppUrlState>>);

#[derive(Debug, Default)]
struct AppUrlState {
    address: Option<String>,
    /// What the page's relative URLs resolve against (the web: its
    /// `document.baseURI`), which Rust's `set_app_url` resolves with.
    page_base: Option<url::Url>,
}

impl AppUrlCell {
    /// The address; `None` when there is none.
    pub fn get(&self) -> Option<String> {
        self.0.borrow().address.clone()
    }

    /// Makes `url` the address.
    pub(crate) fn set(&self, url: String) {
        self.0.borrow_mut().address = Some(url);
    }

    /// The page's base URL (the web), once the page told it.
    pub(crate) fn page_base(&self) -> Option<url::Url> {
        self.0.borrow().page_base.clone()
    }

    pub(crate) fn set_page_base(&self, base: url::Url) {
        self.0.borrow_mut().page_base = Some(base);
    }
}

/// `url`, an address Rust's `set_app_url` sets on the web, resolved against
/// the page's base as `history.replaceState` resolves it, of the page's
/// origin (TS's `setUrl` applies the same rules, `browser/address.js`).
pub(crate) fn resolve_on_page(url: &str, base: &url::Url) -> Result<String, String> {
    let resolved = base.join(url).map_err(|e| format!("not a URL: {e}"))?;
    if resolved.origin() != base.origin() {
        return Err(format!("{resolved} is not of the page's origin"));
    }
    Ok(resolved.into())
}

/// Schemes an app may not claim: the web's, files', other apps' and those
/// that run code or reach the app's own data.
const RESERVED_SCHEMES: &[&str] = &[
    "http",
    "https",
    "ws",
    "wss",
    "file",
    "ftp",
    "mailto",
    "tel",
    "sms",
    "javascript",
    "vbscript",
    "data",
    "blob",
    "about",
    "asset",
    "content",
    "intent",
    "nsh",
];

/// Checks a scheme an app claims, as `nsh.json` writes it: a URL scheme
/// (a letter, then letters, digits, `+`, `-` or `.`; RFC 3986) and none
/// of the reserved ones (`http`, `https`, `file`, `mailto`, `tel`, ...).
/// Upper case is accepted ([`schemes_from_json`] lowers it). The error
/// says what is wrong.
pub fn check_scheme(scheme: &str) -> Result<(), String> {
    let mut chars = scheme.chars();
    let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
    if !valid {
        return Err(format!(
            "`{scheme}` is not a URL scheme: a letter, then letters, digits, `+`, `-` or `.`"
        ));
    }
    let lower = scheme.to_ascii_lowercase();
    if RESERVED_SCHEMES.contains(&lower.as_str()) {
        return Err(format!(
            "`{scheme}:` belongs to the system or to other apps: claim a scheme of the app's own"
        ));
    }
    Ok(())
}

/// The schemes of `nsh.json`'s `"schemes"` (`["myapp"]`), checked
/// ([`check_scheme`]), in lower case, each once. What it cannot claim (a
/// scheme of the system or of other apps, a value of a form it does not
/// know, a newer NSH's) is left out: an app claims less, never more.
pub fn schemes_from_json(value: &crate::JsonValue) -> Vec<String> {
    schemes_from_json_lenient(value).0
}

/// [`schemes_from_json`], with what it left out, which the toolchain warns
/// of (a newer NSH's, or a typo).
pub fn schemes_from_json_lenient(value: &crate::JsonValue) -> (Vec<String>, Vec<String>) {
    let mut ignored = Vec::new();
    let Some(list) = value.as_array() else {
        ignored.push(format!(
            "schemes: {value} is not an array of URL schemes (`[\"myapp\"]`)"
        ));
        return (Vec::new(), ignored);
    };
    let mut schemes = Vec::with_capacity(list.len());
    for scheme in list {
        let Some(scheme) = scheme.as_str() else {
            ignored.push(format!("schemes: {scheme} is not a string"));
            continue;
        };
        if let Err(e) = check_scheme(scheme) {
            ignored.push(format!("schemes: {e}"));
            continue;
        }
        let scheme = scheme.to_ascii_lowercase();
        if schemes.contains(&scheme) {
            ignored.push(format!("schemes: `{scheme}` is listed twice"));
            continue;
        }
        schemes.push(scheme);
    }
    (schemes, ignored)
}

/// Checks a URL the system handed the app: at most [`MAX_URL_LEN`] bytes,
/// no whitespace or control characters, absolute, and of one of `schemes`
/// (lower case, as [`schemes_from_json`] gives them). The error says why
/// it is dropped.
pub fn check_url(url: &str, schemes: &[String]) -> Result<(), String> {
    if url.len() > MAX_URL_LEN {
        return Err(format!(
            "a link has at most {MAX_URL_LEN} bytes (this one has {})",
            url.len()
        ));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("a link has no whitespace or control characters".into());
    }
    let parsed = url::Url::parse(url).map_err(|e| format!("a link is not a URL: {e}"))?;
    // `Url` lowers the scheme.
    if !schemes.iter().any(|s| s == parsed.scheme()) {
        return Err(format!(
            "`{}:` is not a scheme the app claims (nsh.json `schemes`)",
            parsed.scheme()
        ));
    }
    Ok(())
}

/// Checks an address the app sets (`UrlScheme.setUrl`, which may be
/// relative): at most [`MAX_URL_LEN`] bytes, no whitespace or control
/// characters.
pub(crate) fn check_address(url: &str) -> Result<(), String> {
    if url.len() > MAX_URL_LEN {
        return Err(format!(
            "an address has at most {MAX_URL_LEN} bytes (this one has {})",
            url.len()
        ));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("an address has no whitespace or control characters".into());
    }
    Ok(())
}

/// Checks the address of the page the app is (the web, [`PAGE`]): an
/// `http(s)` URL that passes [`check_address`].
pub(crate) fn check_page_url(url: &str) -> Result<(), String> {
    check_address(url)?;
    let parsed = url::Url::parse(url).map_err(|e| format!("a page's address is not a URL: {e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(format!(
            "a page's address is http(s), not `{}:`",
            parsed.scheme()
        ));
    }
    Ok(())
}

/// Whether `url` is of the origin of `page`, the page's address (the web):
/// true while the page has none, or one that is not a URL.
pub(crate) fn same_origin(page: Option<&str>, url: &str) -> bool {
    let Some(page) = page.and_then(|p| url::Url::parse(p).ok()) else {
        return true;
    };
    url::Url::parse(url).is_ok_and(|u| u.origin() == page.origin())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rusts_address_resolves_against_the_page_and_keeps_its_origin() {
        let base = url::Url::parse("https://a.test/app/?m=1").unwrap();
        assert_eq!(
            resolve_on_page("?message=42", &base).as_deref(),
            Ok("https://a.test/app/?message=42")
        );
        assert_eq!(
            resolve_on_page("/inbox", &base).as_deref(),
            Ok("https://a.test/inbox")
        );
        assert!(resolve_on_page("https://b.test/x", &base).is_err());
    }

    #[test]
    fn an_address_on_the_web_keeps_the_pages_origin() {
        let page = Some("https://a.test/app/?m=1");
        assert!(same_origin(page, "https://a.test/other"));
        assert!(!same_origin(page, "https://b.test/app/"));
        assert!(!same_origin(page, "/relative"));
        assert!(same_origin(None, "anything"));
    }

    #[test]
    fn an_address_change_names_its_reason_as_ts_does() {
        for (name, reason) in [
            ("back", AppUrlChangeReason::Back),
            ("forward", AppUrlChangeReason::Forward),
            ("address", AppUrlChangeReason::Address),
        ] {
            assert_eq!(AppUrlChangeReason::parse(name), Some(reason));
        }
        assert_eq!(AppUrlChangeReason::parse("open"), None);
        assert_eq!(AppUrlChangeReason::parse("Back"), None);
        assert_eq!(AppUrlChange::default().reason, AppUrlChangeReason::Back);
    }

    #[test]
    fn an_address_replaces_the_history_entrys_unless_it_asks_to_push() {
        assert_eq!(HistoryBehavior::default(), HistoryBehavior::Replace);
    }

    #[test]
    fn an_address_has_no_spaces_and_a_bounded_length() {
        assert!(check_address("?message=a").is_ok());
        assert!(check_address("https://example.com/a").is_ok());
        assert!(check_address("a b").is_err());
        assert!(check_address("a\nb").is_err());
        assert!(check_address(&"a".repeat(MAX_URL_LEN + 1)).is_err());
    }

    #[test]
    fn a_pages_address_is_an_http_url() {
        assert!(check_page_url("https://example.com/debugger/logs/3?tab=a#x").is_ok());
        assert!(check_page_url("http://127.0.0.1:8790/").is_ok());
        for wrong in [
            "myapp://orders/42",
            "javascript:alert(1)",
            "/debugger",
            "about:blank",
        ] {
            assert!(check_page_url(wrong).is_err(), "{wrong}");
        }
        assert!(check_page_url(&format!("https://a.test/{}", "x".repeat(MAX_URL_LEN))).is_err());
    }

    fn schemes(json: &str) -> Result<Vec<String>, Vec<String>> {
        match schemes_from_json_lenient(&serde_json::from_str(json).unwrap()) {
            (schemes, ignored) if ignored.is_empty() => Ok(schemes),
            (_, ignored) => Err(ignored),
        }
    }

    #[test]
    fn app_schemes_are_claimed_in_lower_case() {
        assert_eq!(
            schemes(r#"["myapp", "My-App.2+x"]"#),
            Ok(vec!["myapp".to_owned(), "my-app.2+x".to_owned()])
        );
        assert_eq!(schemes("[]"), Ok(Vec::new()));
    }

    #[test]
    fn other_schemes_are_refused() {
        for json in [
            r#"{}"#,
            r#"{ "schemes": ["myapp"] }"#,
            r#""myapp""#,
            r#"[1]"#,
            r#"[""]"#,
            r#"["1app"]"#,
            r#"["my app"]"#,
            r#"["myapp:"]"#,
            r#"["https"]"#,
            r#"["HTTP"]"#,
            r#"["mailto"]"#,
            r#"["javascript"]"#,
            r#"["file"]"#,
            r#"["myapp", "MyApp"]"#,
        ] {
            assert!(schemes(json).is_err(), "{json}");
        }
        // Left out alone: the others are claimed.
        assert_eq!(
            schemes_from_json(&serde_json::json!(["https", "MyApp", 1, "myapp"])),
            ["myapp"]
        );
    }

    #[test]
    fn links_of_claimed_schemes_are_taken() {
        let claimed = vec!["myapp".to_owned()];
        for url in [
            "myapp://open/item/42?ref=mail#top",
            "MyApp://open",
            "myapp:item/42",
        ] {
            assert_eq!(check_url(url, &claimed), Ok(()), "{url}");
        }
    }

    #[test]
    fn other_links_are_dropped() {
        let claimed = vec!["myapp".to_owned()];
        for url in [
            "",
            "myapp",
            "/item/42",
            "other://item/42",
            "https://example.com",
            "myapp://item/4 2",
            "myapp://item/42\n",
        ] {
            assert!(check_url(url, &claimed).is_err(), "{url}");
        }
        assert!(check_url("myapp://x", &[]).is_err());
        let long = format!("myapp://{}", "a".repeat(MAX_URL_LEN));
        assert!(check_url(&long, &claimed).is_err());
    }
}
