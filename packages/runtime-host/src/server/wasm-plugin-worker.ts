/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { parentPort, workerData } from 'node:worker_threads';

const MAX_MEMORY_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 1024 * 1024;
const textDecoder = new TextDecoder();

interface WorkerData {
  readonly wasmBytes: Uint8Array;
}

interface WasmExports {
  readonly memory: WebAssembly.Memory;
  readonly maka_plugin_manifest_ptr: () => number;
  readonly maka_plugin_manifest_len: () => number;
  readonly maka_plugin_alloc: (size: number) => number;
  readonly maka_plugin_free: (ptr: number, size: number) => void;
  readonly maka_plugin_invoke: (ptr: number, len: number) => bigint;
  readonly maka_plugin_init?: () => number;
}

interface InvokeMessage {
  readonly type: 'invoke';
  readonly id: number;
  readonly input: string;
}

const port = parentPort;
if (!port) throw new Error('Wasm plugin worker requires a parent port');

try {
  const { wasmBytes } = workerData as WorkerData;
  const instantiated = await WebAssembly.instantiate(wasmBytes, {});
  const instance = (
    'instance' in instantiated ? instantiated.instance : instantiated
  ) as WebAssembly.Instance;
  const exports = instance.exports as unknown as Partial<WasmExports>;
  const wasm = requireExports(exports);
  if (wasm.maka_plugin_init && wasm.maka_plugin_init() !== 0) {
    throw new Error('maka_plugin_init returned a failure status');
  }
  const manifest = JSON.parse(
    readUtf8(wasm.memory, wasm.maka_plugin_manifest_ptr(), wasm.maka_plugin_manifest_len()),
  ) as unknown;
  checkMemory(wasm.memory);
  port.postMessage({ type: 'ready', manifest });
  port.on('message', (message: InvokeMessage) => {
    if (!message || message.type !== 'invoke') return;
    try {
      const result = invoke(wasm, message.input);
      port.postMessage({ type: 'response', id: message.id, ok: true, result });
    } catch (error) {
      port.postMessage({
        type: 'response',
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
} catch (error) {
  port.postMessage({
    type: 'error',
    error: error instanceof Error ? error.message : String(error),
  });
}

function requireExports(exports: Partial<WasmExports>): WasmExports {
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error('Wasm plugin must export memory');
  }
  for (const name of [
    'maka_plugin_manifest_ptr',
    'maka_plugin_manifest_len',
    'maka_plugin_alloc',
    'maka_plugin_free',
    'maka_plugin_invoke',
  ] as const) {
    if (typeof exports[name] !== 'function') throw new Error(`Wasm plugin is missing ${name}`);
  }
  return exports as WasmExports;
}

function invoke(wasm: WasmExports, input: string): unknown {
  const encoded = new TextEncoder().encode(input);
  if (encoded.byteLength > MAX_JSON_BYTES) {
    throw new Error('Wasm plugin input exceeds its size limit');
  }
  const inputPtr = wasm.maka_plugin_alloc(encoded.byteLength);
  checkRange(wasm.memory, inputPtr, encoded.byteLength);
  new Uint8Array(wasm.memory.buffer, inputPtr, encoded.byteLength).set(encoded);
  let outputPtr = 0;
  let outputLen = 0;
  try {
    const packed = wasm.maka_plugin_invoke(inputPtr, encoded.byteLength);
    if (typeof packed !== 'bigint') throw new Error('Wasm plugin invoke must return i64');
    outputPtr = Number((packed >> 32n) & 0xffffffffn);
    outputLen = Number(packed & 0xffffffffn);
    if (outputLen === 0 || outputLen > MAX_JSON_BYTES) {
      throw new Error('Wasm plugin output size is invalid');
    }
    const response = JSON.parse(readUtf8(wasm.memory, outputPtr, outputLen)) as unknown;
    checkMemory(wasm.memory);
    return response;
  } finally {
    wasm.maka_plugin_free(inputPtr, encoded.byteLength);
    if (outputPtr && outputLen) wasm.maka_plugin_free(outputPtr, outputLen);
  }
}

function readUtf8(memory: WebAssembly.Memory, ptr: number, len: number): string {
  checkRange(memory, ptr, len);
  return textDecoder.decode(new Uint8Array(memory.buffer, ptr, len));
}

function checkMemory(memory: WebAssembly.Memory): void {
  if (memory.buffer.byteLength > MAX_MEMORY_BYTES) {
    throw new Error('Wasm plugin memory exceeds its size limit');
  }
}

function checkRange(memory: WebAssembly.Memory, ptr: number, len: number): void {
  if (!Number.isSafeInteger(ptr) || !Number.isSafeInteger(len) || ptr < 0 || len < 0) {
    throw new Error('Wasm plugin returned an invalid memory range');
  }
  if (ptr + len > memory.buffer.byteLength)
    throw new Error('Wasm plugin memory range is out of bounds');
}
