/**
 * #1433: `quickChat:start` was a second session-creation IPC whose only
 * distinct job was turning a product mode into session fields. The IPC is
 * gone; this is the part that survived, so the gates it used to carry are
 * pinned here.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { DEEP_RESEARCH_SESSION_LABEL, normalizeQuickChatMode } from '@maka/core';

import { sessionModeSeed } from '../session-mode-seed.js';

describe('session mode seed', () => {
  it('forces the read-only boundary for Deep Research', () => {
    const seed = sessionModeSeed('deep_research');
    assert.equal(seed?.permissionMode, 'explore');
    assert.equal(seed?.name, 'Deep Research');
    assert.deepEqual(seed?.labels, [DEEP_RESEARCH_SESSION_LABEL]);
  });

  it('leaves plain chat entirely to the regular create path', () => {
    // No seed means `sessions:create` keeps resolving the configured
    // default permission mode — a mode must not silently become an
    // override channel for sessions that did not ask for one.
    assert.equal(sessionModeSeed('chat'), undefined);
    assert.equal(sessionModeSeed(undefined), undefined);
  });

  it('cannot be reached by an unrecognized mode from the renderer', () => {
    for (const raw of ['explore', 'admin', '', null, 42, {}]) {
      assert.equal(sessionModeSeed(normalizeQuickChatMode(raw)), undefined);
    }
  });
});
