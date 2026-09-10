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
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A child gives both shipped entry points real GC, independent module state,
// and no test-runner references to the parsed objects.
for (const format of ['esm', 'cjs'] as const) {
  test(`Zod ${format} releases completed parses and preserves recursive semantics`, () => {
    const result = spawnSync(
      process.execPath,
      ['--expose-gc', '--input-type=module', '--eval', `(${probe.toString()})('${format}')`],
      {
        cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
        encoding: 'utf8',
        timeout: 30_000,
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /all parse references collected/);
  });
}

async function probe(format: 'esm' | 'cjs') {
  const assert: typeof import('node:assert/strict') = (await import('node:assert/strict')).default;
  const { createRequire } = await import('node:module');
  const { setImmediate: immediate } = await import('node:timers/promises');
  const { z }: typeof import('zod') =
    format === 'esm' ? await import('zod') : createRequire(`${process.cwd()}/package.json`)('zod');
  assert.ok(global.gc);
  const gc = global.gc;
  type Node = { label: string; children: Node[] };
  const NodeSchema: import('zod').ZodType<Node> = z.object({
    label: z.string(),
    get children() {
      return z.array(NodeSchema);
    },
  });
  const AsyncSchema: import('zod').ZodType<Node> = z.object({
    label: z.string().refine(async (value) => value !== 'invalid', 'invalid label'),
    get children() {
      return z.array(AsyncSchema);
    },
  });
  const cycle = (label = 'root'): Node => {
    const input: Node = { label, children: [] };
    input.children.push(input);
    return input;
  };
  for (const schema of [NodeSchema, AsyncSchema]) {
    const output = await schema.parseAsync(cycle());
    assert.equal(output.children[0], output);
    const shared = { label: 'child', children: [] };
    const dag = await schema.parseAsync({ label: 'root', children: [shared, shared] });
    assert.equal(dag.children[0], dag.children[1]);
    const invalid = { label: 123, children: [] };
    const failure = await schema.safeParseAsync({ label: 'root', children: [invalid, invalid] });
    assert.equal(failure.success, false);
    if (!failure.success) {
      assert.deepEqual(
        failure.error.issues.map((issue) => issue.path),
        [
          ['children', 0, 'label'],
          ['children', 1, 'label'],
        ],
      );
    }
  }
  const syncCycle = NodeSchema.parse(cycle());
  assert.equal(syncCycle.children[0], syncCycle);
  const shared = { label: 'child', children: [] };
  const syncDag = NodeSchema.parse({ label: 'root', children: [shared, shared] });
  assert.equal(syncDag.children[0], syncDag.children[1]);
  const asyncFailure = await AsyncSchema.safeParseAsync(cycle('invalid'));
  assert.equal(asyncFailure.success, false);
  if (!asyncFailure.success) assert.deepEqual(asyncFailure.error.issues[0].path, ['label']);

  type TransformNode = { payload: object; next?: TransformNode };
  const TransformSchema: import('zod').ZodType<TransformNode> = z
    .object({
      // Preserve the payload identity so its WeakRef also observes the partial
      // output retained by a leaked allocation entry after a thrown parse.
      payload: z.any(),
      get next() {
        return TransformSchema.optional();
      },
    })
    .transform((value) => ({ ...value }));
  function transformCycle(): TransformNode {
    const input: TransformNode = { payload: { text: 'retained payload'.repeat(16_000) } };
    input.next = input;
    return input;
  }
  assert.throws(() => TransformSchema.parse(transformCycle()), { name: 'ZodCyclicError' });
  await assert.rejects(TransformSchema.parseAsync(transformCycle()), { name: 'ZodCyclicError' });
  assert.deepEqual(TransformSchema.parse({ payload: { text: 'good' } }), {
    payload: { text: 'good' },
  });

  // Reentry before alloc: Array(input.length) reads the proxy while the outer
  // bucket is still waiting for alloc. A nested throw must restore that bucket.
  type RecursiveArray = RecursiveArray[];
  const ArraySchema: import('zod').ZodType<RecursiveArray> = z.array(z.lazy(() => ArraySchema));
  for (const throws of [false, true]) {
    let entered = false;
    const target: RecursiveArray = [];
    const proxy = new Proxy(target, {
      get(array, key, receiver) {
        if (key === 'length' && !entered) {
          entered = true;
          if (throws) {
            const bad = new Proxy([], {
              get() {
                throw new Error('nested length');
              },
            });
            assert.throws(() => ArraySchema.parse(bad), /nested length/);
          } else {
            assert.deepEqual(ArraySchema.parse([]), []);
          }
        }
        return Reflect.get(array, key, receiver);
      },
    });
    target.push(proxy);
    const output = ArraySchema.parse(proxy);
    assert.equal(output[0], output);
  }
  const ReentrantSchema: import('zod').ZodType<Node> = z.object({
    label: z.string().transform((value) => {
      assert.throws(() => TransformSchema.parse(transformCycle()), { name: 'ZodCyclicError' });
      return value;
    }),
    get children() {
      return z.array(ReentrantSchema);
    },
  });
  const nested = ReentrantSchema.parse(cycle());
  assert.equal(nested.children[0], nested);
  const AsyncReentrantSchema: import('zod').ZodType<Node> = z.object({
    label: z.string().transform(async (value) => {
      await assert.rejects(TransformSchema.parseAsync(transformCycle()), {
        name: 'ZodCyclicError',
      });
      return value;
    }),
    get children() {
      return z.array(AsyncReentrantSchema);
    },
  });
  const concurrentInput = cycle();
  const [first, second] = await Promise.all([
    AsyncReentrantSchema.parseAsync(concurrentInput),
    AsyncReentrantSchema.parseAsync(concurrentInput),
  ]);
  assert.equal(first.children[0], first);
  assert.equal(second.children[0], second);
  assert.notEqual(first, second);

  const refs: WeakRef<object>[] = [];
  const remember = (...values: object[]) => refs.push(...values.map((value) => new WeakRef(value)));
  const RejectSchema: import('zod').ZodType<Node> = z.object({
    label: z.string().transform(async () => {
      throw new Error('async rejection');
    }),
    get children() {
      return z.array(RejectSchema);
    },
  });
  async function allocate() {
    for (const schema of [NodeSchema, AsyncSchema]) {
      const input = cycle('large'.repeat(50_000));
      const output = await schema.parseAsync(input);
      remember(input, output, input.children, output.children);
    }
    const input = cycle('sync'.repeat(50_000));
    remember(input, NodeSchema.parse(input));
    const invalid = { label: {}, children: [] };
    const failure = NodeSchema.safeParse(invalid);
    assert.equal(failure.success, false);
    remember(invalid, invalid.label);
    const asyncInvalid = cycle('invalid');
    assert.equal((await AsyncSchema.safeParseAsync(asyncInvalid)).success, false);
    remember(asyncInvalid);
    for (let i = 0; i < 30; i++) {
      const bad = transformCycle();
      remember(bad, bad.payload);
      assert.throws(() => TransformSchema.parse(bad), { name: 'ZodCyclicError' });
    }
    const asyncBad = transformCycle();
    remember(asyncBad, asyncBad.payload);
    await assert.rejects(TransformSchema.parseAsync(asyncBad), { name: 'ZodCyclicError' });
    const rejected = cycle('reject');
    remember(rejected);
    await assert.rejects(RejectSchema.parseAsync(rejected), /async rejection/);
  }
  await allocate();
  for (let i = 0; i < 8; i++) {
    await immediate();
    gc();
  }
  await immediate();
  assert.equal(refs.filter((ref) => ref.deref() !== undefined).length, 0);
  // Keep every schema alive through collection, without a replacement parse
  // that would hide retention of the previous parse by a one-entry cache.
  for (const schema of [NodeSchema, AsyncSchema, TransformSchema, RejectSchema]) {
    assert.equal(typeof schema.parse, 'function');
  }
  console.log('all parse references collected');
}
