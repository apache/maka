import assert from 'node:assert/strict';
import test from 'node:test';
import { createAppShellSessionEventHandlers } from '../../renderer/app-shell-session-events.js';
import { createAppShellSessionUiStateController } from '../../renderer/app-shell-session-ui-state.js';

test('queue_update events drive the independent desktop queue projection', () => {
  const controller = createAppShellSessionUiStateController();
  const handlers = createAppShellSessionEventHandlers({
    uiLocale: 'zh',
    activeIdRef: { current: 'session-1' },
    liveTurnBySessionRef: controller.liveTurnBySessionRef,
    refreshMessages: async () => true,
    refreshSessions: async () => [],
    setLiveTurnBySession: controller.setLiveTurnBySession,
    setInteractionBySession: controller.setInteractionBySession,
    setMessageQueueBySession: controller.setMessageQueueBySession,
    showModelSetupToast() {},
    toastApi: { error() {} },
  });

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-1',
    turnId: 'turn-1',
    ts: 1,
    paused: true,
    steering: ['adjust this run'],
    followup: ['do this next'],
  });
  assert.deepEqual(controller.getState().messageQueueBySession['session-1'], {
    paused: true,
    steering: [{
      entryId: 'legacy-steering-0',
      messageId: 'legacy-steering-0',
      content: { text: 'adjust this run' },
      placement: 'current_turn',
      state: 'queued',
    }],
    followup: [{
      entryId: 'legacy-followup-0',
      messageId: 'legacy-followup-0',
      content: { text: 'do this next' },
      placement: 'next_turn',
      state: 'queued',
    }],
  });

  handlers.handleEvent('session-1', {
    type: 'queue_update',
    id: 'queue-2',
    turnId: 'turn-1',
    ts: 2,
    steering: [],
    followup: [],
  });
  assert.equal(controller.getState().messageQueueBySession['session-1'], undefined);
});
