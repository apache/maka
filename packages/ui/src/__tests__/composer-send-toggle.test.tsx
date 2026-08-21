/**
 * The composer's send slot holds ONE control (Astryx's send/stop toggle), and
 * mid-turn it reads Stop while the draft is empty. This is the shape the slot
 * drifted out of once already — a Stop button and a Steer button side by side —
 * so the count is asserted, not just the label.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from '../composer.js';
import { LocaleProvider } from '../locale-context.js';

function renderComposer(streaming: boolean): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer streaming={streaming} onSend={() => undefined} onStop={() => undefined} />
    </LocaleProvider>,
  );
}

function renderComposerWithDictation(state: 'idle' | 'recording' = 'idle'): string {
  return renderToStaticMarkup(
    <LocaleProvider locale="en">
      <Composer
        onSend={() => undefined}
        onStop={() => undefined}
        dictation={{
          state,
          elapsedSeconds: state === 'recording' ? 7 : 0,
          audioLevels: [0, 0.25, 0.75, 0.5],
          onStart: () => undefined,
          onStop: () => undefined,
          onCancel: () => undefined,
        }}
      />
    </LocaleProvider>,
  );
}

function sendSlotButtons(markup: string): string[] {
  const slot = markup.split('class="maka-composer-right-controls"').pop() ?? '';
  return slot.match(/aria-label="[^"]*"/g) ?? [];
}

test('an idle composer offers Send alone', () => {
  const buttons = sendSlotButtons(renderComposer(false));
  assert.deepEqual(buttons, ['aria-label="Send"']);
});

test('a turn in flight turns the same single control into Stop', () => {
  const buttons = sendSlotButtons(renderComposer(true));
  assert.deepEqual(buttons, ['aria-label="Stop"']);
});

test('desktop dictation adds a voice action without changing the send control', () => {
  const buttons = sendSlotButtons(renderComposerWithDictation());
  assert.deepEqual(buttons, ['aria-label="Voice input"', 'aria-label="Send"']);
});

test('recording dictation offers live waveform controls for cancel and transcribe', () => {
  const markup = renderComposerWithDictation('recording');
  const buttons = sendSlotButtons(markup);
  assert.deepEqual(buttons, [
    'aria-label="Voice input"',
    'aria-label="Cancel voice input"',
    'aria-label="Stop recording"',
    'aria-label="Send"',
  ]);
  assert.match(markup, /maka-composer-dictation-waveform/);
  assert.match(markup, />0:07</);
});
