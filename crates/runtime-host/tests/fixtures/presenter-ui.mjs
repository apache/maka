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

let factories = 0;
export default function create(initial) {
  factories++;
  if (Object.keys(initial).join(',') !== 'tui') throw new Error('Ambient initialization authority');
  const { tui } = initial;
  let updates = 0;
  let reads = 0,
    previous,
    lateRejected = 0;
  return {
    async read(route, cx) {
      if (route?.mode === 'sync-loop') {
        while (true) {}
      }
      if (previous) {
        try {
          await previous.backend();
        } catch {
          lateRejected++;
        }
      }
      previous = cx;
      if (route?.original) route.original = 'UI tampered';
      const model = await cx.backend();
      if (route?.mode === 'await-loop') {
        while (true) {}
      }
      return tui.view({
        title: 'Page',
        revision: String(factories),
        root: tui.text(
          'value',
          JSON.stringify({
            factories,
            updates,
            reads: ++reads,
            lateRejected,
            model,
            keys: Object.keys(cx).sort(),
          }),
        ),
      });
    },
    async submit(input, cx) {
      if (input.action === 'fake') return { kind: 'applied', route: { operation: 'forged' } };
      input.fields.note = 'UI tampered';
      const receipt = await cx.backend();
      if (receipt.kind === 'updated') updates++;
      if (input.action === 'after-loop' || input.action === 'updated-after-loop') {
        while (true) {}
      }
      if (input.action === 'override') return { kind: 'applied', route: { operation: 'forged' } };
      return receipt;
    },
    async recover(_route, cx) {
      await cx.backend();
      return { kind: 'applied', route: { operation: 'forged' } };
    },
  };
}
