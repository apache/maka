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

// Fixed experiment fragment, appended to its original test module by the loader.
// Helpers and types intentionally come from that pinned module.

for (const offsets of [[0], [1, 1], [1, 0], [2, 1]]) {
  test(`ablation: rejects non-progressing Pricing offsets ${offsets.join(' -> ')} before dispatch`, async () => {
    const responses = offsets.map((nextOffset, index) =>
      page(
        1,
        index === 0 ? 0 : offsets[index - 1]!,
        [builtin(`provider:model-${index}`, 1)],
        nextOffset,
      ),
    );
    const { client, requests } = clientWithResponses(responses);
    await assert.rejects(
      () => client.loadPricingSnapshot(),
      (error: unknown) =>
        error instanceof DesktopRuntimeHostClientError && error.code === 'pricing_unstable',
    );
    assert.equal(
      requests.length,
      offsets.length,
      'invalid continuation must not cross the connection',
    );
  });
}

test('ablation: assembles three strictly progressing Pricing pages', async () => {
  const entries = [builtin('provider:a', 1), builtin('provider:b', 2), builtin('provider:c', 3)];
  const { client, requests } = clientWithResponses([
    page(8, 0, [entries[0]!], 1),
    page(8, 1, [entries[1]!], 2),
    page(8, 2, [entries[2]!], null),
  ]);
  assert.deepEqual((await client.loadPricingSnapshot()).entries, entries);
  assert.equal(requests.length, 3);
});

test('ablation: rejects a duplicated key at a Pricing page seam', async () => {
  const { client } = clientWithResponses([
    page(1, 0, [builtin('provider:a', 1)], 1),
    page(1, 1, [builtin('provider:a', 2)], null),
  ]);
  await assert.rejects(
    () => client.loadPricingSnapshot(),
    (error: unknown) =>
      error instanceof DesktopRuntimeHostClientError && error.code === 'pricing_unstable',
  );
});

test('ablation: a missing row does not confirm restoration of bundled pricing', async () => {
  const { client, requests } = clientWithResponses([
    { kind: 'revision_conflict', expectedRevision: 1, actualRevision: 2 },
    page(2, 0, [], null),
  ]);
  const result = await client.applyPricingMutation({
    base: snapshot('host-current', 1, [custom('provider:reset', 2, 'restore_builtin')]),
    mutation: { kind: 'delete', modelKey: 'provider:reset' },
  });
  assert.equal(result.kind, 'review_required');
  assert.equal(requests.filter((request) => request.operation === 'pricing.mutate').length, 1);
});
