import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { EndpointDef } from "./endpoints.ts";

const DEFAULT_BASE_URL = "https://prism.openai.com";
const SENSITIVE_HEADER = /authorization|cookie|csrf|token|api-key|openai/i;

// ponytail: 不引入 DOM lib；本项目实际只在 Record 和 Headers 两种形态间转换，body 只产出 FormData/string。
type HeaderSource = Record<string, string> | Headers;

export interface RequestInput {
  endpoint: EndpointDef;
  baseUrl?: string;
  pathParams?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  file?: string;
  fields?: Record<string, string>;
}

interface BuiltRequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: FormData | string;
}

export interface BuiltRequest {
  url: string;
  options: BuiltRequestOptions;
}

function normalizeBaseUrl(baseUrl = DEFAULT_BASE_URL) {
  return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function normalizeHeaders(headers: HeaderSource | undefined = {}) {
  const out: Record<string, string> = {};
  const entries: Iterable<[string, string]> =
    headers instanceof Headers ? headers.entries() : Object.entries(headers as Record<string, string>);
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === "") continue;
    out[String(key).toLowerCase()] = String(value);
  }
  return out;
}

export function redactHeaders(headers: HeaderSource | undefined = {}) {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(normalizeHeaders(headers))) {
    out[key] = SENSITIVE_HEADER.test(key) ? "<redacted>" : value;
  }
  return out;
}

function applyPathParams(path: string, pathParams: Record<string, string> = {}) {
  return path.replace(/\{([^}]+)\}/g, (_, key: string) => {
    if (!(key in pathParams)) throw new Error(`Missing path param: ${key}`);
    return encodeURIComponent(pathParams[key]!);
  });
}

function appendQuery(url: URL, query: Record<string, string> = {}) {
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
}

async function buildBody({ endpoint, headers, body, file, fields = {} }: {
  endpoint: EndpointDef;
  headers: Record<string, string>;
  body?: unknown;
  file?: string;
  fields?: Record<string, string>;
}) {
  if (file) {
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
    const bytes = await readFile(file);
    form.append("file", new Blob([bytes]), basename(file));
    return { body: form, headers };
  }

  if (body === undefined || endpoint.method === "GET") return { body: undefined, headers };
  headers["content-type"] ??= "application/json";
  return { body: typeof body === "string" ? body : JSON.stringify(body), headers };
}

export async function buildRequest({
  endpoint,
  baseUrl = DEFAULT_BASE_URL,
  pathParams = {},
  query = {},
  headers = {},
  body,
  file,
  fields = {},
}: RequestInput): Promise<BuiltRequest> {
  const path = applyPathParams(endpoint.path, pathParams);
  const url = new URL(path, `${normalizeBaseUrl(baseUrl)}/`);
  appendQuery(url, { ...(endpoint.defaultQuery || {}), ...query });

  const requestHeaders = normalizeHeaders(headers);
  const built = await buildBody({ endpoint, headers: requestHeaders, body, file, fields });

  return {
    url: url.toString(),
    options: {
      method: endpoint.method,
      headers: built.headers,
      ...(built.body === undefined ? {} : { body: built.body }),
    },
  };
}

export async function sendRequest(input: RequestInput, fetchImpl: typeof fetch = fetch) {
  const request = await buildRequest(input);
  const response = await fetchImpl(request.url, request.options);
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // ponytail: keep raw text; add content-type parser only if Prism returns more formats.
  }

  return {
    request: {
      url: request.url,
      method: request.options.method,
      headers: redactHeaders(request.options.headers),
    },
    response: {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: redactHeaders(Object.fromEntries(response.headers.entries())),
      body: parsed,
    },
  };
}
