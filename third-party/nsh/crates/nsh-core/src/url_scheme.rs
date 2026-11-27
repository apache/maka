//! Links that open the app (`nsh`'s `UrlScheme`): URLs of the schemes the
//! app claims (`nsh.json` `"schemes": [...]`), and `https` URLs of its web
//! links (`"links": [{ "host": "example.com", "paths": ["/orders/*"] }]`:
//! Universal Links on iOS and macOS, App Links on Android), which the
//! system hands the app when the user opens one — at launch or while it
//! runs.
//!
//! The packages tell the system which schemes and web links the app
//! claims; the app's runner gives the core the same ([`AppLinks`],
//! [`Core::set_app_links`], from the app's own resources, never from its
//! code). The platform reports every URL the system hands it as the root's
//! [`EventKind::UrlScheme`](crate::EventKind::UrlScheme); the core keeps only
//! those [`AppLinks::check`] accepts, so the app hears what the system was
//! told and no more (a link another app sends to Android's activity
//! directly is checked too), and holds them until the app listens
//! ([`crate::element::next_url_scheme_open`]), at most [`MAX_PENDING`]. A
//! module waiting for a link of one scheme
//! ([`crate::element::next_url_scheme_open_for`]) takes those alone while
//! it waits. Nothing navigates on its own: what a link opens is the app's.
//!
//! The core also keeps the app's address ([`AppUrlCell`]); the platform
//! reports moves of it the app did not make (the web's back and forward,
//! [`CHANGE`]) as [`AppUrlChange`]s
//! ([`crate::element::next_app_url_change`]).
//!
//! [`Core::set_app_links`]: crate::Core::set_app_links

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
pub const PAGE: &str = "page";

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme)
/// that, `true`, only takes the URL as the app's address (the page's
/// address at start), with no `open` event.
pub const QUIET: &str = "quiet";

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme)
/// with the page's base URL (the web: its `document.baseURI`).
pub const BASE: &str = "base";

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme)
/// that makes the URL an address the app moved to without making the move
/// itself, and says how (`"back"`, `"forward"`: the web's back or forward
/// to an entry; `"address"`: an address the user typed): the app hears it as
/// a change ([`crate::element::next_app_url_change`]), not as `open`.
pub const CHANGE: &str = "change";

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

/// The longest host name, in bytes (DNS's).
const MAX_HOST_LEN: usize = 253;

/// A web host whose `https` links open the app (`nsh.json` `"links"`:
/// Universal Links on iOS and macOS, App Links on Android), and which of
/// its paths do.
///
/// The host is a domain name (`example.com`), or `*.` and one for its
/// subdomains (`*.example.com`, which does not cover `example.com` itself),
/// in lower case ASCII (an internationalized name in its `xn--` form). The
/// paths are absolute (`/orders/42`), each either a whole path or, ending
/// in `*`, the start of one (`/orders/*`); none means every path of the
/// host. A path matches the URL's path after percent-decoding, with its
/// case, as Android and Apple's associated domains compare them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebLink {
    host: String,
    paths: Vec<String>,
}

impl WebLink {
    /// A web link of `host` (every path) or of `paths` of it, checked
    /// ([`check_link_host`], [`check_link_path`]); `host` is lowered and
    /// an internationalized name put in its `xn--` form. The error says
    /// what is wrong.
    pub fn new(
        host: &str,
        paths: impl IntoIterator<Item = impl Into<String>>,
    ) -> Result<Self, String> {
        let host = check_link_host(host)?;
        let mut checked: Vec<String> = Vec::new();
        for path in paths {
            let path = path.into();
            check_link_path(&path)?;
            if checked.contains(&path) {
                return Err(format!("`{path}` is listed twice"));
            }
            checked.push(path);
        }
        Ok(Self {
            host,
            paths: checked,
        })
    }

    /// The host (`example.com`, `*.example.com`), as checked.
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The paths (`/orders/*`); empty: every path of the host.
    pub fn paths(&self) -> &[String] {
        &self.paths
    }

    /// Whether `host` (a URL's, which `url` lowers) is this link's: its
    /// host, or under it for `*.`.
    fn has_host(&self, host: &str) -> bool {
        match self.host.strip_prefix("*.") {
            Some(parent) => host
                .strip_suffix(parent)
                .is_some_and(|sub| sub.len() > 1 && sub.ends_with('.')),
            None => self.host == host,
        }
    }

