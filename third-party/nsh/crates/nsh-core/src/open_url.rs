//! Opening a URL outside the app (`openUrl` of `nsh/device`,
//! [`crate::element::open_url`]): a web page in the browser, a `mailto:` link in
//! the mail app, a `tel:` link in the phone app, any scheme another app
//! registered.
//!
//! The flow, every part of it in Rust: the call checks the URL
//! ([`check_url`]) and the app's `openUrl` capability; the core keeps the
//! request and hands it to the engine ([`crate::Core::take_url_opens`]),
//! which asks the embedding app first (its `HostChannel`'s URL handler: a
//! host routes links through its own router); a URL the embedding app does
//! not take goes to the platform as [`crate::Command::OpenUrl`] on the root
//! (`UIApplication.open`, `Intent.ACTION_VIEW`, `NSWorkspace`,
//! `ShellExecuteW`, `GtkUriLauncher`, GPUI's `open_url`, `window.open`),
//! which reports whether it opened as [`crate::EventKind::OpenUrl`].
//!
//! Before a link opens, the desktops show where it goes: [`hint_url`] is
//! the line `nsh-base`'s link hints show (the scheme and host never cut,
//! the host in its ASCII form; paths and anchors as written, escaped), so
//! a link's text cannot hide its destination. It lives here, `doc(hidden)`,
//! because the core already depends on the `url` crate and `nsh-base`
//! depends on the core only.

/// The longest URL opened, in bytes (a `mailto:` link with a body fits).
pub const MAX_URL_LEN: usize = 16 * 1024;

/// Schemes never opened: they run code or reach the app's own files and
/// data rather than another app.
const REFUSED_SCHEMES: &[&str] = &[
    "javascript",
    "vbscript",
    "data",
    "blob",
    "file",
    "about",
    "asset",
];

/// Checks a URL an app asks to open: absolute (a scheme), at most
/// [`MAX_URL_LEN`] bytes, no whitespace or control characters, and of a
/// scheme that opens another app (not `javascript:`, `data:`, `blob:`,
/// `file:`, `about:` or `asset:`). The error says what is wrong.
pub fn check_url(url: &str) -> Result<(), String> {
    if url.len() > MAX_URL_LEN {
        return Err(format!(
            "openUrl: a URL has at most {MAX_URL_LEN} bytes (this one has {})",
            url.len()
        ));
    }
    if url.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("openUrl: a URL has no whitespace or control characters".into());
    }
    let parsed = url::Url::parse(url).map_err(|e| format!("openUrl: not a URL: {e} ({url})"))?;
    let scheme = parsed.scheme();
    if REFUSED_SCHEMES.contains(&scheme) {
        return Err(format!("openUrl: `{scheme}:` URLs are not opened"));
    }
    if matches!(scheme, "http" | "https") && parsed.host_str().is_none_or(str::is_empty) {
        return Err(format!("openUrl: a web address has a host ({url})"));
    }
    Ok(())
}

/// Why an app may not open `url`: what its `openUrl` rejects with when
/// the `openUrl` capability does not grant the URL's scheme
/// ([`JsError::access_denied`](crate::element::JsError::access_denied),
/// permission `"openUrl"`, the URL its resource).
pub fn not_granted(url: &str) -> crate::element::JsError {
    let scheme = url.split_once(':').map_or(url, |(scheme, _)| scheme);
    crate::element::JsError::access_denied(
        format!(
            "openUrl: `{scheme}:` URLs are not granted: add `\"openUrl\": true` (or `{scheme}` to `\"openUrl\": {{ \"schemes\": [...] }}`) to capabilities in nsh.json"
        ),
        "openUrl",
        url,
    )
}

/// The fewest characters of a URL's path, query and fragment a hint
/// shows, however long its host is.
const HINT_REST: usize = 12;

/// The most characters of a `user:password@` a hint shows before the
/// host: past them it is cut (its end, the `@`, kept), so a long one
/// passing for a host cannot push the real host out of sight.
const HINT_USERINFO: usize = 16;

