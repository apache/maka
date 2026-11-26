import { afterAll, beforeAll, expect, test } from 'bun:test';

// The page's first press must preload the sounds without opening the audio
// output, and a play must release the output when it ends: a live context
// holds the device open, and on macOS that is what pulls AirPods over to the
// Mac between sounds.
//
// The module registers its first-press listener at load and keeps its decoded
// buffers for the page's lifetime, so the stubs go up and the import happens
// in `beforeAll`, and one test walks one page's whole lifecycle in order.

let offlineCount = 0;
let contextCount = 0;
let closedCount = 0;
const sources: FakeSource[] = [];

class FakeBuffer {}
class FakeSource {
  buffer: unknown;
  onended: (() => void) | undefined;
  connect(node: unknown) {
    return node;
  }
  start() {
    sources.push(this);
  }
}
class FakeGain {
  gain = { value: 0 };
  connect(node: unknown) {
    return node;
  }
}
class FakeOfflineContext {
  constructor() {
    offlineCount++;
  }
  decodeAudioData(): Promise<AudioBuffer> {
    return Promise.resolve(new FakeBuffer() as unknown as AudioBuffer);
  }
}
class FakeContext {
  state = 'running';
  destination = {};
  constructor() {
    contextCount++;
  }
  createBufferSource() {
    return new FakeSource() as unknown as AudioBufferSourceNode;
  }
  createGain() {
    return new FakeGain() as unknown as GainNode;
  }
  close(): Promise<void> {
    closedCount++;
    return Promise.resolve();
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

const goodFetch = (async () => ({ arrayBuffer: async () => new ArrayBuffer(8) })) as unknown as typeof fetch;
const badFetch = (async () => ({ arrayBuffer: async () => Promise.reject(new Error('undecodable')) })) as unknown as typeof fetch;

const globals = globalThis as unknown as Record<string, unknown>;
let original: Record<string, unknown>;
const pointerHandlers: Array<() => void> = [];
let playSound: (name: 'select' | 'success' | 'tap', volume?: number) => void;

beforeAll(async () => {
  original = { document: globals.document, AudioContext: globals.AudioContext, OfflineAudioContext: globals.OfflineAudioContext, fetch: globals.fetch };
  pointerHandlers.length = 0;
  globals.document = { addEventListener: (type: string, handler: () => void) => void (type === 'pointerdown' && pointerHandlers.push(handler)) };
  globals.OfflineAudioContext = FakeOfflineContext;
  globals.AudioContext = FakeContext;
  globals.fetch = goodFetch;
  // `site.ts` reads Astro's base from `import.meta.env`; bun test has none.
  (import.meta as unknown as { env: Record<string, string | undefined> }).env.BASE_URL ??= '/';
  ({ playSound } = await import('../src/lib/sound'));
});

afterAll(() => {
  globals.document = original.document;
  globals.AudioContext = original.AudioContext;
  globals.OfflineAudioContext = original.OfflineAudioContext;
  globals.fetch = original.fetch;
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('one page: preloads with no output context, plays, and releases the output after each sound', async () => {
  // A cold cache with nothing to decode: the play still opens and closes its
  // context.
  globals.fetch = badFetch;
  playSound('tap');
  await tick();
  globals.fetch = goodFetch;
  expect(contextCount).toBe(1);
  expect(closedCount).toBe(1);
  expect(sources).toHaveLength(0);

  // The page's first press: all sounds decode offline, no output context.
  for (const handler of pointerHandlers) handler();
  await tick();
  expect(offlineCount).toBe(1);
  expect(contextCount).toBe(1);

  // Two overlapping sounds hold two contexts; the offline decoder is reused.
  playSound('select');
  playSound('success', 0.3);
  await tick();
  expect(contextCount).toBe(3);
  expect(closedCount).toBe(1);
  expect(sources).toHaveLength(2);
  sources[0].onended?.();
  sources[1].onended?.();
  await tick();
  expect(closedCount).toBe(3);
});
