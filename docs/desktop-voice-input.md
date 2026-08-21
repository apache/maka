# Desktop voice input

The desktop composer uses a local, click-to-record dictation flow:

1. Click the microphone to start audio capture.
2. Click the same control to stop.
3. A dedicated Web Worker runs sherpa-onnx WebAssembly with SenseVoice INT8.
4. The transcript is appended to the draft that owned the recording.
5. The user reviews or edits the text and sends it manually.

V1 deliberately has no VAD, continuous streaming, automatic send, agent integration, or local LLM. The maximum recording length is two minutes.

## Runtime boundaries

- `getUserMedia({ audio: true, video: false })` and Web Audio capture are shared by macOS and Windows.
- Renderer code collects mono PCM and resamples it to 16 kHz.
- Inference runs off the UI thread in `sensevoice.worker.ts`.
- A fixed `maka-asr://bundle/<allowlisted-name>` protocol streams only the five inference assets. It cannot read arbitrary files.
- Electron grants media permission only to the trusted top-level product renderer and only for audio.
- macOS carries `NSMicrophoneUsageDescription` and the audio-input entitlement. Windows uses Chromium's normal microphone permission path and needs no model-specific native runtime.

## Assets

Run:

```sh
npm run prepare:asr --workspace @maka/desktop
```

The preparation script downloads pinned, SHA-256-verified artifacts into the ignored `apps/desktop/resources/asr/sensevoice` directory:

- sherpa-onnx Web 1.13.6: about 15 MB uncompressed;
- SenseVoice multilingual INT8 model: about 239 MB;
- tokens and the applicable sherpa-onnx and FunASR/SenseVoice license files.

`build:resources`, the desktop development launcher, and packaging run the same idempotent preparation step. Packaged builds copy the prepared directory to `resources/asr/sensevoice`.

The sherpa-onnx runtime is Apache-2.0. SenseVoice weights are governed separately by the FunASR Model Open Source License Agreement 1.1 and require attribution and retention of the model name. Any Apache release must complete the project's normal legal review for that model license before distributing the weights.

## Verification

```sh
npm run smoke:asr --workspace @maka/desktop
```

The smoke test loads the production Worker bundle in headless Chrome, runs the bundled WASM and model against an official English WAV fixture, and fails if the transcript is empty.
