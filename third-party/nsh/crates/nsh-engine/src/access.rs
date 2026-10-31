//! `fetch` within the app's capabilities: requests the app may not make
//! fail without reaching the network, and redirects are followed by the
//! engine (not by the platform's stack) so that every hop is checked again.
//! Hops are issued on the engine thread, like the first request.

use nsh_core::{
    access::Access,
    platform::{HttpBody, HttpHead, HttpRequest},
};

/// Redirects followed at most (as browsers).
const MAX_REDIRECTS: usize = 20;

/// A request (or a redirect's hop) the app's capabilities do not grant:
/// JS's `fetch` rejects with a `TypeError` whose `code` is
/// `ERR_ACCESS_DENIED`, `permission` `"network"` and `resource` the URL
/// (`nsh_js::Host::fetch_refused`); a Rust task's fails with the message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Refused {
    /// Why, for people.
    pub(crate) message: String,
    /// The URL refused.
    pub(crate) url: String,
}

/// The refusal of `method` `url`.
pub(crate) fn refused(method: &str, url: &str) -> Refused {
    let host = nsh_core::access::parse_url(url).map_or_else(|| url.to_owned(), |u| u.host);
    Refused {
        message: format!(
            "fetch {method} {url} is not granted: add `{host}` to capabilities.network in nsh.json"
        ),
        url: url.to_owned(),
    }
}

/// A request the engine follows through its redirects.
#[derive(Debug)]
pub(crate) struct Followed {
    /// The request as JS made it (the URL of the current hop).
    pub(crate) request: HttpRequest,
    /// Redirects followed so far.
    pub(crate) hops: usize,
}

/// What to do with a hop's response.
#[derive(Debug)]
pub(crate) enum Next {
    /// The response is the answer.
    Done(HttpHead),
    /// The request fails.
    Fail(String),
    /// The redirect leads where the app may not go.
    Refused(Refused),
    /// Send this request next (checked against the capabilities).
    Hop(HttpRequest),
}

/// After a hop of `followed` answered with `response`'s head: the final
/// response, or the next hop.
pub(crate) fn next(access: &Access, followed: &mut Followed, mut response: HttpHead) -> Next {
    if !is_redirect(response.status) {
        response.redirected |= followed.hops > 0;
        return Next::Done(response);
    }
    let location = response
        .headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("location"))
        .map(|(_, v)| v.clone());
    let Some(location) = location else {
        return Next::Done(response);
    };
    if followed.hops >= MAX_REDIRECTS {
        return Next::Fail("too many redirects".to_owned());
    }
    let request = &mut followed.request;
    let base = if response.url.is_empty() {
        request.url.clone()
    } else {
        response.url.clone()
    };
    let url = nsh_core::access::resolve_reference(&base, &location);
    // Fetch: 303 (and 301 / 302 after a POST) become GET without a body.
    if response.status == 303 || (matches!(response.status, 301 | 302) && request.method == "POST")
    {
        request.method = "GET".to_owned();
        request.body = HttpBody::Empty;
        request.headers.retain(|(k, _)| {
            !k.eq_ignore_ascii_case("content-type") && !k.eq_ignore_ascii_case("content-length")
        });
    } else if request.body == HttpBody::Stream {
        // Fetch: a streamed body cannot be sent again.
        return Next::Fail("cannot follow a redirect with a streamed request body".to_owned());
    }
    if !access.allows_http(&request.method, &url) {
        return Next::Refused(refused(&request.method, &url));
    }
    request.url = url;
    followed.hops += 1;
    Next::Hop(hop(request))
}

/// The request actually sent for a hop: the platform must not follow
/// redirects itself.
pub(crate) fn hop(request: &HttpRequest) -> HttpRequest {
    let mut hop = request.clone();
    hop.follow_redirects = false;
    hop
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_redirect_locations() {
        assert_eq!(
            nsh_core::access::resolve_reference("https://a.com/x/y?q", "https://b.com/"),
            "https://b.com/"
        );
        assert_eq!(
            nsh_core::access::resolve_reference("https://a.com/x/y", "//c.com/z"),
            "https://c.com/z"
        );
        assert_eq!(
            nsh_core::access::resolve_reference("https://a.com:8443/x/y", "/z"),
            "https://a.com:8443/z"
        );
        assert_eq!(
            nsh_core::access::resolve_reference("https://a.com/x/y?q", "z"),
            "https://a.com/x/z"
        );
    }

    #[test]
    fn every_hop_is_checked() {
        let access = Access {
            declared: nsh_core::access::Capabilities::from_json(
                &serde_json::json!({ "network": { "hosts": ["a.com"] } }),
            )
            .unwrap(),
            granted: None,
        };
        let request = HttpRequest {
            method: "POST".into(),
            url: "https://a.com/start".into(),
            headers: vec![("Content-Type".into(), "text/plain".into())],
            body: HttpBody::Bytes(b"x".to_vec()),
            follow_redirects: true,
        };
        let mut followed = Followed { request, hops: 0 };
        let redirect = |status, location: &str| HttpHead {
            status,
            url: String::new(),
            headers: vec![("Location".into(), location.into())],
            ..HttpHead::default()
        };
        // Within the grant: the next hop, as a GET after a 302 POST.
        let Next::Hop(hop) = next(&access, &mut followed, redirect(302, "/next")) else {
            panic!("expected a hop")
        };
        assert_eq!(
            (hop.method.as_str(), hop.url.as_str()),
            ("GET", "https://a.com/next")
        );
        assert!(!hop.follow_redirects && hop.body.is_empty() && hop.headers.is_empty());
        // Out of it: refused.
        let Next::Refused(refused) =
            next(&access, &mut followed, redirect(307, "https://evil.io/"))
        else {
            panic!("expected a refusal")
        };
        assert!(refused.message.contains("`evil.io`"));
        assert_eq!(refused.url, "https://evil.io/");
        // A streamed body is not sent again.
        followed.request.body = HttpBody::Stream;
        followed.request.method = "PUT".into();
        let r = next(&access, &mut followed, redirect(307, "/again"));
        assert!(
            matches!(&r, Next::Fail(e) if e.contains("streamed")),
            "{r:?}"
        );
    }
}
