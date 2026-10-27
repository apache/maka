//! Tiptap's `Link` behavior beyond the mark (the mark is the starter's
//! `link`): autolinking typed URLs ([`link`]'s `autolink` plugin), linking a
//! selection a URL is pasted over (`handlePasteLink`), linking the URLs of
//! pasted text, opening a link on a press (`handleClickLink`), and the URI
//! checks every way in shares ([`is_allowed_uri`], [`should_auto_link`]).
//! Ported from `@tiptap/extension-link`; URLs are found by [`find_links`],
//! a small linkify-style detector.
//!
//! Each piece is a kernel plugin made from [`LinkOptions`], so the
//! extension system can wrap them as one extension.

use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde_json::{Value, json};

use crate::rich_editor::{
    commands::{BoxCommand, command, tiptap},
    extensions::history::is_history_transaction,
    model::{Attrs, Fragment, MarkType, Node, Slice, utf16_len},
    state::{
        ClickEvent, EditorState, Plugin, PluginKey, PluginSpec, Transaction, TransactionOrigin,
    },
};

/// The transaction meta that keeps the autolink plugin from linking what
/// a transaction typed (Tiptap's `preventAutolink`; `setLink` sets it).
pub const PREVENT_AUTOLINK: &str = "preventAutolink";

/// The protocols a link may use without being listed: Tiptap's.
pub const DEFAULT_PROTOCOLS: &[&str] = &[
    "http", "https", "ftp", "ftps", "mailto", "tel", "callto", "sms", "cid", "xmpp",
];

/// A link press the click plugin hands to [`LinkOptions::open`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct LinkPress {
    /// The link's `href`.
    pub href: String,
    /// Its `target` attribute, when it has one.
    pub target: Option<String>,
    /// Where the press was.
    pub pos: usize,
}

/// Opens a pressed link; `true` when it did.
pub type LinkOpener = Arc<dyn Fn(&LinkPress) -> bool + Send + Sync>;

/// Decides whether a found URL is linked, given the URL.
pub type UrlPredicate = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// The options of [`link`], Tiptap's names and defaults.
#[derive(Clone)]
#[non_exhaustive]
pub struct LinkOptions {
    /// The link mark's type name (`link`).
    pub mark: String,
    /// Links URLs as they are typed, when a space or Enter ends them, and
    /// the URLs in pasted text (true).
    pub autolink: bool,
    /// Pasting a URL over a selection links the selection (true).
    pub link_on_paste: bool,
    /// A press on a link opens it while Mod is held or the editor is not
    /// editable (true).
    pub open_on_click: bool,
    /// A press on a link selects the whole link (false).
    pub enable_click_selection: bool,
    /// Protocols allowed beyond [`DEFAULT_PROTOCOLS`] and found in text
    /// (`"ftp"`, `"web+app"`).
    pub protocols: Vec<String>,
    /// The protocol a URL found without one gets (`http`).
    pub default_protocol: String,
    /// Whether a URI may be a link at all; [`is_allowed_uri`] with
    /// `protocols` when `None`.
    pub is_allowed_uri: Option<UrlPredicate>,
    /// Whether a found URL is linked automatically; [`should_auto_link`]
    /// when `None`.
    pub should_auto_link: Option<UrlPredicate>,
    /// Opens a pressed link; NSH's `open_url` (the embedding app first,
    /// then the platform) when `None`.
    pub open: Option<LinkOpener>,
}

impl Default for LinkOptions {
    fn default() -> Self {
        Self {
            mark: "link".into(),
            autolink: true,
            link_on_paste: true,
            open_on_click: true,
            enable_click_selection: false,
            protocols: Vec::new(),
            default_protocol: "http".into(),
            is_allowed_uri: None,
            should_auto_link: None,
            open: None,
        }
    }
}

impl std::fmt::Debug for LinkOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LinkOptions")
            .field("mark", &self.mark)
            .field("autolink", &self.autolink)
            .field("link_on_paste", &self.link_on_paste)
            .field("open_on_click", &self.open_on_click)
            .field("enable_click_selection", &self.enable_click_selection)
            .field("protocols", &self.protocols)
            .field("default_protocol", &self.default_protocol)
            .finish_non_exhaustive()
    }
}

impl LinkOptions {
    /// Whether `uri` may be a link, by the options.
    pub fn allows(&self, uri: &str) -> bool {
        match &self.is_allowed_uri {
            Some(allowed) => allowed(uri),
            None => is_allowed_uri(uri, &self.protocols),
        }
    }

    /// Whether a found `url` is linked automatically, by the options.
    pub fn auto_links(&self, url: &str) -> bool {
        match &self.should_auto_link {
            Some(should) => should(url),
            None => should_auto_link(url),
        }
    }
}

// --- URI checks --------------------------------------------------------------

/// Tiptap's (DOMPurify's) white space: control characters, spaces and the
/// Unicode spaces.
pub fn is_link_whitespace(c: char) -> bool {
    matches!(c, '\u{0}'..='\u{20}' | '\u{A0}' | '\u{1680}' | '\u{180E}' | '\u{2000}'..='\u{2029}' | '\u{205F}' | '\u{3000}')
}

