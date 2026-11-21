import { fileURLToPath } from "node:url";
import { buildRequest, redactHeaders, sendRequest, type RequestInput } from "./http.ts";
import { getEndpoint } from "./endpoints.ts";

// smoke 默认上传样本锚定包内 fixtures，CWD 无关；PRISM_UPLOAD_FILE 可覆盖
const DEFAULT_UPLOAD_FILE = fileURLToPath(new URL("../fixtures/smoke/main.tex", import.meta.url));

const DEFAULT_BASE_URL = "https://prism.openai.com";
const SECRET_KEY = /authorization|cookie|csrf|token|secret|api[-_]?key|session/i;

function isoStamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}

function jsonEnv<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sessionHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.PRISM_COOKIE) headers.cookie = process.env.PRISM_COOKIE;
  if (process.env.PRISM_CSRF_TOKEN) headers["x-csrf-token"] = process.env.PRISM_CSRF_TOKEN;
  if (process.env.PRISM_AUTHORIZATION) headers.authorization = process.env.PRISM_AUTHORIZATION;
  return headers;
}

function redactJson(value: any, depth = 0): any {
  if (depth > 6) return "<truncated>";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactJson(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "<redacted>" : redactJson(nested, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 1000) return `${value.slice(0, 1000)}...<truncated>`;
  return value;
}

function pickId(value: any, names: string[] = ["projectId", "project_id", "uuid", "id"]): string | null {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = pickId(item, names);
      if (found) return found;
    }
    return null;
  }
  for (const name of names) {
    if (typeof value[name] === "string" && value[name]) return value[name];
  }
  for (const nested of Object.values(value)) {
    const found = pickId(nested, names);
    if (found) return found;
  }
  return null;
}

interface CommandConfig {
  mode?: string;
  projectId?: string;
  uploadFile?: string;
  waitMs?: string | number;
}

function commandFor(name: string, config: CommandConfig) {
  const bits = ["console-cli prism", name];
  if (name === "project-access") bits.push("--d", config.projectId || "UUID");
  if (name === "upload") bits.push("--file", config.uploadFile || DEFAULT_UPLOAD_FILE, "--field", `projectId=${config.projectId || "UUID"}`);
  if (name === "thumbnail") bits.push("--uuid", config.projectId || "UUID");
  if (name === "render-status") bits.push("--wait-ms", String(config.waitMs));
  if (config.mode === "dry-run") bits.push("--dry-run");
  return bits.join(" ");
}

