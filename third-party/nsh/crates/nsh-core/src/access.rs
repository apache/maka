//! Capabilities: what an app may reach outside its VM.
//!
//! An app declares them in `nsh.json` (`"capabilities"`); the app embedding
//! nsh may grant less ([`Access`]): a request must be allowed by both.
//! Everything is denied unless listed. `nsh.json` and signed packages are
//! read leniently ([`Capabilities::from_json_lenient`]): a newer NSH may
//! declare what this one does not know, which is then not granted (the
//! toolchain warns of it, so a typo is still seen at build time).
//!
//! ```json
//! "capabilities": {
//!   "network": {
//!     "hosts": ["api.example.com", "*.cdn.example.com"],
//!     "http": [{ "host": "quotes.example.com", "methods": ["GET"], "pathPrefix": "/v1/" }],
//!     "sockets": ["mqtt.example.com:8883"]
//!   },
//!   "webview": { "hosts": ["*.example.com"], "input": true },
//!   "statusBar": true,
//!   "host": ["getUserInfo", "bridge.*"],
//!   "openUrl": { "schemes": ["https", "mailto"] }
//! }
//! ```
//!
//! `openUrl` lets the app open URLs outside it (`openUrl` of `nsh/device`,
//! [`crate::open_url`]: the browser, the mail or phone app, other apps'
//! schemes): `true` for every scheme, `{ "schemes": [...] }` for those
//! listed. `network` covers `fetch` (every redirect is checked again), remote
//! images (also canvas images and `Image.getSize` / `prefetch`) and video
//! sources; `asset:` URIs are always allowed. WebSockets are HTTP upgrades:
//! a `ws:` / `wss:` URL is checked as a GET of the same URL over `http:` /
//! `https:` (or under its own scheme, for legacy rules that list it).
//! `network.sockets` grants raw TCP (`net.connect`) to exact `host:port`
//! pairs only: no wildcards, and neither `hosts` nor `http` grants imply
//! one. `webview` lists the hosts a web view may show and navigate to (its
//! pages' own subresources are the web content's business); its `input`
//! lets a web view's ref give the page trusted input (`sendInput`), which
//! carries user activation and is granted only when declared, also for
//! apps without a declaration. `host` lists
//! the functions of the embedding app `nsh/host` may call: names (1 to 128
//! of `[A-Za-z0-9_.:-]`, without `..`; the core refuses calls of any other
//! name), or prefixes of them ending in `*` (`true`: all of them); the
//! host's events need no grant, the host sends them. An app without
//! `"capabilities"` (a standalone app, its developer's own) retains
//! unrestricted HTTP, web views, the status bar, the clipboard, the picker,
//! speech recognition and opening URLs; raw sockets, processes, the filesystem and the host's
//! functions always require an explicit declaration.

//! A `network.http` rule names a `host` (a pattern, as in `hosts`); every
//! other key narrows it and is optional: `methods` (any when left out),
//! `schemes` or `scheme` (any of http, https, ws, wss), `port` (any),
//! `paths` (exact) and `pathPrefixes` / `pathPrefix` / `path_prefixes`
//! (whole segments: `/v1` covers `/v1` and `/v1/x`, not `/v10`). Without
//! paths or prefixes a rule covers every path. Rules serialize in one form:
//! `schemes` and `pathPrefixes`.

use std::path::{Component, Path, PathBuf};

use serde_json::{Map, Value};

/// A host pattern: `*` (any host), `*.example.com` (its subdomains) or a
/// host name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostPattern(String);

impl HostPattern {
    /// Parses a pattern (lower-cased).
    pub fn new(pattern: &str) -> Result<Self, String> {
        let p = pattern.trim().to_ascii_lowercase();
        let host = p.strip_prefix("*.").unwrap_or(&p);
        let valid = p == "*"
            || (!host.is_empty()
                && host.chars().all(|c| {
                    c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']')
                }));
        if valid {
            Ok(Self(p))
        } else {
            Err(format!("invalid host pattern `{pattern}`"))
        }
    }

    /// Whether `host` (lower case) matches.
    pub fn matches(&self, host: &str) -> bool {
        match self.0.strip_prefix("*.") {
            _ if self.0 == "*" => true,
            Some(suffix) => {
                host.len() > suffix.len() + 1 && host.ends_with(suffix) && {
                    let dot = host.len() - suffix.len() - 1;
                    host.as_bytes()[dot] == b'.'
                }
            }
            None => self.0 == host,
        }
    }

    /// The pattern as written (lower case).
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A finer HTTP grant: a host, narrowed by any of methods, schemes, a port,
/// exact paths and path prefixes (each left empty: any).
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub struct HttpGrant {
    /// The host.
    pub host: HostPattern,
    /// Upper-case methods; empty: any.
    pub methods: Vec<String>,
    /// Lower-case schemes (`http`, `https`, `ws`, `wss`); empty: any of them.
    pub schemes: Vec<String>,
    /// The port, the scheme's default when the URL has none; `None`: any.
    pub port: Option<u16>,
    /// Exact paths (without the query).
    pub paths: Vec<String>,
    /// Path prefixes, matching whole segments (`/v1` covers `/v1/x`, not
    /// `/v10`). With `paths`, a path matching either is covered; with
    /// neither, every path is.
    pub path_prefixes: Vec<String>,
}

impl Default for HttpGrant {
    fn default() -> Self {
        Self {
            host: HostPattern(String::new()),
            methods: Vec::new(),
            schemes: Vec::new(),
            port: None,
            paths: Vec::new(),
            path_prefixes: Vec::new(),
        }
    }
}

impl HttpGrant {
    fn allows(&self, method: &str, url: &UrlParts<'_>) -> bool {
        let default_port = match url.scheme.as_str() {
            "https" | "wss" => 443,
            _ => 80,
        };
        let path = url.path.split(['?', '#']).next().unwrap_or("/");
        let path = if path.is_empty() { "/" } else { path };
        self.host.matches(&url.host)
            && (self.methods.is_empty()
                || self.methods.iter().any(|m| m.eq_ignore_ascii_case(method)))
            && (self.schemes.is_empty() || self.schemes.contains(&url.scheme))
            && self
                .port
                .is_none_or(|p| url.port.unwrap_or(default_port) == p)
            && ((self.paths.is_empty() && self.path_prefixes.is_empty())
                || self.paths.iter().any(|allowed| allowed == path)
                || self.path_prefixes.iter().any(|prefix| {
                    path.strip_prefix(prefix.as_str()).is_some_and(|tail| {
                        tail.is_empty() || prefix.ends_with('/') || tail.starts_with('/')
                    })
                }))
    }
}

/// `capabilities.network`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct NetworkGrants {
    /// Reachable with any method.
    pub hosts: Vec<HostPattern>,
    /// Finer grants.
    pub http: Vec<HttpGrant>,
    /// Raw TCP destinations (`net.connect`).
    pub sockets: Vec<SocketGrant>,
}

/// One raw TCP destination: an exact host and port, written `host:port`
/// (`[::1]:port` for IPv6). A socket bypasses every HTTP rule (methods,
/// paths, schemes), so it is granted per port and never by a pattern.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SocketGrant {
    host: String,
    port: u16,
}

impl SocketGrant {
    /// Parses `host:port` (host lower-cased; port 1 to 65535).
    pub fn new(grant: &str) -> Result<Self, String> {
        let invalid = || {
            format!(
                "invalid socket grant `{grant}`: expected an exact `host:port` (`[::1]:port` for IPv6), without wildcards"
            )
        };
        let (host, port) = grant.trim().rsplit_once(':').ok_or_else(invalid)?;
        let port = port
            .parse::<u16>()
            .ok()
            .filter(|p| *p != 0)
            .ok_or_else(invalid)?;
        let host = host.to_ascii_lowercase();
        let host = match host.strip_prefix('[').and_then(|h| h.strip_suffix(']')) {
            Some(v6)
                if !v6.is_empty()
                    && v6
                        .chars()
                        .all(|c| c.is_ascii_hexdigit() || matches!(c, ':' | '.')) =>
            {
                v6.to_owned()
            }
            Some(_) => return Err(invalid()),
            None if !host.is_empty()
                && host
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-')) =>
            {
                host.trim_end_matches('.').to_owned()
            }
            None => return Err(invalid()),
        };
        Ok(Self { host, port })
    }

    /// The host (lower case, IPv6 without brackets).
    pub fn host(&self) -> &str {
        &self.host
    }

    /// The port.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The `host:port` form [`Self::new`] reads.
    pub fn to_string_form(&self) -> String {
        if self.host.contains(':') {
            format!("[{}]:{}", self.host, self.port)
        } else {
            format!("{}:{}", self.host, self.port)
        }
    }
}

/// Commands an app may execute. Names are exact, without shell expansion.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct ProcessGrants {
    /// Exact executable names or absolute executable paths.
    pub execute: Vec<String>,
    /// The app may ask its host to handle an exit request.
    pub exit: bool,
    /// Additional environment variable names visible to the app.
    pub env: Vec<String>,
}

/// Filesystem roots an app may read or write. `${dataDir}` is resolved by
/// the host to this app's own data directory, never to a JS supplied root.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct FileGrants {
    /// Roots available for read operations.
    pub read: Vec<String>,
    /// Roots available for mutation operations.
    pub write: Vec<String>,
}

/// Host-selected anchors for manifest paths. Apps cannot supply these roots.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct TrustedPaths {
    /// The application source/package directory.
    pub plugin_dir: Option<PathBuf>,
    /// The native user's home directory, when known.
    pub home_dir: Option<PathBuf>,
}
impl TrustedPaths {
    /// Expand one manifest root against host anchors. Relative roots are
    /// anchored to the application directory. Unknown anchors never grant access.
    pub fn resolve_root(&self, root: &str, data_dir: &Path) -> Result<PathBuf, String> {
        validate_path_pattern(root)?;
        for (placeholder, anchor) in [
            ("${dataDir}", Some(data_dir)),
            ("${pluginDir}", self.plugin_dir.as_deref()),
            ("${homeDir}", self.home_dir.as_deref()),
        ] {
            if let Some(tail) = root.strip_prefix(placeholder) {
                let anchor = anchor
                    .filter(|p| absolute(p))
                    .ok_or_else(|| format!("host anchor {placeholder} unavailable"))?;
                // Component by component: `/` separates nothing in a
                // verbatim Windows anchor.
                let tail: PathBuf = tail.split('/').filter(|part| !part.is_empty()).collect();
                return within(anchor, &tail, root);
            }
        }
        let path = PathBuf::from(root);
        if absolute(&path) {
            Ok(path)
        } else {
            let anchor = self
                .plugin_dir
                .as_deref()
                .filter(|p| absolute(p))
                .ok_or_else(|| {
                    "host application directory unavailable for relative filesystem root".to_owned()
                })?;
            within(anchor, &path, root)
        }
    }
}

/// Virtual browser paths use Unix roots. `Path::is_absolute` on
/// wasm32-unknown-unknown always returns false because it has no OS prefix.
pub(crate) fn absolute(path: &Path) -> bool {
    if cfg!(target_arch = "wasm32") {
        path.has_root()
    } else {
        path.is_absolute()
    }
}

