#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  copyFile,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetRoot = resolve(desktopRoot, 'resources', 'asr', 'sensevoice');
const manifestPath = join(targetRoot, 'manifest.json');

const SHERPA_WEB_VERSION = '1.13.6';
const SHERPA_ASR_BROWSER_EXPORT = Buffer.from(
  '\n;globalThis.SherpaOnnxOfflineRecognizer = OfflineRecognizer;\n',
);
const SHERPA_ARCHIVE = {
  url: `https://pub.dev/api/archives/sherpa_onnx_web-${SHERPA_WEB_VERSION}.tar.gz`,
  sha256: '8bc6247c8ac14da5f922dbd40f12193b8d8a1f71a69353e57d49d310c2c98cbc',
  size: 4_262_527,
};
const SHERPA_ASSETS = {
  'assets/sherpa-onnx-wasm-web.js': {
    name: 'sherpa-onnx-wasm-web.js',
    sha256: 'e7ca68efeb8fa4f1bf7768827f468a31a25f1878209d24a3e08fe7bfcbba5cb5',
    size: 93_039,
  },
  'assets/sherpa-onnx-wasm-web.wasm': {
    name: 'sherpa-onnx-wasm-web.wasm',
    sha256: '66087aabe9ef3329f570cf4c88c00ea8cb6bec21e47d18545b6f06554c666ceb',
    size: 14_866_041,
  },
  'assets/sherpa-onnx-asr.js': {
    name: 'sherpa-onnx-asr.js',
    sourceSha256: 'd51ae8e8b756ee5e53423ffada0c9702973f154f561aca7984fe0b12f4060178',
    sourceSize: 53_867,
    sha256: '16140afaf69eb27fb245f06a5d9aa1132e95e6a85b301c3de3884647c2fa2558',
    size: 53_929,
    suffix: SHERPA_ASR_BROWSER_EXPORT,
  },
  LICENSE: {
    name: 'SHERPA_ONNX_LICENSE.txt',
  },
};

const MODEL_REPOSITORY = 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const MODEL_REVISION = '2365baeacb507f821a0c8120fcee3d484dba7a07';
const modelUrl = (name) =>
  `https://huggingface.co/${MODEL_REPOSITORY}/resolve/${MODEL_REVISION}/${name}?download=true`;
const MODEL_ASSETS = [
  {
    name: 'model.int8.onnx',
    url: modelUrl('model.int8.onnx'),
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    size: 239_233_841,
  },
  {
    name: 'tokens.txt',
    url: modelUrl('tokens.txt'),
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    size: 315_894,
  },
  {
    name: 'SENSEVOICE_MODEL_REFERENCE.txt',
    url: modelUrl('LICENSE'),
    sha256: '221c6df10b0931a5629adad671ea48fb7747e034c414b6d2bfa275bc3dd4ea17',
    size: 71,
  },
  {
    name: 'SENSEVOICE_MODEL_LICENSE.txt',
    url: 'https://raw.githubusercontent.com/modelscope/FunASR/58830eca4012644aac0c3218c3ccc7d98f003fda/MODEL_LICENSE',
    sha256: '7dba975a2069691db4992b0592d70828b330d2f8a30a71450f4e152a554e84f8',
    size: 5_306,
  },
];

const expectedManifest = {
  schemaVersion: 1,
  sherpaOnnxWebVersion: SHERPA_WEB_VERSION,
  senseVoiceRepository: MODEL_REPOSITORY,
  senseVoiceRevision: MODEL_REVISION,
  files: [
    ...Object.values(SHERPA_ASSETS)
      .filter((asset) => asset.sha256)
      .map(({ name, sha256, size }) => ({ name, sha256, size })),
    ...MODEL_ASSETS.map(({ name, sha256, size }) => ({ name, sha256, size })),
  ],
};

async function hasPreparedAssets() {
  const manifest = await readFile(manifestPath, 'utf8').catch(() => undefined);
  if (manifest !== `${JSON.stringify(expectedManifest, null, 2)}\n`) return false;
  if (await stat(join(targetRoot, 'sherpa_onnx_web.tar.gz')).catch(() => undefined)) return false;
  return (await Promise.all(expectedManifest.files.map(async ({ name, size }) =>
    (await stat(join(targetRoot, name)).catch(() => undefined))?.size === size))).every(Boolean);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function tarEntries(archive) {
  const entries = new Map();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/u, '');
    const rawSize = header.subarray(124, 136).toString('ascii').replace(/\0.*$/u, '').trim();
    const size = Number.parseInt(rawSize || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar entry: ${name}`);
    const start = offset + 512;
    entries.set(name, archive.subarray(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  return entries;
}

async function download(input, target) {
  const response = await fetch(input.url, { redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new Error(`Download failed (${response.status}) for ${input.url}`);
  }
  await mkdir(dirname(target), { recursive: true });
  const hash = createHash('sha256');
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(target));
  const digest = hash.digest('hex');
  if (size !== input.size || digest !== input.sha256) {
    throw new Error(
      `Checksum mismatch for ${basename(target)}: got ${size} bytes / ${digest}`,
    );
  }
}

async function fileMatches(path, input) {
  const metadata = await stat(path).catch(() => undefined);
  if (metadata?.size !== input.size) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === input.sha256;
}

if (await hasPreparedAssets()) {
  console.log(`[sensevoice-asr] ready: ${targetRoot}`);
  process.exit(0);
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'maka-sensevoice-asr-'));
try {
  const runtimeArchivePath = join(temporaryRoot, 'sherpa_onnx_web.tar.gz');
  console.log(`[sensevoice-asr] downloading sherpa-onnx Web ${SHERPA_WEB_VERSION}...`);
  await download(SHERPA_ARCHIVE, runtimeArchivePath);
  const entries = tarEntries(gunzipSync(await readFile(runtimeArchivePath)));
  await rm(runtimeArchivePath);
  for (const [sourceName, asset] of Object.entries(SHERPA_ASSETS)) {
    const bytes = entries.get(sourceName);
    if (!bytes) throw new Error(`Missing ${sourceName} in sherpa_onnx_web archive`);
    const sourceSize = asset.sourceSize ?? asset.size;
    const sourceSha256 = asset.sourceSha256 ?? asset.sha256;
    if (sourceSize !== undefined && (bytes.length !== sourceSize || sha256(bytes) !== sourceSha256)) {
      throw new Error(`Checksum mismatch for ${sourceName}`);
    }
    await writeFile(
      join(temporaryRoot, asset.name),
      asset.suffix ? Buffer.concat([bytes, asset.suffix]) : bytes,
    );
  }

  for (const [index, asset] of MODEL_ASSETS.entries()) {
    const existingPath = join(targetRoot, asset.name);
    if (await fileMatches(existingPath, asset)) {
      console.log(`[sensevoice-asr] reusing ${asset.name} (${index + 1}/${MODEL_ASSETS.length})...`);
      await copyFile(existingPath, join(temporaryRoot, asset.name));
    } else {
      console.log(`[sensevoice-asr] downloading ${asset.name} (${index + 1}/${MODEL_ASSETS.length})...`);
      await download(asset, join(temporaryRoot, asset.name));
    }
  }
  await writeFile(
    join(temporaryRoot, 'manifest.json'),
    `${JSON.stringify(expectedManifest, null, 2)}\n`,
  );

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(dirname(targetRoot), { recursive: true });
  await rename(temporaryRoot, targetRoot);
  console.log(`[sensevoice-asr] ready: ${targetRoot}`);
} catch (error) {
  await rm(temporaryRoot, { recursive: true, force: true });
  throw error;
}
