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

import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import type { Context } from '@maka/runtime/plugin-kernel';
import type { PluginToolService } from '@maka/runtime/plugin-tool-service';
import type { MakaPluginPackage, MakaPluginContribution } from '@maka/runtime/plugin-runtime';
import type { MakaTool } from '@maka/runtime/tool-runtime';

export const WASM_PLUGIN_ABI = 'maka:plugin/runtime@1' as const;
const MAX_WASM_BYTES = 8 * 1024 * 1024;
const INVOCATION_TIMEOUT_MS = 30_000;
const INITIALIZATION_TIMEOUT_MS = 10_000;
const WASM_MANIFEST_MAX_TOOLS = 64;

export interface WasmPluginToolManifest {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  readonly displayName?: string;
}

export interface WasmPluginManifest {
  readonly abiVersion: 1;
  readonly packageId: string;
  readonly contributions: readonly (MakaPluginContribution & {
    readonly kind: 'tool';
    readonly tool: WasmPluginToolManifest;
  })[];
}

interface WorkerResponse {
  readonly type: 'ready' | 'response' | 'error';
  readonly id?: number;
  readonly ok?: boolean;
  readonly result?: unknown;
  readonly manifest?: unknown;
  readonly error?: string;
}

interface PendingInvocation {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly cleanup: () => void;
}

export class WasmPluginRuntime {
  readonly #worker: Worker;
  readonly #manifest: WasmPluginManifest;
  readonly #pending = new Map<number, PendingInvocation>();
  #nextId = 1;
  #closed = false;

  private constructor(worker: Worker, manifest: WasmPluginManifest) {
    this.#worker = worker;
    this.#manifest = manifest;
    worker.on('message', (message: WorkerResponse) => this.#onMessage(message));
    worker.on('error', (error) => this.#fail(toError(error)));
    worker.on('exit', (code) => {
      if (code !== 0) this.#fail(new Error(`Wasm plugin worker exited with code ${code}`));
    });
  }

  static async load(entry: string, packageId: string): Promise<WasmPluginRuntime> {
    const bytes = await readFile(entry);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_WASM_BYTES) {
      throw new Error('Wasm plugin entry exceeds its size limit');
    }
    const worker = new Worker(new URL('./wasm-plugin-worker.js', import.meta.url), {
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      workerData: { wasmBytes: new Uint8Array(bytes) },
    });
    try {
      const manifest = await waitForManifest(worker);
      const decoded = decodeWasmPluginManifest(manifest, packageId);
      const runtime = new WasmPluginRuntime(worker, decoded);
      return runtime;
    } catch (error) {
      await worker.terminate();
      throw error;
    }
  }

  get manifest(): WasmPluginManifest {
    return this.#manifest;
  }

  async invoke(toolId: string, input: unknown, signal: AbortSignal): Promise<unknown> {
    if (this.#closed) throw new Error('Wasm plugin runtime is closed');
    if (signal.aborted) throw new Error('Wasm plugin invocation was aborted');
    const encoded = JSON.stringify({ kind: 'tool', toolId, input });
    if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > 1024 * 1024) {
      throw new Error('Wasm plugin invocation exceeds its size limit');
    }
    const id = this.#nextId++;
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error('Wasm plugin invocation timed out'));
      }, INVOCATION_TIMEOUT_MS);
      const abort = (): void => {
        signal.removeEventListener('abort', abort);
        this.#fail(new Error('Wasm plugin invocation was aborted'));
      };
      const pending = {
        resolve,
        reject,
        timer,
        cleanup: () => signal.removeEventListener('abort', abort),
      };
      this.#pending.set(id, pending);
      signal.addEventListener('abort', abort, { once: true });
      try {
        this.#worker.postMessage({ type: 'invoke', id, input: encoded });
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        pending.cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(new Error('Wasm plugin runtime is closed'));
    }
    this.#pending.clear();
    await this.#worker.terminate();
  }

  #onMessage(message: WorkerResponse): void {
    if (message.type === 'error') {
      this.#fail(new Error(message.error ?? 'Wasm plugin worker failed'));
      return;
    }
    if (message.type !== 'response' || message.id === undefined) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.cleanup();
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error ?? 'Wasm plugin invocation failed'));
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
    void this.#worker.terminate();
  }
}

