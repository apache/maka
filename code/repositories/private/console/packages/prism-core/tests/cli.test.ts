import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ENDPOINTS, endpointNames, getEndpoint } from "../src/endpoints.ts";
import { buildRequest, redactHeaders } from "../src/http.ts";
import { createPrismCommand } from "../src/index.ts";

const required: Array<[string, string, string]> = [
  ["create-project", "POST", "/api/projects"],
  ["project-access", "GET", "/api/project-access"],
  ["conversation-history", "POST", "/api/codex/conversation-history"],
  ["llm-start", "POST", "/api/llm/response_with_tools_start"],
  ["llm-status", "POST", "/api/llm/response_with_tools_status"],
  ["render", "POST", "/s/sandboxes/proxy/render"],
  ["render-status", "GET", "/s/sandboxes/proxy/render-status"],
  ["upload", "POST", "/api/project-files/upload"],
  ["thumbnail", "PATCH", "/api/projects/{uuid}/thumbnail"],
];

test("endpoint map contains every screenshot endpoint", () => {
  for (const [name, method, path] of required) {
    assert.equal(ENDPOINTS[name]?.method, method);
    assert.equal(ENDPOINTS[name]?.path, path);
  }
  assert.deepEqual(endpointNames(), required.map(([name]) => name));
});

test("buildRequest replaces path and query params without leaking auth", async () => {
  const request = await buildRequest({
    endpoint: getEndpoint("project-access"),
    baseUrl: "https://prism.openai.com",
    query: { d: "abc-123" },
    headers: { cookie: "session=secret", "x-csrf-token": "token" },
  });

  assert.equal(request.url, "https://prism.openai.com/api/project-access?d=abc-123");
  assert.equal(request.options.method, "GET");
  assert.equal(request.options.headers.cookie, "session=secret");
  assert.equal(redactHeaders(request.options.headers).cookie, "<redacted>");
  assert.equal(redactHeaders(request.options.headers)["x-csrf-token"], "<redacted>");
});

test("buildRequest supports JSON bodies and thumbnail uuid path", async () => {
  const request = await buildRequest({
    endpoint: getEndpoint("thumbnail"),
    baseUrl: "https://prism.openai.com/",
    pathParams: { uuid: "proj-1" },
    body: { thumbnailUrl: "data:image/png;base64,abc" },
  });

  assert.equal(request.url, "https://prism.openai.com/api/projects/proj-1/thumbnail");
  assert.equal(request.options.method, "PATCH");
  assert.equal(request.options.headers["content-type"], "application/json");
  assert.equal(request.options.body, JSON.stringify({ thumbnailUrl: "data:image/png;base64,abc" }));
});

test("bare prism command prints usage and exits 0（原 --help spawn 用例，改走 commander 接缝）", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const previous = process.exitCode;
  try {
    await createPrismCommand().parseAsync(["node", "prism"]);
    assert.equal(process.exitCode, 0);
    assert.match(String(log.mock.calls.map((args) => args[0]).join("\n")), /Usage:/);
    assert.doesNotMatch(String(log.mock.calls.map((args) => args[0]).join("\n")), /Unknown endpoint/);
  } finally {
    log.mockRestore();
    process.exitCode = previous;
  }
});

test("dry-run 经 prism 命令组透传手写解析器（未知选项不被 commander 截胡）", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const previous = process.exitCode;
  try {
    await createPrismCommand().parseAsync(["node", "prism", "project-access", "--d", "UUID", "--dry-run"]);
    assert.equal(process.exitCode, 0);
    const printed = String(log.mock.calls.map((args) => args[0]).join("\n"));
    assert.match(printed, /project-access\?d=UUID/);
    assert.doesNotMatch(printed, /PRISM_COOKIE/);
  } finally {
    log.mockRestore();
    process.exitCode = previous;
  }
});