/// Whether `uri` may be a link (Tiptap's `isAllowedUri`): an empty URI, a
/// relative one, or one whose scheme is one of [`DEFAULT_PROTOCOLS`] or
/// `protocols`. `javascript:`, `data:`, `vbscript:` and other schemes are
/// refused.
pub fn is_allowed_uri(uri: &str, protocols: &[String]) -> bool {
    let uri: String = uri.chars().filter(|c| !is_link_whitespace(*c)).collect();
    if uri.is_empty() {
        return true;
    }
    let schemes: Vec<String> = DEFAULT_PROTOCOLS
        .iter()
        .map(|p| regex::escape(p))
        .chain(
            protocols
                .iter()
                .filter(|p| !p.is_empty())
                .map(|p| regex::escape(p)),
        )
        .collect();
    let pattern = format!(
        r"(?i)^(?:(?:{}):|[^a-z]|[a-z0-9+.\-]+(?:[^a-z+.\-:]|$))",
        schemes.join("|")
    );
    Regex::new(&pattern).is_ok_and(|re| re.is_match(&uri))
}

static HAS_PROTOCOL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.\-]*://").expect("valid"));
static HAS_MAYBE_PROTOCOL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)^[a-z][a-z0-9+.\-]*:").expect("valid"));
static IPV4: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\d{1,3}(?:\.\d{1,3}){3}$").expect("valid"));

/// Whether a found `url` is linked automatically (Tiptap's default
/// `shouldAutoLink`): URLs with a protocol are; without one, not IP
/// addresses or host names without a dot (`localhost`).
pub fn should_auto_link(url: &str) -> bool {
    if HAS_PROTOCOL.is_match(url) || (HAS_MAYBE_PROTOCOL.is_match(url) && !url.contains('@')) {
        return true;
    }
    let without_userinfo = url.rsplit('@').next().unwrap_or(url);
    let hostname = without_userinfo
        .split(['/', '?', '#', ':'])
        .next()
        .unwrap_or_default();
    !IPV4.is_match(hostname) && hostname.contains('.')
}

// --- Finding links -----------------------------------------------------------

/// What kind of link [`find_links`] found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[non_exhaustive]
pub enum LinkKind {
    /// A URL, with or without a protocol.
    Url,
    /// An e-mail address (`mailto:` added to its `href`).
    Email,
}

/// A link found in text.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct FoundLink {
    /// What it is.
    pub kind: LinkKind,
    /// The text as written.
    pub value: String,
    /// Its `href`: the value with the default protocol (URLs without one)
    /// or `mailto:` (addresses).
    pub href: String,
    /// Its start in the text, in bytes.
    pub start: usize,
    /// Its end in the text, in bytes.
    pub end: usize,
}

// Common generic top-level domains; every two-letter one (a country's) is
// taken too.
const GENERIC_TLDS: &[&str] = &[
    "com",
    "net",
    "org",
    "edu",
    "gov",
    "mil",
    "int",
    "info",
    "biz",
    "name",
    "pro",
    "aero",
    "coop",
    "museum",
    "mobi",
    "asia",
    "tel",
    "travel",
    "jobs",
    "cat",
    "app",
    "dev",
    "page",
    "blog",
    "cloud",
    "online",
    "site",
    "store",
    "shop",
    "tech",
    "xyz",
    "top",
    "club",
    "art",
    "design",
    "news",
    "live",
    "life",
    "world",
    "today",
    "space",
    "website",
    "email",
    "link",
    "network",
    "digital",
    "media",
    "studio",
    "agency",
    "company",
    "systems",
    "solutions",
    "software",
    "codes",
    "tools",
    "wiki",
    "social",
    "chat",
    "team",
    "zone",
    "work",
    "run",
    "fun",
    "games",
    "game",
    "video",
    "music",
    "photo",
    "photos",
    "pics",
    "events",
    "community",
    "foundation",
    "group",
    "global",
    "center",
    "academy",
    "school",
    "education",
    "health",
    "finance",
    "money",
    "bank",
    "capital",
    "fund",
    "market",
    "markets",
    "trade",
    "exchange",
    "ventures",
    "partners",
    "consulting",
    "services",
    "support",
    "help",
    "guide",
    "review",
    "reviews",
    "blue",
    "red",
    "green",
    "black",
    "pink",
    "gold",
    "new",
    "one",
    "plus",
    "win",
    "lol",
    "wtf",
    "ninja",
    "rocks",
    "cool",
    "cafe",
    "bar",
    "pub",
    "restaurant",
    "pizza",
    "travel",
    "city",
    "london",
    "nyc",
    "paris",
    "berlin",
    "tokyo",
    "google",
    "apple",
    "amazon",
    "microsoft",
    "youtube",
    "xn--fiqs8s",
    "xn--fiqz9s",
];

fn is_tld(tld: &str) -> bool {
    let tld = tld.to_ascii_lowercase();
    (tld.len() == 2 && tld.chars().all(|c| c.is_ascii_alphabetic()))
        || GENERIC_TLDS.contains(&tld.as_str())
}

const URL_CHARS: &str = r#"[^\s<>"'`\u{A0}\u{3000}]"#;

