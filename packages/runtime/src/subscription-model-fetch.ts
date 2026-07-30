import { redactSecrets } from '@maka/core';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import {
  GITHUB_COPILOT_API_VERSION,
  GITHUB_COPILOT_COMPAT_HEADERS,
} from './subscription-credentials.js';

export interface SubscriptionModelFetchInput {
  connection: RuntimeExecutionConnection;
  sessionId: string;
  modelId: string;
  fetchFn?: typeof fetch;
  claude?: {
    cloakEnabled?: boolean;
    deviceId: string;
    accountUuid: string;
  };
}

export function buildSubscriptionModelFetch(
  input: SubscriptionModelFetchInput,
): typeof fetch | undefined {
  if (input.connection.providerType === 'claude-subscription') {
    if (input.claude?.cloakEnabled === false) return undefined;
    return buildClaudeSubscriptionCloakedFetch(input, requireClaudeCloakMetadata(input.claude));
  }
  if (input.connection.providerType === 'openai-codex') {
    return buildOpenAiCodexFetch(input.sessionId, input.fetchFn ?? fetch);
  }
  if (input.connection.providerType === 'github-copilot') {
    return buildGitHubCopilotFetch(input.fetchFn ?? fetch);
  }
  return undefined;
}

function buildGitHubCopilotFetch(fetchFn: typeof fetch): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(GITHUB_COPILOT_COMPAT_HEADERS)) {
      headers.set(name, value);
    }
    headers.set('Openai-Intent', 'conversation-edits');
    headers.set('X-GitHub-Api-Version', GITHUB_COPILOT_API_VERSION);
    headers.set('x-initiator', githubCopilotInitiator(init?.body));
    if (githubCopilotBodyHasVision(init?.body)) headers.set('Copilot-Vision-Request', 'true');
    return fetchFn(url, { ...init, headers });
  };
}

function githubCopilotInitiator(body: BodyInit | null | undefined): 'user' | 'agent' {
  if (typeof body !== 'string') return 'user';
  try {
    const parsed = JSON.parse(body) as { messages?: unknown; input?: unknown };
    const items = Array.isArray(parsed.messages)
      ? parsed.messages
      : Array.isArray(parsed.input)
        ? parsed.input
        : [];
    const last = items.at(-1);
    return isUserInitiatedGitHubCopilotItem(last) ? 'user' : 'agent';
  } catch {
    return 'user';
  }
}

function isUserInitiatedGitHubCopilotItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as { role?: unknown; content?: unknown };
  if (item.role !== 'user') return false;
  if (!Array.isArray(item.content)) return true;
  return item.content.some(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type !== 'tool_result',
  );
}

function githubCopilotBodyHasVision(body: BodyInit | null | undefined): boolean {
  if (typeof body !== 'string') return false;
  try {
    return containsGitHubCopilotImage(JSON.parse(body) as unknown);
  } catch {
    return false;
  }
}

function containsGitHubCopilotImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsGitHubCopilotImage);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image')
    return true;
  return Object.values(record).some(containsGitHubCopilotImage);
}

function requireClaudeCloakMetadata(
  claude: SubscriptionModelFetchInput['claude'],
): NonNullable<SubscriptionModelFetchInput['claude']> {
  if (!claude || !isNonEmptyString(claude.deviceId) || !isNonEmptyString(claude.accountUuid)) {
    throw new Error('Claude subscription cloaking requires deviceId and accountUuid metadata.');
  }
  return claude;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildOpenAiCodexFetch(sessionId: string, fetchFn: typeof fetch): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    headers.set('OpenAI-Beta', 'responses=experimental');
    headers.set('originator', 'codex_cli_rs');
    headers.set('session_id', sessionId);
    headers.set('x-client-request-id', sessionId);
    headers.set('content-type', 'application/json');

    const rawBody = init?.body;
    if (typeof rawBody !== 'string') {
      return checkedOpenAiCodexFetch(fetchFn, url, { ...init, headers });
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return checkedOpenAiCodexFetch(fetchFn, url, { ...init, headers });
      }
      parsedBody = parsed as Record<string, unknown>;
    } catch {
      return checkedOpenAiCodexFetch(fetchFn, url, { ...init, headers });
    }

    return checkedOpenAiCodexFetch(fetchFn, url, {
      ...init,
      headers,
      body: JSON.stringify({
        ...parsedBody,
        instructions: codexInstructionsFromBody(parsedBody),
        store: false,
        parallel_tool_calls: parsedBody.parallel_tool_calls ?? true,
        text: {
          ...(parsedBody.text !== null && typeof parsedBody.text === 'object'
            ? (parsedBody.text as Record<string, unknown>)
            : {}),
          verbosity:
            parsedBody.text !== null &&
            typeof parsedBody.text === 'object' &&
            typeof (parsedBody.text as { verbosity?: unknown }).verbosity === 'string'
              ? (parsedBody.text as { verbosity: string }).verbosity
              : 'medium',
        },
      }),
    });
  };
}

