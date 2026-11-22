//! `nsh/web`: the page around an app on the web: `Head`, the document's
//! title, description and metadata for search engines and link previews.
//! The browser runtime serves the module itself (`web/browser/page.js` in
//! `nsh-platform-web`); here, on the native hosts, there is no page, so
//! `Head` renders and sets nothing.

use std::ffi::c_int;

use rquickjs::qjs;

use crate::modules::{Export, Item, Ts};

type JsValue = qjs::JSValue;
type JsContext = qjs::JSContext;

/// `<Head …/>`: nothing off the web.
unsafe extern "C" fn head(
    _cx: *mut JsContext,
    _this: JsValue,
    _argc: c_int,
    _argv: *mut JsValue,
) -> JsValue {
    qjs::JS_NULL
}

pub(crate) const EXPORTS: &[Item] = &[(
    "Head",
    Export::Function(head, 1),
    Ts::function(
        "The page's `<head>` while it is mounted: its title, description, canonical URL,\nlanguage, metadata and structured data, which search engines index and link\npreviews show. Several may be mounted (the app's, each page's of a stack): the\nlast mounted wins for what it sets, the ones before it for the rest, so a\npage pushed over another titles the document until it is popped. It renders\nnothing; native hosts have no page and ignore it.",
        &["(props: HeadProps): JSX.Element"],
    ),
)];

pub(crate) const TYPES: &str = r#"/** One `<meta>` of the page: `name` (`"robots"`, `"twitter:card"`) or `property`
 * (Open Graph's `"og:image"`) with its `content`. */
export interface HeadMeta {
  name?: string;
  property?: string;
  content: string;
}

/** What a `<Head>` sets in the page's `<head>`; what it leaves out is the
 * `<Head>`s' mounted before it. */
export interface HeadProps {
  /** The document's title (`<title>`, and `og:title` unless `meta` sets one). */
  title?: string;
  /** The page's summary (`<meta name="description">`, and `og:description`). */
  description?: string;
  /** The page's canonical URL, or a path of the site (`"/notes/q3"`, from
   * the directory the site is published to): `<link rel="canonical">`. */
  canonical?: string;
  /** The page's language (`<html lang>`): `"en"`, `"zh-CN"`. */
  lang?: string;
  /** More `<meta>`s: Open Graph, Twitter cards, `robots`. */
  meta?: HeadMeta[];
  /** Structured data (schema.org), as a JSON-LD `<script>`. */
  jsonLd?: object;
}
"#;
