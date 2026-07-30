import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseNavigationState, selectNavigation } from '../../renderer/nav-selection.js';

describe('sidebar navigation state', () => {
  it('migrates legacy module destinations into their hub tabs', () => {
    assert.deepEqual(parseNavigationState(JSON.stringify({ section: 'skills' })), {
      selection: { section: 'extensions', module: 'skills' },
      moduleMemory: { extensions: 'skills', automations: 'plan-reminders' },
    });
    assert.deepEqual(parseNavigationState(JSON.stringify({ section: 'mcp' })), {
      selection: { section: 'extensions', module: 'mcp' },
      moduleMemory: { extensions: 'mcp', automations: 'plan-reminders' },
    });
    assert.deepEqual(parseNavigationState(JSON.stringify({ section: 'daily-review' })), {
      selection: { section: 'automations', module: 'daily-review' },
      moduleMemory: { extensions: 'skills', automations: 'daily-review' },
    });
    assert.deepEqual(parseNavigationState(JSON.stringify({ section: 'automations' })), {
      selection: { section: 'automations', module: 'plan-reminders' },
      moduleMemory: { extensions: 'skills', automations: 'plan-reminders' },
    });
  });

  it('remembers each hub tab while navigating elsewhere', () => {
    const initial = parseNavigationState(null);
    const mcp = selectNavigation(initial, { section: 'extensions', module: 'mcp' });
    const dailyReview = selectNavigation(mcp, { section: 'automations', module: 'daily-review' });
    const sessions = selectNavigation(dailyReview, { section: 'sessions', filter: 'chats' });

    assert.deepEqual(sessions, {
      selection: { section: 'sessions', filter: 'chats' },
      moduleMemory: { extensions: 'mcp', automations: 'daily-review' },
    });
  });

  it('restores persisted tab memory independently of the active destination', () => {
    assert.deepEqual(parseNavigationState(JSON.stringify({
      selection: { section: 'sessions', filter: 'chats' },
      moduleMemory: { extensions: 'mcp', automations: 'daily-review' },
    })), {
      selection: { section: 'sessions', filter: 'chats' },
      moduleMemory: { extensions: 'mcp', automations: 'daily-review' },
    });
  });
});
