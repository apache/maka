//! Web sign-in sessions ([`crate::element::open_auth_session`]): the app
//! opens a provider's sign-in page (an OAuth authorization URL), the user
//! signs in, and the page redirects to a URL of the app's callback scheme,
//! which comes back to the app as the session's result.
//!
//! How each platform shows the page:
//!
//! - iOS: `ASWebAuthenticationSession`, a sheet over the app that shares
//!   cookies with Safari unless the request asks for an ephemeral session
//!   ([`AuthSessionRequest::ephemeral`]). The system hands the callback URL
//!   back itself; the scheme needs no claim in `nsh.json`.
//! - Android: a Custom Tab (the default browser where it has none). The
//!   callback comes back as a link of a scheme the app claims (`nsh.json`
//!   `schemes`), which the core takes as the session's result; the user
//!   coming back to the app without one cancels it.
//! - The macOS, Windows and Linux backends, and tests: the system
//!   browser through [`crate::element::open_url`], and the callback comes
//!   back as a link of a scheme the app claims, as on Android. Nothing tells the core the user
//!   gave up there, so such a session ends only with its callback or a
//!   later session; without a claimed scheme it fails at once.
//! - Where no link of the app's schemes reaches it
//!   ([`Environment::scheme_links()`](crate::platform::Environment::scheme_links()):
//!   the web, whose page hears only its own address, and the GPUI and
//!   terminal backends), nothing could bring the callback back, and the
//!   session fails at once, claimed scheme or not.
//!
//! The flow: the call checks the request ([`AuthSessionRequest::check`])
//! and the app's `openUrl` capability for the page's URL. Where the
//! platform shows sessions
//! ([`Environment::auth_session`](crate::platform::Environment::auth_session))
//! the core sends [`Command::AuthSession`](crate::Command::AuthSession) on
//! the root, answered by the root's
//! [`EventKind::AuthSession`](crate::EventKind::AuthSession)
//! ([`AuthSessionOutcome::payload`], [`AuthSessionError::payload`]); a
//! callback link of the session's scheme ends it too. One session runs at a
//! time: a new one ends the earlier as cancelled. A callback that reaches
//! an app with no session waiting (the system ended the app while the page
//! showed, and the link started it again) is an ordinary link
//! ([`crate::element::next_url_scheme_open`]).

use crate::{EventPayload, PayloadValue};

/// The most bytes of a callback scheme.
pub const MAX_SCHEME_LEN: usize = 64;

/// Schemes a callback never has: web addresses (a page redirects to them
/// on its own, so they do not end a session) and schemes that run code or
/// name local files.
const REFUSED_SCHEMES: &[&str] = &[
    "http",
    "https",
    "file",
    "javascript",
    "vbscript",
    "data",
    "blob",
    "about",
    "asset",
];

/// A sign-in session the app asks for: the page to open and the scheme of
/// the URL it redirects to when the user is done.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct AuthSessionRequest {
    /// The sign-in page: an `https:` (or `http:`) URL, such as an OAuth
    /// authorization URL.
    pub url: String,
    /// The scheme of the callback URL, without `:` (`myapp` for
    /// `myapp://signed-in?code=...`).
    pub callback_scheme: String,
    /// Asks the browser not to share cookies or other data with the user's
    /// browsing (iOS's `prefersEphemeralWebBrowserSession`; ephemeral
    /// browsing in browsers whose Custom Tabs offer it). Off by default.
    pub ephemeral: bool,
}

