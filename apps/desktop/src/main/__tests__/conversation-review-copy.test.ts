import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getDesktopConversationCopy } from '../../renderer/locales/conversation-copy.js';

describe('conversation changes copy', () => {
  it('describes one Git-backed changes surface', () => {
    for (const locale of ['zh', 'en'] as const) {
      const copy = getDesktopConversationCopy(locale);
      const summary = [
        copy.reviewPanel.changedFiles(3),
        copy.reviewPanel.addedLines(63),
        copy.reviewPanel.deletedLines(98),
      ].join(' ');

      assert.equal('lastTurnSource' in copy.reviewPanel, false);
      assert.match(copy.workbar.launcher.review, /Git/);
      assert.match(summary, /3/);
      assert.match(summary, /63/);
      assert.match(summary, /98/);
      assert.doesNotMatch(summary, /[·+]/);
    }
  });
});
