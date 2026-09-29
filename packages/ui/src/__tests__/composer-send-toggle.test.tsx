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

/** The send slot is a single Send/Stop control; queue actions live above it. */

import { strict as assert } from 'node:assert';
import { test as verify } from 'node:test';
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseHTML as parseMarkup } from 'linkedom';
import type { SessionSummary } from '@maka/core/session';
import { Composer } from '../composer.js';
import { deriveComposerSendPolicy, hasComposerStagedContext } from '../composer-send-policy.js';
import { LocaleProvider } from '../locale-context.js';
import { mountComposer } from './composer-test-harness.js';

const noop = () => undefined;

function renderComposer(streaming: boolean): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer streaming={streaming} onSend={noop} onStop={noop} />
    </LocaleProvider>,
  );
}

const sendSlotControls = (markup: string): string[] => {
  const document = parseMarkup(`<html><body>${markup}</body></html>`).document;
  return [...document.querySelectorAll('button[aria-label="Send"], button[aria-label="Stop"]')]
    .map((button) => button.getAttribute('aria-label'))
    .filter((label): label is string => label !== null);
};

const assertOnlySendSlot = (streaming: boolean, label: 'Send' | 'Stop') =>
  assert.deepEqual(sendSlotControls(renderComposer(streaming)), [label]);

/** The Send control's own `aria-disabled` value — asserted directly, not by a
 * substring that could also hit `data-disabled` or other future attributes. */
function sendButtonAriaDisabled(markup: string): string | null {
  const document = parseMarkup(`<html><body>${markup}</body></html>`).document;
  const button = document.querySelector('button[aria-label="Send"]');
  assert.ok(button, 'the send slot renders Send');
  return button.getAttribute('aria-disabled');
}

verify('the send policy treats staged context as sendable content across all gates', () => {
  const staged = hasComposerStagedContext({ pendingQuotes: [{}] });
  assert.deepEqual(
    deriveComposerSendPolicy({
      text: '',
      hasStagedContext: staged,
      executorModelPending: false,
      sendPending: false,
      importActionBusy: false,
      noModelConnection: false,
      streaming: true,
    }),
    { hasSendableContent: true, sendDisabled: false, stopShown: false },
  );
});

verify('an idle composer offers Send alone', () => {
  assertOnlySendSlot(false, 'Send');
});

verify('a host-owned send gate disables Send without an inline notice', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer
        sendBlocked
        sendBlockedReason="Choose a model before sending."
        onSend={() => undefined}
        onStop={() => undefined}
      />
    </LocaleProvider>,
  );
  assert.equal(sendButtonAriaDisabled(markup), 'true');
  assert.doesNotMatch(markup, /maka-composer-no-model-hint/);
});

verify('a turn in flight turns the same single control into Stop', () => {
  assertOnlySendSlot(true, 'Stop');
});

verify('a running composer adds no queue mode switch beside Stop', () => {
  const markup = [true].map(renderComposer)[0]!;
  assert.deepEqual(
    { controls: sendSlotControls(markup), queueModeCopy: /Follow-up behavior|SegmentedControl/.test(markup) },
    { controls: ['Stop'], queueModeCopy: false },
  );
});

verify('a pending Session boundary keeps the access control mounted and disabled', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer
        activeSession={{
          id: 'session-pending-boundary',
          llmConnectionSlug: '',
          model: '',
          permissionMode: 'ask',
        } as SessionSummary}
        permissionMode="ask"
        permissionModeDisabledReason="Loading the Session access boundary."
        onPermissionModeChange={() => undefined}
        onSend={() => undefined}
        onStop={() => undefined}
      />
    </LocaleProvider>,
  );
  assert.match(markup, /class="permissionModeIcon"/);
  assert.match(markup, /aria-label="Permission mode: Auto"[^>]*aria-disabled="true"/);
});

// Pins the #5003 opt-in contract, not a #4815 regression: base already passed
// this exact assertion (reviewed at the #4815 head). What #4815 adds on top —
// staged quotes counting as sendable content without the flag — is covered by
// the staged-quote cases in this file.
verify('an opted-in host renders Send (not Stop) for an attachment-only draft (#5003)', () => {
  const attachments = [{ displayName: 'kept.png', kind: 'image' as const, size: 12 }];
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer
        allowAttachmentOnlySend
        pendingAttachments={attachments}
        onSend={() => undefined}
        onStop={() => undefined}
      />
    </LocaleProvider>,
  );
  assert.match(markup, /aria-label="Send"/);
  assert.equal(sendButtonAriaDisabled(markup), null);
  // Without the Host opt-in the same staged attachment keeps Send disabled:
  // attachment-only sends stay a per-host decision, not a composer default.
  const optedOut = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer
        pendingAttachments={attachments}
        onSend={() => undefined}
        onStop={() => undefined}
      />
    </LocaleProvider>,
  );
  assert.equal(sendButtonAriaDisabled(optedOut), 'true');
});

