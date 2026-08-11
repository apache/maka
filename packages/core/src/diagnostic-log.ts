import { redactSecrets } from './redaction.js';

export type DiagnosticLogLevel = 'debug' | 'info' | 'log' | 'warn' | 'error';

interface DiagnosticLogEntry {
  readonly bytes: number;
  readonly text: string;
}

export interface DiagnosticLogBufferOptions {
  readonly maxBytes?: number;
  readonly maxEntries?: number;
  readonly maxEntryCodePoints?: number;
  readonly maxEntryUtf8Bytes?: number;
}

export class DiagnosticLogBuffer {
  readonly #entries: DiagnosticLogEntry[] = [];
  readonly #maxBytes: number;
  readonly #maxEntries: number | undefined;
  readonly #maxEntryCodePoints: number;
  readonly #maxEntryUtf8Bytes: number | undefined;
  #bytes = 0;

  constructor(options: DiagnosticLogBufferOptions = {}) {
    this.#maxBytes = requireMinimumInteger(options.maxBytes ?? 64 * 1024, 'maxBytes', 4);
    this.#maxEntries = optionalPositiveInteger(options.maxEntries, 'maxEntries');
    this.#maxEntryCodePoints = requirePositiveInteger(
      options.maxEntryCodePoints ?? 8 * 1024,
      'maxEntryCodePoints',
    );
    this.#maxEntryUtf8Bytes = optionalPositiveInteger(
      options.maxEntryUtf8Bytes,
      'maxEntryUtf8Bytes',
    );
  }

  append(level: DiagnosticLogLevel, message: string, capturedAt = new Date()): void {
    const safe = truncateCodePoints(redactSecrets(message), this.#maxEntryCodePoints);
    const prefixed = `[${capturedAt.toISOString()}] ${level.toUpperCase()} ${safe}`;
    const entryBounded =
      this.#maxEntryUtf8Bytes === undefined
        ? prefixed
        : truncateUtf8(prefixed, this.#maxEntryUtf8Bytes, '\n<log entry truncated>');
    const text = truncateEncodedString(entryBounded, this.#maxBytes - 2);
    const entry = { text, bytes: encodedStringBytes(text) };
    this.#entries.push(entry);
    this.#bytes += entry.bytes;
    while (
      (this.#snapshotBytes() > this.#maxBytes ||
        (this.#maxEntries !== undefined && this.#entries.length > this.#maxEntries)) &&
      this.#entries.length > 1
    ) {
      const removed = this.#entries.shift();
      if (removed) this.#bytes -= removed.bytes;
    }
  }

  snapshot(): readonly string[] {
    return this.#entries.map(({ text }) => text);
  }

  #snapshotBytes(): number {
    return 2 + this.#bytes + Math.max(0, this.#entries.length - 1);
  }
}

function encodedStringBytes(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function requirePositiveInteger(value: number, label: string): number {
  return requireMinimumInteger(value, label, 1);
}

function optionalPositiveInteger(value: number | undefined, label: string): number | undefined {
  return value === undefined ? undefined : requirePositiveInteger(value, label);
}

function requireMinimumInteger(value: number, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be at least ${minimum}`);
  }
  return value;
}

function truncateCodePoints(value: string, maximum: number): string {
  const codePoints = [...value];
  if (codePoints.length <= maximum) return value;
  return `${codePoints.slice(0, maximum).join('')}\n<log entry truncated>`;
}

function truncateEncodedString(value: string, maximumBytes: number): string {
  if (encodedStringBytes(value) <= maximumBytes) return value;
  const marker = '\n<log entry truncated>';
  const suffix = encodedStringBytes(marker) <= maximumBytes ? marker : '';
  const codePoints = [...value];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join('')}${suffix}`;
    if (encodedStringBytes(candidate) <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return `${codePoints.slice(0, low).join('')}${suffix}`;
}

export function truncateUtf8(value: string, maximumBytes: number, marker = ''): string {
  requirePositiveInteger(maximumBytes, 'maximumBytes');
  if (new TextEncoder().encode(value).byteLength <= maximumBytes) return value;
  const suffix = new TextEncoder().encode(marker).byteLength <= maximumBytes ? marker : '';
  const codePoints = [...value];
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = `${codePoints.slice(0, middle).join('')}${suffix}`;
    if (new TextEncoder().encode(candidate).byteLength <= maximumBytes) low = middle;
    else high = middle - 1;
  }
  return `${codePoints.slice(0, low).join('')}${suffix}`;
}
