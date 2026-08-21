const TARGET_SAMPLE_RATE = 16_000;

export function measurePcmLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumOfSquares = 0;
  for (const sample of samples) sumOfSquares += sample * sample;
  const rootMeanSquare = Math.sqrt(sumOfSquares / samples.length);
  return Math.min(1, rootMeanSquare * 12);
}

export function mergePcmChunks(chunks: readonly Float32Array[]): Float32Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const merged = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return merged;
}

export function resamplePcm(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate = TARGET_SAMPLE_RATE,
): Float32Array {
  if (inputSampleRate === outputSampleRate) return input;
  if (!(inputSampleRate > 0 && outputSampleRate > 0) || input.length === 0) {
    return new Float32Array();
  }

  const ratio = inputSampleRate / outputSampleRate;
  const output = new Float32Array(Math.max(1, Math.round(input.length / ratio)));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex++) {
    const start = outputIndex * ratio;
    const end = Math.min(input.length, (outputIndex + 1) * ratio);
    const first = Math.floor(start);
    const last = Math.max(first + 1, Math.ceil(end));
    let sum = 0;
    let weight = 0;
    for (let inputIndex = first; inputIndex < last && inputIndex < input.length; inputIndex++) {
      const overlap = Math.max(0, Math.min(end, inputIndex + 1) - Math.max(start, inputIndex));
      sum += input[inputIndex] * overlap;
      weight += overlap;
    }
    output[outputIndex] = weight > 0 ? sum / weight : 0;
  }
  return output;
}

export class PcmMicrophoneRecorder {
  readonly #chunks: Float32Array[] = [];
  readonly #onLevel?: (level: number) => void;
  #stream?: MediaStream;
  #audioContext?: AudioContext;
  #source?: MediaStreamAudioSourceNode;
  #processor?: ScriptProcessorNode;
  #silentOutput?: GainNode;
  #sampleRate = TARGET_SAMPLE_RATE;
  #stopped = false;
  #smoothedLevel = 0;

  constructor(onLevel?: (level: number) => void) {
    this.#onLevel = onLevel;
  }

  async start(): Promise<void> {
    this.#stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    if (this.#stopped) {
      this.#stream.getTracks().forEach((track) => track.stop());
      return;
    }

    const context = new AudioContext({ latencyHint: 'interactive' });
    this.#audioContext = context;
    this.#sampleRate = context.sampleRate;
    this.#source = context.createMediaStreamSource(this.#stream);
    this.#processor = context.createScriptProcessor(4096, 1, 1);
    this.#silentOutput = context.createGain();
    this.#silentOutput.gain.value = 0;
    this.#processor.onaudioprocess = (event) => {
      if (this.#stopped) return;
      const chunk = new Float32Array(event.inputBuffer.getChannelData(0));
      this.#chunks.push(chunk);
      const measuredLevel = measurePcmLevel(chunk);
      this.#smoothedLevel = Math.max(measuredLevel, this.#smoothedLevel * 0.68);
      this.#onLevel?.(this.#smoothedLevel);
    };
    this.#source.connect(this.#processor);
    this.#processor.connect(this.#silentOutput);
    this.#silentOutput.connect(context.destination);
    await context.resume();
  }

  async stop(): Promise<Float32Array> {
    if (this.#stopped) return new Float32Array();
    this.#stopped = true;
    this.#processor?.disconnect();
    this.#source?.disconnect();
    this.#silentOutput?.disconnect();
    if (this.#processor) this.#processor.onaudioprocess = null;
    this.#stream?.getTracks().forEach((track) => track.stop());
    await this.#audioContext?.close().catch(() => undefined);
    return resamplePcm(mergePcmChunks(this.#chunks), this.#sampleRate);
  }

  async cancel(): Promise<void> {
    await this.stop();
  }
}