/// `tail` joined to `anchor`, when it stays there: names only. On Windows
/// a drive (`C:/Windows`), a share (`\\srv\share`) or a rooted path
/// (`\Users`) would replace or leave the anchor in `join`.
fn within(anchor: &Path, tail: &Path, root: &str) -> Result<PathBuf, String> {
    use std::path::Component;
    let names = tail
        .components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir));
    let mut path = anchor.to_path_buf();
    path.extend(tail.components().filter(|c| *c != Component::CurDir));
    if names && path.starts_with(anchor) {
        Ok(path)
    } else {
        Err(format!("filesystem root `{root}` leaves its anchor"))
    }
}

/// Whether environment names `a` and `b` are one variable: ignoring ASCII
/// case on Windows, whose environment does; exactly elsewhere (`lang` is
/// not `LANG` on Unix).
pub(crate) fn env_names_match(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

/// What an app may do (one declaration, or one grant).
/// Start with [`Self::default`] and set the fields to grant; new capabilities
/// default to denied.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct Capabilities {
    /// Explicit native subprocess grants.
    pub process: ProcessGrants,
    /// Explicit native filesystem grants.
    pub fs: FileGrants,
    /// `fetch`, remote images and video.
    pub network: NetworkGrants,
    /// The hosts web views may show; `None`: no web views.
    pub webview: Option<Vec<HostPattern>>,
    /// Web views may take trusted input (`sendInput`, `webview.input`):
    /// never without a declaration ([`Capabilities::all`] leaves it off).
    pub webview_input: bool,
    /// The app may set the status bar.
    pub status_bar: bool,
    /// The app may read and write the system clipboard (`nsh/clipboard`).
    pub clipboard: bool,
    /// The app may show the system's picker (`nsh/picker`): the files the
    /// user picks in it reach the app.
    pub picker: bool,
    /// The app may recognize the user's speech (`Speech` of `nsh`): the
    /// microphone listens while a session runs, and the transcript reaches
    /// the app.
    pub speech: bool,
    /// The app may show notifications and set its badge (`Notifications` of
    /// `nsh`). The user's permission is the system's, on top of this.
    pub notifications: bool,
    /// The app may play sound (`Sound` and `AudioPlayer` of `nsh`).
    pub audio: bool,
    /// The functions of the embedding app `nsh/host` may call: names, or
    /// prefixes ending in `*` (`"*"`: all); empty: none, also for apps
    /// without a declaration ([`Capabilities::all`]).
    pub host: Vec<String>,
    /// The URLs the app may open outside it (`openUrl` of `nsh/device`);
    /// `None`: none.
    pub open_url: Option<OpenUrlGrant>,
    /// The windows the app may open and what they may do (`nsh/desktop`'s
    /// `Window`); `None`: none besides its main one.
    pub windows: Option<WindowsGrant>,
}

/// The windows an app may open (`capabilities.windows`). Overlays,
/// click-through windows and capture protection, which can pass for the
/// system's UI over other apps, are granted only when declared.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct WindowsGrant {
    /// The kinds it may open; empty: every kind but `overlay`, which needs
    /// [`Self::overlay`] as well.
    pub kinds: Vec<crate::desktop::WindowKind>,
    /// The levels its windows may float at; empty: every level.
    pub levels: Vec<crate::desktop::WindowLevel>,
    /// How many windows it may have open at once besides the main one;
    /// `None`: any number.
    pub max: Option<u32>,
    /// Overlays and click-through windows (`pointerEvents: "none"`).
    pub overlay: bool,
}

impl WindowsGrant {
    fn allows_kind(&self, kind: crate::desktop::WindowKind) -> bool {
        use crate::desktop::WindowKind;
        if kind == WindowKind::Overlay && !self.overlay {
            return false;
        }
        self.kinds.is_empty() || self.kinds.contains(&kind)
    }

    fn allows_level(&self, level: crate::desktop::WindowLevel) -> bool {
        self.levels.is_empty() || self.levels.contains(&level)
    }
}

/// Which URLs an app may open outside it (`capabilities.openUrl`).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
#[non_exhaustive]
pub struct OpenUrlGrant {
    /// The schemes it may open, lower case (`https`, `mailto`, `tel`);
    /// empty: every scheme (`"openUrl": true`).
    pub schemes: Vec<String>,
}

impl OpenUrlGrant {
    /// Whether it grants URLs of `scheme` (lower case).
    pub fn allows(&self, scheme: &str) -> bool {
        self.schemes.is_empty() || self.schemes.iter().any(|s| s == scheme)
    }
}

/// The parts of a URL the checks look at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UrlParts<'a> {
    /// Lower-case scheme.
    pub scheme: String,
    /// Lower-case host (without port or user info).
    pub host: String,
    /// The path (and query), `/` when empty.
    pub path: &'a str,
    /// Explicit URL port.
    pub port: Option<u16>,
}

/// Splits an absolute URL into scheme, host and path; `None` when it has no
/// `scheme://host`.
pub fn parse_url(url: &str) -> Option<UrlParts<'_>> {
    let (scheme, rest) = url.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
    {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let (authority, path) = rest.split_at(end);
    // User info ends at the last `@`: `https://good.com@evil.com/` is evil.com.
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = if let Some(v6) = host_port.strip_prefix('[') {
        format!("[{}]", v6.split_once(']')?.0)
    } else {
        host_port.split(':').next().unwrap_or_default().to_owned()
    };
    if host.is_empty() {
        return None;
    }
    let port = if host_port.starts_with('[') {
        host_port
            .split_once(']')
            .and_then(|(_, rest)| rest.strip_prefix(':'))
            .map(str::parse::<u16>)
            .transpose()
            .ok()?
    } else {
        host_port
            .split_once(':')
            .map(|(_, port)| port.parse::<u16>())
            .transpose()
            .ok()?
    };
    Some(UrlParts {
        scheme: scheme.to_ascii_lowercase(),
        host: host.to_ascii_lowercase().trim_end_matches('.').to_owned(),
        path: if path.is_empty() { "/" } else { path },
        port,
    })
}

impl Capabilities {
    /// Legacy unrestricted APIs for apps without a declaration. Socket,
    /// process, filesystem and host function grants stay empty and always
    /// require explicit opt-in.
    pub fn all() -> Self {
        let any = vec![HostPattern("*".into())];
        Self {
            network: NetworkGrants {
                hosts: any.clone(),
                http: Vec::new(),
                sockets: Vec::new(),
            },
            webview: Some(any),
            status_bar: true,
            clipboard: true,
            picker: true,
            speech: true,
            notifications: true,
            audio: true,
            open_url: Some(OpenUrlGrant::default()),
            // Every kind and level, but no overlays or capture protection.
            windows: Some(WindowsGrant::default()),
            // The host's functions are never granted without a declaration.
            ..Self::default()
        }
    }

    /// Parses `capabilities` strictly: unknown keys are errors. What NSH
    /// itself reads (`nsh.json`, bundles, packages, grants) goes through
    /// [`Capabilities::from_json_lenient`], which a newer NSH's keys do not
    /// break.
    pub fn from_json(value: &Value) -> Result<Self, String> {
        Self::parse(value, None)
    }

    /// Parses capabilities a newer NSH may have written (`nsh.json`,
    /// bundles, signed packages, grants): what it cannot read never grants
    /// anything. An unknown capability is not granted; an unknown key inside
    /// one (a restriction this runtime cannot apply) drops what it is in,
    /// the whole capability or the `http` grant; a value of a form it does
    /// not know drops its capability (or its `http` grant), and the others
    /// stay. Declared capabilities allow only what they list, so what is
    /// dropped is denied. Only a declaration that is no object is denied
    /// whole. Returns what was dropped (`capabilities.bluetooth`, ...) with
    /// the capabilities.
    pub fn from_json_lenient(value: &Value) -> Result<(Self, Vec<String>), String> {
        let mut dropped = Vec::new();
        let Value::Object(obj) = value else {
            dropped.push(format!(
                "capabilities ({value} is not an object): all of them"
            ));
            return Ok((Self::default(), dropped));
        };
        // Each capability on its own: one that fails is dropped, alone.
        let mut readable = Map::new();
        for (key, v) in obj {
            let one = Value::Object(Map::from_iter([(key.clone(), v.clone())]));
            let mut its_dropped = Vec::new();
            match Self::parse(&one, Some(&mut its_dropped)) {
                Ok(_) => {
                    dropped.append(&mut its_dropped);
                    readable.insert(key.clone(), v.clone());
                }
                Err(e) => dropped.push(format!("capabilities.{key} ({e})")),
            }
        }
        let caps = Self::parse(&Value::Object(readable), Some(&mut Vec::new()))?;
        Ok((caps, dropped))
    }