    /// Whether `path`, a URL's path percent-decoded, is one of this
    /// link's.
    fn has_path(&self, path: &[u8]) -> bool {
        self.paths.is_empty()
            || self.paths.iter().any(|p| match p.strip_suffix('*') {
                Some(start) => path.starts_with(start.as_bytes()),
                None => path == p.as_bytes(),
            })
    }

    /// As `nsh.json` and `app.json` write it: `{"host": ..., "paths": [...]}`,
    /// without `paths` for every path.
    pub fn to_json(&self) -> crate::JsonValue {
        let mut link = serde_json::Map::new();
        link.insert("host".into(), self.host.clone().into());
        if !self.paths.is_empty() {
            link.insert("paths".into(), self.paths.clone().into());
        }
        link.into()
    }
}

/// Checks the host of a web link (`nsh.json` `"links"`' `"host"`): a domain
/// name of at least two labels (`example.com`), or `*.` and one
/// (`*.example.com`: its subdomains), with no scheme, port, path or IP
/// address. Gives it lowered, an internationalized name in its `xn--` form
/// (`bücher.example` is `xn--bcher-kva.example`). The error says what is
/// wrong.
pub fn check_link_host(host: &str) -> Result<String, String> {
    let wrong = || {
        format!(
            "`{host}` is not a host name: a domain such as `example.com`, or `*.example.com` for its subdomains, with no scheme, port, path or IP address"
        )
    };
    let (wildcard, name) = match host.strip_prefix("*.") {
        Some(name) => (true, name),
        None => (false, host),
    };
    // What `Host::parse` would take but is no host name of a link's: a
    // scheme, port, path, user, another wildcard or a trailing dot.
    if name.is_empty()
        || name.ends_with('.')
        || name
            .chars()
            .any(|c| c.is_whitespace() || c.is_control() || "/:?#@[]\\*%".contains(c))
    {
        return Err(wrong());
    }
    let ascii = match url::Host::parse(name) {
        Ok(url::Host::Domain(ascii)) => ascii,
        Ok(_) => {
            return Err(format!(
                "`{host}` is an IP address: a link opens the app from a domain name, which the system verifies"
            ));
        }
        Err(_) => return Err(wrong()),
    };
    let label = |label: &str| {
        (1..=63).contains(&label.len())
            && label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            && !label.starts_with('-')
            && !label.ends_with('-')
    };
    let labels: Vec<&str> = ascii.split('.').collect();
    // A top-level label has a letter (no IP address in another form).
    let top = labels
        .last()
        .is_some_and(|l| l.chars().any(|c| c.is_ascii_alphabetic()));
    if ascii.len() > MAX_HOST_LEN || labels.len() < 2 || !labels.iter().all(|l| label(l)) || !top {
        return Err(wrong());
    }
    Ok(if wildcard {
        format!("*.{ascii}")
    } else {
        ascii
    })
}

/// Checks a path of a web link (`nsh.json` `"links"`' `"paths"`): absolute
/// (`/orders/42`), with `*` only at its end (`/orders/*`: the paths that
/// start so), and no query, fragment, percent-escape, backslash,
/// whitespace or control character (a path is compared decoded). The
/// error says what is wrong.
pub fn check_link_path(path: &str) -> Result<(), String> {
    if !path.starts_with('/') {
        return Err(format!("`{path}` is not a path: it starts with `/`"));
    }
    if path.len() > MAX_URL_LEN {
        return Err(format!("a path has at most {MAX_URL_LEN} bytes"));
    }
    if path.trim_end_matches('*').contains('*') || path.ends_with("**") {
        return Err(format!(
            "`{path}`: `*` comes only at the end of a path (`/orders/*`)"
        ));
    }
    if path
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || "?#%\\".contains(c))
    {
        return Err(format!(
            "`{path}` is not a path: no query, fragment, `%`-escape, backslash or whitespace (write it decoded)"
        ));
    }
    Ok(())
}

/// The links that open an app: URLs of the schemes it claims (`nsh.json`
/// `"schemes"`) and `https` URLs of its web links (`"links"`, [`WebLink`]).
/// The one value the toolchain, the runners and the core pass along, read
/// from the app's own resources, never from its code; the packages tell the
/// system the same ([`AppLinks::check`] keeps what they claim).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AppLinks {
    schemes: Vec<String>,
    web: Vec<WebLink>,
}