/// How a link's hint shows where `href` goes (`nsh-base`'s `Link` and
/// `TextView` links, while the pointer rests on them), as two parts of one
/// line: the head, never cut, and the rest, whose middle may be cut.
///
/// An absolute URL shows as it is parsed, so what it hides shows: an
/// international host in its ASCII form (punycode, so a letter of another
/// script passing for a Latin one shows as what it is), the host after a
/// `user@`, percent-escapes instead of characters that turn text around.
/// Its head is the scheme, the host and the port (`https://example.com:8443`;
/// `mailto:` for a URL without a host); a `user:password@` before the host
/// keeps at most 16 characters (`HINT_USERINFO`). A scheme-relative `href`
/// (`//cdn.example.com/a`) shows the same with no scheme. Any other `href`
/// (a path of the app's, `docs/intro`, `?q=1`, an `#anchor`) shows as it is
/// written, with an empty head; a character that is a control, white space,
/// or turns or hides text (bidi controls, zero-width marks) shows as its
/// percent-escapes, as do all non-ASCII characters of an `href` that looks
/// absolute but does not parse.
///
/// The rest is cut when head and rest together pass `max_chars`
/// characters: its middle goes to an ellipsis, its start and end stay, and
/// it keeps at least 12 characters (`HINT_REST`) of its own besides the
/// ellipsis. The head is never cut, so a long host makes the line longer
/// than `max_chars`: `max_chars` is a budget for the rest, not a bound on
/// the line. `None` for an empty `href`, which goes nowhere.
#[doc(hidden)]
pub fn hint_url(href: &str, max_chars: usize) -> Option<(String, String)> {
    let href = href.trim();
    if href.is_empty() {
        return None;
    }
    let (head, rest) = hint_parts(href);
    let rest = cut_middle(&rest, max_chars.saturating_sub(head.chars().count()));
    Some((head, rest))
}

/// `href`'s head and rest, before any cut ([`hint_url`]).
fn hint_parts(href: &str) -> (String, String) {
    if href.starts_with("//") {
        // As a page of a secure site would resolve it: the same host rules
        // (punycode, ports), with no scheme of its own to show.
        const SCHEME: &str = "https:";
        if let Ok(parsed) = url::Url::parse(&format!("{SCHEME}{href}"))
            && parsed.has_host()
        {
            let (mut head, rest) = parsed_parts(&parsed, SCHEME.len());
            // The parse drops `:443` as https's default, but the page may
            // resolve `href` with http: a port written stays shown.
            if parsed.port().is_none()
                && has_written_port(href)
                && let Some(port) = parsed.port_or_known_default()
            {
                head.push_str(&format!(":{port}"));
            }
            return (head, rest);
        }
        return (String::new(), escaped(href, true));
    }
    match url::Url::parse(href) {
        Ok(parsed) => parsed_parts(&parsed, 0),
        Err(_) => (String::new(), escaped(href, has_scheme(href))),
    }
}

/// Whether the authority of the scheme-relative `href` writes a port
/// (`//host:443/`), read as a special URL is parsed: tabs and newlines
/// ignored, any `/` or `\` before the authority skipped, the authority
/// ending at `/`, `\`, `?` or `#`, the host after its last `@`, an IPv6
/// host in brackets.
fn has_written_port(href: &str) -> bool {
    let href: String = href
        .chars()
        .filter(|c| !matches!(c, '\t' | '\n' | '\r'))
        .collect();
    let after = href.trim_start_matches(['/', '\\']);
    let authority = after.split(['/', '\\', '?', '#']).next().unwrap_or("");
    let host_port = authority.rsplit('@').next().unwrap_or("");
    let port = if host_port.starts_with('[') {
        host_port.split_once(']').map_or("", |(_, port)| port)
    } else {
        host_port
    };
    port.split_once(':')
        .is_some_and(|(_, port)| port.bytes().any(|b| b.is_ascii_digit()))
}