    /// `dropped`: lenient, recording what unknown keys dropped; `None`:
    /// strict.
    fn parse(value: &Value, mut dropped: Option<&mut Vec<String>>) -> Result<Self, String> {
        const KNOWN: [&str; 13] = [
            "windows",
            "network",
            "webview",
            "statusBar",
            "clipboard",
            "picker",
            "speech",
            "notifications",
            "audio",
            "openUrl",
            "process",
            "fs",
            "host",
        ];
        let obj = object(value, "capabilities")?;
        for key in obj.keys().filter(|k| !KNOWN.contains(&k.as_str())) {
            match dropped.as_deref_mut() {
                // A capability of a newer runtime: not granted.
                Some(dropped) => dropped.push(format!("capabilities.{key}")),
                None => return Err(unknown_key("capabilities", key, &KNOWN)),
            }
        }
        let lenient = dropped.is_some();
        // The `http` grants dropped, recorded once `check` is done with
        // `dropped`.
        let mut http_dropped = Vec::new();
        // Whether `obj` (`what`) has only `keys`; lenient, an unknown key
        // drops `name` (what it is in): recorded, and `false` returned.
        let mut check = |obj: &Map<String, Value>,
                         what: &str,
                         keys: &[&str],
                         name: &str|
         -> Result<bool, String> {
            let Some(key) = obj.keys().find(|k| !keys.contains(&k.as_str())) else {
                return Ok(true);
            };
            match dropped.as_deref_mut() {
                Some(dropped) => {
                    dropped.push(format!("{name} (unknown key `{key}`)"));
                    Ok(false)
                }
                None => Err(unknown_key(what, key, keys)),
            }
        };
        let mut caps = Capabilities::default();
        if let Some(network) = obj.get("network") {
            let network = object(network, "capabilities.network")?;
            if check(
                network,
                "capabilities.network",
                &["hosts", "http", "sockets"],
                "capabilities.network",
            )? {
                if let Some(hosts) = network.get("hosts") {
                    caps.network.hosts = patterns(hosts, "capabilities.network.hosts")?;
                }
                if let Some(sockets) = network.get("sockets") {
                    caps.network.sockets = strings(sockets, "capabilities.network.sockets")?
                        .iter()
                        .map(|s| SocketGrant::new(s))
                        .collect::<Result<_, _>>()?;
                }
                if let Some(http) = network.get("http") {
                    let list = http
                        .as_array()
                        .ok_or("capabilities.network.http must be an array")?;
                    for (i, grant) in list.iter().enumerate() {
                        let name = format!("capabilities.network.http[{i}]");
                        let parsed = object(grant, "capabilities.network.http[]").and_then(|g| {
                            let keys = [
                                "host",
                                "methods",
                                "scheme",
                                "schemes",
                                "port",
                                "paths",
                                "pathPrefix",
                                "pathPrefixes",
                                "path_prefixes",
                            ];
                            Ok(
                                match check(g, "capabilities.network.http[]", &keys, &name)? {
                                    true => Some(http_grant(g)?),
                                    false => None,
                                },
                            )
                        });
                        match parsed {
                            Ok(Some(grant)) => caps.network.http.push(grant),
                            Ok(None) => {}
                            // Lenient: a grant of a form this runtime does
                            // not know is dropped alone.
                            Err(e) if lenient => http_dropped.push(format!("{name} ({e})")),
                            Err(e) => return Err(e),
                        }
                    }
                }
            }
        }
        if let Some(webview) = obj.get("webview") {
            let webview = object(webview, "capabilities.webview")?;
            if check(
                webview,
                "capabilities.webview",
                &["hosts", "input"],
                "capabilities.webview",
            )? {
                caps.webview = Some(match webview.get("hosts") {
                    Some(hosts) => patterns(hosts, "capabilities.webview.hosts")?,
                    None => Vec::new(),
                });
                if let Some(input) = webview.get("input") {
                    caps.webview_input = input
                        .as_bool()
                        .ok_or("capabilities.webview.input must be a boolean")?;
                }
            }
        }
        if let Some(status_bar) = obj.get("statusBar") {
            caps.status_bar = status_bar
                .as_bool()
                .ok_or("capabilities.statusBar must be a boolean")?;
        }
        if let Some(clipboard) = obj.get("clipboard") {
            caps.clipboard = clipboard
                .as_bool()
                .ok_or("capabilities.clipboard must be a boolean")?;
        }
        if let Some(picker) = obj.get("picker") {
            caps.picker = picker
                .as_bool()
                .ok_or("capabilities.picker must be a boolean")?;
        }
        if let Some(speech) = obj.get("speech") {
            caps.speech = speech
                .as_bool()
                .ok_or("capabilities.speech must be a boolean")?;
        }
        if let Some(notifications) = obj.get("notifications") {
            caps.notifications = notifications
                .as_bool()
                .ok_or("capabilities.notifications must be a boolean")?;
        }
        if let Some(audio) = obj.get("audio") {
            caps.audio = audio
                .as_bool()
                .ok_or("capabilities.audio must be a boolean")?;
        }
        if let Some(open_url) = obj.get("openUrl") {
            match open_url {
                Value::Bool(granted) => {
                    caps.open_url = granted.then(OpenUrlGrant::default);
                }
                Value::Object(grant) => {
                    if check(
                        grant,
                        "capabilities.openUrl",
                        &["schemes"],
                        "capabilities.openUrl",
                    )? {
                        let schemes = match grant.get("schemes") {
                            Some(schemes) => strings(schemes, "capabilities.openUrl.schemes")?,
                            None => Vec::new(),
                        };
                        if schemes.iter().any(|s| {
                            s.is_empty()
                                || !s.starts_with(|c: char| c.is_ascii_alphabetic())
                                || !s
                                    .chars()
                                    .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
                        }) {
                            return Err(
                                "capabilities.openUrl.schemes needs URL schemes (`https`, `mailto`)"
                                    .into(),
                            );
                        }
                        caps.open_url = Some(OpenUrlGrant {
                            schemes: schemes.iter().map(|s| s.to_ascii_lowercase()).collect(),
                        });
                    }
                }
                _ => {
                    return Err(
                        "capabilities.openUrl must be a boolean or an object of `schemes`".into(),
                    );
                }
            }
        }
        if let Some(process) = obj.get("process") {
            let process = object(process, "capabilities.process")?;
            if check(
                process,
                "capabilities.process",
                &["execute", "exit", "env"],
                "capabilities.process",
            )? {
                if let Some(execute) = process.get("execute") {
                    caps.process.execute = strings(execute, "capabilities.process.execute")?;
                    if caps.process.execute.iter().any(|s| !valid_command(s)) {
                        return Err("capabilities.process.execute needs exact executable names or absolute paths".into());
                    }
                }
                if let Some(exit) = process.get("exit") {
                    caps.process.exit = exit
                        .as_bool()
                        .ok_or("capabilities.process.exit must be a boolean")?;
                }
                if let Some(env) = process.get("env") {
                    caps.process.env = strings(env, "capabilities.process.env")?;
                    if caps
                        .process
                        .env
                        .iter()
                        .any(|name| name.is_empty() || name.contains(['=', '\0']))
                    {
                        return Err(
                            "capabilities.process.env needs nonempty environment variable names"
                                .into(),
                        );
                    }
                }
            }
        }
        if let Some(fs) = obj.get("fs") {
            let fs = object(fs, "capabilities.fs")?;
            if check(fs, "capabilities.fs", &["read", "write"], "capabilities.fs")? {
                for (key, target) in [("read", &mut caps.fs.read), ("write", &mut caps.fs.write)] {
                    if let Some(value) = fs.get(key) {
                        *target = strings(value, &format!("capabilities.fs.{key}"))?;
                        for root in target.iter() {
                            validate_path_pattern(root)?;
                        }
                    }
                }
            }
        }
        if let Some(windows) = obj.get("windows") {
            match windows {
                Value::Bool(granted) => caps.windows = granted.then(WindowsGrant::default),
                Value::Object(grant) => {
                    if check(
                        grant,
                        "capabilities.windows",
                        &["kinds", "levels", "max", "overlay"],
                        "capabilities.windows",
                    )? {
                        caps.windows = Some(windows_grant(grant)?);
                    }
                }
                _ => {
                    return Err(
                        "capabilities.windows must be a boolean or an object of `kinds`, `levels`, `max` and `overlay`"
                            .into(),
                    );
                }
            }
        }
        if let Some(host) = obj.get("host") {
            caps.host = match host {
                Value::Bool(all) => {
                    if *all {
                        vec!["*".into()]
                    } else {
                        Vec::new()
                    }
                }
                _ => {
                    let names = strings(host, "capabilities.host")
                        .map_err(|e| format!("{e} (or a boolean)"))?;
                    if let Some(bad) = names.iter().find(|n| match n.strip_suffix('*') {
                        Some(prefix) => !prefix.is_empty() && !valid_host_name(prefix),
                        None => !valid_host_name(n),
                    }) {
                        return Err(format!(
                            "capabilities.host: invalid function `{bad}` (a name of {HOST_NAME_CHARS}, or a prefix of them ending in `*`)"
                        ));
                    }
                    names
                }
            };
        }
        if let Some(dropped) = dropped {
            dropped.append(&mut http_dropped);
        }
        Ok(caps)
    }

    /// The JSON form [`Capabilities::from_json`] reads.
    pub fn to_json(&self) -> Value {
        let mut obj = self.to_json_without_windows();
        // Only when granted: older runtimes read what newer signers write.
        if let (Value::Object(obj), Some(w)) = (&mut obj, &self.windows) {
            let mut o = Map::new();
            if !w.kinds.is_empty() {
                o.insert(
                    "kinds".into(),
                    w.kinds
                        .iter()
                        .map(|k| window_kind_name(*k))
                        .collect::<Vec<_>>()
                        .into(),
                );
            }
            if !w.levels.is_empty() {
                o.insert(
                    "levels".into(),
                    w.levels
                        .iter()
                        .map(|l| window_level_name(*l))
                        .collect::<Vec<_>>()
                        .into(),
                );
            }
            if let Some(max) = w.max {
                o.insert("max".into(), max.into());
            }
            if w.overlay {
                o.insert("overlay".into(), true.into());
            }
            obj.insert("windows".into(), Value::Object(o));
        }
        obj
    }

    fn to_json_without_windows(&self) -> Value {
        let list =
            |l: &[HostPattern]| Value::from(l.iter().map(|p| p.0.clone()).collect::<Vec<_>>());
        let mut network = Map::new();
        network.insert("hosts".into(), list(&self.network.hosts));
        let http: Vec<Value> = self
            .network
            .http
            .iter()
            .map(|g| {
                let mut o = Map::new();
                o.insert("host".into(), g.host.0.clone().into());
                if !g.methods.is_empty() {
                    o.insert("methods".into(), g.methods.clone().into());
                }
                if !g.schemes.is_empty() {
                    o.insert("schemes".into(), g.schemes.clone().into());
                }
                if let Some(port) = g.port {
                    o.insert("port".into(), port.into());
                }
                if !g.paths.is_empty() {
                    o.insert("paths".into(), g.paths.clone().into());
                }
                if !g.path_prefixes.is_empty() {
                    o.insert("pathPrefixes".into(), g.path_prefixes.clone().into());
                }
                Value::Object(o)
            })
            .collect();
        network.insert("http".into(), http.into());
        if !self.network.sockets.is_empty() {
            let sockets: Vec<String> = self
                .network
                .sockets
                .iter()
                .map(SocketGrant::to_string_form)
                .collect();
            network.insert("sockets".into(), sockets.into());
        }
        let mut obj = Map::new();
        obj.insert("network".into(), Value::Object(network));
        obj.insert(
            "process".into(),
            serde_json::json!({"execute": self.process.execute, "exit": self.process.exit, "env": self.process.env}),
        );
        obj.insert(
            "fs".into(),
            serde_json::json!({"read": self.fs.read, "write": self.fs.write}),
        );
        if let Some(hosts) = &self.webview {
            let mut w = Map::new();
            w.insert("hosts".into(), list(hosts));
            // Only when granted: older runtimes read what newer signers write.
            if self.webview_input {
                w.insert("input".into(), true.into());
            }
            obj.insert("webview".into(), Value::Object(w));
        }
        obj.insert("statusBar".into(), self.status_bar.into());
        obj.insert("clipboard".into(), self.clipboard.into());
        obj.insert("picker".into(), self.picker.into());
        // Only when granted: older runtimes read what newer signers write.
        if self.speech {
            obj.insert("speech".into(), true.into());
        }
        if self.notifications {
            obj.insert("notifications".into(), true.into());
        }
        if self.audio {
            obj.insert("audio".into(), true.into());
        }
        if !self.host.is_empty() {
            obj.insert("host".into(), self.host.clone().into());
        }
        obj.insert(
            "openUrl".into(),
            match &self.open_url {
                None => false.into(),
                Some(grant) if grant.schemes.is_empty() => true.into(),
                Some(grant) => serde_json::json!({ "schemes": grant.schemes }),
            },
        );
        Value::Object(obj)
    }

    fn allows_http(&self, method: &str, url: &UrlParts<'_>) -> bool {
        if !matches!(url.scheme.as_str(), "http" | "https" | "ws" | "wss") {
            return false;
        }
        self.network.hosts.iter().any(|h| h.matches(&url.host))
            || self.network.http.iter().any(|g| g.allows(method, url))
    }

    fn allows_host(&self, name: &str) -> bool {
        self.host.iter().any(|g| match g.strip_suffix('*') {
            Some(prefix) => name.starts_with(prefix),
            None => g == name,
        })
    }

    fn allows_webview(&self, url: &UrlParts<'_>) -> bool {
        matches!(url.scheme.as_str(), "http" | "https")
            && self
                .webview
                .as_ref()
                .is_some_and(|hosts| hosts.iter().any(|h| h.matches(&url.host)))
    }
}

