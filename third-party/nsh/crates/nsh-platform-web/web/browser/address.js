// `nsh`'s `UrlScheme.url` / `setUrl` where the app is the whole page (the
// web): the address is the page's. In the app's realm, so what `setUrl`
// throws is the app's `TypeError`.

/** `nsh_core::url_scheme::MAX_URL_LEN`, in UTF-8 bytes. */
const MAX_ADDRESS_BYTES = 16 * 1024;
/** What `nsh_core::url_scheme::check_address` refuses: Rust's
 * `char::is_whitespace` (White_Space) and `char::is_control` (Cc). */
const NOT_IN_AN_ADDRESS = /[\p{White_Space}\p{Cc}]/u;

/**
 * Makes `urlScheme`'s `setUrl` (`nsh`'s `UrlScheme`) the page's. `page`:
 * `base()`, what `history.replaceState` resolves against (the page's
 * `document.baseURI`); `origin`, the page's. `url()` reads the core's
 * address as it is, which has the page's from before the app's code runs.
 * The options (`{ history }`) go to the core as they are, which checks them.
 */
export function configureAddress(urlScheme, page) {
  const { setUrl } = urlScheme;
  urlScheme.setUrl = (to, ...options) => {
    // What every platform refuses is checked on what the app passed, not on
    // the URL it resolves to (which escapes spaces): the core throws.
    if (
      typeof to !== "string" ||
      NOT_IN_AN_ADDRESS.test(to) ||
      new TextEncoder().encode(to).length > MAX_ADDRESS_BYTES
    ) {
      return setUrl(to, ...options);
    }
    let resolved;
    try {
      resolved = new URL(to, page.base());
    } catch {
      throw new TypeError(`UrlScheme.setUrl: not a URL: ${to}`);
    }
    if (resolved.origin !== page.origin) {
      throw new TypeError(`UrlScheme.setUrl: ${resolved.href} is not of the page's origin`);
    }
    setUrl(resolved.href, ...options);
  };
}