impl AuthSessionRequest {
    /// A session opening `url` and ending with a URL of `callback_scheme`.
    pub fn new(url: impl Into<String>, callback_scheme: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            callback_scheme: callback_scheme.into(),
            ephemeral: false,
        }
    }

    /// Asks for a session that shares nothing with the user's browsing.
    pub fn ephemeral(mut self, ephemeral: bool) -> Self {
        self.ephemeral = ephemeral;
        self
    }

    /// Checks the request: a URL [`crate::open_url::check_url`] accepts, of
    /// the `https:` or `http:` scheme; a callback scheme of at most
    /// [`MAX_SCHEME_LEN`] bytes, a letter then letters, digits, `+`, `-` or
    /// `.`, and not one of [`REFUSED_SCHEMES`]. The error says what is
    /// wrong.
    pub fn check(&self) -> Result<(), String> {
        crate::open_url::check_url(&self.url)
            .map_err(|e| e.replacen("openUrl:", "openAuthSession:", 1))?;
        let parsed =
            url::Url::parse(&self.url).map_err(|e| format!("openAuthSession: not a URL: {e}"))?;
        if !matches!(parsed.scheme(), "https" | "http") {
            return Err(format!(
                "openAuthSession: the sign-in page is a web address, not a `{}:` URL",
                parsed.scheme()
            ));
        }
        let scheme = &self.callback_scheme;
        if scheme.len() > MAX_SCHEME_LEN {
            return Err(format!(
                "openAuthSession: a callback scheme has at most {MAX_SCHEME_LEN} bytes"
            ));
        }
        let mut chars = scheme.chars();
        let valid = chars.next().is_some_and(|c| c.is_ascii_alphabetic())
            && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'));
        if !valid {
            return Err(format!(
                "openAuthSession: `{scheme}` is not a URL scheme (give it without `:`)"
            ));
        }
        if REFUSED_SCHEMES.contains(&scheme.to_ascii_lowercase().as_str()) {
            return Err(format!(
                "openAuthSession: `{scheme}:` is not a callback scheme (use one of the app's own)"
            ));
        }
        Ok(())
    }

    /// The callback scheme as URLs carry it (lower case).
    pub(crate) fn scheme(&self) -> String {
        self.callback_scheme.to_ascii_lowercase()
    }
}

/// How a sign-in session ended.
#[derive(Debug, Clone, PartialEq, Eq)]
#[non_exhaustive]
pub enum AuthSessionOutcome {
    /// The page redirected to this callback URL (of the request's scheme).
    Completed(String),
    /// The user closed the page, or came back to the app without signing
    /// in, or a later session replaced this one.
    Cancelled,
}

impl AuthSessionOutcome {
    /// The root's [`EventKind::AuthSession`](crate::EventKind::AuthSession)
    /// payload answering request `id` with this outcome.
    pub fn payload(&self, id: u32) -> EventPayload {
        let mut fields = vec![("id", PayloadValue::Number(id as f64))];
        match self {
            AuthSessionOutcome::Completed(url) => {
                fields.push(("url", PayloadValue::Str(url.clone())))
            }
            AuthSessionOutcome::Cancelled => {
                fields.push(("action", PayloadValue::Str("cancelled".into())));
            }
        }
        EventPayload::Map(fields)
    }
}

/// Why a sign-in session could not run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct AuthSessionError {
    /// A stable code the app can branch on
    /// (`ERR_FEATURE_UNAVAILABLE_ON_PLATFORM`, `ERR_ACCESS_DENIED`); `None`
    /// for other failures.
    pub code: Option<String>,
    /// What went wrong, in words.
    pub message: String,
}

impl AuthSessionError {
    /// A failure with `message` and no code.
    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }

    /// Nothing here shows the page or brings its callback back (no
    /// in-app session, and the callback scheme is not one the app claims
    /// or the platform hands the app no links of its schemes).
    pub fn unavailable(message: impl Into<String>) -> Self {
        Self {
            code: Some(crate::element::codes::UNAVAILABLE.into()),
            message: message.into(),
        }
    }

    /// The root's [`EventKind::AuthSession`](crate::EventKind::AuthSession)
    /// payload answering request `id` with this error.
    pub fn payload(&self, id: u32) -> EventPayload {
        let mut fields = vec![
            ("id", PayloadValue::Number(id as f64)),
            ("error", PayloadValue::Str(self.message.clone())),
        ];
        if let Some(code) = &self.code {
            fields.push(("code", PayloadValue::Str(code.clone())));
        }
        EventPayload::Map(fields)
    }
}

impl std::fmt::Display for AuthSessionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AuthSessionError {}