/// What host function names (`nsh/host`) are made of, for messages.
pub const HOST_NAME_CHARS: &str = "1 to 128 of A-Z a-z 0-9 _ . : -, without `..`";

/// Whether `name` may name a function of the embedding host: 1 to 128 of
/// `[A-Za-z0-9_.:-]`, without `..`. Hosts may put a name in a path or a URL,
/// so no name escapes the prefix a grant gives it.
pub fn valid_host_name(name: &str) -> bool {
    (1..=128).contains(&name.len())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
        && !name.contains("..")
}

fn valid_command(command: &str) -> bool {
    !command.is_empty()
        && !command.contains(['\0', '*'])
        && (Path::new(command).is_absolute()
            // A bare name has no drive (`C:git` is relative to the host's
            // directory on drive C).
            || (!command.contains(['/', '\\', ':']) && command != "." && command != ".."))
}

fn validate_path_pattern(path: &str) -> Result<(), String> {
    if [
        "$HOME",
        "${HOME}",
        "$USERPROFILE",
        "${USERPROFILE}",
        "%USERPROFILE%",
        "~",
    ]
    .into_iter()
    .any(|prefix| {
        path.strip_prefix(prefix)
            .is_some_and(|tail| tail.is_empty() || tail.starts_with(['/', '\\']))
    }) {
        return Err("use ${homeDir} for the native home directory".into());
    }
    let placeholder = ["${dataDir}", "${pluginDir}", "${homeDir}"]
        .into_iter()
        .find(|prefix| path.starts_with(prefix));
    let tail = placeholder.and_then(|prefix| path.strip_prefix(prefix));
    if path.is_empty()
        || path.contains(['\0', '*'])
        || tail.is_some_and(|s| !s.is_empty() && !s.starts_with('/'))
        || (placeholder.is_none() && path.contains("${"))
        || tail.is_some_and(|s| s.contains("${"))
        || Path::new(path)
            .components()
            .any(|p| matches!(p, Component::ParentDir))
    {
        return Err(
            "filesystem roots must use valid host placeholders and contain no traversal".into(),
        );
    }
    Ok(())
}

/// `path` resolved as [`std::fs::canonicalize`] resolves it, in the plain
/// form where Windows has one: canonicalizing there gives verbatim paths
/// (`\\?\C:\app`), which no path a host or app writes starts with, and
/// in which `/` separates nothing. Grants, requests and trusted anchors
/// are all compared in this form.
pub fn canonicalize(path: &Path) -> std::io::Result<PathBuf> {
    let path = std::fs::canonicalize(path)?;
    #[cfg(windows)]
    if let Some(plain) = path.to_str().and_then(without_verbatim_prefix) {
        return Ok(PathBuf::from(plain));
    }
    Ok(path)
}

/// The plain form of the Windows verbatim path `path` (`\\?\C:\a` →
/// `C:\a`, `\\?\UNC\server\share\a` → `\\server\share\a`), when it
/// names the same file: under the legacy length limit, and no component
/// that the plain form would read otherwise (empty, `.` or `..`, holding
/// `/`, ending in a dot or space, or a device name such as `NUL` or
/// `com1.txt`). `None` for any other path, which then stays as it is.
/// Text only, so its tests run on every platform.
#[cfg_attr(not(windows), allow(dead_code))]
fn without_verbatim_prefix(path: &str) -> Option<String> {
    let rest = path.strip_prefix(r"\\?\")?;
    let (plain, tail) = if let Some(unc) = rest.strip_prefix(r"UNC\") {
        (format!(r"\\{unc}"), unc)
    } else {
        let bytes = rest.as_bytes();
        if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || &bytes[1..3] != b":\\" {
            return None;
        }
        (rest.to_owned(), &rest[3..])
    };
    if plain.len() >= 260 {
        return None;
    }
    // A trailing separator ends a root (`C:\`) or a directory.
    let tail = tail.strip_suffix('\\').unwrap_or(tail);
    let device = |name: &str| {
        let stem = name.split('.').next().unwrap_or(name).trim_end();
        ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
            .iter()
            .any(|d| stem.eq_ignore_ascii_case(d))
            || (stem.len() == 4
                && ["COM", "LPT"]
                    .iter()
                    .any(|d| stem[..3].eq_ignore_ascii_case(d))
                && matches!(stem.as_bytes()[3], b'1'..=b'9'))
    };
    let plain_component = |c: &str| {
        !c.is_empty()
            && c != "."
            && c != ".."
            && !c.contains('/')
            && !c.ends_with(['.', ' '])
            && !device(c)
    };
    (tail.is_empty() || tail.split('\\').all(plain_component)).then_some(plain)
}

// Resolve every existing ancestor, including symlinks. Missing tails are
// permitted so creation receives the same boundary checks as reads.
/// Why [`Access::authorize_file`] refused a path.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum FileRefusal {
    /// It names no file it can check: relative, with `..`, an unknown
    /// anchor, or unreadable (why).
    Invalid(String),
    /// No grant of the capabilities covers it (why).
    NotGranted(String),
}

impl std::fmt::Display for FileRefusal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileRefusal::Invalid(why) | FileRefusal::NotGranted(why) => f.write_str(why),
        }
    }
}

fn resolved_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.components().any(|p| matches!(p, Component::ParentDir)) {
        return Err("filesystem paths must be absolute and contain no parent traversal".into());
    }
    let mut cursor = path;
    let mut tail = Vec::new();
    loop {
        match std::fs::symlink_metadata(cursor) {
            Ok(_) => {
                let mut resolved = canonicalize(cursor).map_err(|e| e.to_string())?;
                for part in tail.into_iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                tail.push(
                    cursor
                        .file_name()
                        .ok_or("invalid filesystem path")?
                        .to_owned(),
                );
                cursor = cursor.parent().ok_or("invalid filesystem path")?;
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

fn object<'a>(value: &'a Value, what: &str) -> Result<&'a Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| format!("{what} must be an object"))
}

const WINDOW_KINDS: [(&str, crate::desktop::WindowKind); 5] = [
    ("normal", crate::desktop::WindowKind::Normal),
    ("dialog", crate::desktop::WindowKind::Dialog),
    ("panel", crate::desktop::WindowKind::Panel),
    ("popup", crate::desktop::WindowKind::Popup),
    ("overlay", crate::desktop::WindowKind::Overlay),
];

const WINDOW_LEVELS: [(&str, crate::desktop::WindowLevel); 4] = [
    ("normal", crate::desktop::WindowLevel::Normal),
    ("floating", crate::desktop::WindowLevel::Floating),
    ("aboveDock", crate::desktop::WindowLevel::AboveDock),
    ("desktopIcon", crate::desktop::WindowLevel::DesktopIcon),
];

fn window_kind_name(kind: crate::desktop::WindowKind) -> &'static str {
    WINDOW_KINDS
        .iter()
        .find(|(_, k)| *k == kind)
        .map_or("normal", |(n, _)| n)
}

fn window_level_name(level: crate::desktop::WindowLevel) -> &'static str {
    WINDOW_LEVELS
        .iter()
        .find(|(_, l)| *l == level)
        .map_or("normal", |(n, _)| n)
}

/// `capabilities.windows` as an object.
fn windows_grant(grant: &Map<String, Value>) -> Result<WindowsGrant, String> {
    let mut out = WindowsGrant::default();
    if let Some(kinds) = grant.get("kinds") {
        for name in strings(kinds, "capabilities.windows.kinds")? {
            let Some((_, kind)) = WINDOW_KINDS.iter().find(|(n, _)| *n == name) else {
                return Err(format!(
                    "capabilities.windows.kinds: unknown kind `{name}` (normal, dialog, panel, popup or overlay)"
                ));
            };
            out.kinds.push(*kind);
        }
    }
    if let Some(levels) = grant.get("levels") {
        for name in strings(levels, "capabilities.windows.levels")? {
            let Some((_, level)) = WINDOW_LEVELS.iter().find(|(n, _)| *n == name) else {
                return Err(format!(
                    "capabilities.windows.levels: unknown level `{name}` (normal, floating, aboveDock or desktopIcon)"
                ));
            };
            out.levels.push(*level);
        }
    }
    if let Some(max) = grant.get("max") {
        out.max = Some(
            max.as_u64()
                .and_then(|m| u32::try_from(m).ok())
                .ok_or("capabilities.windows.max must be a whole number")?,
        );
    }
    if let Some(v) = grant.get("overlay") {
        out.overlay = v
            .as_bool()
            .ok_or("capabilities.windows.overlay must be a boolean")?;
    }
    Ok(out)
}

fn unknown_key(what: &str, key: &str, known: &[&str]) -> String {
    format!("{what}: unknown key `{key}` (known: {})", known.join(", "))
}

fn strings(value: &Value, what: &str) -> Result<Vec<String>, String> {
    value
        .as_array()
        .and_then(|a| a.iter().map(|v| v.as_str().map(str::to_owned)).collect())
        .ok_or_else(|| format!("{what} must be an array of strings"))
}