impl AppLinks {
    /// The links of `config`, an `nsh.json` or `app.json` object (its
    /// `"schemes"` and `"links"`), checked. What it cannot claim (a value
    /// of a form it does not know, a newer NSH's) is left out: an app
    /// claims less, never more.
    pub fn from_json(config: &crate::JsonValue) -> Self {
        Self::from_json_lenient(config).0
    }

    /// [`AppLinks::from_json`], with what it left out, which the toolchain
    /// warns of (a newer NSH's, or a typo).
    pub fn from_json_lenient(config: &crate::JsonValue) -> (Self, Vec<String>) {
        let mut links = Self::default();
        let mut ignored = Vec::new();
        if let Some(schemes) = config.get("schemes") {
            let (schemes, left_out) = schemes_from_json_lenient(schemes);
            links.schemes = schemes;
            ignored.extend(left_out);
        }
        if let Some(web) = config.get("links") {
            let (web, left_out) = web_links_from_json_lenient(web);
            links.web = web;
            ignored.extend(left_out);
        }
        (links, ignored)
    }

    /// `schemes` and `web` as they are, already checked (lower case
    /// schemes, as [`schemes_from_json`] gives them).
    pub fn new(schemes: Vec<String>, web: Vec<WebLink>) -> Self {
        Self { schemes, web }
    }

    /// The URL schemes (lower case).
    pub fn schemes(&self) -> &[String] {
        &self.schemes
    }

    /// Replaces the URL schemes (lowered).
    pub fn set_schemes(&mut self, schemes: impl IntoIterator<Item = impl Into<String>>) {
        self.schemes = schemes
            .into_iter()
            .map(|s| s.into().to_ascii_lowercase())
            .collect();
    }

    /// The web links.
    pub fn web(&self) -> &[WebLink] {
        &self.web
    }

    /// No scheme and no web link.
    pub fn is_empty(&self) -> bool {
        self.schemes.is_empty() && self.web.is_empty()
    }

    /// As `nsh.json` and `app.json` write them: `{"schemes": [...],
    /// "links": [...]}`, each only when there is one.
    pub fn to_json(&self) -> crate::JsonValue {
        let mut config = serde_json::Map::new();
        self.add_to_json(&mut config);
        config.into()
    }

    /// Adds [`AppLinks::to_json`]'s keys to `config` (an `app.json`
    /// object), replacing its own.
    pub fn add_to_json(&self, config: &mut serde_json::Map<String, crate::JsonValue>) {
        config.remove("schemes");
        config.remove("links");
        if !self.schemes.is_empty() {
            config.insert("schemes".into(), self.schemes.clone().into());
        }
        if !self.web.is_empty() {
            config.insert(
                "links".into(),
                self.web.iter().map(WebLink::to_json).collect(),
            );
        }
    }

    /// Checks a URL the system handed the app ([`check_url`]): of one of
    /// the schemes, or `https` with a host and path of one of the web links
    /// (no port and no user). The error says why it is dropped.
    pub fn check(&self, url: &str) -> Result<(), String> {
        let parsed = parse_link(url)?;
        // `Url` lowers the scheme and a domain host.
        if parsed.scheme() == "https" && !self.web.is_empty() {
            return check_web_link(&parsed, &self.web);
        }
        check_scheme_of(&parsed, &self.schemes)
    }
}

impl serde::Serialize for AppLinks {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.to_json().serialize(serializer)
    }
}

/// The form NSH's own processes pass the links in (`nsh test`'s runner):
/// [`AppLinks::to_json`]'s. The web links are checked again as read; the
/// schemes are taken as written (lowered), as the toolchain gave them,
/// with those the core adds itself (`file:` for an app that opens files,
/// [`crate::file_type::FILE_SCHEME`]), which no `nsh.json` claims.
impl<'de> serde::Deserialize<'de> for AppLinks {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let config = crate::JsonValue::deserialize(deserializer)?;
        let mut links = Self::default();
        if let Some(web) = config.get("links") {
            links.web = web_links_from_json_lenient(web).0;
        }
        if let Some(schemes) = config.get("schemes").and_then(|s| s.as_array()) {
            links.set_schemes(schemes.iter().filter_map(|s| s.as_str()));
        }
        Ok(links)
    }
}