static SCHEME_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(r"(?i)\b([a-z][a-z0-9+.\-]*):(//)?{URL_CHARS}+")).expect("valid")
});
static EMAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)[a-z0-9.!#$%&*+/=?^_{|}~\-]+@((?:[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?\.)+([a-z][a-z0-9\-]{1,62}))",
    )
    .expect("valid")
});
static DOMAIN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?i)(?:[a-z0-9](?:[a-z0-9\-]{{0,61}}[a-z0-9])?\.)+([a-z][a-z0-9\-]{{1,62}})(?::\d{{1,5}})?(?:[/?#]{URL_CHARS}*)?"
    ))
    .expect("valid")
});

// Trims what a link written in text does not end with: trailing
// punctuation and closing brackets without their opening one.
fn trim_end(text: &str) -> &str {
    let mut end = text.len();
    loop {
        let s = &text[..end];
        let Some(last) = s.chars().next_back() else {
            return s;
        };
        let unbalanced = |open: char, close: char| {
            last == close && s.matches(close).count() > s.matches(open).count()
        };
        if matches!(
            last,
            '.' | ',' | ';' | ':' | '!' | '?' | '\'' | '"' | '*' | '_' | '~'
        ) || unbalanced('(', ')')
            || unbalanced('[', ']')
            || unbalanced('{', '}')
            || unbalanced('<', '>')
        {
            end -= last.len_utf8();
        } else {
            return s;
        }
    }
}

fn starts_on_boundary(text: &str, start: usize) -> bool {
    text[..start]
        .chars()
        .next_back()
        .is_none_or(|c| !(c.is_alphanumeric() || matches!(c, '.' | '@' | '-' | '_' | '/' | ':')))
}

/// The links in `text` (linkify's `find`): URLs with a protocol (one with
/// `//`, or `mailto:` / `tel:` / `sms:` / `callto:` / `xmpp:` or one of
/// `protocols`), host names with a known top-level domain (with a port,
/// path, query and fragment), and e-mail addresses, without trailing
/// punctuation. URLs without a protocol get `default_protocol`.
pub fn find_links(text: &str, default_protocol: &str, protocols: &[String]) -> Vec<FoundLink> {
    let mut found: Vec<FoundLink> = Vec::new();
    let push = |found: &mut Vec<FoundLink>, link: FoundLink| {
        if link.end > link.start
            && !found
                .iter()
                .any(|f| f.start < link.end && link.start < f.end)
        {
            found.push(link);
        }
    };
    for m in SCHEME_URL.captures_iter(text) {
        let whole = m.get(0).expect("match");
        let scheme = m[1].to_ascii_lowercase();
        let slashes = m.get(2).is_some();
        let known = ["mailto", "tel", "sms", "callto", "xmpp"].contains(&scheme.as_str())
            || protocols.iter().any(|p| p.eq_ignore_ascii_case(&scheme));
        if !(slashes && scheme.chars().all(|c| c.is_ascii_alphabetic()) || known)
            || !starts_on_boundary(text, whole.start())
        {
            continue;
        }
        let value = trim_end(whole.as_str());
        if value.len() <= scheme.len() + 1 + if slashes { 2 } else { 0 } {
            continue;
        }
        push(
            &mut found,
            FoundLink {
                kind: if scheme == "mailto" {
                    LinkKind::Email
                } else {
                    LinkKind::Url
                },
                value: value.to_owned(),
                href: value.to_owned(),
                start: whole.start(),
                end: whole.start() + value.len(),
            },
        );
    }
    for m in EMAIL.captures_iter(text) {
        let whole = m.get(0).expect("match");
        if !is_tld(&m[2]) || !starts_on_boundary(text, whole.start()) {
            continue;
        }
        let value = trim_end(whole.as_str());
        push(
            &mut found,
            FoundLink {
                kind: LinkKind::Email,
                value: value.to_owned(),
                href: format!("mailto:{value}"),
                start: whole.start(),
                end: whole.start() + value.len(),
            },
        );
    }
    for m in DOMAIN.captures_iter(text) {
        let whole = m.get(0).expect("match");
        if !is_tld(&m[1]) || !starts_on_boundary(text, whole.start()) {
            continue;
        }
        // `example.com1`: a host name runs on into what no URL is.
        if text[whole.end()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '@')
        {
            continue;
        }
        let value = trim_end(whole.as_str());
        push(
            &mut found,
            FoundLink {
                kind: LinkKind::Url,
                value: value.to_owned(),
                href: format!("{default_protocol}://{value}"),
                start: whole.start(),
                end: whole.start() + value.len(),
            },
        );
    }
    found.sort_by_key(|f| f.start);
    found
}

/// The link `word` is (Tiptap's `isValidLinkStructure`): the whole word,
/// or the whole word inside `()` or `[]`.
pub fn word_link(word: &str, default_protocol: &str, protocols: &[String]) -> Option<FoundLink> {
    let links = find_links(word, default_protocol, protocols);
    let [link] = links.as_slice() else {
        return None;
    };
    if link.start == 0 && link.end == word.len() {
        return Some(link.clone());
    }
    let (open, close) = (&word[..link.start], &word[link.end..]);
    (matches!((open, close), ("(", ")") | ("[", "]"))).then(|| link.clone())
}

// --- The plugins -------------------------------------------------------------

