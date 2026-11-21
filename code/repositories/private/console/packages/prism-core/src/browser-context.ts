import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactHeaders } from "./http.ts";

const DEFAULT_BASE_URL = "https://prism.openai.com";
const SECRET_KEY = /authorization|cookie|csrf|token|secret|api[-_]?key|session|set-cookie/i;

function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function redactJson(value: any, depth = 0): any {
  if (depth > 6) return "<truncated>";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactJson(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) out[key] = SECRET_KEY.test(key) ? "<redacted>" : redactJson(nested, depth + 1);
    return out;
  }
  if (typeof value === "string" && value.length > 1200) return `${value.slice(0, 1200)}...<truncated>`;
  return value;
}

function cleanCookieHeader(header = "") {
  return header.trim().replace(/\\_/g, "_").replace(/\\\./g, ".").replace(/&#x20;/g, " ").replace(/;\s*$/g, "");
}

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
}

export function cookieHeaderToCdpCookies(header: string, url = DEFAULT_BASE_URL): CdpCookie[] {
  const host = new URL(url).hostname;
  return cleanCookieHeader(header)
    .split(/;\s*/)
    .map((part) => {
      const index = part.indexOf("=");
      if (index < 1) return null;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!name || /^(path|expires|max-age|domain|secure|httponly|samesite)$/i.test(name)) return null;
      return { name, value, domain: host, path: "/", secure: true, httpOnly: false, sameSite: "Lax" };
    })
    .filter((cookie): cookie is CdpCookie => cookie !== null);
}

function jsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (error) { throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

export function loadBrowserConfig() {
  return {
    baseUrl: process.env.PRISM_BASE_URL || DEFAULT_BASE_URL,
    cookieHeader: process.env.PRISM_COOKIE || "",
    probePath: process.env.PRISM_BROWSER_PATH || "/s/sandboxes/proxy/render-status?waitMs=10000",
    method: process.env.PRISM_BROWSER_METHOD || "GET",
    body: jsonEnv<unknown>("PRISM_BROWSER_BODY_JSON", undefined),
    reportDir: process.env.PRISM_REPORT_DIR || "verification",
    port: Number(process.env.PRISM_CDP_PORT || 9223),
    userDataDir: process.env.PRISM_CHROME_USER_DATA_DIR,
    keepOpen: process.env.PRISM_KEEP_BROWSER === "1",
  };
}

export function makeBrowserFetchExpression({ url, method = "GET", headers = {}, body }: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): string {
  return `
(async () => {
  const res = await fetch(${JSON.stringify(url)}, {
    method: ${JSON.stringify(method)},
    credentials: "include",
    headers: ${JSON.stringify(body === undefined ? headers : { "content-type": "application/json", ...headers })},
    ${body === undefined ? "" : `body: ${JSON.stringify(typeof body === "string" ? body : JSON.stringify(body))},`}
  });
  const text = await res.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  const headers = Object.fromEntries([...res.headers.entries()]);
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    contentType: res.headers.get("content-type"),
    server: res.headers.get("server"),
    xPrismAuthRequestId: res.headers.get("x-prism-auth-request-id"),
    headers,
    body: parsed,
  };
})()`;
}

// ponytail: 脱敏输出是给人看的报告 JSON，不值得为它建精确类型。
export function redactBrowserResult(result: any): any {
  return redactJson({ ...result, headers: redactHeaders(result?.headers || {}) });
}

function findChrome() {
  const candidates = [
    process.env.PRISM_CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "D:\\DevTools\\Network\\RunningCheeseChrome\\App\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter((candidate): candidate is string => Boolean(candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("Chrome executable not found. Set PRISM_CHROME_PATH.");
  return found;
}

async function waitForJson(url: string, timeoutMs = 15000): Promise<any> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(1, timeoutMs - (Date.now() - start))) });
      if (res.ok) return await res.json();
      lastError = new Error(`${res.status} ${res.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  const message = lastError instanceof Error ? lastError.message : "unknown";
  throw new Error(`Timed out waiting for ${url}: ${message}`);
}

async function cdpCall(ws: WebSocket, idRef: { value: number }, method: string, params: Record<string, unknown> = {}): Promise<any> {
  const id = ++idRef.value;
  ws.send(JSON.stringify({ id, method, params }));
  return await new Promise((resolvePromise, rejectPromise) => {
    const onMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data.toString());
      if (msg.id !== id) return;
      ws.removeEventListener("message", onMessage);
      if (msg.error) rejectPromise(new Error(`${method}: ${msg.error.message}`));
      else resolvePromise(msg.result);
    };
    ws.addEventListener("message", onMessage);
    setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      rejectPromise(new Error(`${method}: timeout`));
    }, 20000).unref?.();
  });
}

interface CdpTarget {
  id?: string;
  webSocketDebuggerUrl: string;
}

async function createTarget(port: number, targetUrl: string): Promise<CdpTarget> {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`, { method: "PUT", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`CDP new target failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as CdpTarget;
}

async function closeTarget(port: number, targetId: string) {
  try { await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, { signal: AbortSignal.timeout(5_000) }); } catch {}
}

export interface BrowserProbeOptions {
  baseUrl?: string;
  cookieHeader?: string;
  probePath?: string;
  method?: string;
  body?: unknown;
  reportDir?: string;
  port?: number;
  userDataDir?: string;
  keepOpen?: boolean;
}

export interface BrowserReport {
  mode: "browser-context";
  status: "PASS" | "FAIL";
  startedAt: string;
  endedAt: string;
  chromePath: string;
  userDataDir: string;
  probeUrl: string;
  cookiesInjected: string[];
  result: unknown;
}

export async function runBrowserProbe({
  baseUrl = DEFAULT_BASE_URL,
  cookieHeader = process.env.PRISM_COOKIE || "",
  probePath = "/s/sandboxes/proxy/render-status?waitMs=10000",
  method = "GET",
  body,
  reportDir = "verification",
  port = Number(process.env.PRISM_CDP_PORT || 9223),
  userDataDir = process.env.PRISM_CHROME_USER_DATA_DIR,
  keepOpen = process.env.PRISM_KEEP_BROWSER === "1",
}: BrowserProbeOptions = {}): Promise<{ path: string; report: BrowserReport }> {
  const startedAt = new Date().toISOString();
  const profileDir = userDataDir || await mkdtemp(join(tmpdir(), "prism-cdp-"));
  let child: ReturnType<typeof spawn> | undefined;
  let target: CdpTarget | undefined;
  let ws: WebSocket | undefined;
  try {
    const chromePath = findChrome();
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      baseUrl,
    ];
    child = spawn(chromePath, args, { stdio: "ignore", detached: true });
    child.unref();
    await once(child, "spawn");
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    target = await createTarget(port, baseUrl);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      ws!.addEventListener("open", resolveOpen, { once: true });
      ws!.addEventListener("error", rejectOpen, { once: true });
    });
    const idRef = { value: 0 };
    await cdpCall(ws, idRef, "Network.enable");
    const cookies = cookieHeaderToCdpCookies(cookieHeader, baseUrl);
    if (cookies.length) await cdpCall(ws, idRef, "Network.setCookies", { cookies });
    await cdpCall(ws, idRef, "Page.navigate", { url: baseUrl });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2500));
    const url = new URL(probePath, baseUrl).toString();
    const expression = makeBrowserFetchExpression({ url, method, headers: { accept: "application/json,text/plain,*/*" }, body });
    const evaluated = await cdpCall(ws, idRef, "Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    const value = evaluated.result?.value || { error: evaluated.exceptionDetails?.text || "no result" };
    const report: BrowserReport = {
      mode: "browser-context",
      status: value.ok ? "PASS" : "FAIL",
      startedAt,
      endedAt: new Date().toISOString(),
      chromePath,
      userDataDir: profileDir,
      probeUrl: url,
      cookiesInjected: cookies.map((cookie) => cookie.name),
      result: redactBrowserResult(value),
    };
    await mkdir(reportDir, { recursive: true });
    const path = join(reportDir, `browser-context-${isoStamp()}.md`);
    await writeFile(path, renderBrowserReport(report), "utf8");
    return { path, report };
  } finally {
    ws?.close();
    if (target?.id) await closeTarget(port, target.id);
    if (!keepOpen && child?.pid && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill();
      await stopped;
    }
    // keepOpen 明确保留浏览器及 profile；显式目录始终由用户管理。
    if (!userDataDir && (!keepOpen || !child?.pid)) {
      await rm(profileDir, { recursive: true, force: true });
    }
  }
}

export function renderBrowserReport(report: BrowserReport): string {
  return [
    "# Prism browser-context verification",
    "",
    `MODE: ${report.mode}`,
    `STATUS: ${report.status}`,
    `STARTED: ${report.startedAt}`,
    `ENDED: ${report.endedAt}`,
    `PROBE: ${report.probeUrl}`,
    "",
    "## Cookie names injected",
    "",
    "```json",
    JSON.stringify(report.cookiesInjected, null, 2),
    "```",
    "",
    "## Result",
    "",
    "```json",
    JSON.stringify(report.result, null, 2),
    "```",
    "",
  ].join("\n");
}

