import assert from "node:assert/strict";
import { test } from "vitest";
import { cookieHeaderToCdpCookies, makeBrowserFetchExpression, redactBrowserResult } from "../src/browser-context.ts";

test("cookieHeaderToCdpCookies parses Prism cookies for CDP without attributes", () => {
  const cookies = cookieHeaderToCdpCookies("a=1; prism_session_token=secret.jwt; cf_clearance=clear", "https://prism.openai.com");
  assert.deepEqual(cookies.map((c) => c.name), ["a", "prism_session_token", "cf_clearance"]);
  assert.equal(cookies[1]!.value, "secret.jwt");
  assert.equal(cookies[1]!.domain, "prism.openai.com");
  assert.equal(cookies[1]!.secure, true);
  assert.equal(cookies[1]!.sameSite, "Lax");
});

test("makeBrowserFetchExpression creates same-origin fetch script", () => {
  const expr = makeBrowserFetchExpression({
    url: "https://prism.openai.com/s/sandboxes/proxy/render-status?waitMs=10000",
    method: "GET",
    headers: {},
  });
  assert.match(expr, /fetch\(/);
  assert.match(expr, /credentials: "include"/);
  assert.match(expr, /xPrismAuthRequestId/);
  assert.doesNotMatch(expr, /prism_session_token|cf_clearance/);
});

test("redactBrowserResult hides sensitive response headers", () => {
  const redacted = redactBrowserResult({
    status: 200,
    headers: {
      "content-type": "application/json",
      "set-cookie": "secret",
      "x-prism-auth-request-id": "id-1",
    },
    body: { token: "secret", ok: true },
  });
  assert.equal(redacted.headers["set-cookie"], "<redacted>");
  assert.equal(redacted.body.token, "<redacted>");
  assert.equal(redacted.body.ok, true);
});