async function checkedOpenAiCodexFetch(
  fetchFn: typeof fetch,
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const edgeRetryDelaysMs = [2_000, 10_000, 30_000] as const;
  for (let retry = 0; ; retry += 1) {
    const response = await fetchFn(url, init);
    if (response.ok) return response;
    const detail = await response
      .clone()
      .text()
      .catch(() => '');
    if (
      edgeRetryDelaysMs[retry] !== undefined &&
      isReplayableOpenAiCodexRequest(url, init) &&
      isTransientOpenAiCodexEdgeRejection(response, detail)
    ) {
      await abortableDelay(
        openAiCodexRetryAfterMs(response, edgeRetryDelaysMs[retry] ?? 30_000),
        effectiveOpenAiCodexRequestSignal(url, init),
      );
      continue;
    }
    throw new Error(formatOpenAiCodexHttpError(response.status, detail));
  }
}

function isReplayableOpenAiCodexRequest(
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): boolean {
  if (typeof init?.body === 'string') return true;
  if (init?.body != null) return false;
  return !(url instanceof Request) || url.body === null;
}

function effectiveOpenAiCodexRequestSignal(
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): AbortSignal | null | undefined {
  if (init?.signal !== undefined) return init.signal;
  return url instanceof Request ? url.signal : undefined;
}

function isTransientOpenAiCodexEdgeRejection(response: Response, detail: string): boolean {
  if (response.status !== 403) return false;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/html') || /^\s*(?:<!doctype html|<html\b)/i.test(detail);
}

function openAiCodexRetryAfterMs(response: Response, fallbackMs: number): number {
  const rawRetryAfter = response.headers.get('retry-after');
  if (rawRetryAfter === null || rawRetryAfter.trim() === '') return fallbackMs;
  const retryAfterSeconds = Number(rawRetryAfter);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return fallbackMs;
  return Math.min(retryAfterSeconds * 1_000, 30_000);
}

function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function codexInstructionsFromBody(body: Record<string, unknown>): string {
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    return body.instructions;
  }
  if (typeof body.system === 'string' && body.system.trim()) {
    return body.system;
  }
  const input = body.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.role !== 'system') continue;
      const content = record.content;
      if (typeof content === 'string' && content.trim()) return content;
      if (!Array.isArray(content)) continue;
      const text = content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const value = (part as Record<string, unknown>).text;
          return typeof value === 'string' ? value : '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return 'You are Maka, a helpful AI assistant.';
}

function formatOpenAiCodexHttpError(statusCode: number, detail: string): string {
  const compact = redactSecrets(detail).replace(/\s+/g, ' ').trim().slice(0, 240);
  return compact
    ? `Codex OAuth request failed: HTTP ${statusCode} ${compact}`
    : `Codex OAuth request failed: HTTP ${statusCode}`;
}

function buildClaudeSubscriptionCloakedFetch(
  input: SubscriptionModelFetchInput,
  claude: NonNullable<SubscriptionModelFetchInput['claude']>,
): typeof fetch {
  const fetchFn = input.fetchFn ?? fetch;
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const rawBody = init?.body;
    if (typeof rawBody !== 'string') {
      return fetchFn(url, init);
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return fetchFn(url, init);
      }
      parsedBody = parsed as Record<string, unknown>;
    } catch {
      return fetchFn(url, init);
    }

    const { buildCloakedRequest } = await import('./subscription-cloaked-request.js');
    const upstream = await buildCloakedRequest({
      body: parsedBody,
      model: input.modelId,
      sessionKey: input.sessionId,
      streaming: parsedBody.stream === true,
      timeoutMs: 600_000,
      deviceId: claude.deviceId,
      accountUuid: claude.accountUuid,
      sessionId: input.sessionId,
    });

    const headers = new Headers(init?.headers);
    for (const [key, value] of Object.entries(upstream.headers)) {
      headers.set(key, value);
    }
    headers.set('content-type', 'application/json');
    headers.delete('x-api-key');

    return fetchFn(url, {
      ...init,
      headers,
      body: JSON.stringify(upstream.body),
    });
  };
}
