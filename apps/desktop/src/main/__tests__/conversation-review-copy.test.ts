import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';

describe('conversation changes copy', () => {
  it('describes one Git-backed changes surface', () => {
    for (const locale of ['zh', 'en'] as const) {
      const copy = getDesktopConversationCopy(locale);

      assert.equal('lastTurnSource' in copy.reviewPanel, false);
      assert.match(copy.workbar.launcher.review, /Git/);
    }
  });
});
