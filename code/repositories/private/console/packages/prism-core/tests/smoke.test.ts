import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { planSmokeSteps, renderSmokeReport, runSmoke } from "../src/smoke.ts";
import { createPrismCommand } from "../src/index.ts";

const workflow = ["create-project", "upload", "render", "render-status"];

test("C-level smoke plan covers create upload render status", () => {
  const steps = planSmokeSteps({
    mode: "dry-run",
    projectId: "proj-test",
    uploadFile: "README.md",
    uploadFields: { projectId: "proj-test" },
  });

  assert.deepEqual(steps.map((step) => step.endpointName), workflow);
  assert.equal(steps[0]!.input.endpoint.path, "/api/projects");
  assert.equal(steps[1]!.input.file, "README.md");
  assert.equal(steps[2]!.input.endpoint.path, "/s/sandboxes/proxy/render");
  assert.equal(steps[3]!.input.query?.waitMs, "10000");
});

test("smoke report is markdown and redacts session headers", () => {
  const report = renderSmokeReport({
    mode: "dry-run",
    startedAt: "2026-09-17T00:00:00.000Z",
    endedAt: "2026-09-17T00:00:01.000Z",
    status: "PASS",
    results: [{
      name: "project-access",
      status: "PASS",
      command: "console-cli prism project-access --d UUID --dry-run",
      request: {
        method: "GET",
        url: "https://prism.openai.com/api/project-access?d=UUID",
        headers: { cookie: "<redacted>", "x-csrf-token": "<redacted>" },
        hasBody: false,
      },
      response: null,
      error: null,
    }],
  });

  assert.match(report, /^# Prism local smoke verification/m);
  assert.match(report, /MODE: dry-run/);
  assert.match(report, /cookie.*<redacted>/);
  assert.doesNotMatch(report, /session=secret|csrf-secret/);
});

test("smoke 子命令写出 dry-run 验证报告（原 spawn 用例，改走 commander 接缝）", async () => {
  const reportDir = mkdtempSync(join(tmpdir(), "prism-smoke-"));
  const previous = process.exitCode;
  try {
    await createPrismCommand().parseAsync(["node", "prism", "smoke", "--dry-run", "--report-dir", reportDir]);
    const files = readdirSync(reportDir).filter((name) => name.endsWith(".md"));
    assert.equal(files.length, 1);
    assert.match(readFileSync(join(reportDir, files[0]!), "utf8"), /MODE: dry-run/);
  } finally {
    process.exitCode = previous;
  }
});

test("live smoke stops after the first failed endpoint", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return new Response("blocked", { status: 403, statusText: "Forbidden", headers: { "content-type": "text/plain" } });
  };

  const report = await runSmoke({
    mode: "live",
    baseUrl: "https://prism.openai.com",
    headers: { cookie: "session=secret" },
    projectId: "UUID",
    uploadFile: new URL("../fixtures/smoke/main.tex", import.meta.url).pathname,
    fetchImpl,
  });

  assert.equal(report.status, "FAIL");
  assert.equal(calls, 1);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]!.name, "create-project");
});

test("live smoke without a cookie fails fast at preflight without any request", async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    throw new Error("network must not be touched");
  };

  const report = await runSmoke({ mode: "live", headers: {}, fetchImpl });

  assert.equal(report.status, "FAIL");
  assert.equal(calls, 0);
  assert.equal(report.results.length, 1);
  assert.equal(report.results[0]!.name, "preflight");
  assert.equal(report.results[0]!.error, "PRISM_COOKIE is required for --live");
});

test("默认创建项目请求使用已记录的 project_uuid/title 字段", () => {
  const steps = planSmokeSteps({ projectId: "b6d5fe3b-99b4-4e0d-a0d5-5cf4e9cf6273" });
  const body = steps[0]!.input.body as Record<string, unknown>;
  assert.equal(body.project_uuid, "b6d5fe3b-99b4-4e0d-a0d5-5cf4e9cf6273");
  assert.match(body.title as string, /^prismctl-smoke-/);
  assert.equal("name" in body, false);
});
