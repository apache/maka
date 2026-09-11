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

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import type { ZodType } from 'zod';

// Both shipped entry points must preserve identity across nested parses.
for (const format of ['esm', 'cjs'] as const) {
  test(`Zod ${format} preserves recursive identity across reentry and thrown parses`, async () => {
    const { z }: typeof import('zod') =
      format === 'esm' ? await import('zod') : createRequire(import.meta.url)('zod');
    type Node = { label: string; children: Node[] };
    const schema: ZodType<Node> = z.object({
      label: z.string(),
      get children() {
        return z.array(schema);
      },
    });
    const cycle: Node = { label: 'root', children: [] };
    cycle.children.push(cycle);
    const shared: Node = { label: 'child', children: [] };
    for (const parse of [
      (input: Node) => schema.parse(input),
      (input: Node) => schema.parseAsync(input),
    ]) {
      const output = await parse(cycle);
      assert.equal(output.children[0], output);
      const aliases = await parse({ label: 'root', children: [shared, shared] });
      assert.equal(aliases.children[0], aliases.children[1]);
    }

    type RecursiveArray = RecursiveArray[];
    const arraySchema: ZodType<RecursiveArray> = z.array(z.lazy(() => arraySchema));
    arraySchema.parse([]);
    for (const throws of [false, true]) {
      let entered = false;
      const target: RecursiveArray = [];
      const proxy = new Proxy(target, {
        get(array, key, receiver) {
          // Reenter before the outer array allocates its output.
          if (key === 'length' && !entered) {
            entered = true;
            if (throws) {
              assert.throws(
                () =>
                  arraySchema.parse(
                    new Proxy([], {
                      get() {
                        throw new Error('nested length');
                      },
                    }),
                  ),
                /nested length/,
              );
            } else {
              schema.parse({ label: 'nested', children: [] });
            }
          }
          return Reflect.get(array, key, receiver);
        },
      });
      target.push(proxy);
      const output = arraySchema.parse(proxy);
      assert.equal(entered, true);
      assert.equal(output[0], output);
    }

    const throwing: ZodType<Node> = z.object({
      label: z.string().transform(() => {
        throw new Error('nested transform');
      }),
      get children() {
        return z.array(throwing);
      },
    });
    assert.throws(() => throwing.parse(cycle), /nested transform/);
    await assert.rejects(throwing.parseAsync(cycle), /nested transform/);
    const recovered = schema.parse(cycle);
    assert.equal(recovered.children[0], recovered);
  });
}
