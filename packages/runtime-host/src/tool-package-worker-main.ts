import { Console } from 'node:console';
import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { Socket } from 'node:net';
import { pathToFileURL } from 'node:url';

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const protocolInput = createReadStream('', { fd: 3, autoClose: false });
const protocolOutput = createWriteStream('', { fd: 4, autoClose: false });
const callbackOutput = new Socket({ fd: 5, readable: false, writable: true });
const callbackInput = new Socket({ fd: 6, readable: true, writable: false });
protocolInput.on('error', () => process.exit(1));
protocolOutput.on('error', () => process.exit(1));
callbackOutput.on('error', () => process.exit(1));
callbackInput.on('error', () => process.exit(1));

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
const pendingCallbacks = new Map<
  string,
  {
    kind: 'emit_event' | 'call_service';
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }
>();
let callbackProtocol = '';
let callbackProtocolBytes = 0;
callbackInput.on('data', (chunk: Buffer) => {
  callbackProtocolBytes += chunk.byteLength;
  if (callbackProtocolBytes > 2 * 1024 * 1024) {
    failPendingCallbacks(new Error('Tool package callback input exceeds its size limit'));
    process.exit(1);
    return;
  }
  callbackProtocol += chunk.toString('utf8');
  let newline: number;
  while ((newline = callbackProtocol.indexOf('\n')) >= 0) {
    const encoded = callbackProtocol.slice(0, newline);
    callbackProtocol = callbackProtocol.slice(newline + 1);
    if (!encoded) continue;
    try {
      settleCallback(JSON.parse(encoded));
    } catch (error) {
      failPendingCallbacks(error instanceof Error ? error : new Error(String(error)));
      process.exit(1);
      return;
    }
  }
});
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
      emitEvent,
      callService,
    });
    const result = await handler(request.args, context);
    if (pendingCallbacks.size > 0) {
      throw new Error('Extension Event emissions must be awaited before the handler returns');
    }
    assertJsonValue(result);
    writeFrame({ kind: 'result', result: result ?? null });
  }
} catch (error) {
  writeFrame({ kind: 'error', error: serializeError(error) });
  process.exitCode = 1;
} finally {
  failPendingCallbacks(new Error('Tool package worker is closing'));
  callbackInput.destroy();
  callbackOutput.end();
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
    readonly emitEvent: (event: string, payload: unknown) => Promise<unknown>;
    readonly callService: (service: string, method: string, input: unknown) => Promise<unknown>;
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

async function emitEvent(event: string, payload: unknown): Promise<unknown> {
  if (
    typeof event !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(event) ||
    Buffer.byteLength(event, 'utf8') > 192
  ) {
    throw new Error('Extension Event name is invalid');
  }
  if (payload === undefined) throw new Error('Extension Event payload must be JSON');
  assertJsonValue(payload);
  return await requestCallback('emit_event', {
    event,
    payload,
  });
}

async function callService(service: string, method: string, input: unknown): Promise<unknown> {
  if (
    typeof service !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(service) ||
    Buffer.byteLength(service, 'utf8') > 192 ||
    typeof method !== 'string' ||
    !/^[A-Za-z][A-Za-z0-9._-]{0,127}$/u.test(method)
  ) {
    throw new Error('Extension Service identity is invalid');
  }
  if (input === undefined) throw new Error('Extension Service input must be JSON');
  assertJsonValue(input);
  return await requestCallback('call_service', { service, method, input });
}

async function requestCallback(
  kind: 'emit_event' | 'call_service',
  fields: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  const id = randomBytes(16).toString('hex');
  const encoded = `${JSON.stringify({
    ...fields,
    kind,
    id,
    auth: protocolAuth,
  })}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('Extension callback payload exceeds its size limit');
  }
  const result = new Promise<unknown>((resolve, reject) => {
    pendingCallbacks.set(id, { kind, resolve, reject });
  });
  callbackOutput.write(encoded);
  return await result;
}

function settleCallback(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool package callback response is invalid');
  }
  const frame = value as Record<string, unknown>;
  const fields = ['kind', 'id', 'ok', frame.ok === true ? 'result' : 'error', 'auth'];
  exactKeys(frame, fields);
  if (
    frame.auth !== protocolAuth ||
    typeof frame.id !== 'string' ||
    typeof frame.ok !== 'boolean'
  ) {
    throw new Error('Tool package callback response identity is invalid');
  }
  const pending = pendingCallbacks.get(frame.id);
  if (!pending) throw new Error('Tool package callback response is unexpected');
  if (frame.kind !== `${pending.kind}_result`) {
    throw new Error('Tool package callback response kind is invalid');
  }
  pendingCallbacks.delete(frame.id);
  if (frame.ok) {
    pending.resolve(frame.result);
    return;
  }
  if (!frame.error || typeof frame.error !== 'object' || Array.isArray(frame.error)) {
    throw new Error('Tool package callback error is invalid');
  }
  const error = frame.error as Record<string, unknown>;
  exactKeys(error, ['name', 'message']);
  if (typeof error.name !== 'string' || typeof error.message !== 'string') {
    throw new Error('Tool package callback error fields are invalid');
  }
  pending.reject(Object.assign(new Error(error.message), { name: error.name }));
}

function failPendingCallbacks(error: Error): void {
  for (const pending of pendingCallbacks.values()) pending.reject(error);
  pendingCallbacks.clear();
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
