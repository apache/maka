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

/**
 * Serialises every mutation of a Storage Root's managed context values.
 *
 * The Context Store's own operations read database state, await, and then act
 * on files -- garbage collection decides a payload is unreferenced, awaits, and
 * unlinks it. A second writer that commits a reference to that payload inside
 * the await leaves a reference pointing at a file that is about to disappear.
 * The re-check garbage collection performs cannot see it, because the check and
 * the unlink straddle the await.
 *
 * The Store used to serialise those operations against each other through a
 * private promise tail, which fenced nothing outside the instance. This is the
 * same queue, keyed by Storage Root, so that an importer publishing payloads
 * into a live workspace takes its turn alongside the Store's own publication
 * and collection rather than interleaving with them.
 *
 * In-process is the whole boundary: the interactive write authority is an
 * exclusive election, so one process at a time can mutate a root's context.
 *
 * `root` must already be canonical -- the same string the Store derives with
 * `realpath`. Two spellings of one directory would be two queues and fence
 * nothing.
 */
const gates = new Map<string, Promise<void>>();

export async function runWithContextValueMutation<T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = gates.get(root);
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  gates.set(root, current);
  await previous?.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (gates.get(root) === current) gates.delete(root);
  }
}
