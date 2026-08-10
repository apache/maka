import assert from 'node:assert/strict';
import test from 'node:test';
import { planTitlebarChrome } from '../../renderer/app-shell-titlebar-chrome.js';

test('settings owns the front surface: no shell session or workbar chrome', () => {
  assert.deepEqual(
    planTitlebarChrome({
      settingsOpen: true,
      agentsView: 'chat',
      onSessionsSurface: true,
      hasSessionIdentity: true,
      hasWorkbarSession: true,
    }),
    {
      showShellRail: false,
      showSessionIdentity: false,
      showWorkbarActions: false,
    },
  );
});

test('active session on the sessions surface shows shell + workbar chrome', () => {
  assert.deepEqual(
    planTitlebarChrome({
      settingsOpen: false,
      agentsView: 'chat',
      onSessionsSurface: true,
      hasSessionIdentity: true,
      hasWorkbarSession: true,
    }),
    {
      showShellRail: true,
      showSessionIdentity: true,
      showWorkbarActions: true,
    },
  );
});

test('sessions surface without an active session keeps search/sidebar only', () => {
  assert.deepEqual(
    planTitlebarChrome({
      settingsOpen: false,
      agentsView: 'chat',
      onSessionsSurface: true,
      hasSessionIdentity: false,
      hasWorkbarSession: false,
    }),
    {
      showShellRail: true,
      showSessionIdentity: false,
      showWorkbarActions: false,
    },
  );
});

test('session identity can appear before workbar while a placeholder view loads', () => {
  assert.deepEqual(
    planTitlebarChrome({
      settingsOpen: false,
      agentsView: 'chat',
      onSessionsSurface: true,
      hasSessionIdentity: true,
      hasWorkbarSession: false,
    }),
    {
      showShellRail: true,
      showSessionIdentity: true,
      showWorkbarActions: false,
    },
  );
});

test('module hubs that own the column drop workbar actions', () => {
  for (const agentsView of ['skills', 'cron', 'daily-review'] as const) {
    assert.deepEqual(
      planTitlebarChrome({
        settingsOpen: false,
        agentsView,
        onSessionsSurface: false,
        hasSessionIdentity: false,
        hasWorkbarSession: false,
      }),
      {
        showShellRail: true,
        showSessionIdentity: false,
        showWorkbarActions: false,
      },
    );
  }
});