// The textblocks in `from..to` of `doc`, with their positions.
fn textblocks_in(doc: &Node, from: usize, to: usize) -> Vec<(Node, usize)> {
    let mut out = Vec::new();
    doc.nodes_between(from, to, &mut |node, pos, _, _| {
        if node.is_textblock() {
            out.push((node.clone(), pos));
            return false;
        }
        true
    });
    out
}

struct Autolink {
    options: LinkOptions,
}

impl Autolink {
    fn link_word_before(
        &self,
        tr: &mut Transaction,
        state: &EditorState,
        ty: &MarkType,
        block_pos: usize,
        text: &str,
    ) {
        let Some(word) = text.split(is_link_whitespace).rfind(|w| !w.is_empty()) else {
            return;
        };
        let Some(byte) = text.rfind(word) else {
            return;
        };
        let Some(link) = word_link(
            word,
            &self.options.default_protocol,
            &self.options.protocols,
        ) else {
            return;
        };
        let offset = block_pos + 1 + utf16_len(&text[..byte]);
        let from = offset + utf16_len(&word[..link.start]);
        let to = from + utf16_len(&link.value);
        let doc = state.doc();
        if let Some(code) = state.schema().mark_type("code")
            && doc.range_has_mark(from, to, &code)
        {
            return;
        }
        if !self.options.allows(&link.value)
            || !self.options.auto_links(&link.value)
            || doc.range_has_mark(from, to, ty)
        {
            return;
        }
        let mut attrs = Attrs::new();
        attrs.insert("href".into(), Value::from(link.href));
        if let Ok(mark) = ty.create(Some(attrs)) {
            let _ = tr.add_mark(from, to, mark);
        }
    }
}

impl PluginSpec for Autolink {
    fn key(&self) -> PluginKey {
        PluginKey::new("autolink")
    }

    fn append_transaction(
        &self,
        trs: &[Transaction],
        old: &EditorState,
        new: &EditorState,
    ) -> Option<Transaction> {
        if !trs.iter().any(|tr| tr.doc_changed())
            || old.doc().eq(new.doc())
            || trs.iter().any(|tr| {
                tr.get_meta(PREVENT_AUTOLINK)
                    .is_some_and(|v| v != &Value::Bool(false))
            })
            || trs.iter().any(is_history_transaction)
        {
            return None;
        }
        let ty = new.schema().mark_type(&self.options.mark)?;
        // Each transaction's changed range, mapped to the last document.
        let mut ranges = Vec::new();
        for (i, tr) in trs.iter().enumerate() {
            let Some((mut from, mut to)) = tr.changed_range() else {
                continue;
            };
            for later in &trs[i + 1..] {
                from = later.mapping.map(from, 1);
                to = later.mapping.map(to, -1).max(from);
            }
            ranges.push((from, to));
        }
        let doc = new.doc();
        let mut tr = new.tr();
        for (from, to) in ranges {
            let blocks = textblocks_in(doc, from, to);
            match blocks.as_slice() {
                [] => {}
                // Enter: the first of the blocks the change spans.
                [(block, pos), _, ..] => {
                    let text = doc.text_between(*pos, pos + block.node_size(), None, Some(" "));
                    self.link_word_before(&mut tr, new, &ty, *pos, &text);
                }
                [(_, pos)] => {
                    let end = doc.text_between(from, to, Some(" "), Some(" "));
                    if !end.chars().next_back().is_some_and(is_link_whitespace) {
                        continue;
                    }
                    let text = doc.text_between(*pos, to, None, Some(" "));
                    self.link_word_before(&mut tr, new, &ty, *pos, &text);
                }
            }
        }
        (!tr.steps.is_empty()).then(|| {
            tr.set_origin(TransactionOrigin::Plugin("autolink".into()));
            tr
        })
    }
}

struct PasteLink {
    options: LinkOptions,
}

impl PasteLink {
    // Links the URLs in the text nodes of `fragment` (outside code).
    fn link_fragment(&self, fragment: &Fragment, ty: &MarkType, code: bool) -> Fragment {
        let mut out = Vec::with_capacity(fragment.child_count());
        for node in fragment.iter() {
            if let Some(text) = node.text()
                && !code
                && !node.marks().iter().any(|m| &m.ty == ty || m.ty.spec().code)
            {
                let schema = node.schema();
                let mut last = 0;
                for link in find_links(
                    text,
                    &self.options.default_protocol,
                    &self.options.protocols,
                ) {
                    if !self.options.allows(&link.href) || !self.options.auto_links(&link.value) {
                        continue;
                    }
                    let mut attrs = Attrs::new();
                    attrs.insert("href".into(), Value::from(link.href.clone()));
                    let Ok(mark) = ty.create(Some(attrs)) else {
                        continue;
                    };
                    if link.start > last {
                        out.push(schema.text(&text[last..link.start], node.marks().to_vec()));
                    }
                    out.push(schema.text(&link.value, mark.add_to_set(node.marks())));
                    last = link.end;
                }
                if last == 0 {
                    out.push(node.clone());
                } else if last < text.len() {
                    out.push(schema.text(&text[last..], node.marks().to_vec()));
                }
            } else if node.content().child_count() > 0 {
                let code = code || node.ty().spec().code;
                out.push(node.copy(self.link_fragment(node.content(), ty, code)));
            } else {
                out.push(node.clone());
            }
        }
        out.into()
    }
}

