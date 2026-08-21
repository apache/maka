#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(desktopRoot, '..', '..');
const assetRoot = join(desktopRoot, 'resources', 'asr', 'sensevoice');
const rendererAssetRoot = join(desktopRoot, 'dist-renderer', 'assets');
const workerName = (await readdir(rendererAssetRoot)).find((name) =>
  /^sensevoice\.worker-.*\.js$/u.test(name));
if (!workerName) throw new Error('Build the desktop renderer before running the ASR smoke test');

const workerSource = (await readFile(join(rendererAssetRoot, workerName), 'utf8'))
  .replaceAll('maka-asr://bundle', '/assets');
const testWaveUrl =
  'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/en.wav?download=true';
const testWaveResponse = await fetch(testWaveUrl);
if (!testWaveResponse.ok) throw new Error(`Unable to download ASR smoke fixture (${testWaveResponse.status})`);
const testWave = Buffer.from(await testWaveResponse.arrayBuffer());

const contentTypes = {
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname === '/worker.js') {
    response.setHeader('content-type', 'text/javascript; charset=utf-8');
    response.end(workerSource);
    return;
  }
  if (url.pathname === '/en.wav') {
    response.setHeader('content-type', 'audio/wav');
    response.setHeader('content-length', String(testWave.length));
    response.end(testWave);
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    const name = url.pathname.slice('/assets/'.length);
    if (![
      'sherpa-onnx-wasm-web.js',
      'sherpa-onnx-wasm-web.wasm',
      'sherpa-onnx-asr.js',
      'model.int8.onnx',
      'tokens.txt',
    ].includes(name)) {
      response.writeHead(404).end();
      return;
    }
    const path = join(assetRoot, name);
    const metadata = await stat(path);
    response.setHeader('content-type', contentTypes[extname(name)] ?? 'application/octet-stream');
    response.setHeader('content-length', String(metadata.size));
    createReadStream(path).pipe(response);
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><title>SenseVoice smoke</title>');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Smoke server did not bind a TCP port');

const chromePath = process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : undefined;
const browser = await chromium.launch({ headless: true, ...(chromePath ? { executablePath: chromePath } : {}) });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}/`);
  const text = await page.evaluate(async () => {
    const wave = await (await fetch('/en.wav')).arrayBuffer();
    const view = new DataView(wave);
    const ascii = (offset, length) =>
      String.fromCharCode(...new Uint8Array(wave, offset, length));
    if (ascii(0, 4) !== 'RIFF' || ascii(8, 4) !== 'WAVE') throw new Error('Invalid WAV fixture');
    let offset = 12;
    let sampleRate = 0;
    let dataOffset = 0;
    let dataLength = 0;
    while (offset + 8 <= view.byteLength) {
      const kind = ascii(offset, 4);
      const length = view.getUint32(offset + 4, true);
      if (kind === 'fmt ') sampleRate = view.getUint32(offset + 12, true);
      if (kind === 'data') {
        dataOffset = offset + 8;
        dataLength = length;
        break;
      }
      offset += 8 + length + (length % 2);
    }
    if (!sampleRate || !dataOffset) throw new Error('Unsupported WAV fixture');
    const samples = new Float32Array(dataLength / 2);
    for (let index = 0; index < samples.length; index++) {
      samples[index] = view.getInt16(dataOffset + index * 2, true) / 32768;
    }
    if (sampleRate !== 16_000) throw new Error(`Unexpected sample rate: ${sampleRate}`);

    return await new Promise((resolveResult, rejectResult) => {
      const worker = new Worker('/worker.js');
      const timeout = window.setTimeout(() => rejectResult(new Error('ASR smoke timed out')), 120_000);
      worker.onmessage = (event) => {
        if (event.data.type === 'result') {
          window.clearTimeout(timeout);
          worker.terminate();
          resolveResult(event.data.text);
        } else if (event.data.type === 'error') {
          window.clearTimeout(timeout);
          worker.terminate();
          rejectResult(new Error(event.data.message));
        }
      };
      worker.onerror = (event) => rejectResult(new Error(event.message));
      worker.postMessage({ id: 1, samples: samples.buffer }, [samples.buffer]);
    });
  });
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('SenseVoice returned an empty transcript');
  }
  console.log(`[sensevoice-asr-smoke] transcript: ${text}`);
} finally {
  await browser.close();
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => error ? rejectClose(error) : resolveClose()));
}
