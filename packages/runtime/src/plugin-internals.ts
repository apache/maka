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

import type { Context, Disposable } from './plugin-kernel.js';
import type { MakaCompositionEntry } from './plugin-runtime.js';

export class PluginRuntimeBinding<T> {
  #runtime?: T;

  constructor(
    private readonly serviceName: string,
    private readonly runtimeName: string,
    private readonly hostRuntimeName = runtimeName,
  ) {}

  bind(ctx: Context, runtime: T): Disposable<Promise<void>> {
    if (ctx.maka) throw new Error(`Only the Host may bind the ${this.hostRuntimeName} Runtime`);
    if (this.#runtime) throw new Error(`Plugin ${this.runtimeName} Runtime is already bound`);
    this.#runtime = runtime;
    return ctx.effect(
      () => () => {
        if (this.#runtime === runtime) this.#runtime = undefined;
      },
      `${this.serviceName}.bindRuntime()`,
    );
  }

  get(): T {
    if (!this.#runtime) throw new Error(`Plugin ${this.runtimeName} Runtime is unavailable`);
    return this.#runtime;
  }
}

export function cloneCompositionEntry(entry: MakaCompositionEntry): MakaCompositionEntry {
  return copyCompositionEntry(entry, false);
}

export function freezeCompositionEntry(entry: MakaCompositionEntry): MakaCompositionEntry {
  return copyCompositionEntry(entry, true);
}

export function* walkCompositionEntry(
  entry: MakaCompositionEntry,
): Generator<MakaCompositionEntry> {
  yield entry;
  for (const child of entry.children ?? []) yield* walkCompositionEntry(child);
}

function copyCompositionEntry(entry: MakaCompositionEntry, freeze: boolean): MakaCompositionEntry {
  const copy = <T>(value: readonly T[]): readonly T[] => {
    const output = [...value];
    return freeze ? Object.freeze(output) : output;
  };
  const record = <T>(value: Readonly<Record<string, T>>): Readonly<Record<string, T>> => {
    const output = { ...value };
    return freeze ? Object.freeze(output) : output;
  };
  const output: MakaCompositionEntry = {
    ...entry,
    ...(entry.inject && !Array.isArray(entry.inject)
      ? { inject: record(entry.inject as Readonly<Record<string, unknown>>) }
      : entry.inject
        ? { inject: copy(entry.inject) }
        : {}),
    ...(entry.isolate ? { isolate: record(entry.isolate) } : {}),
    ...(entry.intercept ? { intercept: record(entry.intercept) } : {}),
    children: copy((entry.children ?? []).map((child) => copyCompositionEntry(child, freeze))),
  };
  return freeze ? Object.freeze(output) : output;
}