impl PluginSpec for PasteLink {
    fn key(&self) -> PluginKey {
        PluginKey::new("handlePasteLink")
    }

    fn handle_paste(
        &self,
        state: &EditorState,
        slice: &Slice,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        if !self.options.link_on_paste || state.selection().empty() {
            return false;
        }
        let Some(ty) = state.schema().mark_type(&self.options.mark) else {
            return false;
        };
        let text: String = slice.content.iter().map(|n| n.text_content()).collect();
        let Some(link) = find_links(
            &text,
            &self.options.default_protocol,
            &self.options.protocols,
        )
        .into_iter()
        .find(|l| l.value == text) else {
            return false;
        };
        if !self.options.auto_links(&link.value) || !self.options.allows(&link.href) {
            return false;
        }
        let mut attrs = Attrs::new();
        attrs.insert("href".into(), Value::from(link.href));
        tiptap::set_mark(ty, attrs)(
            state,
            Some(&mut |mut tr: Transaction| {
                tr.set_meta(PREVENT_AUTOLINK, Value::Bool(true));
                tr.set_origin(TransactionOrigin::Paste);
                dispatch(tr);
            }),
        )
    }

    fn transform_pasted(&self, state: &EditorState, slice: Slice) -> Slice {
        if !self.options.autolink || state.selection().resolved_from().parent().ty().spec().code {
            return slice;
        }
        let Some(ty) = state.schema().mark_type(&self.options.mark) else {
            return slice;
        };
        let content = self.link_fragment(&slice.content, &ty, false);
        Slice::new(content, slice.open_start, slice.open_end)
    }
}

struct ClickLink {
    options: LinkOptions,
}

impl PluginSpec for ClickLink {
    fn key(&self) -> PluginKey {
        PluginKey::new("handleClickLink")
    }

    fn handle_click(
        &self,
        state: &EditorState,
        pos: usize,
        event: &ClickEvent,
        dispatch: &mut dyn FnMut(Transaction),
    ) -> bool {
        if event.button != 0 {
            return false;
        }
        let Some(ty) = state.schema().mark_type(&self.options.mark) else {
            return false;
        };
        let Some((mark, from, to)) = link_at(state.doc(), pos, &ty) else {
            return false;
        };
        let mut handled = false;
        if self.options.enable_click_selection {
            let mut tr = state.tr();
            tr.set_selection(crate::rich_editor::state::TextSelection::create(
                state.doc(),
                from,
                Some(to),
            ));
            dispatch(tr);
            handled = true;
        }
        let editable = !event.read_only
            && state
                .plugins()
                .iter()
                .all(|p| p.editable(state) != Some(false));
        if self.options.open_on_click && (event.mod_key || !editable) {
            let href = mark
                .attrs()
                .get("href")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if !href.is_empty() && self.options.allows(href) {
                let press = LinkPress {
                    href: href.to_owned(),
                    target: mark
                        .attrs()
                        .get("target")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    pos,
                };
                handled |= match &self.options.open {
                    Some(open) => open(&press),
                    None => {
                        drop(nsh_core::element::ambient::open_url(press.href));
                        true
                    }
                };
            }
        }
        handled
    }
}

/// The link mark of type `ty` at `pos` in `doc` and the range of the text
/// it covers around `pos`.
pub fn link_at(
    doc: &Node,
    pos: usize,
    ty: &MarkType,
) -> Option<(crate::rich_editor::model::Mark, usize, usize)> {
    let resolved = doc.resolve(pos).ok()?;
    let parent = resolved.parent();
    let start = resolved.start(resolved.depth);
    let after = resolved.node_after();
    let before = resolved.node_before();
    let mark = after
        .iter()
        .chain(before.iter())
        .flat_map(|n| n.marks().iter())
        .find(|m| &m.ty == ty)?
        .clone();
    // The children around `pos` carrying the same mark.
    let mut spans = Vec::new();
    let mut offset = start;
    for i in 0..parent.child_count() {
        let child = parent.child(i);
        let end = offset + child.node_size();
        spans.push((offset, end, mark.is_in_set(child.marks())));
        offset = end;
    }
    let index = spans
        .iter()
        .position(|(s, e, has)| *has && *s <= pos && pos <= *e)?;
    let (mut from, mut to) = (spans[index].0, spans[index].1);
    for (s, _, has) in spans[..index].iter().rev() {
        if !has {
            break;
        }
        from = *s;
    }
    for (_, e, has) in &spans[index + 1..] {
        if !has {
            break;
        }
        to = *e;
    }
    Some((mark, from, to))
}

/// The key of the plugin keeping the link options in the state, where the
/// link commands read the allowed protocols.
pub const LINK_KEY: &str = "link";

struct LinkConfig {
    options: LinkOptions,
}

impl PluginSpec for LinkConfig {
    fn key(&self) -> PluginKey {
        PluginKey::new(LINK_KEY)
    }

    fn init_state(
        &self,
        _: &crate::rich_editor::state::EditorStateConfig,
        _: &EditorState,
    ) -> Option<crate::rich_editor::state::PluginState> {
        Some(Arc::new(self.options.clone()))
    }
}

/// The link options of `state`'s [`link`] plugins, if it has them.
pub fn link_options(state: &EditorState) -> Option<Arc<LinkOptions>> {
    PluginKey::new(LINK_KEY).get_state::<LinkOptions>(state)
}

