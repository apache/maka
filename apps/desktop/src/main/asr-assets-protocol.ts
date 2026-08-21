import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Protocol } from 'electron';

export const SENSEVOICE_ASSET_SCHEME = 'maka-asr';

const SENSEVOICE_ASSETS = {
  'sherpa-onnx-wasm-web.js': 'text/javascript; charset=utf-8',
  'sherpa-onnx-wasm-web.wasm': 'application/wasm',
  'sherpa-onnx-asr.js': 'text/javascript; charset=utf-8',
  'model.int8.onnx': 'application/octet-stream',
  'tokens.txt': 'text/plain; charset=utf-8',
} as const;

export type SenseVoiceAssetName = keyof typeof SENSEVOICE_ASSETS;

export function senseVoiceAssetNameFromUrl(rawUrl: string): SenseVoiceAssetName | undefined {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== `${SENSEVOICE_ASSET_SCHEME}:` || url.hostname !== 'bundle') {
      return undefined;
    }
    const name = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
    return Object.hasOwn(SENSEVOICE_ASSETS, name)
      ? name as SenseVoiceAssetName
      : undefined;
  } catch {
    return undefined;
  }
}

function errorResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    },
  });
}

export async function serveSenseVoiceAsset(
  rawUrl: string,
  assetRoot: string,
): Promise<Response> {
  const name = senseVoiceAssetNameFromUrl(rawUrl);
  if (!name) return errorResponse(404, 'Unknown speech recognition asset');

  const path = join(assetRoot, name);
  const metadata = await stat(path).catch(() => undefined);
  if (!metadata?.isFile()) {
    return errorResponse(503, 'Local speech recognition assets are not installed');
  }

  const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': SENSEVOICE_ASSETS[name],
      'content-length': String(metadata.size),
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
}

export function registerSenseVoiceAssetProtocol(
  protocol: Pick<Protocol, 'handle'>,
  assetRoot: string,
): void {
  protocol.handle(SENSEVOICE_ASSET_SCHEME, (request) =>
    serveSenseVoiceAsset(request.url, assetRoot));
}