export function createWasmPluginPackage(runtime: WasmPluginRuntime): MakaPluginPackage {
  const contributions = runtime.manifest.contributions.map(({ id, kind }) => ({ id, kind }));
  const host = {
    inject: ['tools'] as const,
    apply(ctx: Context): () => Promise<void> {
      const tools = ctx.get<PluginToolService>('tools');
      if (!tools) throw new Error('Wasm plugin requires the tools service');
      const disposers = runtime.manifest.contributions.map((contribution) =>
        tools.register(wasmTool(runtime, contribution)),
      );
      return async () => {
        await Promise.all(disposers.map((dispose) => dispose()));
      };
    },
  };
  return Object.freeze({
    packageId: runtime.manifest.packageId,
    host,
    contributions: Object.freeze(contributions),
  });
}

function wasmTool(
  runtime: WasmPluginRuntime,
  contribution: WasmPluginManifest['contributions'][number],
): MakaTool {
  return {
    name: contribution.tool.name,
    description: contribution.tool.description,
    parameters: contribution.tool.parameters,
    ...(contribution.tool.displayName === undefined
      ? {}
      : { displayName: contribution.tool.displayName }),
    impl: (input, context) => runtime.invoke(contribution.id, input, context.abortSignal),
  };
}

function decodeWasmPluginManifest(value: unknown, packageId: string): WasmPluginManifest {
  if (!value || typeof value !== 'object')
    throw new Error('Wasm plugin manifest must be an object');
  const source = value as Record<string, unknown>;
  if (source.abiVersion !== 1 || source.packageId !== packageId) {
    throw new Error('Wasm plugin manifest ABI or package identity is invalid');
  }
  if (
    !Array.isArray(source.contributions) ||
    source.contributions.length > WASM_MANIFEST_MAX_TOOLS
  ) {
    throw new Error('Wasm plugin manifest contributions are invalid');
  }
  const contributions = source.contributions.map((value, index) => {
    if (!value || typeof value !== 'object')
      throw new Error(`Wasm contribution ${index} is invalid`);
    const source = value as Record<string, unknown>;
    if (typeof source.id !== 'string' || source.id.length === 0 || source.id.length > 128) {
      throw new Error(`Wasm contribution ${index} has an invalid id`);
    }
    if (source.kind !== 'tool' || !source.tool || typeof source.tool !== 'object') {
      throw new Error(`Wasm contribution ${source.id} is not a tool`);
    }
    const tool = source.tool as Record<string, unknown>;
    if (
      typeof tool.name !== 'string' ||
      tool.name.length === 0 ||
      tool.name.length > 128 ||
      typeof tool.description !== 'string' ||
      tool.description.length === 0 ||
      tool.description.length > 16 * 1024 ||
      !Object.hasOwn(tool, 'parameters')
    ) {
      throw new Error(`Wasm tool ${source.id} metadata is invalid`);
    }
    if (tool.displayName !== undefined && typeof tool.displayName !== 'string') {
      throw new Error(`Wasm tool ${source.id} displayName is invalid`);
    }
    return Object.freeze({
      id: source.id,
      kind: 'tool' as const,
      tool: Object.freeze({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        ...(tool.displayName === undefined ? {} : { displayName: tool.displayName }),
      }),
    });
  });
  const ids = new Set<string>();
  for (const contribution of contributions) {
    if (ids.has(contribution.id)) throw new Error(`Wasm contribution repeats: ${contribution.id}`);
    ids.add(contribution.id);
  }
  return Object.freeze({
    abiVersion: 1,
    packageId,
    contributions: Object.freeze(contributions),
  });
}

async function waitForManifest(worker: Worker): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      void worker.terminate();
      reject(new Error('Wasm plugin initialization timed out'));
    }, INITIALIZATION_TIMEOUT_MS);
    const onMessage = (message: WorkerResponse): void => {
      if (message.type === 'ready') {
        cleanup();
        resolve(message.manifest);
      } else if (message.type === 'error') {
        cleanup();
        reject(new Error(message.error ?? 'Wasm plugin failed to initialize'));
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    worker.on('message', onMessage);
    worker.on('error', onError);
  });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