// Whether `href` may be a link in `state`: by its link options (with
// `protocols` added) or by Tiptap's check with `protocols`.
fn allowed_in(state: &EditorState, href: &str, protocols: &[String]) -> bool {
    match link_options(state) {
        Some(options) if options.is_allowed_uri.is_some() => options.allows(href),
        Some(options) => {
            let all: Vec<String> = options.protocols.iter().chain(protocols).cloned().collect();
            is_allowed_uri(href, &all)
        }
        None => is_allowed_uri(href, protocols),
    }
}

/// The link plugins `options` turn on, in Tiptap's order: autolink, the
/// click handler, the paste handler; and one keeping the options in the
/// state (key [`LINK_KEY`]) for the commands.
pub fn link(options: LinkOptions) -> Vec<Plugin> {
    let mut plugins: Vec<Plugin> = vec![Arc::new(LinkConfig {
        options: options.clone(),
    })];
    if options.autolink {
        plugins.push(Arc::new(Autolink {
            options: options.clone(),
        }));
    }
    if options.open_on_click || options.enable_click_selection {
        plugins.push(Arc::new(ClickLink {
            options: options.clone(),
        }));
    }
    if options.link_on_paste || options.autolink {
        plugins.push(Arc::new(PasteLink { options }));
    }
    plugins
}

// --- Commands ----------------------------------------------------------------

/// Tiptap's `setLink`: links the selection with `attrs` (`href`, `target`,
/// `rel`, `class`, `title`), refused for a URI the state's link options
/// (with `protocols` added) do not allow.
pub fn set_link(ty: MarkType, attrs: Attrs, protocols: Vec<String>) -> BoxCommand {
    command(move |state, dispatch| {
        let href = attrs
            .get("href")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !allowed_in(state, href, &protocols) {
            return false;
        }
        let attrs = known_attrs(&ty, &attrs);
        match dispatch {
            Some(dispatch) => tiptap::set_mark(ty.clone(), attrs)(
                state,
                Some(&mut |mut tr: Transaction| {
                    tr.set_meta(PREVENT_AUTOLINK, Value::Bool(true));
                    dispatch(tr);
                }),
            ),
            None => tiptap::set_mark(ty.clone(), attrs)(state, None),
        }
    })
}

/// Tiptap's `toggleLink`: links the selection, or unlinks the link around
/// it; refused for a URI `protocols` do not allow.
pub fn toggle_link(ty: MarkType, attrs: Attrs, protocols: Vec<String>) -> BoxCommand {
    command(move |state, dispatch| {
        if let Some(href) = attrs.get("href").and_then(Value::as_str)
            && !allowed_in(state, href, &protocols)
        {
            return false;
        }
        let attrs = known_attrs(&ty, &attrs);
        let toggle = tiptap::toggle_mark(ty.clone(), attrs, true);
        match dispatch {
            Some(dispatch) => toggle(
                state,
                Some(&mut |mut tr: Transaction| {
                    tr.set_meta(PREVENT_AUTOLINK, Value::Bool(true));
                    dispatch(tr);
                }),
            ),
            None => toggle(state, None),
        }
    })
}

/// Tiptap's `unsetLink`: removes the link around the selection, the whole
/// link at a cursor.
pub fn unset_link(ty: MarkType) -> BoxCommand {
    command(move |state, dispatch| {
        let unset = tiptap::unset_mark(ty.clone(), true);
        match dispatch {
            Some(dispatch) => unset(
                state,
                Some(&mut |mut tr: Transaction| {
                    tr.set_meta(PREVENT_AUTOLINK, Value::Bool(true));
                    dispatch(tr);
                }),
            ),
            None => unset(state, None),
        }
    })
}

