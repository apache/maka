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
//! [`Core::set_url_schemes`]: crate::Core::set_url_schemes

/// The longest URL taken, in bytes (as [`crate::open_url::MAX_URL_LEN`]).
pub const MAX_URL_LEN: usize = crate::open_url::MAX_URL_LEN;

/// The most links kept while no listener takes them: past it the oldest
/// goes.
pub const MAX_PENDING: usize = 16;

/// The payload key of [`EventKind::UrlScheme`](crate::EventKind::UrlScheme):
/// the URL.
pub const URL: &str = "url";

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

#[cfg(test)]
mod tests {
    use super::*;

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
