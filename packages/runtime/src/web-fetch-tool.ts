import { z } from 'zod';
import type { MakaTool } from './tool-runtime.js';

const WEB_FETCH_TOOL_NAME = 'WebFetch';
export const WEB_FETCH_MODEL_OUTPUT_MAX_BYTES = 50 * 1024;
const WEB_FETCH_TRUNCATION_MARKER =
  '\n\n…[WebFetch content truncated to fit the 50 KB model-output limit]';
const httpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'URL must use HTTP or HTTPS.');

export interface WebFetchExecutor {
  fetch(input: {
    readonly url: string;
    readonly sessionId: string;
    readonly abortSignal?: AbortSignal;
  }): Promise<string>;
}

/** Builds the model-facing tool while the host owns policy and transport. */
export function buildWebFetchTool(executor: WebFetchExecutor): MakaTool {
  return {
    name: WEB_FETCH_TOOL_NAME,
    categoryHint: 'web_read',
    displayName: 'Web fetch',
    description:
      'Read the main content of a specific HTTP or HTTPS URL. Use it when a concrete URL is already known.',
    parameters: z.object({ url: httpUrlSchema }).strict(),
    impl: async ({ url }, context) => {
      const canonicalUrl = new URL(httpUrlSchema.parse(url)).toString();
      const content = await executor.fetch({
        url: canonicalUrl,
        sessionId: context.sessionId,
        ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
      });
      return truncateWebFetchOutput(content);
    },
  };
}

/** Removes network reading from the model-visible turn while privacy mode is active. */
export function routeWebFetchTools(
  tools: readonly MakaTool[],
  privacy: { readonly incognitoActive: boolean },
): MakaTool[] {
  return privacy.incognitoActive
    ? tools.filter((tool) => tool.name !== WEB_FETCH_TOOL_NAME)
    : [...tools];
}

function truncateWebFetchOutput(content: string): string {
  if (Buffer.byteLength(content, 'utf8') <= WEB_FETCH_MODEL_OUTPUT_MAX_BYTES) return content;
  const markerBytes = Buffer.byteLength(WEB_FETCH_TRUNCATION_MARKER, 'utf8');
  const kept = Buffer.from(content, 'utf8')
    .subarray(0, WEB_FETCH_MODEL_OUTPUT_MAX_BYTES - markerBytes)
    .toString('utf8')
    .replace(/�+$/, '');
  return kept + WEB_FETCH_TRUNCATION_MARKER;
}
