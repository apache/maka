/**
 * Changing the global default permission mode must not escalate a session
 * whose restrictive mode is a security boundary.
 *
 * The composer's picker is GLOBAL — it writes `chatDefaults.permissionMode`,
 * and `applySettingsRuntimeEffects` then pushes that mode onto existing
 * sessions. Several flows deliberately create sessions at `explore` as their
 * read-only boundary: Deep Research, bot conversations (whose prompts come
 * from a remote sender), expert-team review crews, and cron automations.
 *
 * Before this contract only Deep Research was exempt, by label, so flipping
 * the picker in an unrelated chat silently moved bot / expert-team / cron
 * sessions to `execute` or `bypass`. Bot sessions re-pinned themselves on the
 * next inbound message; expert-team and cron sessions never did.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createSettingsRuntimeEffects } from '../settings-runtime-effects.js';

interface FakeSession {
  id: string;
  permissionMode: string;
  labels: string[];
  status: string;
}

function harness(sessions: FakeSession[]) {
  const setCalls: Array<{ id: string; mode: string }> = [];
  const settings = {
    chatDefaults: { permissionMode: 'bypass' },
  } as unknown as Parameters<
    ReturnType<typeof createSettingsRuntimeEffects>['applySettingsRuntimeEffects']
  >[0];

  const effects = createSettingsRuntimeEffects({
    settingsStore: { get: async () => settings } as never,
    botRegistry: {} as never,
    openGateway: {} as never,
    keepSystemAwake: { apply: () => {} } as never,
    runtime: {
      listSessions: async () => sessions,
      setPermissionMode: async (id: string, mode: string) => { setCalls.push({ id, mode }); },
    } as never,
    safeSendToRenderer: () => {},
    emitSessionsChanged: () => {},
  });

  return { effects, settings, setCalls };
}

const CHAT = { id: 'chat', permissionMode: 'ask', labels: [], status: 'idle' };

describe('global permission-mode sync', () => {
  it('never escalates a session sitting in explore, whoever conferred it', async () => {
    // `explore` is structurally unreachable as a global default
    // (ChatDefaultPermissionMode excludes it) and the picker never offers
    // it — so a session in `explore` was put there deliberately.
    const pinned: FakeSession[] = [
      { id: 'deep-research', permissionMode: 'explore', labels: ['deep-research'], status: 'idle' },
      { id: 'bot', permissionMode: 'explore', labels: ['bot', 'telegram'], status: 'idle' },
      { id: 'expert-team', permissionMode: 'explore', labels: ['expert-team:review'], status: 'idle' },
      { id: 'cron', permissionMode: 'explore', labels: ['automation', 'cron'], status: 'idle' },
    ];
    const h = harness([...pinned, CHAT]);

    await h.effects.applySettingsRuntimeEffects(h.settings, { chatDefaults: { permissionMode: 'bypass' } } as never);

    assert.deepEqual(
      h.setCalls.map((c) => c.id).sort(),
      ['chat'],
      'only the ordinary chat may follow the new default; every explore-pinned session must be left alone',
    );
  });

  it('still applies the new default to ordinary sessions', async () => {
    const h = harness([CHAT, { id: 'chat2', permissionMode: 'execute', labels: [], status: 'idle' }]);
    await h.effects.applySettingsRuntimeEffects(h.settings, { chatDefaults: { permissionMode: 'bypass' } } as never);
    assert.deepEqual(h.setCalls.map((c) => c.id).sort(), ['chat', 'chat2']);
    assert.ok(h.setCalls.every((c) => c.mode === 'bypass'));
  });

  it('leaves busy sessions to be reconciled later rather than mutating mid-run', async () => {
    const h = harness([
      { id: 'running', permissionMode: 'ask', labels: [], status: 'running' },
      { id: 'waiting', permissionMode: 'ask', labels: [], status: 'waiting_for_user' },
      CHAT,
    ]);
    await h.effects.applySettingsRuntimeEffects(h.settings, { chatDefaults: { permissionMode: 'bypass' } } as never);
    assert.deepEqual(h.setCalls.map((c) => c.id), ['chat']);
  });
});