/// The web links of `nsh.json`'s `"links"` (`[{"host": "example.com",
/// "paths": ["/orders/*"]}]`), checked ([`WebLink::new`]), each host once,
/// with what it left out. An entry it cannot read whole is left out whole,
/// never in part: a key it does not know (a newer NSH's, which may narrow
/// the link) or a path it cannot take would leave it claiming more.
fn web_links_from_json_lenient(value: &crate::JsonValue) -> (Vec<WebLink>, Vec<String>) {
    let mut ignored = Vec::new();
    let Some(list) = value.as_array() else {
        ignored.push(format!(
            "links: {value} is not an array of links (`[{{ \"host\": \"example.com\" }}]`)"
        ));
        return (Vec::new(), ignored);
    };
    let mut links: Vec<WebLink> = Vec::with_capacity(list.len());
    for entry in list {
        let Some(fields) = entry.as_object() else {
            ignored.push(format!(
                "links: {entry} is not a link (`{{ \"host\": \"example.com\", \"paths\": [\"/orders/*\"] }}`)"
            ));
            continue;
        };
        if let Some(key) = fields
            .keys()
            .find(|k| !matches!(k.as_str(), "host" | "paths"))
        {
            ignored.push(format!(
                "links: {entry} has `{key}`, which this NSH does not know: the link is left out"
            ));
            continue;
        }
        let Some(host) = fields.get("host").and_then(|h| h.as_str()) else {
            ignored.push(format!("links: {entry} has no `host` string"));
            continue;
        };
        let paths: Vec<String> = match fields.get("paths") {
            None => Vec::new(),
            Some(crate::JsonValue::Array(paths)) if paths.is_empty() => {
                ignored.push(format!(
                    "links: `{host}` lists no paths: leave `paths` out for every path of it"
                ));
                continue;
            }
            Some(crate::JsonValue::Array(paths)) => {
                let Some(paths) = paths
                    .iter()
                    .map(|p| p.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
                else {
                    ignored.push(format!(
                        "links: `{host}`'s paths are not all strings: the link is left out"
                    ));
                    continue;
                };
                paths
            }
            Some(other) => {
                ignored.push(format!(
                    "links: `{host}`'s paths {other} are not an array of paths (`[\"/orders/*\"]`)"
                ));
                continue;
            }
        };
        let link = match WebLink::new(host, paths) {
            Ok(link) => link,
            Err(e) => {
                ignored.push(format!("links: {e}: the link is left out"));
                continue;
            }
        };
        if links.iter().any(|l| l.host == link.host) {
            ignored.push(format!(
                "links: `{}` is listed twice: list its paths in one entry",
                link.host
            ));
            continue;
        }
        links.push(link);
    }
    (links, ignored)
}

/// `url` parsed, if it is a link at all: at most [`MAX_URL_LEN`] bytes, no
/// whitespace or control characters, absolute.
fn parse_link(url: &str) -> Result<url::Url, String> {
    if url.len() > MAX_URL_LEN {
        return Err(format!(
            "a link has at most {MAX_URL_LEN} bytes (this one has {})",
            url.len()
        ));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("a link has no whitespace or control characters".into());
    }
    url::Url::parse(url).map_err(|e| format!("a link is not a URL: {e}"))
}

fn check_scheme_of(parsed: &url::Url, schemes: &[String]) -> Result<(), String> {
    if !schemes.iter().any(|s| s == parsed.scheme()) {
        return Err(format!(
            "`{}:` is not a scheme the app claims (nsh.json `schemes`)",
            parsed.scheme()
        ));
    }
    Ok(())
}

/// Checks an `https` link against `web`: no user or port (the systems
/// verify neither), a host and a path of one of them.
fn check_web_link(parsed: &url::Url, web: &[WebLink]) -> Result<(), String> {
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("a web link has no user name or password".into());
    }
    if parsed.port().is_some() {
        return Err("a web link has no port: the system opens only https on its own".into());
    }
    let host = parsed.host_str().unwrap_or_default();
    let of_host: Vec<&WebLink> = web.iter().filter(|l| l.has_host(host)).collect();
    if of_host.is_empty() {
        return Err(format!(
            "`{host}` is not a host the app claims (nsh.json `links`)"
        ));
    }
    let path: Vec<u8> = percent_encoding::percent_decode_str(parsed.path()).collect();
    if !of_host.iter().any(|l| l.has_path(&path)) {
        return Err(format!(
            "`{}` is not a path the app claims of `{host}` (nsh.json `links`)",
            parsed.path()
        ));
    }
    Ok(())
}

