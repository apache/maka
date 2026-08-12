import { generateText as aiGenerateText, type LanguageModel } from 'ai';
import { normalizeUserSessionName } from '@maka/core/session-name';

const MAX_SOURCE_BYTES = 8 * 1024;
const MAX_FALLBACK_CODE_POINTS = 42;
export const SESSION_TITLE_GENERATION_TIMEOUT_MS = 15_000;

export function sessionTitleSource(input: { text: string; displayText?: string }): string {
  const raw = input.displayText ?? input.text;
  const cleaned = (raw.match(/<user-message>([\s\S]*?)<\/user-message>/i)?.[1] ?? raw)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
    .trim();
  const bytes = new TextEncoder().encode(cleaned);
  if (bytes.length <= MAX_SOURCE_BYTES) return cleaned;
  let end = MAX_SOURCE_BYTES;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  while (end > 0) {
    try {
      return decoder.decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return '';
}

export function fallbackSessionTitle(sourceText: string): string | undefined {
  const firstLine = sourceText
    .split(/\r?\n/)
    .find((line) => line.trim())
    ?.trim();
  return firstLine ? Array.from(firstLine).slice(0, MAX_FALLBACK_CODE_POINTS).join('') : undefined;
}

type GenerateText = (options: Record<string, unknown>) => Promise<{
  text: string;
  finishReason?: string;
}>;

export async function generateSessionTitle(input: {
  model: LanguageModel;
  sourceText: string;
  providerOptions?: unknown;
  generateText?: GenerateText;
  timeoutMs?: number;
}): Promise<string | undefined> {
  if (!input.sourceText.trim()) return undefined;
  try {
    const generateText: GenerateText =
      input.generateText ??
      (async (options) => aiGenerateText(options as Parameters<typeof aiGenerateText>[0]));
    const abortSignal = AbortSignal.timeout(input.timeoutMs ?? SESSION_TITLE_GENERATION_TIMEOUT_MS);
    let onAbort!: () => void;
    const timeout = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortSignal.reason);
      abortSignal.addEventListener('abort', onAbort, { once: true });
    });
    const result = await Promise.race([
      generateText({
        model: input.model,
        prompt: buildSessionTitlePrompt(input.sourceText),
        ...(input.providerOptions === undefined ? {} : { providerOptions: input.providerOptions }),
        maxOutputTokens: 1024,
        abortSignal,
      }),
      timeout,
    ]).finally(() => abortSignal.removeEventListener('abort', onAbort));
    if (result.finishReason === 'length') return undefined;
    return cleanGeneratedSessionTitle(result.text);
  } catch {
    return undefined;
  }
}

export function buildSessionTitlePrompt(sourceText: string): string {
  return `Create a descriptive 5–10 word title for the user message below. Use the user's language; for Chinese and similar languages, use an equivalently brief natural title. Output only the title.\n\n${sourceText}`;
}

export function cleanGeneratedSessionTitle(text: string): string | undefined {
  const firstLine = text
    .replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^(?:title|标题)\s*[:：]\s*/i, '')
    .trim();
  if (!firstLine) return undefined;
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
    ['“', '”'],
    ['「', '」'],
    ['『', '』'],
  ];
  const unquoted = pairs.find(
    ([left, right]) => firstLine.startsWith(left) && firstLine.endsWith(right),
  )
    ? firstLine.slice(1, -1).trim()
    : firstLine;
  const normalized = normalizeUserSessionName(unquoted);
  return normalized.ok ? normalized.value : undefined;
}
