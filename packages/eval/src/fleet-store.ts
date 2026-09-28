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

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { stableJsonStringify } from '@maka/core/canonical-json';
import type { ExperimentSpec } from './experiment.js';
import {
  createFleetState,
  transitionFleet,
  type FleetArtifact,
  type FleetCommand,
  type FleetPolicy,
  type FleetReply,
  type FleetState,
  type FleetWorkerCommand,
} from './fleet.js';

/** Exactly one coordinator owns a persistence instance. save must be atomic and durable. */
export interface FleetPersistence {
  load(): Promise<FleetState | null>;
  save(state: FleetState): Promise<void>;
  putArtifact(bytes: Uint8Array): Promise<FleetArtifact>;
  getArtifact(ref: FleetArtifact): Promise<Uint8Array>;
}

export interface FleetTransport {
  command(command: FleetWorkerCommand): Promise<FleetReply>;
  putArtifact(bytes: Uint8Array): Promise<FleetArtifact>;
}

export class FleetCoordinator implements FleetTransport {
  static #owners = new WeakSet<FleetPersistence>();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  private constructor(
    readonly persistence: FleetPersistence,
    private readonly now: () => number,
  ) {}

  static async open(input: {
    persistence: FleetPersistence;
    spec: ExperimentSpec;
    policy: FleetPolicy;
    now: () => number;
  }): Promise<FleetCoordinator> {
    if (FleetCoordinator.#owners.has(input.persistence))
      throw new Error('fleet persistence already has a coordinator');
    FleetCoordinator.#owners.add(input.persistence);
    try {
      const initial = createFleetState(input.spec, input.policy);
      const existing = await input.persistence.load();
      if (
        existing &&
        (existing.version !== initial.version ||
          stableJsonStringify(existing.spec) !== stableJsonStringify(initial.spec) ||
          stableJsonStringify(existing.policy) !== stableJsonStringify(initial.policy))
      ) {
        throw new Error('fleet run identity differs');
      }
      if (!existing) await input.persistence.save(initial);
      const coordinator = new FleetCoordinator(input.persistence, input.now);
      await coordinator.command({ kind: 'recover' });
      return coordinator;
    } catch (error) {
      FleetCoordinator.#owners.delete(input.persistence);
      throw error;
    }
  }

  command(command: FleetCommand): Promise<FleetReply> {
    if (this.#closed) return Promise.reject(new Error('coordinator closed'));
    const captured = structuredClone(command);
    const operation = this.#tail.then(async () => {
      const state = await this.persistence.load();
      if (!state) throw new Error('fleet state missing');
      if (captured.kind === 'report') {
        for (const artifact of captured.report.artifacts)
          await this.persistence.getArtifact(artifact);
      }
      const next = transitionFleet(state, captured, this.now());
      await this.persistence.save(next.state);
      return next.reply;
    });
    this.#tail = operation.catch(() => undefined);
    return operation;
  }

  async snapshot(): Promise<FleetState> {
    await this.#tail;
    const state = await this.persistence.load();
    if (!state) throw new Error('fleet state missing');
    return state;
  }

  putArtifact(bytes: Uint8Array): Promise<FleetArtifact> {
    if (this.#closed) return Promise.reject(new Error('coordinator closed'));
    return this.persistence.putArtifact(bytes);
  }

  /** Stop accepting commands and drain commits before closing persistence or replacing this owner. */
  async close() {
    if (this.#closed) {
      await this.#tail;
      return;
    }
    this.#closed = true;
    await this.#tail;
    FleetCoordinator.#owners.delete(this.persistence);
  }
}

export class MemoryFleetPersistence implements FleetPersistence {
  #state: FleetState | null = null;
  #artifacts = new Map<string, Uint8Array>();
  async load() {
    return structuredClone(this.#state);
  }
  async save(state: FleetState) {
    this.#state = structuredClone(state);
  }
  async putArtifact(bytes: Uint8Array) {
    const ref = reference(bytes);
    this.#artifacts.set(ref.sha256, Uint8Array.from(bytes));
    return ref;
  }
  async getArtifact(ref: FleetArtifact) {
    validateReference(ref);
    const bytes = this.#artifacts.get(ref.sha256);
    if (!bytes) throw new Error('artifact missing');
    verifyArtifact(ref, bytes);
    return Uint8Array.from(bytes);
  }
}

/** Local coordinator storage. A stale writer lock requires explicit operator recovery. */
export class FileFleetPersistence implements FleetPersistence {
  #tail: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;
  private constructor(
    readonly root: string,
    private readonly release: () => Promise<void>,
  ) {}

  static async open(root: string): Promise<FileFleetPersistence> {
    await mkdir(root, { recursive: true });
    const lockPath = join(root, '.writer.lock');
    const lock = await open(lockPath, 'wx', 0o600);
    let closed = false;
    return new FileFleetPersistence(root, async () => {
      if (closed) return;
      closed = true;
      await lock.close();
      await unlink(lockPath);
    });
  }

  async close() {
    this.#closing ??= this.#tail.then(() => this.release());
    await this.#closing;
  }

  #operation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closing) return Promise.reject(new Error('fleet persistence closed'));
    const running = this.#tail.then(operation);
    this.#tail = running.catch(() => undefined);
    return running;
  }

  load(): Promise<FleetState | null> {
    return this.#operation(() => this.#load());
  }

  async #load(): Promise<FleetState | null> {
    let raw: string;
    try {
      raw = await readFile(join(this.root, 'state.json'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const envelope = JSON.parse(raw) as { sha256: string; state: FleetState };
    if (digest(Buffer.from(stableJsonStringify(envelope.state))) !== envelope.sha256) {
      throw new Error('fleet state checksum mismatch');
    }
    if (envelope.state.version !== 'maka.eval.fleet.v1') throw new Error('unsupported fleet state');
    return envelope.state;
  }

  async save(state: FleetState) {
    const canonical = stableJsonStringify(state);
    const bytes = Buffer.from(JSON.stringify({ sha256: digest(Buffer.from(canonical)), state }));
    await this.#operation(() => atomicWrite(this.root, 'state.json', bytes));
  }

  async putArtifact(bytes: Uint8Array): Promise<FleetArtifact> {
    const captured = Uint8Array.from(bytes);
    return this.#operation(async () => {
      const ref = reference(captured);
      const directory = join(this.root, 'artifacts');
      await mkdir(directory, { recursive: true });
      await atomicWrite(directory, ref.sha256, captured);
      return ref;
    });
  }

  async getArtifact(ref: FleetArtifact): Promise<Uint8Array> {
    validateReference(ref);
    const captured = { ...ref };
    return this.#operation(async () => {
      const bytes = await readFile(join(this.root, 'artifacts', captured.sha256));
      verifyArtifact(captured, bytes);
      return bytes;
    });
  }
}

async function atomicWrite(directory: string, name: string, bytes: Uint8Array) {
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await rename(temporary, join(directory, name));
    if (process.platform !== 'win32') {
      const parent = await open(directory, 'r');
      try {
        await parent.sync();
      } finally {
        await parent.close();
      }
    }
  } finally {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function digest(bytes: Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}
function reference(bytes: Uint8Array): FleetArtifact {
  return { sha256: digest(bytes), bytes: bytes.byteLength };
}
function validateReference(ref: FleetArtifact) {
  if (!/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
    throw new Error('invalid artifact reference');
  }
}
function verifyArtifact(ref: FleetArtifact, bytes: Uint8Array) {
  if (bytes.byteLength !== ref.bytes || digest(bytes) !== ref.sha256)
    throw new Error('artifact checksum mismatch');
}
