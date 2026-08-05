import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsTestResultMessage } from "../../renderer/locales/settings-test-result-copy.js";

test("localizes structured proxy results without main-process display copy", () => {
  const result = {
    ok: true,
    code: "proxy_reachable",
    message: "The proxy is reachable.",
    details: {
      endpoint: "http://127.0.0.1:7890",
      ip: "203.0.113.7",
      countryFlag: "🌐",
    },
  } as const;

  assert.equal(
    settingsTestResultMessage(result, "en"),
    "The proxy is reachable · http://127.0.0.1:7890 · 🌐 203.0.113.7",
  );
  assert.equal(
    settingsTestResultMessage(result, "zh"),
    "代理配置有效 · http://127.0.0.1:7890 · 🌐 203.0.113.7",
  );
});

test("localizes proxy and bot failure codes", () => {
  assert.equal(
    settingsTestResultMessage(
      {
        ok: false,
        code: "proxy_http_error",
        message: "The proxy test returned HTTP 502.",
        details: { status: 502 },
      },
      "zh",
    ),
    "代理测试返回 HTTP 502，请检查代理服务或测试地址。",
  );
  assert.equal(
    settingsTestResultMessage(
      {
        ok: false,
        code: "bot_token_missing",
        message: "Telegram requires a Bot Token.",
      },
      "en",
    ),
    "Enter a Bot Token before testing the connection.",
  );
});