/// Checks a URL the system handed the app: at most [`MAX_URL_LEN`] bytes,
/// no whitespace or control characters, absolute, and of one of `schemes`
/// (lower case, as [`schemes_from_json`] gives them). The error says why
/// it is dropped.
pub fn check_url(url: &str, schemes: &[String]) -> Result<(), String> {
    // `Url` lowers the scheme.
    check_scheme_of(&parse_link(url)?, schemes)
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

    fn links(json: serde_json::Value) -> (AppLinks, Vec<String>) {
        AppLinks::from_json_lenient(&json)
    }

    #[test]
    fn link_hosts_are_domain_names_lowered_and_in_ascii() {
        for (host, checked) in [
            ("example.com", "example.com"),
            ("Shop.Example.COM", "shop.example.com"),
            ("*.example.com", "*.example.com"),
            ("*.Example.com", "*.example.com"),
            ("bücher.example", "xn--bcher-kva.example"),
            ("xn--bcher-kva.example", "xn--bcher-kva.example"),
            ("a-b.co", "a-b.co"),
        ] {
            assert_eq!(check_link_host(host).as_deref(), Ok(checked), "{host}");
        }
        for host in [
            "",
            "*.",
            "example",
            "localhost",
            "*.com",
            "https://example.com",
            "example.com/path",
            "example.com:8443",
            "user@example.com",
            "*example.com",
            "a.*.example.com",
            "**.example.com",
            "-a.example.com",
            "a-.example.com",
            "a..example.com",
            "a_b.example.com",
            "example.com.",
            "exa mple.com",
            "exa%6dple.com",
            "192.0.2.1",
            "[::1]",
            "0x7f.1",
        ] {
            assert!(check_link_host(host).is_err(), "{host}");
        }
        // Valid labels, but longer than DNS takes.
        let long = format!("{}com", "a.".repeat(MAX_HOST_LEN / 2));
        assert!(long.len() > MAX_HOST_LEN);
        assert!(check_link_host(&long).is_err());
        assert!(check_link_host(&long[long.len() - MAX_HOST_LEN..]).is_ok());
    }

    #[test]
    fn link_paths_are_absolute_and_end_their_wildcard() {
        for path in [
            "/",
            "/*",
            "/orders/*",
            "/orders/42",
            "/a:b@c!$&'()+,;=",
            "/café/*",
        ] {
            assert_eq!(check_link_path(path), Ok(()), "{path}");
        }
        for path in [
            "",
            "*",
            "orders/*",
            "/orders/*/edit",
            "/orders/**",
            "/*/x",
            "/orders?id=1",
            "/orders#top",
            "/caf%C3%A9",
            "/a b",
            "/a\\b",
            "/a\n",
        ] {
            assert!(check_link_path(path).is_err(), "{path}");
        }
        assert!(check_link_path(&format!("/{}", "a".repeat(MAX_URL_LEN))).is_err());
    }

    #[test]
    fn an_apps_links_read_its_schemes_and_web_links() {
        let (read, ignored) = links(serde_json::json!({
            "schemes": ["MyApp"],
            "links": [
                { "host": "Example.com", "paths": ["/orders/*", "/about"] },
                { "host": "*.example.com" }
            ],
            "other": true
        }));
        assert!(ignored.is_empty(), "{ignored:?}");
        assert_eq!(read.schemes(), ["myapp"]);
        assert_eq!(read.web().len(), 2);
        assert_eq!(read.web()[0].host(), "example.com");
        assert_eq!(read.web()[0].paths(), ["/orders/*", "/about"]);
        assert_eq!(read.web()[1].host(), "*.example.com");
        assert!(read.web()[1].paths().is_empty());
        // Written back as read, and read again the same.
        assert_eq!(
            read.to_json(),
            serde_json::json!({
                "schemes": ["myapp"],
                "links": [
                    { "host": "example.com", "paths": ["/orders/*", "/about"] },
                    { "host": "*.example.com" }
                ]
            })
        );
        assert_eq!(AppLinks::from_json(&read.to_json()), read);
        let wire = serde_json::to_string(&read).unwrap();
        assert_eq!(serde_json::from_str::<AppLinks>(&wire).unwrap(), read);
        // The core's own `file:` passes between NSH's processes, which no
        // nsh.json claims.
        let mut files = read.clone();
        files.set_schemes(["myapp", crate::file_type::FILE_SCHEME]);
        assert!(AppLinks::from_json(&files.to_json()).schemes() == ["myapp"]);
        let wire = serde_json::to_string(&files).unwrap();
        assert_eq!(serde_json::from_str::<AppLinks>(&wire).unwrap(), files);
        // None: nothing written.
        assert_eq!(AppLinks::default().to_json(), serde_json::json!({}));
        assert!(AppLinks::from_json(&serde_json::json!({})).is_empty());
    }

    #[test]
    fn a_link_it_cannot_read_whole_is_left_out_whole() {
        let (read, ignored) = links(serde_json::json!({
            "links": [
                { "host": "ok.example" },
                "example.com",
                { "paths": ["/x"] },
                { "host": 7 },
                { "host": "new.example", "exclude": ["/admin/*"] },
                { "host": "empty.example", "paths": [] },
                { "host": "mixed.example", "paths": ["/fine", "bad"] },
                { "host": "typed.example", "paths": ["/fine", 3] },
                { "host": "shape.example", "paths": "/fine" },
                { "host": "dup.example", "paths": ["/a", "/a"] },
                { "host": "192.0.2.1" },
                { "host": "OK.example", "paths": ["/again"] }
            ]
        }));
        assert_eq!(read.web().len(), 1, "{read:?}");
        assert_eq!(read.web()[0].host(), "ok.example");
        assert!(read.web()[0].paths().is_empty());
        assert_eq!(ignored.len(), 11, "{ignored:#?}");
        // Not an array: none.
        let (read, ignored) = links(serde_json::json!({ "links": { "host": "example.com" } }));
        assert!(read.web().is_empty());
        assert_eq!(ignored.len(), 1);
    }

    #[test]
    fn web_links_of_claimed_hosts_and_paths_are_taken() {
        let (claimed, _) = links(serde_json::json!({
            "schemes": ["myapp"],
            "links": [
                { "host": "example.com", "paths": ["/orders/*", "/about"] },
                { "host": "*.shop.example" },
                { "host": "café.example", "paths": ["/menü/*"] }
            ]
        }));
        for url in [
            "https://example.com/orders/7?ref=mail#top",
            "https://example.com/orders/",
            "https://EXAMPLE.com/about",
            "https://example.com:443/about",
            "https://eu.shop.example/cart",
            "https://a.b.shop.example/",
            "https://eu.shop.example",
            "https://xn--caf-dma.example/men%C3%BC/1",
            "https://café.example/menü/1",
            "myapp://open",
        ] {
            assert_eq!(claimed.check(url), Ok(()), "{url}");
        }
        for url in [
            // Only `https`: Universal Links and verified App Links are.
            "http://example.com/orders/7",
            // Paths are whole or the start of one, with their case.
            "https://example.com/",
            "https://example.com",
            "https://example.com/orders",
            "https://example.com/Orders/7",
            "https://example.com/about/team",
            "https://example.com/blog",
            // `..` is resolved before the path is compared.
            "https://example.com/orders/../admin",
            "https://example.com/orders/%2E%2E/admin",
            // Hosts are whole, `*.` only for subdomains.
            "https://www.example.com/orders/7",
            "https://example.com.evil.test/orders/7",
            "https://evilexample.com/orders/7",
            "https://shop.example/",
            "https://evilshop.example/",
            "https://192.0.2.1/",
            // No port or user: the systems open neither.
            "https://example.com:8443/orders/7",
            "https://user@example.com/orders/7",
            "https://user:pw@example.com/orders/7",
            "other://example.com",
            "https://example.com/orders/7 x",
        ] {
            assert!(claimed.check(url).is_err(), "{url}");
        }
        // Without web links, as before: no web link opens the app.
        let schemes_only = AppLinks::new(vec!["myapp".into()], Vec::new());
        assert!(schemes_only.check("https://example.com/").is_err());
        assert_eq!(schemes_only.check("myapp://x"), Ok(()));
        assert!(check_url("https://example.com/", &["myapp".to_owned()]).is_err());
    }
}