/// A parsed URL's head and rest, its first `skip` bytes left out (a
/// scheme added to parse a scheme-relative URL).
fn parsed_parts(parsed: &url::Url, skip: usize) -> (String, String) {
    let shown = parsed.as_str();
    if !parsed.has_host() {
        // The scheme and its colon (`mailto:`).
        let end = (parsed[..url::Position::AfterScheme].len() + 1).min(shown.len());
        return (shown[skip.min(end)..end].into(), shown[end..].into());
    }
    let user = parsed[..url::Position::BeforeUsername].len();
    let host = parsed[..url::Position::BeforeHost].len();
    let end = parsed[..url::Position::AfterPort].len();
    let mut head = String::with_capacity(end - skip.min(user));
    head.push_str(&shown[skip.min(user)..user]);
    // `user:password@`, the `@` always kept before the host.
    let userinfo = &shown[user..host];
    match userinfo.strip_suffix('@') {
        Some(info) if info.chars().count() > HINT_USERINFO => {
            head.extend(info.chars().take(HINT_USERINFO - 1));
            head.push_str("…@");
        }
        _ => head.push_str(userinfo),
    }
    head.push_str(&shown[host..end]);
    (head, shown[end..].into())
}

/// `rest` in at most `room` characters (at least [`HINT_REST`]): its
/// middle cut to an ellipsis, its start and end kept.
fn cut_middle(rest: &str, room: usize) -> String {
    let chars = rest.chars().count();
    if chars <= room {
        return rest.to_owned();
    }
    // The ellipsis takes one character.
    let keep = room.saturating_sub(1).max(HINT_REST);
    if keep >= chars {
        return rest.to_owned();
    }
    let back = keep / 2;
    let front = keep - back;
    let mut out = String::with_capacity(keep + 3);
    out.extend(rest.chars().take(front));
    out.push('…');
    out.extend(rest.chars().skip(chars - back));
    out
}

