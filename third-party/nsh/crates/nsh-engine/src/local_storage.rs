//! Where an app's storage lives in a browser's `localStorage`, which the
//! origin's apps share: each entry under `nsh:<app id>:<key>`, or, for an
//! app without an id, `nsh:<path>:<key>`, `<path>` being the directory of
//! the page's URL; so apps keep apart and the page's other keys are left
//! alone. Here rather than in the web backend, which only builds for
//! WebAssembly, so it is tested on every machine.

/// The prefix of the `localStorage` keys of app `app_id` on the page at
/// `url` (`document.baseURI`): `nsh:com.example.todo:`; without an id,
/// `nsh:/apps/todo/:` for `https://x.com/apps/todo/index.html?a#b`.
pub fn local_storage_prefix(app_id: Option<&str>, url: &str) -> String {
    if let Some(id) = app_id.filter(|id| !id.is_empty() && !id.contains(':')) {
        return format!("nsh:{id}:");
    }
    let url = url.split(['?', '#']).next().unwrap_or("");
    let path = match url.find("://") {
        Some(scheme) => {
            let rest = &url[scheme + 3..];
            rest.find('/').map_or("/", |host| &rest[host..])
        }
        None => url,
    };
    let dir = path.rfind('/').map_or("/", |slash| &path[..=slash]);
    format!("nsh:{dir}:")
}

#[cfg(test)]
mod tests {
    use super::local_storage_prefix;

    fn prefix(url: &str) -> String {
        local_storage_prefix(None, url)
    }

    #[test]
    fn the_prefix_is_the_page_directory() {
        assert_eq!(
            prefix("https://x.com/apps/todo/index.html?a#b"),
            "nsh:/apps/todo/:"
        );
        // A directory and its index page share their entries.
        assert_eq!(prefix("https://x.com/apps/todo/"), "nsh:/apps/todo/:");
        assert_eq!(
            prefix("https://x.com/apps/todo/index.html"),
            "nsh:/apps/todo/:"
        );
        // Pages at other paths keep apart.
        assert_ne!(
            prefix("https://x.com/apps/todo/"),
            prefix("https://x.com/apps/notes/")
        );
        assert_eq!(prefix("https://x.com"), "nsh:/:");
        assert_eq!(prefix("https://x.com?q=/a/b"), "nsh:/:");
        assert_eq!(
            prefix("http://127.0.0.1:8765/play/index.html#counter"),
            "nsh:/play/:"
        );
        // An unknown page: one namespace.
        assert_eq!(prefix(""), "nsh:/:");
    }

    #[test]
    fn an_app_id_names_the_prefix() {
        let at = |id| local_storage_prefix(Some(id), "https://x.com/apps/todo/");
        assert_eq!(at("com.example.todo"), "nsh:com.example.todo:");
        // Apps keep their entries wherever their page is.
        assert_eq!(
            local_storage_prefix(Some("com.example.todo"), "https://y.org/"),
            at("com.example.todo")
        );
        // An id that cannot be one falls back to the page.
        assert_eq!(at(""), "nsh:/apps/todo/:");
        assert_eq!(at("a:b"), "nsh:/apps/todo/:");
    }
}
