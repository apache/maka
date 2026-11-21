import { afterEach, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBrowserProbe } from "../src/browser-context.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

class CdpSocket extends EventTarget {
  constructor() {
    super();
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(raw: string) {
    const { id, method } = JSON.parse(raw);
    queueMicrotask(() =>
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            id,
            result:
              method === "Runtime.evaluate" ? { result: { value: { ok: true, status: 200 } } } : {},
          }),
        }),
      ),
    );
  }
  close() {}
}

it("探测成功后清理本次自建 Cookie profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-profile-test-"));
  const chrome = join(dir, "chrome");
  writeFileSync(chrome, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
  vi.stubEnv("TMPDIR", dir);
  vi.stubEnv("PRISM_CHROME_PATH", chrome);
  vi.stubGlobal("WebSocket", CdpSocket);
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ id: "fixture", webSocketDebuggerUrl: "ws://fixture.invalid" })),
  );
  const { report } = await runBrowserProbe({
    baseUrl: "https://fixture.invalid",
    cookieHeader: "session=fixture-only",
    reportDir: join(dir, "reports"),
    keepOpen: false,
  });
  expect(report.status).toBe("PASS");
  expect(existsSync(report.userDataDir)).toBe(false);
  expect(readdirSync(dir).some((name) => name.startsWith("prism-cdp-"))).toBe(false);
});

it("浏览器创建失败时拒绝探测并清理自建 profile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-profile-fail-"));
  vi.stubEnv("TMPDIR", dir);
  vi.stubEnv("PRISM_CHROME_PATH", dir); // 目录不可作为可执行文件。
  vi.stubGlobal("WebSocket", CdpSocket);
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ id: "fixture", webSocketDebuggerUrl: "ws://fixture.invalid" })),
  );
  await expect(
    runBrowserProbe({
      baseUrl: "https://fixture.invalid",
      cookieHeader: "session=fixture-only",
      reportDir: join(dir, "reports"),
      keepOpen: false,
    }),
  ).rejects.toThrow();
  expect(readdirSync(dir).some((name) => name.startsWith("prism-cdp-"))).toBe(false);
});

it("显式 profile 由用户管理，异常退出也保持目录内容", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-explicit-profile-"));
  const profile = join(dir, "user-profile");
  const { mkdirSync, readFileSync } = await import("node:fs");
  mkdirSync(profile);
  writeFileSync(join(profile, "marker"), "user-owned");
  const chrome = join(dir, "chrome");
  writeFileSync(chrome, "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
  vi.stubEnv("PRISM_CHROME_PATH", chrome);
  vi.stubGlobal("WebSocket", CdpSocket);
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ id: "fixture", webSocketDebuggerUrl: "ws://fixture.invalid" })),
  );
  await expect(
    runBrowserProbe({
      baseUrl: "invalid-url",
      cookieHeader: "session=fixture-only",
      userDataDir: profile,
      reportDir: join(dir, "reports"),
      keepOpen: false,
    }),
  ).rejects.toThrow();
  expect(readFileSync(join(profile, "marker"), "utf8")).toBe("user-owned");
});

it("keepOpen 保留自建浏览器和 profile，CDP 失败仍释放探测连接", async () => {
  const dir = mkdtempSync(join(tmpdir(), "prism-keep-profile-"));
  const chrome = join(dir, "chrome");
  const pidFile = join(dir, "pid");
  const { readFileSync } = await import("node:fs");
  writeFileSync(chrome, '#!/bin/sh\nprintf "%s" "$$" > "$PRISM_FIXTURE_PID"\nexec sleep 60\n', {
    mode: 0o700,
  });
  vi.stubEnv("TMPDIR", dir);
  vi.stubEnv("PRISM_CHROME_PATH", chrome);
  vi.stubEnv("PRISM_FIXTURE_PID", pidFile);
  let connected = false;
  vi.stubGlobal(
    "WebSocket",
    class extends CdpSocket {
      constructor() {
        super();
        connected = true;
      }
      close() {
        connected = false;
      }
      send(raw: string) {
        const { id, method } = JSON.parse(raw);
        if (method !== "Runtime.evaluate") return super.send(raw);
        queueMicrotask(() =>
          this.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({ id, error: { message: "fixture CDP failure" } }),
            }),
          ),
        );
      }
    },
  );
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(JSON.stringify({ id: "fixture", webSocketDebuggerUrl: "ws://fixture.invalid" })),
  );
  try {
    await expect(
      runBrowserProbe({
        baseUrl: "https://fixture.invalid",
        cookieHeader: "session=fixture-only",
        reportDir: join(dir, "reports"),
        keepOpen: true,
      }),
    ).rejects.toThrow("fixture CDP failure");
    expect(connected).toBe(false);
    expect(readdirSync(dir).some((name) => name.startsWith("prism-cdp-"))).toBe(true);
    process.kill(Number(readFileSync(pidFile, "utf8")), 0);
  } finally {
    process.kill(Number(readFileSync(pidFile, "utf8")));
  }
});
