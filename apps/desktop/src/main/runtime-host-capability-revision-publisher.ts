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

interface ActivePublisher {
  readonly generation: symbol;
  readonly publish: () => Promise<void>;
}

export interface CapabilityRevisionBinding {
  readonly aligned: Promise<void>;
  dispose(): void;
}

export interface CapabilityRevisionPublisher {
  bind(publish: () => Promise<void>): CapabilityRevisionBinding;
  refreshIfChanged(): Promise<void>;
}

/** Publish each callable revision once to the currently active candidate generation. */
export function createCapabilityRevisionPublisher(
  readRevision: () => number,
): CapabilityRevisionPublisher {
  let active: ActivePublisher | undefined;
  let published:
    | { readonly generation: symbol; readonly revision: number }
    | undefined;
  let queue = Promise.resolve();

  const refreshIfChanged = (): Promise<void> => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        const target = active;
        if (!target) return;
        const revision = readRevision();
        if (
          published?.generation === target.generation &&
          published.revision === revision
        ) {
          return;
        }
        await target.publish();
        if (active === target) {
          published = { generation: target.generation, revision };
        }
      });
    return queue;
  };

  return {
    bind: (publish) => {
      const target: ActivePublisher = {
        generation: Symbol("Runtime Host Desktop candidate"),
        publish,
      };
      active = target;
      return {
        aligned: refreshIfChanged(),
        dispose: () => {
          if (active === target) active = undefined;
        },
      };
    },
    refreshIfChanged,
  };
}