/// Whether `href` starts with a scheme (`name:` before any `/`, `?` or
/// `#`), as an absolute URL does.
fn has_scheme(href: &str) -> bool {
    let Some((scheme, _)) = href.split_once(':') else {
        return false;
    };
    let mut chars = scheme.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// `href` with the characters a hint must not show as they are (controls,
/// white space, bidi controls and invisible marks; all non-ASCII ones when
/// `ascii`) as percent-escapes of their UTF-8 bytes.
fn escaped(href: &str, ascii: bool) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(href.len());
    for c in href.chars() {
        let hidden = c.is_control()
            || c.is_whitespace()
            || matches!(
                c,
                '\u{061C}'
                    | '\u{115F}'
                    | '\u{1160}'
                    | '\u{180E}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'..='\u{206F}'
                    | '\u{3164}'
                    | '\u{FE00}'..='\u{FE0F}'
                    | '\u{FEFF}'
                    | '\u{FFA0}'
            )
            || (ascii && !c.is_ascii());
        if hidden {
            let mut bytes = [0; 4];
            for b in c.encode_utf8(&mut bytes).bytes() {
                let _ = write!(out, "%{b:02X}");
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The longest line the tests show.
    const SHOWN: usize = 48;

    /// `href`'s hint as its head and rest.
    fn parts(href: &str) -> (String, String) {
        hint_url(href, SHOWN).unwrap_or_else(|| panic!("a hint for {href:?}"))
    }

    /// `href`'s hint as one line.
    fn line(href: &str) -> String {
        let (head, rest) = parts(href);
        head + &rest
    }

    #[test]
    fn a_short_url_is_shown_whole() {
        for (url, head, rest) in [
            ("https://example.com/docs", "https://example.com", "/docs"),
            ("https://example.com", "https://example.com", "/"),
            ("mailto:ada@example.com", "mailto:", "ada@example.com"),
            ("lb://router/stock/700.HK", "lb://router", "/stock/700.HK"),
        ] {
            assert_eq!(parts(url), (head.into(), rest.into()), "{url}");
        }
    }

    #[test]
    fn a_long_url_loses_the_middle_of_its_path_never_its_host() {
        let url = format!(
            "https://docs.example.com/{}/guide?utm_source=newsletter&page=2",
            "section/".repeat(12)
        );
        let (head, rest) = parts(&url);
        assert_eq!(head, "https://docs.example.com");
        assert!(rest.starts_with('/') && rest.contains('…'), "{rest}");
        assert!(rest.ends_with("page=2"), "the end stays: {rest}");
        assert_eq!(line(&url).chars().count(), SHOWN);
    }

    #[test]
    fn a_host_longer_than_the_line_is_still_shown_whole() {
        let host = format!("{0}.{0}.{0}.example.com", "login-secure-account-update");
        let url = format!("https://{host}:8443/a/very/long/path/to/somewhere/else");
        let (head, rest) = parts(&url);
        assert_eq!(head, format!("https://{host}:8443"));
        assert!(head.chars().count() > SHOWN, "longer than the line");
        // The rest keeps its least (and the ellipsis), its middle cut.
        assert_eq!(rest.chars().count(), HINT_REST + 1, "{rest}");
        assert!(rest.starts_with("/a/") && rest.contains('…'), "{rest}");
    }

    #[test]
    fn an_ipv6_host_and_its_port_are_the_head() {
        let (head, rest) = parts("http://[2001:db8::1]:8080/status?verbose=1");
        assert_eq!(head, "http://[2001:db8::1]:8080");
        assert_eq!(rest, "/status?verbose=1");
        let (head, _) = parts("https://[::FFFF:192.168.0.1]/");
        assert_eq!(head, "https://[::ffff:c0a8:1]", "as it is parsed");
    }

    #[test]
    fn an_international_host_is_shown_as_its_ascii_form() {
        assert_eq!(
            parts("https://münchen.de/karte"),
            ("https://xn--mnchen-3ya.de".into(), "/karte".into())
        );
        // A Cyrillic "а" passing for a Latin one shows as what it is.
        let (head, rest) = parts("https://\u{430}pple.com/login");
        assert!(
            head.starts_with("https://xn--") && head.ends_with(".com"),
            "{head}"
        );
        assert_eq!(rest, "/login");
        // Punycode written as such stays as it is.
        assert_eq!(
            parts("https://xn--mnchen-3ya.de/"),
            ("https://xn--mnchen-3ya.de".into(), "/".into())
        );
    }

    #[test]
    fn what_a_url_hides_is_shown() {
        // The host is after the `@`, and shown so.
        let (head, _) = parts("https://bank.example@evil.example/login");
        assert_eq!(head, "https://bank.example@evil.example");
        // A right-to-left override cannot turn the text around.
        assert!(line("https://example.com/\u{202E}gpj.exe").is_ascii());
    }

    #[test]
    fn a_long_user_before_the_host_cannot_push_the_host_away() {
        let user = "www.bank.example.com.secure-login.account-verify";
        let (head, rest) = parts(&format!("https://{user}:pw@evil.example:444/login"));
        assert!(head.starts_with("https://www.bank.exam"), "{head}");
        assert!(
            head.ends_with("…@evil.example:444"),
            "the host whole: {head}"
        );
        assert_eq!(
            head.chars().count(),
            "https://".len() + HINT_USERINFO + "@evil.example:444".len()
        );
        assert_eq!(rest, "/login");
    }

    #[test]
    fn a_scheme_relative_url_shows_its_host_without_a_scheme() {
        assert_eq!(
            parts("//cdn.example.com:8443/lib.js"),
            ("//cdn.example.com:8443".into(), "/lib.js".into())
        );
        assert_eq!(
            parts("//münchen.de/karte"),
            ("//xn--mnchen-3ya.de".into(), "/karte".into())
        );
        let host = format!("{0}.{0}.example.org", "a-very-long-label-of-a-host");
        let (head, rest) = parts(&format!("//{host}/{}", "x/".repeat(40)));
        assert_eq!(head, format!("//{host}"));
        assert!(rest.contains('…'), "{rest}");
    }

    #[test]
    fn a_scheme_relative_url_keeps_a_default_port_it_writes() {
        for (href, head, rest) in [
            ("//example.com:443/path", "//example.com:443", "/path"),
            ("//example.com:80/path", "//example.com:80", "/path"),
            (
                "//user@example.com:443/path",
                "//user@example.com:443",
                "/path",
            ),
            ("//[::1]:443/path", "//[::1]:443", "/path"),
            ("//example.com/path", "//example.com", "/path"),
            (
                "//münchen.de:443/karte",
                "//xn--mnchen-3ya.de:443",
                "/karte",
            ),
            // A `:443` after the authority is no port.
            ("//example.com\\a:443", "//example.com", "/a:443"),
            ("//example.com?q=:443", "//example.com", "/?q=:443"),
            ("//example.com#:443", "//example.com", "/#:443"),
            ("//u:443@example.com/path", "//u:443@example.com", "/path"),
        ] {
            assert_eq!(parts(href), (head.into(), rest.into()), "{href}");
        }
        // With its scheme known, the default port is dropped as parsed.
        assert_eq!(
            parts("https://example.com:443/path"),
            ("https://example.com".into(), "/path".into())
        );
    }

    #[test]
    fn a_path_or_anchor_of_the_app_shows_as_written() {
        for href in ["/settings", "#top", "docs/intro", "?tab=2", "../up"] {
            assert_eq!(parts(href), (String::new(), href.into()), "{href}");
        }
        // Its own script stays; nothing hides or turns around.
        assert_eq!(parts("/文档/简介").1, "/文档/简介");
        assert_eq!(
            parts("#a\u{202E}b\u{200B}c d").1,
            "#a%E2%80%AEb%E2%80%8Bc%20d"
        );
        // A long one keeps its start and end.
        let long = format!("/archive/{}end", "x".repeat(80));
        let (head, rest) = parts(&long);
        assert!(head.is_empty());
        assert!(
            rest.starts_with("/archive/") && rest.ends_with("end"),
            "{rest}"
        );
        assert_eq!(rest.chars().count(), SHOWN);
    }

    #[test]
    fn an_absolute_looking_href_that_does_not_parse_shows_in_ascii() {
        let (head, rest) = parts("https://\u{430}pple.com:99999/");
        assert!(head.is_empty());
        assert!(
            rest.is_ascii() && rest.starts_with("https://%D0%B0pple.com"),
            "{rest}"
        );
    }

    #[test]
    fn an_empty_href_has_no_hint() {
        for href in ["", "  "] {
            assert_eq!(hint_url(href, SHOWN), None, "{href:?}");
        }
    }

    #[test]
    fn a_long_url_without_a_host_keeps_its_scheme() {
        let url = format!("mailto:{}@example.com?subject=Hello", "a".repeat(80));
        let (head, rest) = parts(&url);
        assert_eq!(head, "mailto:");
        assert!(rest.starts_with("aaa"), "{rest}");
        assert!(rest.ends_with("subject=Hello"), "{rest}");
        assert_eq!(line(&url).chars().count(), SHOWN);
    }

    #[test]
    fn urls_of_other_apps_are_opened() {
        for url in [
            "https://example.com/a?b=c#d",
            "http://localhost:8080",
            "mailto:ada@example.com?subject=Hi%20there",
            "tel:+1-555-0100",
            "sms:+15550100",
            "maps://?q=Paris",
            "lb://router/stock/700.HK",
        ] {
            assert_eq!(check_url(url), Ok(()), "{url}");
        }
    }

    #[test]
    fn other_urls_are_refused() {
        for url in [
            "",
            "example.com",
            "/relative/path",
            "javascript:alert(1)",
            "JavaScript:alert(1)",
            "data:text/html,<b>x</b>",
            "file:///etc/passwd",
            "blob:https://example.com/1",
            "about:blank",
            "asset:/logo.png",
            "https://exa mple.com",
            "https://example.com/\n",
        ] {
            assert!(check_url(url).is_err(), "{url}");
        }
        let long = format!("https://example.com/{}", "a".repeat(MAX_URL_LEN));
        assert!(check_url(&long).is_err());
    }
}
