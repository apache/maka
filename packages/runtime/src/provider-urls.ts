/**
 * The Anthropic AI SDK expects a versioned API prefix and appends
 * `/messages` internally. Maka's provider defaults are user-facing roots
 * (`https://api.anthropic.com`) because our manual probes append `/v1/...`.
 * Keep the translation centralized so OAuth/API-key sends and probes do not
 * drift into `https://api.anthropic.com/messages` or `/v1/v1/...`.
 */
export function anthropicRootUrl(baseUrl: string): string {
  return stripTrailing(baseUrl).replace(/\/v1$/i, '');
}

export function anthropicV1BaseUrl(baseUrl: string): string {
  return `${anthropicRootUrl(baseUrl)}/v1`;
}

export function anthropicV1Url(baseUrl: string, path: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${anthropicV1BaseUrl(baseUrl)}${cleanPath}`;
}

/**
 * Normalize a Google AI base URL to a single `/v1beta` suffix: a bare-root
 * override self-heals to `/v1beta` instead of 404ing on
 * `/models/{model}:generateContent`.
 */
export function googleV1BetaBaseUrl(baseUrl: string): string {
  return `${stripTrailing(baseUrl).replace(/\/v1beta$/i, '')}/v1beta`;
}

/**
 * The model-list fetcher and the connection probe route through here; the chat
 * path uses `googleV1BetaBaseUrl` directly via `createGoogle`.
 */
export function googleApiUrl(baseUrl: string, path: string, apiKey: string): string {
  const cleanPath = path.startsWith('/') ? path : `/${path}`;
  return `${googleV1BetaBaseUrl(baseUrl)}${cleanPath}?key=${encodeURIComponent(apiKey)}`;
}

/** Normalize an Open Responses endpoint without assuming a `/v1` prefix. */
export function openResponsesUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '').replace(/\/responses$/i, '');
  url.pathname = `${basePath}/responses`;
  return url.toString();
}

function stripTrailing(u: string): string {
  return u.replace(/\/+$/, '');
}
