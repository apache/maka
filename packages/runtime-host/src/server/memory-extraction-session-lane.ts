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

export type MemoryExtractionLanePriority = 'foreground' | 'background';

interface LaneJob {
  readonly keys: readonly string[];
  readonly priority: MemoryExtractionLanePriority;
  readonly operation: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

/**
 * Process-local serialization shared by Memory Extraction and Session retirement.
 * Foreground user requests may pass queued background extraction, but never
 * preempt running work or pass an earlier foreground operation for the Session.
 */
export class MemoryExtractionSessionLane {
  readonly #held = new Set<string>();
  readonly #queue: LaneJob[] = [];

  run<T>(
    sessionId: string,
    operation: () => Promise<T>,
    priority: MemoryExtractionLanePriority = 'foreground',
  ): Promise<T> {
    return this.runMany([sessionId], operation, priority);
  }

  runMany<T>(
    sessionIds: readonly string[],
    operation: () => Promise<T>,
    priority: MemoryExtractionLanePriority = 'foreground',
  ): Promise<T> {
    const keys = [...new Set(sessionIds)].sort();
    if (keys.length === 0) return operation();
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({
        keys,
        priority,
        operation,
        resolve: (value) => resolve(value as T),
        reject,
      });
      this.#drain();
    });
  }

  #drain(): void {
    while (true) {
      const index = this.#nextRunnableIndex();
      if (index < 0) return;
      const [job] = this.#queue.splice(index, 1);
      if (!job) return;
      for (const key of job.keys) this.#held.add(key);
      void Promise.resolve()
        .then(job.operation)
        .then(job.resolve, job.reject)
        .finally(() => {
          for (const key of job.keys) this.#held.delete(key);
          this.#drain();
        });
    }
  }

  #nextRunnableIndex(): number {
    for (const priority of ['foreground', 'background'] as const) {
      for (let index = 0; index < this.#queue.length; index += 1) {
        const candidate = this.#queue[index]!;
        if (candidate.priority !== priority || candidate.keys.some((key) => this.#held.has(key))) {
          continue;
        }
        const blockedByEarlier = this.#queue
          .slice(0, index)
          .some(
            (earlier) =>
              earlier.keys.some((key) => candidate.keys.includes(key)) &&
              (candidate.priority === 'background' || earlier.priority === 'foreground'),
          );
        if (!blockedByEarlier) return index;
      }
    }
    return -1;
  }
}
