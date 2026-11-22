//! Portable URL utilities. Browser paths resolve against the virtual root,
//! while serialization follows the native standard-module implementation.
use rquickjs::{Coerced, Ctx, Exception, Object, Result, Value, function::Opt};
use url::Url;

pub(super) fn file_href(path: &str) -> String {
    let mut url = Url::parse("file:///").expect("constant file URL");
    // set_path escapes URL delimiters but preserves percent escapes. File
    // paths contain literal percent signs, so escape those before setting it.
    url.set_path(&path.replace('%', "%25").replace('\\', "%5C"));
    url.into()
}

pub(super) fn file_url_to_path(_cx: Ctx<'_>, input: Coerced<String>) -> Result<String> {
    // Preserve the native module's string projection, including its treatment
    // of escaped characters. The existing API record owns these semantics.
    Ok(input.0.trim_start_matches("file://").to_owned())
}

fn parse(cx: &Ctx<'_>, input: &str) -> Result<Url> {
    Url::parse(input).map_err(|error| Exception::throw_type(cx, &error.to_string()))
}

pub(super) fn format<'js>(
    cx: Ctx<'js>,
    input: Coerced<String>,
    options: Opt<Value<'js>>,
) -> Result<String> {
    let url = parse(&cx, &input.0)?;
    let options = options.0.and_then(|value| value.into_object());
    let option = |name: &str, default: bool| {
        options
            .as_ref()
            .and_then(|object| object.get::<_, bool>(name).ok())
            .unwrap_or(default)
    };
    let mut text = format!("{}://", url.scheme());
    if option("auth", true) && !url.username().is_empty() {
        text.push_str(url.username());
        if let Some(password) = url.password().filter(|password| !password.is_empty()) {
            text.push(':');
            text.push_str(password);
        }
        text.push('@');
    }
    let host = &url[url::Position::BeforeHost..url::Position::AfterPort];
    if option("unicode", false) {
        text.push_str(&url::quirks::domain_to_unicode(host));
    } else {
        text.push_str(host);
    }
    text.push_str(url.path());
    if option("search", true) {
        text.push_str(url::quirks::search(&url));
    }
    if option("fragment", true) {
        text.push_str(url::quirks::hash(&url));
    }
    Ok(text)
}

pub(super) fn url_to_http_options<'js>(
    cx: Ctx<'js>,
    input: Coerced<String>,
) -> Result<Object<'js>> {
    let url = parse(&cx, &input.0)?;
    let object = Object::new(cx)?;
    object.set("protocol", format!("{}:", url.scheme()))?;
    object.set("hostname", url.host_str().unwrap_or(""))?;
    if let Some(fragment) = url.fragment().filter(|fragment| !fragment.is_empty()) {
        object.set("hash", fragment)?;
    }
    let search = url::quirks::search(&url);
    if !search.is_empty() {
        object.set("search", search)?;
    }
    object.set("pathname", url.path())?;
    object.set("path", format!("{}{search}", url.path()))?;
    object.set("href", url.as_str())?;
    if !url.username().is_empty() {
        object.set(
            "auth",
            format!("{}:{}", url.username(), url.password().unwrap_or("")),
        )?;
    }
    if let Some(port) = url.port() {
        object.set("port", port.to_string())?;
    }
    Ok(object)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_utilities_preserve_native_projection() {
        assert_eq!(
            file_href("docs/a b#c%20.txt"),
            "file:///docs/a%20b%23c%2520.txt"
        );
        let host = crate::Host::new().unwrap();
        host.with_raw(|raw| {
            // SAFETY: the host holds the context lock; no JS handle escapes.
            let cx = unsafe { Ctx::from_raw(std::ptr::NonNull::new(raw).unwrap()) };
            let input = "https://user:pass@example.com:8443/a?q=1#fragment";
            let portable = url_to_http_options(cx.clone(), Coerced(input.to_owned())).unwrap();
            let native =
                super::super::url_to_http_options(cx.clone(), Coerced(input.to_owned())).unwrap();
            for key in [
                "protocol", "hostname", "hash", "search", "pathname", "path", "href", "auth",
                "port",
            ] {
                assert_eq!(
                    portable.get::<_, String>(key).unwrap(),
                    native.get::<_, String>(key).unwrap(),
                    "{key}"
                );
            }
            assert_eq!(
                format(cx.clone(), Coerced(input.to_owned()), Opt(None)).unwrap(),
                super::super::format(cx.clone(), Coerced(input.to_owned()), Opt(None)).unwrap()
            );
            assert_eq!(
                file_url_to_path(cx, Coerced("file:///a%20b".to_owned())).unwrap(),
                "/a%20b"
            );
        });
    }
}
