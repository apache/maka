export interface SenseVoiceLoadProgress {
  stage: 'runtime' | 'model';
  loaded?: number;
  total?: number;
}

type WorkerMessage =
  | ({ type: 'progress' } & SenseVoiceLoadProgress)
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string };

class SenseVoiceClient {
  readonly #worker = new Worker(new URL('./sensevoice.worker.ts', import.meta.url), {
    name: 'maka-sensevoice-asr',
  });
  readonly #pending = new Map<
    number,
    { resolve(text: string): void; reject(error: Error): void }
  >();
  #nextId = 1;
  onProgress?: (progress: SenseVoiceLoadProgress) => void;

  constructor() {
    this.#worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'progress') {
        this.onProgress?.(message);
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.type === 'result') pending.resolve(message.text);
      else pending.reject(new Error(message.message));
    };
    this.#worker.onerror = (event) => {
      const error = new Error(event.message || 'SenseVoice worker failed');
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    };
  }

  transcribe(samples: Float32Array): Promise<string> {
    const id = this.#nextId++;
    const buffer = samples.buffer.slice(
      samples.byteOffset,
      samples.byteOffset + samples.byteLength,
    ) as ArrayBuffer;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, samples: buffer }, [buffer]);
    });
  }
}

let sharedClient: SenseVoiceClient | undefined;

export function senseVoiceClient(): SenseVoiceClient {
  sharedClient ??= new SenseVoiceClient();
  return sharedClient;
}
