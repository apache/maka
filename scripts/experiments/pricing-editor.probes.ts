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

it('ablation: a disposed view cannot dismiss the recovered draft on the same Host', async () => {
  const pending = deferred<DesktopPricingMutationOutcome>();
  const harness = await renderEditor({
    load: async () => SNAPSHOT,
    mutate: async () => pending.promise,
  });
  try {
    await click(buttonByLabel(harness.doc, copy.editAria('anthropic:claude')));
    await typeInput(inputByLabel(harness.doc, copy.inputLabel), '7.25');
    await clickWithoutSettling(buttonByText(harness.doc, copy.save));
    await harness.hideView();
    await harness.rerender(`${TEST_RUNTIME_HOST.profileId}:${TEST_RUNTIME_HOST.hostId}:e1`);
    assert.equal(inputByLabel(harness.doc, copy.inputLabel)?.value, '7.25');
    await act(async () =>
      pending.resolve({ kind: 'saved', disposition: 'committed', snapshot: SNAPSHOT }),
    );
    assert.ok(
      openDialog(harness.doc),
      'a disposed controller must not clear the scope-owned draft',
    );
    assert.equal(inputByLabel(harness.doc, copy.inputLabel)?.value, '7.25');
  } finally {
    await act(async () => harness.root.unmount());
  }
});

for (const staleFails of [false, true]) {
  it(`ablation: newer refresh wins when the older read ${staleFails ? 'fails' : 'succeeds'}`, async () => {
    const stale = deferred<DesktopPricingSnapshot>(),
      fresh = deferred<DesktopPricingSnapshot>();
    const latest: DesktopPricingSnapshot = {
      ...SNAPSHOT,
      revision: 9,
      entries: SNAPSHOT.entries.map((row) => ({
        ...row,
        pricing: { ...row.pricing, inputUsdPer1M: 987 },
      })),
    };
    let reads = 0;
    const harness = await renderEditor({
      load: async () => (++reads === 1 ? SNAPSHOT : reads === 2 ? stale.promise : fresh.promise),
    });
    try {
      const refresh = buttonByLabel(harness.doc, copy.refresh)!;
      // Two requests dispatched before React commits the loading indicator.
      await act(async () => {
        activateButton(refresh);
        activateButton(refresh);
      });
      assert.equal(harness.loadCalls(), 3);
      await act(async () => fresh.resolve(latest));
      await act(async () => {
        if (staleFails) stale.reject(new Error('stale read disconnected'));
        else stale.resolve(SNAPSHOT);
      });
      assert.ok(
        harness.container.textContent?.includes('$987'),
        'the newest authority must remain visible',
      );
      assert.doesNotMatch(harness.container.textContent ?? '', new RegExp(copy.loadFailedTitle));
      await click(buttonByLabel(harness.doc, copy.editAria('anthropic:claude')));
      assert.equal(inputByLabel(harness.doc, copy.inputLabel)?.value, '987');
    } finally {
      await act(async () => harness.root.unmount());
    }
  });
}
