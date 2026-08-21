type WorkerRequest = {
  id: number;
  samples: ArrayBuffer;
};

type WorkerResponse =
  | { type: 'progress'; stage: 'runtime' | 'model'; loaded?: number; total?: number }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id: number; message: string };

type SherpaModule = {
  FS: {
    mkdir(path: string): void;
    writeFile(path: string, data: Uint8Array): void;
  };
};

type OfflineStream = {
  acceptWaveform(sampleRate: number, samples: Float32Array): void;
  free(): void;
};

type OfflineRecognizerInstance = {
  createStream(): OfflineStream;
  decode(stream: OfflineStream): void;
  getResult(stream: OfflineStream): { text?: string };
};

type OfflineRecognizerConstructor = new (
  config: Record<string, unknown>,
  module: SherpaModule,
) => OfflineRecognizerInstance;

type ClassicWorkerScope = {
  importScripts(...urls: string[]): void;
  postMessage(message: WorkerResponse): void;
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  SherpaOnnx?: (config: Record<string, unknown>) => Promise<SherpaModule>;
  SherpaOnnxOfflineRecognizer?: OfflineRecognizerConstructor;
};

const workerScope = globalThis as unknown as ClassicWorkerScope;
const ASSET_ROOT = 'maka-asr://bundle';
let recognizerPromise: Promise<OfflineRecognizerInstance> | undefined;

function post(message: WorkerResponse): void {
  workerScope.postMessage(message);
}

async function fetchBytes(name: string, reportProgress = false): Promise<Uint8Array> {
  const response = await fetch(`${ASSET_ROOT}/${name}`);
  if (!response.ok) throw new Error(`Unable to load ${name} (${response.status})`);
  const total = Number(response.headers.get('content-length') ?? 0) || undefined;
  if (!reportProgress || !response.body) return new Uint8Array(await response.arrayBuffer());

  const reader = response.body.getReader();
  const bytes = total ? new Uint8Array(total) : undefined;
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes) bytes.set(value, loaded);
    else chunks.push(value);
    loaded += value.length;
    post({ type: 'progress', stage: 'model', loaded, total });
  }
  if (bytes) return loaded === bytes.length ? bytes : bytes.slice(0, loaded);
  const collected = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    collected.set(chunk, offset);
    offset += chunk.length;
  }
  return collected;
}

async function createRecognizer(): Promise<OfflineRecognizerInstance> {
  post({ type: 'progress', stage: 'runtime' });
  workerScope.importScripts(
    `${ASSET_ROOT}/sherpa-onnx-wasm-web.js`,
    `${ASSET_ROOT}/sherpa-onnx-asr.js`,
  );
  const factory = workerScope.SherpaOnnx;
  const Recognizer = workerScope.SherpaOnnxOfflineRecognizer;
  if (!factory || !Recognizer) throw new Error('sherpa-onnx Web runtime did not initialize');

  const module = await factory({
    locateFile(path: string) {
      return path.endsWith('.wasm')
        ? `${ASSET_ROOT}/sherpa-onnx-wasm-web.wasm`
        : path;
    },
  });
  try {
    module.FS.mkdir('/sensevoice');
  } catch {
    // A retried initialization may observe the directory from the first one.
  }
  const [model, tokens] = await Promise.all([
    fetchBytes('model.int8.onnx', true),
    fetchBytes('tokens.txt'),
  ]);
  module.FS.writeFile('/sensevoice/model.int8.onnx', model);
  module.FS.writeFile('/sensevoice/tokens.txt', tokens);

  return new Recognizer({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model: '/sensevoice/model.int8.onnx',
        language: '',
        useInverseTextNormalization: 1,
      },
      tokens: '/sensevoice/tokens.txt',
      numThreads: 1,
      provider: 'cpu',
      debug: 0,
    },
  }, module);
}

function recognizer(): Promise<OfflineRecognizerInstance> {
  recognizerPromise ??= createRecognizer().catch((error) => {
    recognizerPromise = undefined;
    throw error;
  });
  return recognizerPromise;
}

workerScope.onmessage = (event) => {
  const { id, samples } = event.data;
  void recognizer()
    .then((instance) => {
      const stream = instance.createStream();
      try {
        stream.acceptWaveform(16_000, new Float32Array(samples));
        instance.decode(stream);
        post({ type: 'result', id, text: instance.getResult(stream).text?.trim() ?? '' });
      } finally {
        stream.free();
      }
    })
    .catch((error: unknown) => {
      post({
        type: 'error',
        id,
        message: error instanceof Error ? error.message : String(error),
      });
    });
};