/// One `network.http` rule: `host`, and any of `methods`, `scheme` /
/// `schemes`, `port`, `paths` and `pathPrefix` / `pathPrefixes` /
/// `path_prefixes` (the spellings of one key are merged).
fn http_grant(g: &Map<String, Value>) -> Result<HttpGrant, String> {
    let what = "capabilities.network.http[]";
    let host = g
        .get("host")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{what} needs a `host`"))?;
    // A key as a string or an array of strings.
    let list = |key: &str| -> Result<Vec<String>, String> {
        match g.get(key) {
            None => Ok(Vec::new()),
            Some(Value::String(s)) => Ok(vec![s.clone()]),
            Some(v) => strings(v, &format!("{what}.{key}")),
        }
    };
    let methods = list("methods")?
        .into_iter()
        .map(|m| {
            if !m.is_empty() && m.bytes().all(|b| b.is_ascii_alphabetic() || b == b'-') {
                Ok(m.to_ascii_uppercase())
            } else {
                Err(format!("{what}.methods: `{m}` is not an HTTP method"))
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut schemes = Vec::new();
    for scheme in list("scheme")?.into_iter().chain(list("schemes")?) {
        let scheme = scheme.to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https" | "ws" | "wss") {
            return Err(format!(
                "{what}.schemes: `{scheme}` is not http, https, ws or wss"
            ));
        }
        if !schemes.contains(&scheme) {
            schemes.push(scheme);
        }
    }
    let port = match g.get("port") {
        None => None,
        Some(v) => Some(
            v.as_u64()
                .and_then(|p| u16::try_from(p).ok())
                .filter(|&p| p != 0)
                .ok_or_else(|| format!("{what}.port must be a port from 1 to 65535"))?,
        ),
    };
    let paths = list("paths")?;
    let mut path_prefixes = Vec::new();
    for prefix in list("pathPrefix")?
        .into_iter()
        .chain(list("pathPrefixes")?)
        .chain(list("path_prefixes")?)
    {
        if !path_prefixes.contains(&prefix) {
            path_prefixes.push(prefix);
        }
    }
    // A path is matched as written: a pattern in it would match nothing.
    if let Some(bad) = paths
        .iter()
        .chain(&path_prefixes)
        .find(|p| !p.starts_with('/') || p.contains(['*', '?', '#']))
    {
        return Err(format!(
            "{what}: path `{bad}` must start with / and has no `*`, `?` or `#` (paths match as written)"
        ));
    }
    Ok(HttpGrant {
        host: HostPattern::new(host)?,
        methods,
        schemes,
        port,
        paths,
        path_prefixes,
    })
}

fn patterns(value: &Value, what: &str) -> Result<Vec<HostPattern>, String> {
    strings(value, what)?
        .iter()
        .map(|p| HostPattern::new(p))
        .collect()
}

/// What an app may do: its declaration and the embedder's grant (when the
/// embedder limits it); an action must be allowed by both.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Access {
    /// What the app declared (everything without a declaration).
    pub declared: Capabilities,
    /// What the embedding app grants it at most (`None`: what it declared).
    pub granted: Option<Capabilities>,
}

impl Default for Access {
    fn default() -> Self {
        Self::all()
    }
}

impl Access {
    /// Everything allowed.
    pub fn all() -> Self {
        Self {
            declared: Capabilities::all(),
            granted: None,
        }
    }

    fn each(&self, f: impl Fn(&Capabilities) -> bool) -> bool {
        f(&self.declared) && self.granted.as_ref().is_none_or(f)
    }

    /// True when nothing is restricted (no check needed, redirects may be
    /// followed by the platform).
    pub fn is_unrestricted(&self) -> bool {
        let all = Capabilities::all();
        self.declared == all && self.granted.as_ref().is_none_or(|g| *g == all)
    }

    /// Whether an exact command is declared and granted. These capabilities
    /// always require explicit opt-in, including for legacy standalone apps.
    pub fn allows_process(&self, command: &str) -> bool {
        valid_command(command) && self.each(|c| c.process.execute.iter().any(|p| p == command))
    }

    /// Whether the app may request an exit from its host. This never exits the
    /// embedding process by itself; the host supplies the meaning of the request.
    pub fn allows_exit(&self) -> bool {
        self.each(|caps| caps.process.exit)
    }

    /// Whether an environment variable is visible. The built-in metadata names
    /// are always visible; other names require both app and host permission.
    pub fn allows_env(&self, name: &str) -> bool {
        let defaults = include_str!("default-env").lines().filter_map(|line| {
            let name = line.split('#').next().unwrap_or_default().trim();
            (!name.is_empty()).then_some(name)
        });
        defaults
            .into_iter()
            .any(|allowed| env_names_match(allowed, name))
            || self.each(|caps| {
                caps.process
                    .env
                    .iter()
                    .any(|allowed| env_names_match(allowed, name))
            })
    }

    /// Resolve a filesystem path within both the declaration and host grant.
    /// `data_dir` is an app-specific directory supplied only by the host.
    pub fn authorize_file(
        &self,
        path: &Path,
        data_dir: &Path,
        write: bool,
    ) -> Result<PathBuf, FileRefusal> {
        self.authorize_file_with_paths(path, data_dir, &TrustedPaths::default(), write)
    }

    /// Authorize a file with trusted host source and home directory anchors.
    pub fn authorize_file_with_paths(
        &self,
        path: &Path,
        data_dir: &Path,
        paths: &TrustedPaths,
        write: bool,
    ) -> Result<PathBuf, FileRefusal> {
        let requested = if let Some(text) = path.to_str().filter(|s| s.starts_with("${")) {
            paths
                .resolve_root(text, data_dir)
                .map_err(FileRefusal::Invalid)?
        } else {
            path.to_owned()
        };
        let resolved = resolved_path(&requested).map_err(FileRefusal::Invalid)?;
        let allowed = self.each(|c| {
            let roots = if write { &c.fs.write } else { &c.fs.read };
            roots.iter().any(|root| {
                paths
                    .resolve_root(root, data_dir)
                    .and_then(|r| resolved_path(&r))
                    .is_ok_and(|root| resolved.starts_with(root))
            })
        });
        if allowed {
            Ok(resolved)
        } else {
            Err(FileRefusal::NotGranted(format!(
                "filesystem {} is not granted by capabilities.fs",
                if write { "write" } else { "read" }
            )))
        }
    }

    /// Whether a raw TCP connection to `host:port` may be opened: only an
    /// exact `network.sockets` grant allows it, never `hosts` or `http`
    /// grants, and [`Capabilities::all`] grants none.
    pub fn allows_socket(&self, host: &str, port: u16) -> bool {
        if host.is_empty() || host.contains(['/', '@', '?', '#', '\0']) {
            return false;
        }
        let host = host.to_ascii_lowercase();
        let host = host
            .strip_prefix('[')
            .and_then(|h| h.strip_suffix(']'))
            .unwrap_or(&host)
            .trim_end_matches('.');
        self.each(|c| {
            c.network
                .sockets
                .iter()
                .any(|grant| grant.port == port && grant.host == host)
        })
    }

    /// Whether a WebSocket to `url` (`ws:` / `wss:`) may connect. The
    /// handshake is an HTTP GET, so it is checked as a GET of the same URL
    /// over `http:` / `https:`; legacy rules may also list `ws` / `wss`.
    pub fn allows_websocket(&self, url: &str) -> bool {
        let http = if let Some(rest) = url.strip_prefix("wss:") {
            format!("https:{rest}")
        } else if let Some(rest) = url.strip_prefix("ws:") {
            format!("http:{rest}")
        } else {
            return false;
        };
        self.allows_http("GET", &http) || self.allows_http("GET", url)
    }

    /// Whether `fetch(url, { method })` may go out. `asset:` URIs are always
    /// allowed.
    pub fn allows_http(&self, method: &str, url: &str) -> bool {
        if url.starts_with("asset:") {
            return true;
        }
        let Some(parts) = parse_url(url) else {
            return false;
        };
        self.each(|c| c.allows_http(method, &parts))
    }

    /// Whether a media URL (image, video, canvas image) may be loaded.
    /// Relative and `asset:` URIs are the app's own files; `data:` URIs and
    /// `blob:` URLs (`URL.createObjectURL`) are bytes the app already has.
    pub fn allows_media(&self, uri: &str) -> bool {
        if !uri.contains("://")
            || uri.starts_with("asset:")
            || uri.starts_with("data:")
            || uri.starts_with("blob:")
        {
            return true;
        }
        self.allows_http("GET", uri)
    }

    /// The next URL of a media load that was redirected from `base` to
    /// `location`, if the app may load it: the redirect must stay on
    /// `http(s)` and pass the same check as a first request, so loaders
    /// follow redirects themselves, one hop at a time, and never contact
    /// a target the app is not granted.
    pub fn media_redirect(&self, base: &str, location: &str) -> Result<String, String> {
        let url = resolve_reference(base, location);
        if !(url.starts_with("http://") || url.starts_with("https://")) {
            return Err(format!("redirect to `{url}` is not an http(s) URL"));
        }
        if !self.is_unrestricted() && !self.allows_media(&url) {
            return Err(format!(
                "redirect to `{url}` is not granted by capabilities.network"
            ));
        }
        Ok(url)
    }

    /// Whether web views are granted at all (inline HTML needs only this).
    pub fn allows_webviews(&self) -> bool {
        self.each(|c| c.webview.is_some())
    }

    /// Whether a web view may show (or navigate to) `url`; `about:blank`
    /// whenever web views are granted.
    pub fn allows_webview(&self, url: &str) -> bool {
        if url == "about:blank" {
            return self.allows_webviews();
        }
        let Some(parts) = parse_url(url) else {
            return false;
        };
        self.each(|c| c.allows_webview(&parts))
    }

    /// Whether a web view's ref may give its page trusted input
    /// (`sendInput`): declared and granted, never by default.
    pub fn allows_web_input(&self) -> bool {
        self.each(|c| c.webview.is_some() && c.webview_input)
    }

    /// Whether the app may open a window of `kind` with `attributes` (its
    /// own, before its kind's defaults) while `open` windows besides the
    /// main one are open; the message of the refusal otherwise (the call
    /// fails with `ERR_ACCESS_DENIED`, permission `windows`).
    pub fn check_window(
        &self,
        kind: crate::desktop::WindowKind,
        attributes: &crate::desktop::WindowAttributes,
        open: usize,
    ) -> Result<(), String> {
        if !self.each(|c| c.windows.is_some()) {
            return Err("windows of the app's own are not granted by capabilities.windows".into());
        }
        if !self.each(|c| c.windows.as_ref().is_some_and(|w| w.allows_kind(kind))) {
            return Err(format!(
                "a window of kind `{}` is not granted by capabilities.windows{}",
                window_kind_name(kind),
                if kind == crate::desktop::WindowKind::Overlay {
                    " (overlays need `overlay: true`)"
                } else {
                    ""
                }
            ));
        }
        if !self.each(|c| {
            c.windows
                .as_ref()
                .is_some_and(|w| w.max.is_none_or(|max| open < max as usize))
        }) {
            return Err("capabilities.windows.max windows are open already".into());
        }
        let mut own = attributes.clone();
        // The kind's own level is granted with the kind.
        let level = own.level.take();
        let denied = self.deny_window_attributes(&mut own);
        if let Some(name) = denied.first() {
            return Err(format!(
                "the window attribute `{name}` is not granted by capabilities.windows"
            ));
        }
        if let Some(level) = level
            && !self.each(|c| c.windows.as_ref().is_some_and(|w| w.allows_level(level)))
        {
            return Err(format!(
                "the window level `{}` is not granted by capabilities.windows.levels",
                window_level_name(level)
            ));
        }
        Ok(())
    }

    /// Leaves out of `attributes` what the app's capabilities do not grant
    /// a window (an ungranted level, click-through without `overlay`) and
    /// returns their
    /// names, for a warning. The main window needs no `windows` grant for
    /// the rest.
    pub fn deny_window_attributes(
        &self,
        attributes: &mut crate::desktop::WindowAttributes,
    ) -> Vec<&'static str> {
        let mut denied = Vec::new();
        let grant = |f: &dyn Fn(&WindowsGrant) -> bool| {
            self.each(|c| match &c.windows {
                Some(w) => f(w),
                // Without windows the main window keeps the safe defaults.
                None => false,
            })
        };
        if let Some(level) = attributes.level
            && level != crate::desktop::WindowLevel::Normal
            && !grant(&|w| w.allows_level(level))
        {
            attributes.level = None;
            denied.push("level");
        }
        if attributes.passes_pointer() && !grant(&|w| w.overlay) {
            attributes.pointer_events = None;
            denied.push("pointerEvents");
        }
        denied
    }

    /// Whether the app may set the status bar.
    pub fn allows_status_bar(&self) -> bool {
        self.each(|c| c.status_bar)
    }

    /// Whether the app may read and write the system clipboard.
    pub fn allows_clipboard(&self) -> bool {
        self.each(|c| c.clipboard)
    }

    /// Whether the app may show the system's picker (`nsh/picker`).
    pub fn allows_picker(&self) -> bool {
        self.each(|c| c.picker)
    }

    /// Whether the app may recognize the user's speech (`Speech` of `nsh`).
    pub fn allows_speech(&self) -> bool {
        self.each(|c| c.speech)
    }

    /// Whether the app may show notifications and set its badge
    /// (`Notifications` of `nsh`).
    pub fn allows_notifications(&self) -> bool {
        self.each(|c| c.notifications)
    }

    /// Whether the app may play sound (`Sound` and `AudioPlayer` of `nsh`).
    pub fn allows_audio(&self) -> bool {
        self.each(|c| c.audio)
    }

    /// Whether `nsh/host` may call the embedding app's function `name`.
    pub fn allows_host(&self, name: &str) -> bool {
        self.each(|c| c.allows_host(name))
    }

    /// Whether the app may open `url` outside it (`openUrl` of
    /// `nsh/device`): its scheme is granted.
    pub fn allows_open_url(&self, url: &str) -> bool {
        let Some(scheme) = url
            .split_once(':')
            .map(|(scheme, _)| scheme.to_ascii_lowercase())
        else {
            return false;
        };
        self.each(|c| c.open_url.as_ref().is_some_and(|g| g.allows(&scheme)))
    }
}

