import type { HttpHandlerOptions, HttpRequest as SmithyHttpRequest } from '@smithy/types';
import { HttpResponse, type HttpHandler } from '@smithy/protocol-http';

const AWS_CONTROL_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Adapts AWS SDK v3 control-plane clients to Maka's scoped fetch transport.
 * This keeps proxy, abort and Host ownership semantics in the same boundary as
 * model-provider HTTP instead of letting Smithy's Node handler open a second
 * network path.
 */
export class ScopedFetchHttpHandler implements HttpHandler {
  readonly metadata = { handlerProtocol: 'fetch' };

  constructor(private readonly fetchFn: typeof fetch) {}

  async handle(request: SmithyHttpRequest, options: HttpHandlerOptions = {}) {
    const url = smithyRequestUrl(request);
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers.set(name, value);
    }
    const body = await requestBody(request.body);
    const response = await this.fetchFn(url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.abortSignal ? { signal: options.abortSignal as globalThis.AbortSignal } : {}),
    });
    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      responseHeaders[name] = value;
    });
    return {
      response: new HttpResponse({
        statusCode: response.status,
        reason: response.statusText,
        headers: responseHeaders,
        body: await readBoundedResponse(response),
      }),
    };
  }

  updateHttpClientConfig(_key: string, _value: unknown): void {}

  httpHandlerConfigs(): Record<string, unknown> {
    return {};
  }
}

async function readBoundedResponse(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > AWS_CONTROL_RESPONSE_MAX_BYTES) {
    await response.body?.cancel();
    throw new Error('AWS control-plane response is too large');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > AWS_CONTROL_RESPONSE_MAX_BYTES) {
        await reader.cancel();
        throw new Error('AWS control-plane response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function smithyRequestUrl(request: SmithyHttpRequest): URL {
  const authority = request.port ? `${request.hostname}:${request.port}` : request.hostname;
  const url = new URL(`${request.protocol}//${authority}${request.path}`);
  for (const [name, value] of Object.entries(request.query ?? {})) {
    if (value === undefined) continue;
    for (const entry of Array.isArray(value) ? value : [value]) {
      if (entry !== undefined) url.searchParams.append(name, String(entry));
    }
  }
  return url;
}

async function requestBody(body: unknown): Promise<BodyInit | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string' || body instanceof Blob) return body;
  if (body instanceof Uint8Array) return new Blob([new Uint8Array(body)]);
  if (body instanceof ArrayBuffer) return body;
  if (typeof ReadableStream !== 'undefined' && body instanceof ReadableStream) return body;
  if (isAsyncIterable(body)) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body) {
      const bytes =
        typeof chunk === 'string'
          ? new TextEncoder().encode(chunk)
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      chunks.push(bytes);
      size += bytes.byteLength;
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return joined;
  }
  throw new Error('Unsupported AWS SDK request body');
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string | ArrayBufferView> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Symbol.asyncIterator in value &&
    typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function'
  );
}