export interface SmokeConfig {
  mode?: "dry-run" | "live";
  baseUrl?: string;
  projectId?: string;
  uploadFile?: string;
  uploadFields?: Record<string, string> | null;
  createProjectBody?: Record<string, unknown> | null;
  renderBody?: Record<string, unknown> | null;
  renderStatusQuery?: Record<string, string>;
  waitMs?: string;
  reportDir?: string;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

export function loadSmokeConfig(argv: string[] = process.argv.slice(2)): SmokeConfig {
  const config: SmokeConfig = {
    mode: process.env.PRISM_LIVE === "1" ? "live" : "dry-run",
    baseUrl: process.env.PRISM_BASE_URL || DEFAULT_BASE_URL,
    projectId: process.env.PRISM_PROJECT_ID || "UUID",
    uploadFile: process.env.PRISM_UPLOAD_FILE || DEFAULT_UPLOAD_FILE,
    uploadFields: jsonEnv<Record<string, string> | null>("PRISM_UPLOAD_FIELDS_JSON", null),
    createProjectBody: jsonEnv<Record<string, unknown> | null>("PRISM_CREATE_PROJECT_JSON", null),
    renderBody: jsonEnv<Record<string, unknown> | null>("PRISM_RENDER_JSON", null),
    renderStatusQuery: jsonEnv<Record<string, string>>("PRISM_RENDER_STATUS_QUERY_JSON", {}),
    waitMs: process.env.PRISM_WAIT_MS || "10000",
    reportDir: process.env.PRISM_REPORT_DIR || "verification",
    headers: sessionHeaders(),
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--live") config.mode = "live";
    else if (arg === "--dry-run") config.mode = "dry-run";
    else if (arg === "--project-id") config.projectId = argv[++i];
    else if (arg === "--upload-file") config.uploadFile = argv[++i];
    else if (arg === "--report-dir") config.reportDir = argv[++i];
    else if (arg === "--wait-ms") config.waitMs = argv[++i];
    else throw new Error(`Unknown smoke option: ${arg}`);
  }
  return config;
}

export interface SmokeStep {
  name: string;
  endpointName: string;
  command: string;
  input: RequestInput;
}

export function planSmokeSteps(config: SmokeConfig = {}): SmokeStep[] {
  const mode = config.mode || "dry-run";
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const headers = config.headers || {};
  const projectId = config.projectId || "UUID";
  const waitMs = String(config.waitMs || "10000");
  const uploadFile = config.uploadFile || DEFAULT_UPLOAD_FILE;
  const uploadFields = config.uploadFields || { projectId };
  const createProjectBody = config.createProjectBody || { project_uuid: projectId, title: `prismctl-smoke-${isoStamp()}` };
  const renderBody = config.renderBody || { projectId };

  return [
    {
      name: "create project",
      endpointName: "create-project",
      command: commandFor("create-project", { mode }),
      input: { endpoint: getEndpoint("create-project"), baseUrl, headers, body: createProjectBody },
    },
    {
      name: "upload tex file",
      endpointName: "upload",
      command: commandFor("upload", { mode, uploadFile, projectId }),
      input: { endpoint: getEndpoint("upload"), baseUrl, headers, file: uploadFile, fields: uploadFields },
    },
    {
      name: "start render",
      endpointName: "render",
      command: commandFor("render", { mode }),
      input: { endpoint: getEndpoint("render"), baseUrl, headers, body: renderBody },
    },
    {
      name: "poll render status",
      endpointName: "render-status",
      command: commandFor("render-status", { mode, waitMs }),
      input: { endpoint: getEndpoint("render-status"), baseUrl, headers, query: { waitMs, ...(config.renderStatusQuery || {}) } },
    },
  ];
}

export interface SmokeResult {
  name: string;
  status: "PASS" | "FAIL";
  command: string;
  request: { url?: string; method?: string; headers?: Record<string, string>; hasBody?: boolean } | null;
  response: { ok?: boolean; status?: number; statusText?: string; headers?: Record<string, string>; body?: unknown } | null;
  error: string | null;
}

export interface SmokeReport {
  mode: string;
  startedAt: string;
  endedAt: string;
  status: string;
  results: SmokeResult[];
}

async function dryRunStep(step: SmokeStep): Promise<SmokeResult> {
  const request = await buildRequest(step.input);
  return {
    name: step.endpointName,
    status: "PASS",
    command: step.command,
    request: {
      method: request.options.method,
      url: request.url,
      headers: redactHeaders(request.options.headers || {}),
      hasBody: request.options.body !== undefined,
    },
    response: null,
    error: null,
  };
}

async function liveStep(step: SmokeStep, fetchImpl: typeof fetch = fetch): Promise<SmokeResult> {
  try {
    const result = await sendRequest(step.input, fetchImpl);
    return {
      name: step.endpointName,
      status: result.response.ok ? "PASS" : "FAIL",
      command: step.command,
      request: result.request,
      response: redactJson(result.response),
      error: null,
    };
  } catch (error) {
    return {
      name: step.endpointName,
      status: "FAIL",
      command: step.command,
      request: null,
      response: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runSmoke(config: SmokeConfig = loadSmokeConfig()): Promise<SmokeReport> {
  const startedAt = new Date().toISOString();
  const results: SmokeResult[] = [];
  const state = { projectId: config.projectId === "UUID" ? null : config.projectId };

  if (config.mode === "live" && !config.headers?.cookie) {
    results.push({
      name: "preflight",
      status: "FAIL",
      command: "set PRISM_COOKIE before live smoke",
      request: null,
      response: null,
      error: "PRISM_COOKIE is required for --live",
    });
  } else {
    for (const planned of planSmokeSteps({ ...config, projectId: state.projectId || config.projectId })) {
      if (planned.endpointName === "upload" && state.projectId) {
        planned.input.fields ??= {};
        planned.input.fields.projectId ??= state.projectId;
      }
      if (planned.endpointName === "render" && state.projectId && !config.renderBody) planned.input.body = { projectId: state.projectId };

      const result = config.mode === "live" ? await liveStep(planned, config.fetchImpl) : await dryRunStep(planned);
      results.push(result);
      if (config.mode === "live" && result.status !== "PASS") break;

      if (planned.endpointName === "create-project" && result.status === "PASS" && result.response?.body) {
        const id = pickId(result.response.body);
        if (id) state.projectId = id;
      }
    }
  }

  const status = results.every((result) => result.status === "PASS") ? "PASS" : "FAIL";
  return { mode: config.mode || "dry-run", startedAt, endedAt: new Date().toISOString(), status, results };
}

function mdJson(value: unknown) {
  return "```json\n" + JSON.stringify(value, null, 2) + "\n```";
}

export function renderSmokeReport(report: SmokeReport): string {
  const lines = [
    "# Prism local smoke verification",
    "",
    `MODE: ${report.mode}`,
    `STATUS: ${report.status}`,
    `STARTED: ${report.startedAt}`,
    `ENDED: ${report.endedAt}`,
    "",
    "## Results",
    "",
  ];

  for (const result of report.results) {
    lines.push(`### ${result.name}: ${result.status}`, "", `Command: \`${result.command}\``, "");
    if (result.request) lines.push("Request:", mdJson(result.request), "");
    if (result.response) lines.push("Response:", mdJson(result.response), "");
    if (result.error) lines.push("Error:", "```text", result.error, "```", "");
  }

  lines.push(
    "## Interpretation",
    "",
    report.mode === "dry-run"
      ? "Dry-run proves local CLI wiring, endpoint coverage, request construction, and secret redaction. Run `pnpm run smoke:live` with PRISM_COOKIE to prove live Prism behavior."
      : "Live mode proves whether the current local session can call Prism endpoints. Non-2xx responses are evidence for schema/auth drift and should be copied into docs after redaction.",
    "",
  );
  return lines.join("\n");
}