/// `location` against `base` (absolute, scheme-relative, absolute-path or
/// relative references), as a redirect's `Location` is read.
pub fn resolve_reference(base: &str, location: &str) -> String {
    if location.contains("://") {
        return location.to_owned();
    }
    let Some((scheme, rest)) = base.split_once("://") else {
        return location.to_owned();
    };
    if let Some(net) = location.strip_prefix("//") {
        return format!("{scheme}://{net}");
    }
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let origin = format!("{scheme}://{}", &rest[..authority_end]);
    if location.starts_with('/') {
        return format!("{origin}{location}");
    }
    let path = &rest[authority_end..];
    let path = path.split(['?', '#']).next().unwrap_or_default();
    let dir = path.rsplit_once('/').map_or("", |(d, _)| d);
    format!("{origin}{dir}/{location}")
}

#[cfg(test)]
mod tests {
    #[test]
    fn verbatim_windows_paths_compare_in_their_plain_form() {
        use super::without_verbatim_prefix as plain;
        assert_eq!(plain(r"\\?\C:\Users\a").as_deref(), Some(r"C:\Users\a"));
        assert_eq!(plain(r"\\?\d:\").as_deref(), Some(r"d:\"));
        assert_eq!(plain(r"\\?\C:\app\").as_deref(), Some(r"C:\app\"));
        assert_eq!(
            plain(r"\\?\UNC\server\share\a").as_deref(),
            Some(r"\\server\share\a")
        );
        // Plain paths, and verbatim ones of other kinds, stay as they are.
        for path in [
            r"C:\a",
            r"\\server\share",
            "/home/a",
            r"\\?\Volume{x}\a",
            r"\\.\C:\a",
        ] {
            assert_eq!(plain(path), None, "{path}");
        }
        // Components the plain form reads otherwise keep the verbatim form.
        for path in [
            r"\\?\C:\a\NUL",
            r"\\?\C:\a\com1.txt",
            r"\\?\C:\a\Lpt9",
            r"\\?\C:\a\b.",
            r"\\?\C:\a\b ",
            r"\\?\C:\a\..\b",
            r"\\?\C:\a\.\b",
            r"\\?\C:\a\\b",
            r"\\?\C:\a/b",
        ] {
            assert_eq!(plain(path), None, "{path}");
        }
        assert_eq!(
            plain(r"\\?\C:\a\com10\console").as_deref(),
            Some(r"C:\a\com10\console")
        );
        let long = format!(r"\\?\C:\{}", "a".repeat(260));
        assert_eq!(plain(&long), None);
    }

    #[test]
    fn anchored_roots_join_their_tail_component_by_component() {
        let app = PathBuf::from(if cfg!(windows) { r"C:\app" } else { "/app" });
        let paths = super::TrustedPaths {
            plugin_dir: Some(app.clone()),
            home_dir: None,
        };
        let root = paths.resolve_root("${pluginDir}/a//b/", &app).unwrap();
        assert_eq!(root, app.join("a").join("b"));
        let names = root.components().rev().take(2).collect::<Vec<_>>();
        assert_eq!(
            names,
            [
                Component::Normal("b".as_ref()),
                Component::Normal("a".as_ref())
            ]
        );
    }
    use super::*;

    fn caps(json: &str) -> Capabilities {
        Capabilities::from_json(&serde_json::from_str(json).unwrap()).unwrap()
    }

    #[test]
    fn windows_are_granted_by_kind_level_and_count() {
        use crate::desktop::{WindowAttributes, WindowKind, WindowLevel, WindowPointerEvents};
        let none = WindowAttributes::default();
        // Without a declaration: every kind but overlays, no click-through,
        // no capture protection.
        let all = Access::all();
        assert!(all.check_window(WindowKind::Panel, &none, 10).is_ok());
        assert!(all.check_window(WindowKind::Overlay, &none, 0).is_err());
        let click_through = WindowAttributes {
            pointer_events: Some(WindowPointerEvents::None),
            ..Default::default()
        };
        assert!(
            all.check_window(WindowKind::Normal, &click_through, 0)
                .is_err()
        );
        // Declared without `windows`: none.
        let declared = |json: &str| Access {
            declared: caps(json),
            granted: None,
        };
        assert!(
            declared(r#"{"process":{"exit":true}}"#)
                .check_window(WindowKind::Normal, &none, 0)
                .is_err()
        );
        let limited = declared(
            r#"{"windows":{"kinds":["normal","dialog"],"levels":["normal","floating"],"max":2}}"#,
        );
        assert!(limited.check_window(WindowKind::Dialog, &none, 1).is_ok());
        assert!(limited.check_window(WindowKind::Popup, &none, 0).is_err());
        assert!(limited.check_window(WindowKind::Normal, &none, 2).is_err());
        let above = WindowAttributes {
            level: Some(WindowLevel::AboveDock),
            ..Default::default()
        };
        assert!(limited.check_window(WindowKind::Normal, &above, 0).is_err());
        let overlay = declared(r#"{"windows":{"overlay":true}}"#);
        assert!(
            overlay
                .check_window(WindowKind::Overlay, &click_through, 0)
                .is_ok()
        );
        // `set()` keeps what is granted and leaves out the rest.
        let mut asked = WindowAttributes {
            title: Some("Notes".into()),
            level: Some(WindowLevel::AboveDock),
            ..Default::default()
        };
        assert_eq!(limited.deny_window_attributes(&mut asked), ["level"]);
        assert_eq!(asked.title.as_deref(), Some("Notes"));
        assert_eq!(asked.level, None);
    }

    #[test]
    fn environment_names_match_exactly_except_on_windows() {
        let access = Access {
            declared: caps(r#"{"process":{"env":["MY_TOKEN"]}}"#),
            granted: None,
        };
        assert!(access.allows_env("MY_TOKEN"));
        assert_eq!(access.allows_env("my_token"), cfg!(windows));
        assert_eq!(super::env_names_match("Path", "PATH"), cfg!(windows));
    }

    #[test]
    fn roots_stay_within_their_anchor_and_bare_commands_have_no_drive() {
        let anchor = Path::new(if cfg!(windows) { "C:\\app" } else { "/app" });
        assert!(super::within(anchor, Path::new("data/x"), "r").is_ok());
        assert!(super::within(anchor, Path::new("/etc"), "r").is_err());
        #[cfg(windows)]
        for tail in ["C:/Windows", "\\\\srv\\share", "\\Users", "D:x"] {
            assert!(
                super::within(anchor, Path::new(tail), "r").is_err(),
                "{tail}"
            );
        }
        assert!(!super::valid_command("C:git"));
        assert!(super::valid_command("git"));
    }

    #[test]
    fn system_capabilities_are_explicit_and_intersected() {
        let declared = caps(
            r#"{"process":{"execute":["claude","codex"]},"fs":{"read":["${dataDir}"],"write":["${dataDir}"]}}"#,
        );
        assert_eq!(
            Capabilities::from_json(&declared.to_json()).unwrap(),
            declared
        );
        let access = Access {
            declared,
            granted: Some(caps(
                r#"{"process":{"execute":["codex"]},"fs":{"read":["${dataDir}/conversations"]}}"#,
            )),
        };
        assert!(access.allows_process("codex"));
        assert!(!access.allows_process("claude"));
        assert!(!access.allows_process("/usr/bin/codex"));
        assert!(!Access::all().allows_process("codex"));
        let root = std::env::current_dir().unwrap();
        assert!(
            access
                .authorize_file(&root.join("conversations/new.json"), &root, false)
                .is_ok()
        );
        assert!(
            access
                .authorize_file(&root.join("other.json"), &root, false)
                .is_err()
        );
        assert!(
            access
                .authorize_file(&root.join("conversations/new.json"), &root, true)
                .is_err()
        );
        assert!(Access::all().authorize_file(&root, &root, false).is_err());
        assert!(
            access
                .authorize_file(&root.join("../secret"), &root, false)
                .is_err()
        );
        for bad in [
            r#"{"process":{"execut":[]}}"#,
            r#"{"fs":{"reads":[]}}"#,
            r#"{"fs":{"read":["${dataDir}/../outside"]}}"#,
            r#"{"process":{"execute":["*"]}}"#,
        ] {
            assert!(Capabilities::from_json(&serde_json::from_str(bad).unwrap()).is_err());
        }
    }

    #[test]
    fn trusted_host_anchors_expand_without_implicit_grants() {
        let root = std::env::current_dir().unwrap();
        let anchors = TrustedPaths {
            plugin_dir: Some(root.clone()),
            home_dir: Some(root.join("native-home")),
        };
        let access = Access {
            declared: caps(
                r#"{"fs":{"read":["assets","${homeDir}/settings","${pluginDir}/content"]}}"#,
            ),
            granted: None,
        };
        for path in ["assets/file", "native-home/settings/file", "content/file"] {
            assert!(
                access
                    .authorize_file_with_paths(&root.join(path), &root, &anchors, false)
                    .is_ok()
            );
        }
        assert!(
            access
                .authorize_file(&root.join("content/file"), &root, false)
                .is_err()
        );
        assert!(
            access
                .authorize_file_with_paths(&root.join("other/file"), &root, &anchors, false)
                .is_err()
        );
        assert!(
            TrustedPaths::default()
                .resolve_root("${homeDir}/settings", &root)
                .is_err()
        );
        assert!(
            TrustedPaths::default()
                .resolve_root("assets", &root)
                .is_err()
        );
    }

    #[test]
    fn http_rules_are_one_form_whose_keys_all_narrow() {
        let allows = |rule: serde_json::Value, method: &str, url: &str| {
            Access {
                declared: Capabilities::from_json(&serde_json::json!({"network":{"http":[rule]}}))
                    .unwrap(),
                granted: None,
            }
            .allows_http(method, url)
        };
        // `{host, methods}` covers every path, scheme and port, as manifests had it.
        let plain = serde_json::json!({"host": "api.example.com", "methods": ["GET"]});
        assert!(allows(plain.clone(), "GET", "https://api.example.com/"));
        assert!(allows(
            plain.clone(),
            "GET",
            "http://api.example.com:8080/any/path"
        ));
        assert!(!allows(plain.clone(), "POST", "https://api.example.com/"));
        assert!(allows(
            serde_json::json!({"host": "api.example.com"}),
            "PUT",
            "https://api.example.com/x"
        ));
        // Paths are exact, prefixes whole segments; either one covers a path.
        let scoped = serde_json::json!({
            "host": "api.example.com", "methods": ["GET"], "scheme": "https", "port": 443,
            "paths": ["/exact"], "pathPrefixes": ["/v1"]
        });
        assert!(allows(
            scoped.clone(),
            "GET",
            "https://api.example.com/exact?q=1"
        ));
        assert!(allows(scoped.clone(), "GET", "https://api.example.com/v1"));
        assert!(allows(
            scoped.clone(),
            "GET",
            "https://api.example.com/v1/child"
        ));
        assert!(!allows(
            scoped.clone(),
            "GET",
            "https://api.example.com/v10"
        ));
        assert!(!allows(
            scoped.clone(),
            "GET",
            "https://api.example.com/exact/more"
        ));
        assert!(!allows(
            scoped.clone(),
            "GET",
            "http://api.example.com/exact"
        ));
        assert!(!allows(
            scoped.clone(),
            "GET",
            "https://api.example.com:444/exact"
        ));
        assert!(allows(scoped, "GET", "https://api.example.com:443/exact"));
        // Main's spelling still reads, and a prefix ending in `/` covers what follows it.
        let legacy = serde_json::json!({"host": "*.example.com", "schemes": ["https", "wss"], "pathPrefix": "/v1/"});
        assert!(allows(
            legacy.clone(),
            "GET",
            "https://quotes.example.com/v1/quote"
        ));
        assert!(!allows(legacy, "GET", "https://quotes.example.com/v2/"));
        // Every spelling of a key is merged, and one form is written back.
        let mixed = caps(
            r#"{"network":{"http":[{"host":"a.example.com","methods":["get"],"scheme":"https","schemes":["wss","https"],"pathPrefix":"/a","path_prefixes":["/b"],"pathPrefixes":["/a","/c"]}]}}"#,
        );
        let grant = &mixed.network.http[0];
        assert_eq!(grant.methods, ["GET"]);
        assert_eq!(grant.schemes, ["https", "wss"]);
        assert_eq!(grant.path_prefixes, ["/a", "/c", "/b"]);
        assert_eq!(
            mixed.to_json()["network"]["http"][0],
            serde_json::json!({"host":"a.example.com","methods":["GET"],"schemes":["https","wss"],"pathPrefixes":["/a","/c","/b"]})
        );
        assert_eq!(Capabilities::from_json(&mixed.to_json()).unwrap(), mixed);
        // What cannot match is an error, not a rule that grants nothing.
        for bad in [
            serde_json::json!({"host": "a.example.com", "schemes": ["ftp"]}),
            serde_json::json!({"host": "a.example.com", "port": 0}),
            serde_json::json!({"host": "a.example.com", "port": 70000}),
            serde_json::json!({"host": "a.example.com", "paths": ["relative"]}),
            serde_json::json!({"host": "a.example.com", "pathPrefixes": ["/v1/*"]}),
            serde_json::json!({"host": "a.example.com", "methods": ["*"]}),
            serde_json::json!({"host": "a.example.com", "paths": "/x", "query": true}),
            serde_json::json!({"methods": ["GET"]}),
        ] {
            assert!(
                Capabilities::from_json(&serde_json::json!({"network":{"http":[bad.clone()]}}))
                    .is_err(),
                "{bad}"
            );
        }
    }

    #[test]
    fn exit_and_environment_permissions_intersect() {
        let declared = caps(r#"{"process":{"env":["NSH_SECRET","OTHER"],"exit":true}}"#);
        assert_eq!(
            Capabilities::from_json(&declared.to_json()).unwrap(),
            declared
        );
        let access = Access {
            declared,
            granted: Some(caps(r#"{"process":{"env":["NSH_SECRET"]}}"#)),
        };
        assert!(access.allows_env("NSH_SECRET"));
        assert!(!access.allows_env("OTHER"));
        assert!(!access.allows_exit());
        assert!(!Access::all().allows_exit());
        assert!(!Access::all().allows_env("NSH_SECRET"));
        assert!(Access::all().allows_env("LANG"));
        assert_eq!(Access::all().allows_env("lang"), cfg!(windows));
        assert!(Access::all().allows_env("TZ"));
        // Identity, paths and proxy credentials need an explicit grant.
        for name in [
            "HOME",
            "USER",
            "USERNAME",
            "HOSTNAME",
            "COMPUTERNAME",
            "PATH",
            "TMPDIR",
            "XDG_RUNTIME_DIR",
            "APPDATA",
            "http_proxy",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "NO_PROXY",
            "DISPLAY",
        ] {
            assert!(!Access::all().allows_env(name), "{name}");
        }
        assert!(!Access::all().allows_env("SSH_AUTH_SOCK"));
        assert!(!Access::all().allows_env("DBUS_SESSION_BUS_ADDRESS"));
        assert!(Capabilities::from_json(&serde_json::json!({"process":{"exit":"true"}})).is_err());
        assert!(
            Capabilities::from_json(&serde_json::json!({"process":{"env":["BAD=NAME"]}})).is_err()
        );
    }

    #[test]
    fn default_environment_entries_are_upper_case_names() {
        for line in include_str!("default-env").lines() {
            let name = line.split('#').next().unwrap_or_default().trim();
            assert!(
                name.is_empty()
                    || name
                        .chars()
                        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_'),
                "{line}"
            );
        }
    }

    #[test]
    fn sockets_need_exact_host_and_port_grants() {
        let declared = caps(
            r#"{"network":{"hosts":["*"],"sockets":["MQTT.example.com:8883","[::1]:9000","127.0.0.1:22"]}}"#,
        );
        assert_eq!(
            Capabilities::from_json(&declared.to_json()).unwrap(),
            declared
        );
        let access = Access {
            declared,
            granted: None,
        };
        assert!(access.allows_socket("mqtt.example.com", 8883));
        assert!(access.allows_socket("MQTT.example.com.", 8883));
        assert!(!access.allows_socket("mqtt.example.com", 1883));
        assert!(!access.allows_socket("example.com", 8883));
        assert!(!access.allows_socket("a.mqtt.example.com", 8883));
        assert!(access.allows_socket("::1", 9000));
        assert!(access.allows_socket("[::1]", 9000));
        assert!(access.allows_socket("127.0.0.1", 22));
        assert!(!access.allows_socket("127.0.0.1", 0));
        // `hosts: ["*"]` (and the unrestricted default) grant no sockets.
        assert!(!access.allows_socket("localhost", 22));
        assert!(!Access::all().allows_socket("127.0.0.1", 22));
        assert!(!Access::all().allows_socket("example.com", 443));
        let narrowed = Access {
            granted: Some(caps(r#"{"network":{"sockets":["127.0.0.1:22"]}}"#)),
            ..access
        };
        assert!(narrowed.allows_socket("127.0.0.1", 22));
        assert!(!narrowed.allows_socket("mqtt.example.com", 8883));
        for bad in [
            "*.example.com:443",
            "*:443",
            "example.com",
            "example.com:0",
            "example.com:65536",
            "example.com:*",
            ":443",
            "::1:443",
            "[]:443",
            "exa mple.com:1",
        ] {
            assert!(
                Capabilities::from_json(&serde_json::json!({"network":{"sockets":[bad]}}))
                    .unwrap_err()
                    .contains("invalid socket grant"),
                "{bad}"
            );
        }
    }

    #[test]
    fn websockets_follow_http_grants() {
        let access = Access {
            declared: caps(
                r#"{"network":{"hosts":["ws.example.com"],"http":[
                    {"host":"chat.example.com","methods":["GET"],"scheme":"https","paths":["/socket"]},
                    {"host":"legacy.example.com","schemes":["wss"]}
                ]}}"#,
            ),
            granted: None,
        };
        assert!(access.allows_websocket("ws://ws.example.com:8080/x"));
        assert!(access.allows_websocket("wss://chat.example.com/socket"));
        assert!(!access.allows_websocket("ws://chat.example.com/socket"));
        assert!(!access.allows_websocket("wss://chat.example.com/other"));
        assert!(access.allows_websocket("wss://legacy.example.com/"));
        assert!(!access.allows_websocket("ws://legacy.example.com/"));
        assert!(!access.allows_websocket("https://ws.example.com/"));
        assert!(!access.allows_socket("ws.example.com", 8080));
    }

    #[cfg(unix)]
    #[test]
    fn filesystem_symlinks_cannot_escape_granted_roots() {
        use std::os::unix::fs::symlink;
        let base = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(std::env::var_os("HOME").unwrap()).join(".cache/nsh-benchs-test-tmp")
            });
        let root = base.join(format!("access-policy-{}", std::process::id()));
        std::fs::create_dir_all(root.join("allowed")).unwrap();
        std::fs::create_dir_all(root.join("outside")).unwrap();
        symlink(root.join("outside"), root.join("allowed/link")).unwrap();
        let access = Access {
            declared: caps(r#"{"fs":{"read":["${dataDir}"],"write":["${dataDir}"]}}"#),
            granted: None,
        };
        for write in [false, true] {
            assert!(
                access
                    .authorize_file(
                        &root.join("allowed/link/missing/file"),
                        &root.join("allowed"),
                        write
                    )
                    .is_err()
            );
            assert!(
                access
                    .authorize_file(&root.join("allowed/new/file"), &root.join("allowed"), write)
                    .is_ok()
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn denies_unless_listed() {
        let access = Access {
            declared: caps("{}"),
            granted: None,
        };
        assert!(!access.allows_http("GET", "https://example.com/"));
        assert!(!access.allows_media("https://example.com/a.png"));
        assert!(access.allows_media("asset:/logo.png"));
        assert!(access.allows_media("logo.png"));
        assert!(!access.allows_webview("https://example.com/"));
        assert!(!access.allows_status_bar());
        assert!(!access.allows_clipboard());
        assert!(!access.allows_picker());
        assert!(!access.allows_speech());
        assert!(!access.allows_audio());
        assert!(!access.allows_host("getUserInfo"));
        assert!(Access::all().is_unrestricted());
    }

    #[test]
    fn host_functions_need_an_explicit_grant() {
        // Undeclared, the other capabilities are all granted; the host's
        // functions are not.
        let all = Access::all();
        assert!(all.allows_clipboard());
        assert!(!all.allows_host("getUserInfo"));
        let access = |json: &str| Access {
            declared: caps(json),
            granted: None,
        };
        let every = access(r#"{ "host": true }"#);
        assert!(every.allows_host("getUserInfo") && every.allows_host("bridge.call"));
        assert!(!access(r#"{ "host": false }"#).allows_host("getUserInfo"));
        let listed = access(r#"{ "host": ["getUserInfo", "bridge.*"] }"#);
        assert!(listed.allows_host("getUserInfo"));
        assert!(listed.allows_host("bridge.share"));
        assert!(!listed.allows_host("getUserInfoX"));
        assert!(!listed.allows_host("bridge"));
        assert!(Capabilities::from_json(&serde_json::json!({ "host": ["a*b"] })).is_err());
        assert!(Capabilities::from_json(&serde_json::json!({ "host": [""] })).is_err());
        // The embedding app may grant less.
        let narrowed = Access {
            declared: caps(r#"{ "host": true }"#),
            granted: Some(caps(r#"{ "host": ["bridge.*"] }"#)),
        };
        assert!(narrowed.allows_host("bridge.call") && !narrowed.allows_host("getUserInfo"));
    }

    #[test]
    fn trusted_web_input_needs_an_explicit_grant() {
        // Undeclared, web views are granted; their trusted input is not.
        let all = Access::all();
        assert!(all.allows_webviews() && !all.allows_web_input());
        let access = |json: &str| Access {
            declared: caps(json),
            granted: None,
        };
        let input = r#"{ "webview": { "hosts": ["example.com"], "input": true } }"#;
        assert!(access(input).allows_web_input());
        assert!(!access(r#"{ "webview": { "hosts": ["example.com"] } }"#).allows_web_input());
        assert!(!access(r#"{ "webview": { "input": false } }"#).allows_web_input());
        assert!(
            Capabilities::from_json(&serde_json::json!({ "webview": { "input": "yes" } })).is_err()
        );
        // It round-trips, and the embedding app may withhold it.
        assert_eq!(
            Capabilities::from_json(&caps(input).to_json()),
            Ok(caps(input))
        );
        let narrowed = Access {
            declared: caps(input),
            granted: Some(caps(r#"{ "webview": { "hosts": ["*"] } }"#)),
        };
        assert!(!narrowed.allows_web_input());
    }

    #[test]
    fn host_function_names_and_grants_keep_to_their_charset() {
        for good in ["getUserInfo", "user.info", "a-b_c:d.E9", &"a".repeat(128)] {
            assert!(valid_host_name(good), "{good}");
        }
        for bad in [
            "",
            "user.x/../../admin",
            "a..b",
            "user x",
            "a\\b",
            "caf\u{e9}",
            "ok\u{0}",
            "a*",
            &"a".repeat(129),
        ] {
            assert!(!valid_host_name(bad), "{bad:?}");
        }
        let parses =
            |grant: &str| Capabilities::from_json(&serde_json::json!({ "host": [grant] })).is_ok();
        assert!(parses("*") && parses("user.*") && parses("user.info"));
        for bad in ["user/*", "a..*", "../*", "a b", "**"] {
            assert!(!parses(bad), "{bad}");
        }
    }

    #[test]
    fn hosts_and_finer_grants() {
        let c = caps(
            r#"{ "network": {
                "hosts": ["*.example.org"],
                "http": [{ "host": "api.example.com", "methods": ["get"], "pathPrefix": "/v1/" }]
            } }"#,
        );
        let a = Access {
            declared: c,
            granted: None,
        };
        assert!(a.allows_http("POST", "https://api.example.org/x"));
        assert!(!a.allows_http("GET", "https://example.org/"));
        assert!(!a.allows_http("GET", "https://example.org.evil.io/"));
        assert!(!a.allows_http("GET", "https://evilexample.org/"));
        assert!(a.allows_http("GET", "https://API.example.com/v1/quote"));
        assert!(!a.allows_http("POST", "https://api.example.com/v1/quote"));
        assert!(!a.allows_http("GET", "https://api.example.com/v2/"));
        assert!(!a.allows_http("GET", "file://api.example.com/v1/"));
        // User info does not fool the host check.
        assert!(!a.allows_http("GET", "https://api.example.org@evil.io/"));
        assert!(a.allows_http("GET", "https://user:pw@api.example.org:8443/"));
    }

    #[test]
    fn the_embedder_grants_at_most() {
        let a = Access {
            declared: caps(
                r#"{ "network": { "hosts": ["a.com", "b.com"] }, "statusBar": true, "clipboard": true, "picker": true, "speech": true, "audio": true }"#,
            ),
            granted: Some(caps(
                r#"{ "network": { "hosts": ["b.com"] }, "clipboard": true }"#,
            )),
        };
        assert!(a.allows_clipboard());
        assert!(!a.allows_http("GET", "https://a.com/"));
        assert!(!a.allows_picker());
        assert!(!a.allows_speech());
        assert!(!a.allows_audio());
        assert!(a.allows_http("GET", "https://b.com/"));
        assert!(!a.allows_status_bar());
    }

    #[test]
    fn typos_are_errors() {
        let bad =
            |json: &str| Capabilities::from_json(&serde_json::from_str(json).unwrap()).unwrap_err();
        assert!(bad(r#"{ "netwrok": {} }"#).contains("unknown key `netwrok`"));
        assert!(bad(r#"{ "network": { "host": [] } }"#).contains("unknown key `host`"));
        assert!(bad(r#"{ "network": { "hosts": ["exa mple.com"] } }"#).contains("invalid host"));
        let c = caps(
            r#"{ "network": { "hosts": ["a.com"], "http": [{ "host": "b.com", "methods": ["GET"] }] }, "webview": { "hosts": ["*"] } }"#,
        );
        assert_eq!(Capabilities::from_json(&c.to_json()).unwrap(), c);
    }

    /// Packages from newer signers: what this runtime does not know is never
    /// granted, and an unknown restriction drops what it restricts.
    #[test]
    fn unknown_keys_in_packages_grant_nothing() {
        let lenient =
            |json: &str| Capabilities::from_json_lenient(&serde_json::from_str(json).unwrap());
        let (c, dropped) = lenient(
            r#"{ "bluetooth": true, "clipboard": true,
                 "network": { "hosts": ["a.com"], "http": [
                     { "host": "b.com", "ports": [443] },
                     { "host": "c.com", "methods": ["GET"] }
                 ] } }"#,
        )
        .unwrap();
        assert!(c.clipboard);
        assert_eq!(c.network.hosts, [HostPattern::new("a.com").unwrap()]);
        assert_eq!(c.network.http.len(), 1);
        assert_eq!(c.network.http[0].host.as_str(), "c.com");
        assert_eq!(
            dropped,
            [
                "capabilities.bluetooth",
                "capabilities.network.http[0] (unknown key `ports`)"
            ]
        );
        let (c, dropped) =
            lenient(r#"{ "network": { "hosts": ["a.com"], "ipv6": false }, "webview": { "hosts": ["*"], "x": 1 } }"#)
                .unwrap();
        assert_eq!(c, Capabilities::default());
        assert_eq!(dropped.len(), 2);
        // A value of a form it does not know (a newer NSH's, or a typo)
        // drops its capability, alone: denied, as nothing is granted
        // unless listed.
        let (c, dropped) = lenient(
            r#"{ "statusBar": "yes", "clipboard": true,
                 "network": { "hosts": ["exa mple.com"] }, "webview": { "hosts": ["a.com"] } }"#,
        )
        .unwrap();
        assert!(!c.status_bar);
        assert!(c.clipboard);
        assert!(c.network.hosts.is_empty());
        assert_eq!(c.webview, Some(vec![HostPattern::new("a.com").unwrap()]));
        assert_eq!(dropped.len(), 2, "{dropped:?}");
        assert!(
            dropped
                .iter()
                .any(|d| d.starts_with("capabilities.statusBar ("))
        );
        assert!(
            dropped
                .iter()
                .any(|d| d.starts_with("capabilities.network ("))
        );
        // An `http` grant of another form is dropped alone.
        let (c, dropped) = lenient(
            r#"{ "network": { "hosts": ["a.com"], "http": [
                 { "host": "b.com", "port": "any" }, { "host": "c.com" } ] } }"#,
        )
        .unwrap();
        assert_eq!(c.network.hosts.len(), 1);
        assert_eq!(c.network.http.len(), 1);
        assert_eq!(c.network.http[0].host.as_str(), "c.com");
        assert_eq!(dropped.len(), 1, "{dropped:?}");
        assert!(dropped[0].starts_with("capabilities.network.http[0] ("));
        // A declaration that is no object grants nothing.
        let (c, dropped) = lenient(r#""everything""#).unwrap();
        assert_eq!(c, Capabilities::default());
        assert_eq!(dropped.len(), 1);
        // The strict parse still refuses them.
        assert!(Capabilities::from_json(&serde_json::json!({ "statusBar": "yes" })).is_err());
        // Nothing unknown: the same as the strict parse.
        let json = serde_json::json!({ "network": { "hosts": ["a.com"] }, "statusBar": true });
        let (c, dropped) = Capabilities::from_json_lenient(&json).unwrap();
        assert_eq!(c, Capabilities::from_json(&json).unwrap());
        assert!(dropped.is_empty());
    }

    #[test]
    fn media_redirects_are_checked() {
        let a = Access {
            declared: Capabilities::from_json(
                &serde_json::json!({ "network": { "hosts": ["a.com"] } }),
            )
            .unwrap(),
            granted: None,
        };
        let from = "https://a.com/x/y.png";
        assert_eq!(
            a.media_redirect(from, "/z.png").unwrap(),
            "https://a.com/z.png"
        );
        assert_eq!(
            a.media_redirect(from, "z.png").unwrap(),
            "https://a.com/x/z.png"
        );
        assert!(a.media_redirect(from, "https://b.com/z.png").is_err());
        assert!(a.media_redirect(from, "//b.com/z.png").is_err());
        assert!(a.media_redirect(from, "file:///etc/passwd").is_err());
        assert!(
            Access::default()
                .media_redirect(from, "//b.com/z.png")
                .is_ok()
        );
        assert!(
            Access::default()
                .media_redirect(from, "ftp://b.com/z.png")
                .is_err()
        );
    }

    #[test]
    fn opening_urls_is_granted_by_scheme() {
        let caps = |json: serde_json::Value| Capabilities::from_json(&json).unwrap();
        let access =
            |declared: Capabilities, granted: Option<Capabilities>| Access { declared, granted };
        let any = access(caps(serde_json::json!({ "openUrl": true })), None);
        assert!(any.allows_open_url("https://a.com"));
        assert!(any.allows_open_url("tel:+15550100"));
        let some = access(
            caps(serde_json::json!({ "openUrl": { "schemes": ["HTTPS", "mailto"] } })),
            None,
        );
        assert!(some.allows_open_url("https://a.com"));
        assert!(some.allows_open_url("MAILTO:a@b.c"));
        assert!(!some.allows_open_url("tel:1"));
        // The embedding app grants less.
        let narrowed = access(
            caps(serde_json::json!({ "openUrl": true })),
            Some(caps(
                serde_json::json!({ "openUrl": { "schemes": ["https"] } }),
            )),
        );
        assert!(narrowed.allows_open_url("https://a.com"));
        assert!(!narrowed.allows_open_url("mailto:a@b.c"));
        let none = access(caps(serde_json::json!({ "openUrl": false })), None);
        assert!(!none.allows_open_url("https://a.com"));
        assert!(!access(caps(serde_json::json!({})), None).allows_open_url("https://a.com"));
        assert!(Access::default().allows_open_url("https://a.com"));
        for bad in [
            serde_json::json!({ "openUrl": "yes" }),
            serde_json::json!({ "openUrl": { "schemes": ["ht tp"] } }),
            serde_json::json!({ "openUrl": { "hosts": ["a.com"] } }),
        ] {
            assert!(Capabilities::from_json(&bad).is_err(), "{bad}");
        }
        // Round trip.
        for json in [
            serde_json::json!(true),
            serde_json::json!(false),
            serde_json::json!({ "schemes": ["https"] }),
        ] {
            let c = caps(serde_json::json!({ "openUrl": json }));
            assert_eq!(c.to_json()["openUrl"], json);
        }
    }
}