// The attributes the mark type has (the starter's link has `href` and
// `title`; Tiptap's also `target`, `rel`, `class`).
fn known_attrs(ty: &MarkType, attrs: &Attrs) -> Attrs {
    let spec = ty.spec();
    attrs
        .iter()
        .filter(|(k, _)| spec.attrs.iter().any(|(name, _)| name == *k))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// Registers `setLink` (`{ href, target?, title?, name?, protocols? }`),
/// `toggleLink` and `unsetLink` (`{ name? }`, the mark type, `link` by
/// default) in `registry`.
pub fn register_commands(registry: &mut crate::rich_editor::commands::CommandRegistry) {
    fn mark(args: &Value, schema: &crate::rich_editor::model::Schema) -> Result<MarkType, String> {
        let name = args.get("name").and_then(Value::as_str).unwrap_or("link");
        schema
            .mark_type(name)
            .ok_or_else(|| format!("the schema has no mark type `{name}`"))
    }
    fn attrs(args: &Value) -> Attrs {
        args.as_object()
            .map(|o| {
                o.iter()
                    .filter(|(k, _)| !matches!(k.as_str(), "name" | "protocols"))
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect()
            })
            .unwrap_or_default()
    }
    fn protocols(args: &Value) -> Vec<String> {
        args.get("protocols")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default()
    }
    registry.register("setLink", |args, schema| {
        if args.get("href").and_then(Value::as_str).is_none() {
            return Err("setLink needs a string `href`".into());
        }
        Ok(set_link(mark(args, schema)?, attrs(args), protocols(args)))
    });
    registry.register("toggleLink", |args, schema| {
        Ok(toggle_link(
            mark(args, schema)?,
            attrs(args),
            protocols(args),
        ))
    });
    registry.register("unsetLink", |args, schema| {
        Ok(unset_link(mark(args, schema)?))
    });
}

/// `options`' JSON form, for the JS face's tests and state dumps.
pub fn options_json(options: &LinkOptions) -> Value {
    json!({
        "autolink": options.autolink,
        "linkOnPaste": options.link_on_paste,
        "openOnClick": options.open_on_click,
        "enableClickSelection": options.enable_click_selection,
        "protocols": options.protocols,
        "defaultProtocol": options.default_protocol,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::rich_editor::{
        extensions::starter,
        state::{EditorStateConfig, TextSelection},
    };

    fn state_with(text: &str, options: LinkOptions) -> EditorState {
        let schema = starter::schema();
        let doc = schema
            .node(
                "doc",
                None,
                Fragment::from(vec![
                    schema
                        .node(
                            "paragraph",
                            None,
                            if text.is_empty() {
                                Fragment::empty()
                            } else {
                                Fragment::from(vec![schema.text(text, vec![])])
                            },
                            vec![],
                        )
                        .unwrap(),
                ]),
                vec![],
            )
            .unwrap();
        let end = 1 + utf16_len(text);
        let selection = TextSelection::create(&doc, end, None);
        EditorState::create(
            EditorStateConfig::new(schema)
                .doc(doc)
                .selection(selection)
                .plugins(link(options)),
        )
        .unwrap()
    }

    fn type_text(state: &EditorState, text: &str) -> EditorState {
        let mut tr = state.tr();
        tr.insert_text(text, None, None);
        state.apply(tr).unwrap()
    }

    fn links(state: &EditorState) -> Vec<(String, String)> {
        let ty = state.schema().mark_type("link").unwrap();
        let mut out = Vec::new();
        state.doc().descendants(&mut |node, _, _, _| {
            if let Some(mark) = node.marks().iter().find(|m| m.ty == ty) {
                out.push((
                    node.text().unwrap_or_default().to_owned(),
                    mark.attrs()["href"].as_str().unwrap_or_default().to_owned(),
                ));
            }
            true
        });
        out
    }

    #[test]
    fn finds_urls_hosts_and_addresses() {
        let found = find_links(
            "see https://nsh.dev/docs?x=1, example.com. or mail me@example.org (www.a.io)",
            "http",
            &[],
        );
        let values: Vec<_> = found.iter().map(|f| f.value.as_str()).collect();
        assert_eq!(
            values,
            [
                "https://nsh.dev/docs?x=1",
                "example.com",
                "me@example.org",
                "www.a.io"
            ]
        );
        assert_eq!(found[1].href, "http://example.com");
        assert_eq!(found[2].href, "mailto:me@example.org");
        assert!(find_links("example.com1 readme", "http", &[]).is_empty());
        assert!(find_links("no links here.", "http", &[]).is_empty());
    }

    #[test]
    fn word_links_are_whole_or_bracketed() {
        assert!(word_link("example.com", "http", &[]).is_some());
        assert!(word_link("(example.com)", "http", &[]).is_some());
        assert!(word_link("example.com.", "http", &[]).is_none());
        assert!(word_link("x(example.com)", "http", &[]).is_none());
    }

    #[test]
    fn allowed_uris_refuse_scripts() {
        assert!(is_allowed_uri("https://a.com", &[]));
        assert!(is_allowed_uri("/relative", &[]));
        assert!(is_allowed_uri("mailto:a@b.co", &[]));
        assert!(!is_allowed_uri("javascript:alert(1)", &[]));
        assert!(!is_allowed_uri("java\nscript:alert(1)", &[]));
        assert!(!is_allowed_uri("data:text/html,x", &[]));
        assert!(!is_allowed_uri("web+app:x", &[]));
        assert!(is_allowed_uri("web+app:x", &["web+app".into()]));
    }

    #[test]
    fn should_auto_link_follows_tiptap() {
        assert!(should_auto_link("https://localhost"));
        assert!(should_auto_link("example.com"));
        assert!(!should_auto_link("localhost"));
        assert!(!should_auto_link("127.0.0.1"));
    }

    #[test]
    fn a_space_after_a_url_links_it() {
        let state = state_with("visit example.com", LinkOptions::default());
        let state = type_text(&state, " ");
        assert_eq!(
            links(&state),
            [("example.com".into(), "http://example.com".into())]
        );
        // Text without a link stays plain.
        let plain = type_text(&state_with("hello", LinkOptions::default()), " ");
        assert!(links(&plain).is_empty());
    }

    #[test]
    fn enter_after_a_url_links_it() {
        let state = state_with("https://nsh.dev", LinkOptions::default());
        let mut tr = state.tr();
        let at = state.selection().from();
        tr.split(at, 1, None).unwrap();
        let state = state.apply(tr).unwrap();
        assert_eq!(
            links(&state),
            [("https://nsh.dev".into(), "https://nsh.dev".into())]
        );
    }

    #[test]
    fn autolink_respects_options_and_meta() {
        let off = LinkOptions {
            autolink: false,
            ..LinkOptions::default()
        };
        assert!(links(&type_text(&state_with("a.com", off), " ")).is_empty());
        let never = LinkOptions {
            should_auto_link: Some(Arc::new(|_| false)),
            ..LinkOptions::default()
        };
        assert!(links(&type_text(&state_with("a.com", never), " ")).is_empty());
        let state = state_with("a.com", LinkOptions::default());
        let mut tr = state.tr();
        tr.insert_text(" ", None, None);
        tr.set_meta(PREVENT_AUTOLINK, Value::Bool(true));
        assert!(links(&state.apply(tr).unwrap()).is_empty());
    }

    #[test]
    fn pasting_a_url_over_a_selection_links_it() {
        let state = state_with("click here", LinkOptions::default());
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 7, Some(11)));
        let state = state.apply(tr).unwrap();
        let schema = state.schema().clone();
        let slice = Slice::new(
            Fragment::from(vec![schema.text("https://a.io", vec![])]),
            0,
            0,
        );
        let mut out = None;
        let handled = state
            .plugins()
            .iter()
            .any(|p| p.handle_paste(&state, &slice, &mut |tr| out = Some(tr)));
        assert!(handled);
        let state = state.apply(out.unwrap()).unwrap();
        assert_eq!(links(&state), [("here".into(), "https://a.io".into())]);
    }

    #[test]
    fn pasted_text_gets_its_urls_linked() {
        let state = state_with("", LinkOptions::default());
        let schema = state.schema().clone();
        let slice = Slice::new(
            Fragment::from(vec![schema.text("go to nsh.dev now", vec![])]),
            0,
            0,
        );
        let slice = state
            .plugins()
            .iter()
            .fold(slice, |s, p| p.transform_pasted(&state, s));
        let mut tr = state.tr();
        tr.replace_selection(slice);
        let state = state.apply(tr).unwrap();
        assert_eq!(links(&state), [("nsh.dev".into(), "http://nsh.dev".into())]);
    }

    #[test]
    fn a_press_with_mod_opens_the_link() {
        let opened = Arc::new(Mutex::new(Vec::new()));
        let seen = opened.clone();
        let options = LinkOptions {
            open: Some(Arc::new(move |press: &LinkPress| {
                seen.lock().unwrap().push(press.href.clone());
                true
            })),
            ..LinkOptions::default()
        };
        let state = type_text(&state_with("x example.com", options), " ");
        let click = |mod_key| ClickEvent {
            mod_key,
            ..ClickEvent::default()
        };
        let pressed = |state: &EditorState, event: &ClickEvent| {
            state
                .plugins()
                .iter()
                .any(|p| p.handle_click(state, 5, event, &mut |_| {}))
        };
        assert!(!pressed(&state, &click(false)));
        assert!(pressed(&state, &click(true)));
        assert_eq!(*opened.lock().unwrap(), ["http://example.com"]);
        // A read-only view opens it on a plain press.
        let read_only = ClickEvent {
            read_only: true,
            ..ClickEvent::default()
        };
        assert!(pressed(&state, &read_only));
        assert_eq!(opened.lock().unwrap().len(), 2);
        // Not on a link: nothing.
        assert!(!state.plugins().iter().any(|p| p.handle_click(
            &state,
            1,
            &click(true),
            &mut |_| {}
        )));
    }

    #[test]
    fn set_link_refuses_scripts() {
        let state = state_with("text", LinkOptions::default());
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 1, Some(5)));
        let state = state.apply(tr).unwrap();
        let ty = state.schema().mark_type("link").unwrap();
        let mut attrs = Attrs::new();
        attrs.insert("href".into(), json!("javascript:alert(1)"));
        assert!(!set_link(ty.clone(), attrs, vec![])(&state, None));
        let mut attrs = Attrs::new();
        attrs.insert("href".into(), json!("https://nsh.dev"));
        let mut out = None;
        assert!(set_link(ty.clone(), attrs, vec![])(
            &state,
            Some(&mut |tr| out = Some(tr))
        ));
        let state = state.apply(out.unwrap()).unwrap();
        assert_eq!(links(&state), [("text".into(), "https://nsh.dev".into())]);
        let mut out = None;
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 2, None));
        let state = state.apply(tr).unwrap();
        assert!(unset_link(ty)(&state, Some(&mut |tr| out = Some(tr))));
        assert!(links(&state.apply(out.unwrap()).unwrap()).is_empty());
    }

    #[test]
    fn commands_take_the_protocols_of_the_options() {
        let options = LinkOptions {
            protocols: vec!["web+app".into()],
            ..LinkOptions::default()
        };
        let state = state_with("text", options);
        let mut tr = state.tr();
        tr.set_selection(TextSelection::create(state.doc(), 1, Some(5)));
        let state = state.apply(tr).unwrap();
        let ty = state.schema().mark_type("link").unwrap();
        let mut attrs = Attrs::new();
        attrs.insert("href".into(), json!("web+app:x"));
        assert!(toggle_link(ty.clone(), attrs.clone(), vec![])(&state, None));
        let plain = state_with("text", LinkOptions::default());
        assert!(!toggle_link(ty, attrs, vec![])(&plain, None));
        assert_eq!(link_options(&state).unwrap().protocols, ["web+app"]);
    }
}
