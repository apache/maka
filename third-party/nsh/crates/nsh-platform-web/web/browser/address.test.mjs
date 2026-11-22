// `UrlScheme.url` / `setUrl` where the app is the page, without nsh.wasm:
// `node --test crates/nsh-platform-web/web/browser/address.test.mjs`.
import test from "node:test";
import assert from "node:assert/strict";
import { configureAddress } from "./address.js";

/** `UrlScheme` whose core side records the URLs set and throws as the
 * core's `check_address` does. */
function urlScheme() {
  const set = [];
  const scheme = {
    url: () => null,
    setUrl(url, ...options) {
      if (typeof url !== "string") throw new TypeError("not a string");
      if (/[\p{White_Space}\p{Cc}]/u.test(url)) throw new TypeError("an address has no whitespace or control characters");
      if (new TextEncoder().encode(url).length > 16 * 1024) throw new TypeError("an address has at most 16384 bytes");
      set.push(options.length ? [url, ...options] : url);
    },
  };
  configureAddress(scheme, {
    base: () => "https://a.test/app/",
    origin: "https://a.test",
  });
  return { scheme, set };
}

test("setUrl resolves a page's address against its base", () => {
  const { scheme, set } = urlScheme();
  scheme.setUrl("?message=42");
  scheme.setUrl("/other");
  assert.deepEqual(set, ["https://a.test/app/?message=42", "https://a.test/other"]);
});

test("setUrl refuses what every platform refuses before resolving it", () => {
  const { scheme, set } = urlScheme();
  // Resolved, these would be `a%20b` and `a%0Ab`: valid on the web only.
  for (const wrong of ["a b", "a\nb", "a b", "a b", 42, "a".repeat(16 * 1024 + 1)]) {
    assert.throws(() => scheme.setUrl(wrong), TypeError, String(wrong).slice(0, 20));
  }
  assert.throws(() => scheme.setUrl("https://b.test/"), /not of the page's origin/);
  assert.deepEqual(set, []);
});

test("setUrl hands its options to the core as they are", () => {
  const { scheme, set } = urlScheme();
  scheme.setUrl("?tab=live", { history: "push" });
  scheme.setUrl("?tab=all");
  assert.deepEqual(set, [["https://a.test/app/?tab=live", { history: "push" }], "https://a.test/app/?tab=all"]);
});