/// What the platform shows: a checked [`AuthSessionRequest`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct AuthSessionPage {
    /// The sign-in page's URL.
    pub url: String,
    /// The callback scheme, lower case.
    pub callback_scheme: String,
    /// Share nothing with the user's browsing.
    pub ephemeral: bool,
}

impl AuthSessionPage {
    pub(crate) fn new(request: &AuthSessionRequest) -> Self {
        Self {
            url: request.url.clone(),
            callback_scheme: request.scheme(),
            ephemeral: request.ephemeral,
        }
    }
}

/// The request a platform's
/// [`EventKind::AuthSession`](crate::EventKind::AuthSession) payload
/// answers and its answer: an `error` (with its `code`, if any) fails it, a
/// `url` completes it, anything else cancels it. `None` when the payload
/// names no request.
pub(crate) fn answer_from_payload(
    payload: &EventPayload,
) -> Option<(u32, Result<AuthSessionOutcome, AuthSessionError>)> {
    let EventPayload::Map(fields) = payload else {
        return None;
    };
    let text = |key: &str| {
        fields.iter().find_map(|(k, v)| match v {
            PayloadValue::Str(s) if *k == key => Some(s.clone()),
            _ => None,
        })
    };
    let id = fields.iter().find_map(|(k, v)| match v {
        PayloadValue::Number(n) if *k == "id" => Some(*n as u32),
        _ => None,
    })?;
    if let Some(message) = text("error") {
        return Some((
            id,
            Err(AuthSessionError {
                code: text("code"),
                message,
            }),
        ));
    }
    let outcome = match text("url") {
        Some(url) => AuthSessionOutcome::Completed(url),
        None => AuthSessionOutcome::Cancelled,
    };
    Some((id, Ok(outcome)))
}

/// Whether `url` is a callback of a session waiting for `scheme`.
pub(crate) fn is_callback(url: &str, scheme: &str) -> bool {
    url::Url::parse(url).is_ok_and(|parsed| parsed.scheme() == scheme)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_opens_a_web_page_and_ends_with_an_app_scheme() {
        let ok = AuthSessionRequest::new("https://example.com/authorize?x=1", "com.example.app");
        assert!(ok.check().is_ok());
        assert!(
            AuthSessionRequest::new("http://127.0.0.1:8080/authorize", "my-app+1")
                .check()
                .is_ok()
        );
        for (url, scheme) in [
            ("myapp://authorize", "myapp"),
            ("javascript:alert(1)", "myapp"),
            ("https://example.com/a b", "myapp"),
            ("https://example.com", ""),
            ("https://example.com", "myapp:"),
            ("https://example.com", "1app"),
            ("https://example.com", "https"),
            ("https://example.com", "HTTP"),
            ("https://example.com", "file"),
        ] {
            assert!(
                AuthSessionRequest::new(url, scheme).check().is_err(),
                "{url} {scheme}"
            );
        }
        let long = "a".repeat(MAX_SCHEME_LEN + 1);
        assert!(
            AuthSessionRequest::new("https://example.com", long)
                .check()
                .is_err()
        );
    }

    #[test]
    fn payloads_round_trip() {
        let done = AuthSessionOutcome::Completed("myapp://done?code=1".into());
        assert_eq!(answer_from_payload(&done.payload(3)), Some((3, Ok(done))));
        let cancelled = AuthSessionOutcome::Cancelled;
        assert_eq!(
            answer_from_payload(&cancelled.payload(4)),
            Some((4, Ok(cancelled)))
        );
        let error = AuthSessionError::unavailable("no browser");
        assert_eq!(
            answer_from_payload(&error.payload(5)),
            Some((5, Err(error)))
        );
        assert_eq!(answer_from_payload(&EventPayload::None), None);
    }

    #[test]
    fn a_callback_is_a_url_of_the_scheme() {
        let page = AuthSessionPage::new(&AuthSessionRequest::new("https://example.com", "MyApp"));
        assert_eq!(page.callback_scheme, "myapp");
        assert!(is_callback("MYAPP://done?code=1", &page.callback_scheme));
        assert!(!is_callback("other://done", &page.callback_scheme));
        assert!(!is_callback("not a url", &page.callback_scheme));
    }
}