verify('a staged quote enables Send without any host opt-in (#4804)', () => {
  const quotes = [
    { text: 'the deploy failed at step three', label: 'Assistant', sourceTurnId: 'turn-9' },
  ];
  const staged = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer pendingQuotes={quotes} onSend={() => undefined} onStop={() => undefined} />
    </LocaleProvider>,
  );
  // The toggle and the disabled state agree: a quote-only draft is a live
  // Send, and it needs no per-host decision the way attachments do.
  assert.deepEqual(sendSlotControls(staged), ['Send']);
  assert.equal(sendButtonAriaDisabled(staged), null);
  // The same empty draft with nothing staged is what disabled looks like, so
  // the assertion above pins the staged quote as the enabling reason.
  assert.equal(sendButtonAriaDisabled(renderComposer(false)), 'true');
});

verify('the three send gates agree about a staged quote while streaming (#4804)', async () => {
  const sends: string[] = [];
  const harness = await mountComposer({
    streaming: true,
    pendingQuotes: [{ text: 'the excerpt', sourceTurnId: 'turn-9' }],
    onSend(text) {
      sends.push(text);
    },
    onStop() {},
  });
  try {
    // Gate 1 — the send/stop toggle: mid-turn the slot stays on Send because
    // the staged quote is handable content, not an empty draft.
    assert.deepEqual(sendSlotControls(harness.container.innerHTML), ['Send']);
    const button = harness.container.querySelector('button[aria-label="Send"]');
    assert.ok(button);
    // Gate 2 — sendDisabled: the control is live.
    assert.equal(button.getAttribute('aria-disabled'), null);
    // Gate 3 — sendCurrent's content guard: submitting hands the empty draft
    // text over, the quote travelling as the message's structured content.
    // The control is type="submit", so its activation is the form's submit.
    await harness.submit();
    assert.deepEqual(sends, ['']);
  } finally {
    await harness.unmount();
  }
});

verify('the actual submit waits for Session references and keeps the draft on refusal', async () => {
  const sends: string[] = [];
  let release!: (ready: boolean) => void;
  const harness = await mountComposer({
    pendingSessionReferences: [{ id: 'source', name: 'Research' }],
    waitForSessionReference: () => new Promise((resolve) => { release = resolve; }),
    onSend(text) {
      sends.push(text);
    },
    onStop() {},
  });
  try {
    for (const ready of [false, true]) {
      await harness.submit();
      assert.deepEqual(sends, [], 'no send may precede snapshot resolution');
      await act(async () => { release(ready); await Promise.resolve(); });
      assert.deepEqual(sends, ready ? [''] : []);
    }
  } finally {
    await harness.unmount();
  }
});

verify('deduplicates pending steering against Host queue entries and keeps the plate through an empty queue snapshot', () => {
  const pending = {
    id: 'steer',
    text: 'new direction',
    ts: 1,
    transientPlacement: 'follow_up' as const,
  };
  const queued = {
    entryId: 'host-entry',
    messageId: pending.id,
    placement: 'current_turn' as const,
    state: 'queued' as const,
    content: { text: pending.text },
  };
  for (const entries of [[queued], []]) {
    const markup = renderToStaticMarkup(
      <LocaleProvider locale="en">
        <Composer
          onSend={() => undefined}
          onStop={() => undefined}
          queuedMessages={entries}
          pendingMessages={[pending]}
        />
      </LocaleProvider>,
    );
    const document = parseMarkup(`<html><body>${markup}</body></html>`).document;
    assert.equal(document.querySelectorAll('.maka-composer-queue-text').length, 1);
    assert.equal(document.querySelector('.maka-composer-queue-text')?.textContent, pending.text);
    assert.equal(document.querySelector('.maka-composer-queue-status')?.textContent, 'queued');
  }
});
verify('a locally saved follow-up keeps its delivery status and recovery actions in the pending list', () => {
  const markup = renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer
        onSend={() => undefined}
        onStop={() => undefined}
        pendingMessages={[
          {
            id: 'local',
            text: 'offline follow-up',
            ts: 1,
            transientPlacement: 'follow_up',
            deliveryStatus: 'Delivery uncertain',
            deliveryDetail: 'Connection interrupted',
            deliveryActions: [
              { label: 'Check delivery', icon: <span aria-hidden="true" />, onClick() {} },
            ],
          },
        ]}
      />
    </LocaleProvider>,
  );
  const document = parseMarkup(`<html><body>${markup}</body></html>`).document;
  assert.equal(document.querySelector('.maka-composer-queue-delivery')?.textContent, 'Delivery uncertain');
  assert.ok(document.querySelector('.maka-composer-queue-actions button[aria-label="Check delivery"]'));
});

verify('Composer forwards the compatibility edit action to Host-owned queue rows', () => {
  const queued = {
    entryId: 'host-entry',
    messageId: 'host-message',
    placement: 'next_turn' as const,
    state: 'queued' as const,
    content: { text: 'editable follow-up' },
  };
  const markup = renderToStaticMarkup(<LocaleProvider locale="en"><Composer
    onSend={() => undefined}
    onStop={() => undefined}
    queuedMessages={[queued]}
    onEditQueuedEntry={() => undefined}
  /></LocaleProvider>);
  const document = parseMarkup(`<html><body>${markup}</body></html>`).document;
  const edit = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => (button.getAttribute('aria-label') ?? button.textContent) === 'Edit',
  );
  assert.ok(edit);
  assert.equal(edit.disabled, false);
  assert.notEqual(edit.getAttribute('aria-disabled'), 'true');
});
