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

import { strict as assert } from 'node:assert';
import { afterEach, describe, it } from 'node:test';
import { parseHTML } from 'linkedom';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AstryxLocaleProvider, LocaleProvider, ToastProvider } from '@maka/ui';
import type {
  DesktopPricingMutationInput,
  DesktopPricingMutationOutcome,
  DesktopPricingSnapshot,
} from '../../shared/desktop-pricing.js';
import {
  getPricingSettingsCopy,
  PricingEditor,
  UsagePricingServicesProvider,
  formatCache,
  formatUsd,
  type UsageHostRef,
  type UsagePricingServices,
} from '../../renderer/features/usage/testing.js';

const copy = getPricingSettingsCopy('en');

const TEST_RUNTIME_HOST: UsageHostRef = { profileId: 'test-profile', hostId: 'test-host' };

const SNAPSHOT: DesktopPricingSnapshot = {
  hostEpoch: 'epoch-1',
  connectionId: 'conn-1',
  revision: 5,
  entries: [
    { source: 'builtin', pricing: { modelKey: 'openai:gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10 } },
    {
      source: 'custom',
      resetEffect: 'restore_builtin',
      pricing: { modelKey: 'anthropic:claude', inputUsdPer1M: 2, outputUsdPer1M: 12 },
    },
  ],
};

const originalGlobals = {
  document: globalThis.document,
  window: globalThis.window,
  matchMedia: globalThis.matchMedia,
  HTMLElement: globalThis.HTMLElement,
  HTMLIFrameElement: globalThis.HTMLIFrameElement,
  getComputedStyle: globalThis.getComputedStyle,
  requestAnimationFrame: globalThis.requestAnimationFrame,
  cancelAnimationFrame: globalThis.cancelAnimationFrame,
  CSS: (globalThis as { CSS?: unknown }).CSS,
  IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT,
};

afterEach(() => {
  Object.assign(globalThis, originalGlobals);
});

describe('PricingEditor', () => {
  it('renders only the user overrides; built-ins are catalog-only', async () => {
    const harness = await renderEditor({ load: async () => SNAPSHOT });
    // The custom override is listed with its 自定义 source label.
    assert.match(harness.container.textContent ?? '', /anthropic:claude/);
    assert.match(harness.container.textContent ?? '', new RegExp(copy.sourceCustomFallback));
    // The built-in is NOT rendered as a table row — it is reachable only through
    // the Add flow's catalog picker — nor does the 内置 source label appear.
    assert.doesNotMatch(harness.container.textContent ?? '', /openai:gpt-4o/);
    assert.doesNotMatch(harness.container.textContent ?? '', /Built-in/);
    assert.equal(harness.loadCalls(), 1);
    // The Pricing tab loads against the settings-SELECTED Host it was handed —
    // not the app's active Host (an omitted arg) — so it stays in lockstep with
    // the rest of the settings page.
    assert.deepEqual(harness.loadHosts, [TEST_RUNTIME_HOST]);
    await act(async () => harness.root.unmount());
  });

  it('the Add dialog offers a catalog picker with a manual-entry fallback', async () => {
    const harness = await renderEditor({ load: async () => SNAPSHOT });
    await click(buttonByText(harness.doc, copy.add));
    // Catalog mode is the default: no free-text model-key input, plus a toggle to
    // manual entry (inferred without depending on the Typeahead's internal DOM).
    assert.equal(
      inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder),
      undefined,
      'no free-text model-key input in catalog mode',
    );
    const toManual = buttonByText(harness.doc, copy.manualEntryToggle);
    assert.ok(toManual, 'manual-entry toggle present in catalog mode');
    // Switching to manual reveals one exact model-key input + a toggle
    // back to the catalog.
    await click(toManual);
    assert.ok(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder), 'manual model-key input');
    assert.ok(buttonByText(harness.doc, copy.catalogToggle), 'catalog toggle present in manual mode');
    await act(async () => harness.root.unmount());
  });

  it('selecting a built-in catalog model saves an override', async () => {
    const committed: DesktopPricingSnapshot = {
      ...SNAPSHOT,
      revision: 6,
      entries: [
        {
          source: 'custom',
          resetEffect: 'restore_builtin',
          pricing: {
            modelKey: 'openai:gpt-4o',
            inputUsdPer1M: 2.5,
            outputUsdPer1M: 10,
          },
        },
        SNAPSHOT.entries[1]!,
      ],
    };
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => ({ kind: 'saved', disposition: 'committed', snapshot: committed }),
    });
    await click(buttonByText(harness.doc, copy.add));
    await setInput(inputByPlaceholder(harness.doc, copy.catalogPickerPlaceholder), 'openai');
    const option = Array.from(harness.doc.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (item) => item.textContent?.includes('openai:gpt-4o'),
    );
    assert.ok(option, 'catalog search exposes the built-in model');
    await clickElement(option);
    await click(buttonByText(harness.doc, copy.save));

    assert.equal(harness.mutations.length, 1);
    assert.deepEqual(harness.mutations[0]?.mutation, {
      kind: 'upsert',
      pricing: {
        modelKey: 'openai:gpt-4o',
        inputUsdPer1M: 2.5,
        outputUsdPer1M: 10,
      },
    });
    await act(async () => harness.root.unmount());
  });

  it('switching entry modes clears values that would otherwise be hidden', async () => {
    const harness = await renderEditor({ load: async () => SNAPSHOT });
    await click(buttonByText(harness.doc, copy.add));
    await click(buttonByText(harness.doc, copy.manualEntryToggle));
    await setInput(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder), 'acme:hidden');
    const rateInputs = Array.from(harness.doc.querySelectorAll<HTMLInputElement>('input')).filter(
      (input) => !input.getAttribute('placeholder'),
    );
    await setInput(rateInputs[0], '1');
    await setInput(rateInputs[1], '2');
    await click(buttonByText(harness.doc, copy.catalogToggle));
    await click(buttonByText(harness.doc, copy.save));

    assert.match(harness.container.textContent ?? '', new RegExp(copy.errorRequired));
    assert.equal(harness.mutations.length, 0);
    await act(async () => harness.root.unmount());
  });

  it('does not load host-scoped pricing when no Host is selected', async () => {
    let loadInvoked = false;
    const harness = await renderEditor({
      host: null,
      load: async () => {
        loadInvoked = true;
        return SNAPSHOT;
      },
    });
    // No selected Host: the controller resolves an empty state instead of
    // reaching the bridge (which would otherwise fall back to the active Host).
    assert.equal(loadInvoked, false);
    assert.equal(harness.loadCalls(), 0);
    // Without a loaded snapshot there is no CAS base, so Add is disabled rather
    // than opening an editor whose save would silently no-op.
    assert.equal(buttonByText(harness.doc, copy.add)?.getAttribute('aria-disabled'), 'true');
    await act(async () => harness.root.unmount());
  });

  it('reset sends a delete against the loaded snapshot', async () => {
    const committed: DesktopPricingSnapshot = { ...SNAPSHOT, revision: 6, entries: [SNAPSHOT.entries[0]!] };
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => ({ kind: 'saved', disposition: 'committed', snapshot: committed }),
    });

    const resetButton = buttonByLabel(harness.doc, copy.resetAria('anthropic:claude'));
    assert.ok(resetButton, 'reset button is present for a custom-with-fallback row');
    await click(resetButton);

    const confirmButton = buttonByText(harness.doc, copy.confirmReset);
    assert.ok(confirmButton, 'confirm dialog exposes the reset action');
    await click(confirmButton);

    assert.equal(harness.mutations.length, 1);
    const mutation = harness.mutations[0]!;
    // The renderer carries the snapshot it loaded as the CAS base — same revision
    // and Host stamp — never a freshly reloaded latest.
    assert.deepEqual(mutation.base, SNAPSHOT);
    assert.deepEqual(mutation.mutation, { kind: 'delete', modelKey: 'anthropic:claude' });
    // The mutation targets the same settings-selected Host as the load.
    assert.deepEqual(harness.mutateHosts, [TEST_RUNTIME_HOST]);
    await act(async () => harness.root.unmount());
  });

  it('moves focus to Add after a successful reset removes its trigger row', async () => {
    const committed: DesktopPricingSnapshot = { ...SNAPSHOT, revision: 6, entries: [SNAPSHOT.entries[0]!] };
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => ({ kind: 'saved', disposition: 'committed', snapshot: committed }),
    });
    const resetButton = buttonByLabel(harness.doc, copy.resetAria('anthropic:claude'));
    const addButton = buttonByText(harness.doc, copy.add);
    assert.ok(resetButton);
    assert.ok(addButton);
    let focused: HTMLElement | null = null;
    resetButton.focus = () => { focused = resetButton; };
    addButton.focus = () => { focused = addButton; };

    await click(resetButton);
    await click(buttonByText(harness.doc, copy.confirmReset));
    await flushAnimationFrame();

    assert.equal(resetButton.isConnected, false, 'the reset trigger leaves with its override row');
    assert.equal(focused, addButton, 'focus falls back to the stable Add action');
    await act(async () => harness.root.unmount());
  });

  it('a saved-but-refresh-failed outcome disables further writes', async () => {
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => ({ kind: 'saved_refresh_failed', disposition: 'committed' }),
    });
    await click(buttonByLabel(harness.doc, copy.resetAria('anthropic:claude')));
    await click(buttonByText(harness.doc, copy.confirmReset));

    assert.match(harness.container.textContent ?? '', new RegExp(copy.refreshFailedTitle));
    // #2015: the committed-but-unrefreshed list is now stale — it must not be
    // shown as authoritative, so the previously-listed override is cleared until
    // a successful refresh.
    assert.doesNotMatch(
      harness.container.querySelector('table')?.textContent ?? '',
      /anthropic:claude/,
    );
    const addButton = buttonByText(harness.doc, copy.add);
    assert.ok(addButton);
    // A disabled control that carries its reason via tooltip stays focusable and
    // marks itself with aria-disabled rather than the native disabled attribute
    // (DESIGN.md §Fields), so the write-block reason stays discoverable.
    assert.equal(addButton.getAttribute('aria-disabled'), 'true');
    await act(async () => harness.root.unmount());
  });

  it('keeps a saved reset reachable from its dialog until pricing refreshes', async () => {
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => ({ kind: 'saved_refresh_failed', disposition: 'committed' }),
    });
    await click(buttonByLabel(harness.doc, copy.resetAria('anthropic:claude')));
    await click(buttonByText(harness.doc, copy.confirmReset));

    const dialog = openDialog(harness.doc);
    assert.ok(dialog, 'the pending reset stays reachable after refresh failure');
    assert.match(dialog.textContent ?? '', new RegExp(copy.refreshFailedTitle));
    assert.ok(buttonByText(dialog, copy.refresh), 'recovery is available inside the modal focus trap');
    assertButtonDisabled(buttonByText(dialog, copy.confirmReset));
    await act(async () => harness.root.unmount());
  });

  it('keeps an upsert draft reachable and refreshes from inside the editor', async () => {
    const committed: DesktopPricingSnapshot = {
      ...SNAPSHOT,
      revision: 6,
      entries: [
        ...SNAPSHOT.entries,
        {
          source: 'custom',
          resetEffect: 'become_unpriced',
          pricing: { modelKey: 'acme:draft', inputUsdPer1M: 1, outputUsdPer1M: 2 },
        },
      ],
    };
    let loadCall = 0;
    const harness = await renderEditor({
      load: async () => {
        loadCall += 1;
        return loadCall === 1 ? SNAPSHOT : committed;
      },
      mutate: async () => ({ kind: 'saved_refresh_failed', disposition: 'committed' }),
    });
    await click(buttonByText(harness.doc, copy.add));
    await click(buttonByText(harness.doc, copy.manualEntryToggle));
    await setInput(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder), 'acme:draft');
    const rateInputs = Array.from(harness.doc.querySelectorAll<HTMLInputElement>('input')).filter(
      (input) => !input.getAttribute('placeholder'),
    );
    await setInput(rateInputs[0], '1');
    await setInput(rateInputs[1], '2');
    await click(buttonByText(harness.doc, copy.save));

    const dialog = openDialog(harness.doc);
    assert.ok(dialog, 'the draft stays open after the committed refresh failure');
    assert.match(dialog.textContent ?? '', new RegExp(copy.refreshFailedTitle));
    assert.equal(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder)?.value, 'acme:draft');
    const refresh = buttonByText(dialog, copy.refresh);
    assert.ok(refresh, 'recovery is available inside the modal focus trap');
    await click(refresh);

    assert.equal(openDialog(harness.doc), undefined, 'a successful refresh completes the saved draft');
    assert.match(harness.container.textContent ?? '', /acme:draft/);
    assert.equal(harness.loadCalls(), 2);
    assert.equal(harness.mutations.length, 1, 'refresh never replays the upsert');
    await act(async () => harness.root.unmount());
  });

  it('a reset conflict keeps the dialog and confirms again against fresh authority', async () => {
    const latest: DesktopPricingSnapshot = { ...SNAPSHOT, revision: 9 };
    let calls = 0;
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'review_required', reason: 'revision_conflict', snapshot: latest }
          : { kind: 'saved', disposition: 'committed', snapshot: latest };
      },
    });
    await click(buttonByLabel(harness.doc, copy.resetAria('anthropic:claude')));
    await click(buttonByText(harness.doc, copy.confirmReset));

    // The conflict is surfaced inside the modal focus trap and the action label
    // changes before an explicit second confirm — the mutation is never replayed
    // blindly while the warning sits behind the dialog.
    const dialog = openDialog(harness.doc);
    assert.ok(dialog, 'reset dialog stays open on conflict');
    assert.match(dialog.textContent ?? '', new RegExp(copy.conflictTitle));
    const confirmAgain = buttonByText(dialog, copy.reviewReset);
    assert.ok(confirmAgain, 'the reset action calls out the required review');
    await click(confirmAgain);

    assert.equal(calls, 2);
    // The second attempt carries the fresh authority (revision 9) as its base.
    assert.equal(harness.mutations[1]?.base.revision, 9);
    await act(async () => harness.root.unmount());
  });

  it('an uncertain outcome blocks writes and explains the required recovery', async () => {
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => ({ kind: 'reconciliation_unavailable', reason: 'outcome_unknown' }),
    });
    await click(buttonByLabel(harness.doc, copy.resetAria('anthropic:claude')));
    await click(buttonByText(harness.doc, copy.confirmReset));

    assert.match(harness.container.textContent ?? '', new RegExp(copy.reconcileTitle));
    assert.equal(buttonByText(harness.doc, copy.add)?.getAttribute('aria-disabled'), 'true');
    await act(async () => harness.root.unmount());
  });

  it('reconciles an unavailable reset against the next authoritative refresh', async () => {
    const latest: DesktopPricingSnapshot = {
      ...SNAPSHOT,
      revision: 6,
      entries: [
        SNAPSHOT.entries[0]!,
        {
          source: 'custom',
          resetEffect: 'restore_builtin',
          pricing: {
            modelKey: 'anthropic:claude',
            inputUsdPer1M: 7,
            outputUsdPer1M: 8,
            cacheReadUsdPer1M: 0,
            cacheWriteUsdPer1M: 0.4,
          },
        },
      ],
    };
    let loadCall = 0;
    const harness = await renderEditor({
      load: async () => {
        loadCall += 1;
        return loadCall === 1 ? SNAPSHOT : latest;
      },
      mutate: async () => ({ kind: 'reconciliation_unavailable', reason: 'outcome_unknown' }),
    });
    await click(buttonByLabel(harness.doc, copy.resetAria('anthropic:claude')));
    await click(buttonByText(harness.doc, copy.confirmReset));
    assert.match(harness.container.textContent ?? '', new RegExp(copy.reconcileTitle));

    const dialog = openDialog(harness.doc);
    assert.ok(dialog, 'the unreconciled draft stays open');
    await click(buttonByText(dialog, copy.refresh));

    const text = harness.container.textContent ?? '';
    assert.match(text, new RegExp(copy.conflictTitleUnknown));
    assert.match(text, new RegExp(copy.sourceCustomFallback));
    for (const value of ['$7', '$8', '$0', '$0.4']) assert.ok(text.includes(value));
    assert.equal(harness.mutations.length, 1, 'refresh reconciles without replaying the reset');
    await act(async () => harness.root.unmount());
  });

  it('finishes an unavailable upsert when the refreshed authority matches exactly', async () => {
    const committed: DesktopPricingSnapshot = {
      ...SNAPSHOT,
      revision: 6,
      entries: [
        {
          source: 'custom',
          resetEffect: 'restore_builtin',
          pricing: {
            modelKey: 'openai:gpt-4o',
            inputUsdPer1M: 2.5,
            outputUsdPer1M: 10,
          },
        },
        SNAPSHOT.entries[1]!,
      ],
    };
    let loadCall = 0;
    const harness = await renderEditor({
      load: async () => {
        loadCall += 1;
        return loadCall === 1 ? SNAPSHOT : committed;
      },
      mutate: async () => ({ kind: 'reconciliation_unavailable', reason: 'outcome_unknown' }),
    });
    await selectCatalogModel(harness.doc, 'openai:gpt-4o');
    await click(buttonByText(harness.doc, copy.save));
    const dialog = openDialog(harness.doc);
    assert.ok(dialog, 'the unreconciled draft stays open');
    await click(buttonByText(dialog, copy.refresh));

    assert.equal(openDialog(harness.doc), undefined, 'the matched draft is complete');
    assert.equal(harness.mutations.length, 1, 'reconciliation never replays the upsert');
    await act(async () => harness.root.unmount());
  });

  it('does not mistake equal built-in rates for a reconciled custom override', async () => {
    let loadCall = 0;
    const harness = await renderEditor({
      load: async () => {
        loadCall += 1;
        return SNAPSHOT;
      },
      mutate: async () => ({ kind: 'reconciliation_unavailable', reason: 'outcome_unknown' }),
    });
    await selectCatalogModel(harness.doc, 'openai:gpt-4o');
    await click(buttonByText(harness.doc, copy.save));
    await click(buttonByLabel(harness.doc, copy.refresh));

    assert.match(harness.container.textContent ?? '', new RegExp(copy.conflictTitleUnknown));
    assert.ok(openDialog(harness.doc), 'the draft remains open for explicit review');
    assert.equal(harness.mutations.length, 1);
    await act(async () => harness.root.unmount());
  });

  it('associates required-field errors with their controls after an empty save', async () => {
    const harness = await renderEditor({ load: async () => SNAPSHOT });
    // Open the Add editor and submit it empty.
    await click(buttonByText(harness.doc, copy.add));
    await click(buttonByText(harness.doc, copy.save));

    // The required-field message renders, and at least one control is marked
    // invalid — the DS wires aria-invalid + aria-describedby to the message, so
    // the error is announced against its own field rather than floating free.
    assert.match(harness.container.textContent ?? '', new RegExp(copy.errorRequired));
    const invalid = harness.doc.querySelector('[aria-invalid="true"]');
    assert.ok(invalid, 'an empty required field is marked aria-invalid');
    assert.ok(
      invalid?.getAttribute('aria-describedby'),
      'the invalid field points at its error message via aria-describedby',
    );

    // No mutation is attempted while the draft is invalid.
    assert.equal(harness.mutations.length, 0);
    await act(async () => harness.root.unmount());
  });

  it('a Host generation change preserves the draft and requires review after reloading authority (P1.1)', async () => {
    const nextSnapshot: DesktopPricingSnapshot = { ...SNAPSHOT, hostEpoch: 'epoch-2', revision: 1 };
    let loadCall = 0;
    const harness = await renderEditor({
      load: async () => {
        loadCall += 1;
        return loadCall === 1 ? SNAPSHOT : nextSnapshot;
      },
      mutate: async () => ({ kind: 'saved', disposition: 'committed', snapshot: nextSnapshot }),
    });
    await click(buttonByText(harness.doc, copy.add));
    await click(buttonByText(harness.doc, copy.manualEntryToggle));
    await setInput(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder), 'acme:new');
    const rateInputs = Array.from(harness.doc.querySelectorAll<HTMLInputElement>('input')).filter(
      (input) => !input.getAttribute('placeholder'),
    );
    await setInput(rateInputs[0], '1');
    await setInput(rateInputs[1], '2');
    // A Host generation bump (new epoch) re-renders with a new generationKey.
    await harness.rerender(`${TEST_RUNTIME_HOST.profileId}:${TEST_RUNTIME_HOST.hostId}:e2`);
    // The draft remains visible, but the old mutation base is discarded. Even
    // after the fresh snapshot loads, save stays disabled until explicit review.
    assert.equal(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder)?.value, 'acme:new');
    assert.equal(harness.loadCalls(), 2, 'a fresh authority reload ran');
    assert.match(harness.container.textContent ?? '', new RegExp(copy.hostChangedTitle));
    assertButtonDisabled(buttonByText(harness.doc, copy.save));
    await click(buttonByText(harness.doc, copy.reviewHostChange));
    assertButtonEnabled(buttonByText(harness.doc, copy.save));
    await click(buttonByText(harness.doc, copy.save));
    assert.equal(harness.mutations.length, 1);
    assert.deepEqual(harness.mutations[0]?.base, nextSnapshot);
    await act(async () => harness.root.unmount());
  });

  it('does not allow Host-change review until fresh authority loads', async () => {
    const secondLoad = deferred<DesktopPricingSnapshot>();
    let loadCall = 0;
    const harness = await renderEditor({
      load: async () => {
        loadCall += 1;
        return loadCall === 1 ? SNAPSHOT : secondLoad.promise;
      },
    });
    await click(buttonByText(harness.doc, copy.add));
    await click(buttonByText(harness.doc, copy.manualEntryToggle));
    await setInput(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder), 'acme:new');
    await harness.rerender(`${TEST_RUNTIME_HOST.profileId}:${TEST_RUNTIME_HOST.hostId}:e2`);

    assert.match(
      harness.container.querySelector('table')?.getAttribute('aria-label') ?? '',
      new RegExp(copy.loading),
      'the replacement authority renders as loading immediately',
    );
    assertButtonDisabled(buttonByText(harness.doc, copy.reviewHostChange));
    assertButtonDisabled(buttonByText(harness.doc, copy.save));
    await act(async () => {
      secondLoad.resolve({ ...SNAPSHOT, hostEpoch: 'epoch-2', revision: 1 });
      await Promise.resolve();
      await Promise.resolve();
    });
    assertButtonEnabled(buttonByText(harness.doc, copy.reviewHostChange));
    assertButtonDisabled(buttonByText(harness.doc, copy.save));
    await act(async () => harness.root.unmount());
  });

  it('ignores an old-Host save result after the generation changes', async () => {
    const pendingSave = deferred<DesktopPricingMutationOutcome>();
    let loadCall = 0;
    const harness = await renderEditor({
      load: async () => {
        loadCall += 1;
        return loadCall === 1
          ? SNAPSHOT
          : { ...SNAPSHOT, hostEpoch: 'epoch-2', revision: 1 };
      },
      mutate: async () => pendingSave.promise,
    });
    await click(buttonByLabel(harness.doc, copy.editAria('anthropic:claude')));
    const rateInputs = Array.from(harness.doc.querySelectorAll<HTMLInputElement>('input')).filter(
      (input) => !input.getAttribute('placeholder'),
    );
    await setInput(rateInputs[0], '3');
    await click(buttonByText(harness.doc, copy.save));
    await harness.rerender(`${TEST_RUNTIME_HOST.profileId}:${TEST_RUNTIME_HOST.hostId}:e2`);
    await act(async () => {
      pendingSave.resolve({
        kind: 'saved',
        disposition: 'committed',
        snapshot: { ...SNAPSHOT, revision: 6 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.match(harness.container.textContent ?? '', new RegExp(copy.hostChangedTitle));
    assert.equal(buttonByText(harness.doc, copy.save)?.textContent, copy.save);
    assertButtonDisabled(buttonByText(harness.doc, copy.save));
    await act(async () => harness.root.unmount());
  });

  it('ignores an old-Host save result when the Host event fences it before React re-renders', async () => {
    const pendingSave = deferred<DesktopPricingMutationOutcome>();
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => pendingSave.promise,
    });
    await click(buttonByLabel(harness.doc, copy.editAria('anthropic:claude')));
    await clickWithoutSettling(buttonByText(harness.doc, copy.save));
    assert.equal(harness.mutations.length, 1, 'the save is in flight before the Host fence');
    assert.ok(buttonByText(harness.doc, copy.cancel), 'the edit dialog starts open');

    // The settings Host event arrives before React can commit the replacement
    // generation. Its synchronous fence must already make the in-flight result
    // stale; otherwise this old Host can close the draft and claim success.
    harness.fenceTarget();
    await act(async () => {
      pendingSave.resolve({
        kind: 'saved',
        disposition: 'committed',
        snapshot: { ...SNAPSHOT, revision: 6 },
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    assert.ok(buttonByText(harness.doc, copy.cancel), 'the old-Host result must not close the preserved draft');
    await act(async () => harness.root.unmount());
  });

  it('a reload landing after a mutation does not overwrite the committed authority (P1.2)', async () => {
    // The reset commits a claude-less authority; a refresh started earlier is
    // still in flight and will resolve with the PRE-reset snapshot.
    const committed: DesktopPricingSnapshot = { ...SNAPSHOT, revision: 6, entries: [SNAPSHOT.entries[0]!] };
    const secondLoad = deferred<DesktopPricingSnapshot>();
    let loadCall = 0;
    const harness = await renderEditor({
      load: async () => {
        loadCall += 1;
        return loadCall === 1 ? SNAPSHOT : secondLoad.promise;
      },
      mutate: async () => ({ kind: 'saved', disposition: 'committed', snapshot: committed }),
    });
    // Kick off a manual refresh (reload #2) that stays pending.
    await click(buttonByLabel(harness.doc, copy.refresh));
    // Reset the override; the mutation commits the fresh (claude-less) authority.
    await click(buttonByLabel(harness.doc, copy.resetAria('anthropic:claude')));
    await click(buttonByText(harness.doc, copy.confirmReset));
    assert.doesNotMatch(harness.container.textContent ?? '', /anthropic:claude/, 'committed authority shown');
    // The stale in-flight refresh resolves with the pre-reset snapshot — it must
    // be fenced, not resurrect the deleted override.
    await act(async () => {
      secondLoad.resolve(SNAPSHOT);
      await Promise.resolve();
      await Promise.resolve();
    });
    assert.doesNotMatch(
      harness.container.textContent ?? '',
      /anthropic:claude/,
      'a stale reload must not overwrite the committed authority',
    );
    await act(async () => harness.root.unmount());
  });

  it('an Add conflict whose key now exists converts to Edit so the second save upserts (P1.3)', async () => {
    const conflictLatest: DesktopPricingSnapshot = {
      ...SNAPSHOT,
      revision: 7,
      entries: [
        ...SNAPSHOT.entries,
        {
          source: 'custom',
          resetEffect: 'become_unpriced',
          pricing: { modelKey: 'acme:new', inputUsdPer1M: 9, outputUsdPer1M: 9 },
        },
      ],
    };
    let calls = 0;
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => {
        calls += 1;
        return calls === 1
          ? { kind: 'review_required', reason: 'revision_conflict', snapshot: conflictLatest }
          : { kind: 'saved', disposition: 'committed', snapshot: conflictLatest };
      },
    });
    // Add a brand-new key via the manual fallback.
    await click(buttonByText(harness.doc, copy.add));
    await click(buttonByText(harness.doc, copy.manualEntryToggle));
    await setInput(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder), 'acme:new');
    // Fill the two required rate NumberInputs (the placeholder-less inputs).
    const rateInputs = Array.from(harness.doc.querySelectorAll<HTMLInputElement>('input')).filter(
      (input) => !input.getAttribute('placeholder'),
    );
    await setInput(rateInputs[0], '1');
    await setInput(rateInputs[1], '2');
    // First save → conflict: the same key was added elsewhere.
    await click(buttonByText(harness.doc, copy.save));
    assert.match(harness.container.textContent ?? '', new RegExp(copy.conflictTitle));
    // The Add converted to an Edit locked on the key, so the explicit second save
    // upserts (not silently blocked by the duplicate check).
    await click(buttonByText(harness.doc, copy.reviewSave));
    assert.equal(calls, 2, 'the second save was allowed');
    assert.equal(harness.mutations.length, 2);
    assert.equal(harness.mutations[0]!.mutation.kind, 'upsert');
    assert.deepEqual(harness.mutations[1]!.base, conflictLatest);
    const second = harness.mutations[1]!.mutation as { kind: 'upsert'; pricing: { modelKey: string } };
    assert.equal(second.pricing.modelKey, 'acme:new');
    await act(async () => harness.root.unmount());
  });

  it('adding a built-in key that is not yet overridden is a new override, not a duplicate', async () => {
    const committed: DesktopPricingSnapshot = {
      ...SNAPSHOT,
      revision: 6,
      entries: [
        ...SNAPSHOT.entries,
        {
          source: 'custom',
          resetEffect: 'restore_builtin',
          pricing: { modelKey: 'openai:gpt-4o', inputUsdPer1M: 5, outputUsdPer1M: 15 },
        },
      ],
    };
    const harness = await renderEditor({
      load: async () => SNAPSHOT,
      mutate: async () => ({ kind: 'saved', disposition: 'committed', snapshot: committed }),
    });
    // Enter a key that exists as a BUILT-IN (openai:gpt-4o, catalog-only) but is
    // not yet overridden. Overriding it is an upsert, not a duplicate — the
    // catalog picker offers exactly these built-ins, so this must save (a full
    // built-in ∪ overrides union check would wrongly block it).
    await click(buttonByText(harness.doc, copy.add));
    await click(buttonByText(harness.doc, copy.manualEntryToggle));
    await setInput(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder), 'openai:gpt-4o');
    const rateInputs = Array.from(harness.doc.querySelectorAll<HTMLInputElement>('input')).filter(
      (input) => !input.getAttribute('placeholder'),
    );
    await setInput(rateInputs[0], '5');
    await setInput(rateInputs[1], '15');
    await click(buttonByText(harness.doc, copy.save));

    assert.doesNotMatch(harness.container.textContent ?? '', new RegExp(copy.errorDuplicate));
    assert.equal(harness.mutations.length, 1);
    const mutation = harness.mutations[0]!.mutation as { kind: 'upsert'; pricing: { modelKey: string } };
    assert.equal(mutation.kind, 'upsert');
    assert.equal(mutation.pricing.modelKey, 'openai:gpt-4o');
    await act(async () => harness.root.unmount());
  });

  it('rejects a key that already has a custom override as a duplicate', async () => {
    const harness = await renderEditor({ load: async () => SNAPSHOT });
    await click(buttonByText(harness.doc, copy.add));
    await click(buttonByText(harness.doc, copy.manualEntryToggle));
    // 'anthropic:claude' already has a custom override row — re-adding it is a
    // duplicate; the user is told to edit the existing row instead.
    await setInput(inputByPlaceholder(harness.doc, copy.modelKeyPlaceholder), 'anthropic:claude');
    const rateInputs = Array.from(harness.doc.querySelectorAll<HTMLInputElement>('input')).filter(
      (input) => !input.getAttribute('placeholder'),
    );
    await setInput(rateInputs[0], '1');
    await setInput(rateInputs[1], '2');
    await click(buttonByText(harness.doc, copy.save));

    assert.match(harness.container.textContent ?? '', new RegExp(copy.errorDuplicate));
    assert.equal(harness.mutations.length, 0);
    await act(async () => harness.root.unmount());
  });
});

describe('pricing display formatting', () => {
  const copy = getPricingSettingsCopy('en');

  it('round-trips positive rates without collapsing to $0 or losing precision', () => {
    assert.equal(formatUsd(2.5), '$2.5');
    assert.equal(formatUsd(10), '$10');
    // A small positive rate keeps its digits — never rounded to `$0`.
    assert.equal(formatUsd(0.075), '$0.075');
    assert.equal(formatUsd(1.23456789), '$1.23456789');
    // An explicit zero rate (e.g. a free local model) is a real `$0`.
    assert.equal(formatUsd(0), '$0');
  });

  it('keeps an omitted cache rate distinct from an explicit zero', () => {
    assert.equal(formatCache(undefined, copy), copy.cacheNotSet);
    assert.equal(formatCache(0, copy), '$0');
    assert.equal(formatCache(0.3, copy), '$0.3');
  });
});

async function renderEditor(options: {
  load: () => Promise<DesktopPricingSnapshot>;
  mutate?: (
    base: DesktopPricingSnapshot,
    mutation: DesktopPricingMutationInput['mutation'],
  ) => Promise<DesktopPricingMutationOutcome>;
  // Omitted → the default selected Host; `null` → no Host selected.
  host?: UsageHostRef | null;
}) {
  const { document, window } = parseHTML('<div id="root"></div>');
  const matchMedia = (media: string) => ({
    matches: false,
    media,
    onchange: null,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
  });
  Object.assign(window, { matchMedia, scrollTo: () => {} });
  Object.assign(globalThis, {
    document,
    window,
    matchMedia,
    HTMLElement: window.HTMLElement,
    HTMLIFrameElement: window.HTMLIFrameElement ?? class HTMLIFrameElement {},
    getComputedStyle: (element: Element) => ({
      color: (element as HTMLElement).style?.color || 'currentColor',
    }) as CSSStyleDeclaration,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
    cancelAnimationFrame: (handle: number) => clearTimeout(handle),
    // Astryx Dialog probes `CSS.supports` during layout; linkedom has no CSS.
    CSS: { supports: () => false, escape: (value: string) => value },
    IS_REACT_ACT_ENVIRONMENT: true,
  });

  const runtimeHost = options.host === null ? undefined : options.host ?? TEST_RUNTIME_HOST;
  let loadCalls = 0;
  const loadHosts: UsageHostRef[] = [];
  const mutateHosts: UsageHostRef[] = [];
  const mutations: DesktopPricingMutationInput[] = [];
  // Host resolution lives in the preload/adapter for the *selected* Host, threaded
  // to the feature as a prop — so the feature-facing services take the Host as
  // their first argument (they never resolve it themselves).
  const services: UsagePricingServices = {
    loadPricing: async (host) => {
      loadHosts.push(host);
      loadCalls += 1;
      return options.load();
    },
    mutatePricing: async (host, base, mutation) => {
      mutateHosts.push(host);
      mutations.push({ base, mutation });
      return (
        options.mutate?.(base, mutation) ??
        Promise.reject(new Error('mutate is not used by this test'))
      );
    },
  };

  const container = document.querySelector<HTMLElement>('#root');
  assert.ok(container);
  // linkedom's <dialog> has no showModal/close; Astryx Dialog/AlertDialog call
  // them on mount. Patch the element prototype so modal dialogs can render.
  const dialogProto = Object.getPrototypeOf(document.createElement('dialog')) as {
    showModal?: () => void;
    close?: () => void;
  };
  dialogProto.showModal = function showModal(this: { open?: boolean }) {
    this.open = true;
  };
  dialogProto.close = function close(this: { open?: boolean }) {
    this.open = false;
  };
  const root = createRoot(container);
  const defaultGenerationKey = runtimeHost
    ? `${runtimeHost.profileId}:${runtimeHost.hostId}:e1`
    : 'no-host';
  let currentGenerationKey: string | null = defaultGenerationKey;
  function renderTree(generationKey: string): void {
    currentGenerationKey = generationKey;
    const editor = createElement(PricingEditor, {
      describeError: (error: unknown) => (error instanceof Error ? error.message : String(error)),
      target: runtimeHost
        ? {
            host: runtimeHost,
            generationKey,
            isCurrent: () => currentGenerationKey === generationKey,
          }
        : null,
    });
    const provided = createElement(UsagePricingServicesProvider, { services, children: editor });
    const toasted = createElement(ToastProvider, { children: provided });
    const localized = createElement(AstryxLocaleProvider, { children: toasted });
    root.render(createElement(LocaleProvider, { locale: 'en', children: localized }));
  }
  await act(async () => {
    renderTree(defaultGenerationKey);
    await Promise.resolve();
    await Promise.resolve();
  });
  async function rerender(generationKey: string): Promise<void> {
    await act(async () => {
      renderTree(generationKey);
      await Promise.resolve();
      await Promise.resolve();
    });
  }
  return {
    doc: document as unknown as Document,
    container,
    root: root as Root,
    rerender,
    fenceTarget: () => {
      currentGenerationKey = null;
    },
    loadCalls: () => loadCalls,
    loadHosts,
    mutateHosts,
    mutations,
  };
}

async function click(button: HTMLButtonElement | undefined) {
  assert.ok(button, 'expected a clickable button');
  await act(async () => {
    button.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function clickWithoutSettling(button: HTMLButtonElement | undefined) {
  assert.ok(button, 'expected a clickable button');
  await act(async () => {
    button.click();
    await Promise.resolve();
  });
}

async function clickElement(element: HTMLElement | undefined) {
  assert.ok(element, 'expected a clickable element');
  await act(async () => {
    element.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushAnimationFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function selectCatalogModel(doc: Document, modelKey: string): Promise<void> {
  await click(buttonByText(doc, copy.add));
  await setInput(inputByPlaceholder(doc, copy.catalogPickerPlaceholder), modelKey);
  const option = Array.from(doc.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (item) => item.textContent?.includes(modelKey),
  );
  await clickElement(option);
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function inputByPlaceholder(doc: Document, placeholder: string): HTMLInputElement | undefined {
  return doc.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`) ?? undefined;
}

function reactProps(input: HTMLInputElement): {
  onChange?: (event: { target: HTMLInputElement; defaultPrevented: boolean }) => void;
  onBlur?: (event: { target: HTMLInputElement }) => void;
} {
  const propsKey = Object.keys(input).find((key) => key.startsWith('__reactProps$'));
  assert.ok(propsKey, 'missing React props on the input');
  return (input as unknown as Record<string, unknown>)[propsKey] as ReturnType<typeof reactProps>;
}

/** Set a controlled input's value and commit it. TextInput commits on change;
 *  NumberInput stages the text and only commits on blur — so fire both, with a
 *  render flush between so the blur handler sees the staged value. */
async function setInput(input: HTMLInputElement | undefined, value: string): Promise<void> {
  assert.ok(input, 'expected an input to fill');
  await act(async () => {
    input.value = value;
    reactProps(input).onChange?.({ target: input, defaultPrevented: false });
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    reactProps(input).onBlur?.({ target: input });
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement | undefined {
  return Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(
    (button) => (button.textContent ?? '').trim() === text,
  );
}

function buttonByLabel(doc: Document, label: string): HTMLButtonElement | undefined {
  return (
    doc.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`) ?? undefined
  );
}

function openDialog(doc: Document): HTMLDialogElement | undefined {
  return Array.from(doc.querySelectorAll<HTMLDialogElement>('dialog')).find((dialog) => dialog.open);
}

function assertButtonDisabled(button: HTMLButtonElement | undefined): void {
  assert.ok(button, 'expected button');
  assert.ok(button.disabled || button.getAttribute('aria-disabled') === 'true');
}

function assertButtonEnabled(button: HTMLButtonElement | undefined): void {
  assert.ok(button, 'expected button');
  assert.equal(button.disabled, false);
  assert.notEqual(button.getAttribute('aria-disabled'), 'true');
}
