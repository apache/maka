export interface LiveAssistantReplayBufferOptions {
  readonly maxRawBytes: number;
  readonly maxWireBytes: number;
  readonly maxChunkRawBytes: number;
  readonly maxChunkWireBytes: number;
}

/** Bounded text tail with a bounded number of coarse chunks. */
export class LiveAssistantReplayBuffer {
  readonly #chunks: string[] = [];
  readonly #options: LiveAssistantReplayBufferOptions;
  #rawBytes = 0;
  #wireBytes = 0;

  constructor(options: LiveAssistantReplayBufferOptions, text = '') {
    this.#options = options;
    this.append(text);
  }

  get wireBytes(): number {
    return this.#wireBytes;
  }

  get retainedChunkCount(): number {
    return this.#chunks.length;
  }

  append(text: string): void {
    let chunk = this.#chunks.pop() ?? '';
    let chunkRawBytes = Buffer.byteLength(chunk, 'utf8');
    let chunkWireBytes = jsonStringContentBytes(chunk);
    for (const character of text) {
      const rawBytes = Buffer.byteLength(character, 'utf8');
      const wireBytes = jsonStringContentBytes(character);
      if (
        chunk.length > 0 &&
        (chunkRawBytes + rawBytes > this.#options.maxChunkRawBytes ||
          chunkWireBytes + wireBytes > this.#options.maxChunkWireBytes)
      ) {
        this.#chunks.push(chunk);
        chunk = '';
        chunkRawBytes = 0;
        chunkWireBytes = 0;
      }
      chunk += character;
      chunkRawBytes += rawBytes;
      chunkWireBytes += wireBytes;
      this.#rawBytes += rawBytes;
      this.#wireBytes += wireBytes;
    }
    if (chunk.length > 0) this.#chunks.push(chunk);
    this.#trim();
  }

  value(): string {
    return this.#chunks.join('');
  }

  #trim(): void {
    while (
      this.#rawBytes > this.#options.maxRawBytes ||
      this.#wireBytes > this.#options.maxWireBytes
    ) {
      const first = this.#chunks[0];
      if (first === undefined) {
        this.#rawBytes = 0;
        this.#wireBytes = 0;
        return;
      }
      const firstRawBytes = Buffer.byteLength(first, 'utf8');
      const firstWireBytes = jsonStringContentBytes(first);
      const rawExcess = Math.max(0, this.#rawBytes - this.#options.maxRawBytes);
      const wireExcess = Math.max(0, this.#wireBytes - this.#options.maxWireBytes);
      if (firstRawBytes <= rawExcess || firstWireBytes <= wireExcess) {
        this.#chunks.shift();
        this.#rawBytes -= firstRawBytes;
        this.#wireBytes -= firstWireBytes;
        continue;
      }
      const bounded = boundedJsonTextTail(
        first,
        firstRawBytes - rawExcess,
        firstWireBytes - wireExcess,
      );
      this.#chunks[0] = bounded;
      this.#rawBytes += Buffer.byteLength(bounded, 'utf8') - firstRawBytes;
      this.#wireBytes += jsonStringContentBytes(bounded) - firstWireBytes;
    }
  }
}

export function jsonStringContentBytes(value: string): number {
  const encoded = JSON.stringify(value);
  return Buffer.byteLength(encoded.slice(1, -1), 'utf8');
}

export function boundedJsonTextTail(
  value: string,
  maxRawBytes: number,
  maxWireBytes: number,
): string {
  if (
    Buffer.byteLength(value, 'utf8') <= maxRawBytes &&
    jsonStringContentBytes(value) <= maxWireBytes
  ) {
    return value;
  }
  const reversed: string[] = [];
  let rawBytes = 0;
  let wireBytes = 0;
  for (let index = value.length; index > 0; ) {
    let start = index - 1;
    const trailing = value.charCodeAt(start);
    if (trailing >= 0xdc00 && trailing <= 0xdfff && start > 0) {
      const leading = value.charCodeAt(start - 1);
      if (leading >= 0xd800 && leading <= 0xdbff) start -= 1;
    }
    const character = value.slice(start, index);
    const characterRawBytes = Buffer.byteLength(character, 'utf8');
    const characterWireBytes = jsonStringContentBytes(character);
    if (
      rawBytes + characterRawBytes > maxRawBytes ||
      wireBytes + characterWireBytes > maxWireBytes
    ) {
      break;
    }
    reversed.push(character);
    rawBytes += characterRawBytes;
    wireBytes += characterWireBytes;
    index = start;
  }
  return reversed.reverse().join('');
}
