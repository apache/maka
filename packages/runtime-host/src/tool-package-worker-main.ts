import { Console } from 'node:console';
import { createReadStream, createWriteStream } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const protocolInput = createReadStream('', { fd: 3, autoClose: false });
const protocolOutput = createWriteStream('', { fd: 4, autoClose: false });
protocolInput.on('error', () => process.exit(1));
protocolOutput.on('error', () => process.exit(1));

// Package diagnostics belong on stderr. Direct stdout writes are captured by
// the parent but can never corrupt the dedicated protocol descriptor.
globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });

interface WorkerContext {
  readonly sessionId: string;
  readonly runId?: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly toolCallId: string;
  readonly operationId?: string;
  readonly configuration: Readonly<Record<string, string | number | boolean>>;
}

type WorkerRequest =
  | { readonly kind: 'health'; readonly handlers: readonly string[] }
  | {
      readonly kind: 'invoke';
      readonly handler: string;
      readonly args: unknown;
      readonly context: WorkerContext;
    };

const abortController = new AbortController();
let protocolAuth = '';
process.once('SIGTERM', () => abortController.abort(new Error('Tool invocation was terminated')));
process.once('SIGINT', () => abortController.abort(new Error('Tool invocation was interrupted')));

try {
  const decoded = decodeRequest(JSON.parse(await readRequest()));
  protocolAuth = decoded.auth;
  const { request } = decoded;
  const entry = process.argv[2];
  if (!entry) throw new Error('Tool package worker entry is missing');
  const handlers = await loadHandlers(entry);
  if (request.kind === 'health') {
    for (const handler of request.handlers) requireHandler(handlers, handler);
    writeFrame({ kind: 'result', result: { ready: true } });
  } else {
    const handler = requireHandler(handlers, request.handler);
    const context = Object.freeze({
      ...request.context,
      abortSignal: abortController.signal,
      emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => {
        if (stream !== 'stdout' && stream !== 'stderr') {
          throw new Error('Tool package emitted an invalid output stream');
        }
        if (typeof chunk !== 'string') throw new Error('Tool package output must be a string');
        writeFrame({ kind: 'output', stream, chunk });
      },
    });
    const result = await handler(request.args, context);
    assertJsonValue(result);
    writeFrame({ kind: 'result', result: result ?? null });
  }
} catch (error) {
  writeFrame({ kind: 'error', error: serializeError(error) });
  process.exitCode = 1;
} finally {
  protocolOutput.end();
}

async function loadHandlers(entry: string): Promise<Readonly<Record<string, ToolHandler>>> {
  const imported = (await import(`${pathToFileURL(entry).href}?worker=${process.pid}`)) as {
    default?: unknown;
    tools?: unknown;
  };
  const value = imported.default ?? imported.tools;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool package entry must export a default handler object');
  }
  return value as Readonly<Record<string, ToolHandler>>;
}

type ToolHandler = (
  args: unknown,
  context: WorkerContext & {
    readonly abortSignal: AbortSignal;
    readonly emitOutput: (stream: 'stdout' | 'stderr', chunk: string) => void;
  },
) => unknown | Promise<unknown>;

function requireHandler(
  handlers: Readonly<Record<string, ToolHandler>>,
  name: string,
): ToolHandler {
  const handler = handlers[name];
  if (typeof handler !== 'function') throw new Error(`Tool package handler is missing: ${name}`);
  return handler;
}

async function readRequest(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of protocolInput) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_REQUEST_BYTES) throw new Error('Tool package worker request is too large');
    chunks.push(buffer);
  }
  const encoded = Buffer.concat(chunks).toString('utf8').trim();
  if (!encoded) throw new Error('Tool package worker request is empty');
  return encoded;
}

function decodeRequest(value: unknown): { auth: string; request: WorkerRequest } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool package worker request is invalid');
  }
  const record = value as Record<string, unknown>;
  const auth = requiredAuth(record.auth);
  if (record.kind === 'health') {
    exactKeys(record, ['kind', 'handlers', 'auth']);
    if (
      !Array.isArray(record.handlers) ||
      record.handlers.length === 0 ||
      record.handlers.some((handler) => typeof handler !== 'string')
    ) {
      throw new Error('Tool package health request is invalid');
    }
    return { auth, request: { kind: 'health', handlers: record.handlers as string[] } };
  }
  if (record.kind === 'invoke') {
    exactKeys(record, ['kind', 'handler', 'args', 'context', 'auth']);
    if (typeof record.handler !== 'string') throw new Error('Tool package handler is invalid');
    return {
      auth,
      request: {
        kind: 'invoke',
        handler: record.handler,
        args: record.args,
        context: decodeContext(record.context),
      },
    };
  }
  throw new Error('Tool package worker request kind is invalid');
}

function decodeContext(value: unknown): WorkerContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool package worker context is invalid');
  }
  const context = value as Record<string, unknown>;
  const allowed = [
    'sessionId',
    'runId',
    'turnId',
    'cwd',
    'toolCallId',
    'operationId',
    'configuration',
  ];
  if (Object.keys(context).some((key) => !allowed.includes(key))) {
    throw new Error('Tool package worker context fields are invalid');
  }
  const result: WorkerContext = {
    sessionId: requiredString(context.sessionId, 'sessionId'),
    turnId: requiredString(context.turnId, 'turnId'),
    cwd: requiredString(context.cwd, 'cwd'),
    toolCallId: requiredString(context.toolCallId, 'toolCallId'),
    configuration: decodeConfiguration(context.configuration),
    ...(context.runId === undefined ? {} : { runId: requiredString(context.runId, 'runId') }),
    ...(context.operationId === undefined
      ? {}
      : { operationId: requiredString(context.operationId, 'operationId') }),
  };
  return Object.freeze(result);
}

function decodeConfiguration(value: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool package worker configuration is invalid');
  }
  const result: Record<string, string | number | boolean> = {};
  for (const [key, configured] of Object.entries(value as Record<string, unknown>)) {
    if (
      !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(key) ||
      (typeof configured !== 'string' &&
        typeof configured !== 'boolean' &&
        !(typeof configured === 'number' && Number.isFinite(configured)))
    )
      throw new Error('Tool package worker configuration value is invalid');
    result[key] = configured;
  }
  return Object.freeze(result);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096) {
    throw new Error(`Tool package worker ${label} is invalid`);
  }
  return value;
}

function requiredAuth(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error('Tool package worker authentication is invalid');
  }
  return value;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): void {
  if (
    Object.keys(record).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !keys.includes(key))
  ) {
    throw new Error('Tool package worker request fields are invalid');
  }
}

function writeFrame(frame: unknown): void {
  const encoded = `${JSON.stringify({ ...(frame as object), auth: protocolAuth })}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES) {
    throw new Error('Tool package worker response is too large');
  }
  protocolOutput.write(encoded);
}

function assertJsonValue(value: unknown): void {
  if (value === undefined) return;
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('undefined');
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FRAME_BYTES / 2) {
      throw new Error('Tool package result exceeds its size limit');
    }
  } catch (error) {
    throw new Error('Tool package result must be a bounded JSON value', { cause: error });
  }
}

function serializeError(error: unknown): { name: string; message: string; stack?: string } {
  const value = error instanceof Error ? error : new Error(String(error));
  return {
    name: bounded(value.name || 'Error', 128),
    message: bounded(value.message || 'Tool package execution failed', 4096),
    ...(value.stack ? { stack: bounded(value.stack, 16 * 1024) } : {}),
  };
}

function bounded(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.byteLength <= maxBytes) return value;
  return `${encoded
    .subarray(0, maxBytes - 3)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')}...`;
}
