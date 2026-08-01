import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { createDefaultSettings, mergeSettings, type AppSettings } from '@maka/core';
import type { MakaTool, MakaToolContext } from '@maka/runtime';
import type { z } from 'zod';
import {
  buildAgentSettingsTools,
  MAKA_SETTINGS_GET_TOOL_NAME,
  MAKA_SETTINGS_UPDATE_TOOL_NAME,
} from '../agent-settings-tools.js';

function fixture() {
  let settings = createDefaultSettings();
  const patches: unknown[] = [];
  const tools = buildAgentSettingsTools({
    settingsStore: { get: async () => settings },
    updateSettings: async (patch) => {
      patches.push(structuredClone(patch));
      settings = mergeSettings(settings, patch);
      return settings;
    },
  });
  return {
    tools,
    patches,
    readSettings: () => settings,
    replaceSettings: (next: AppSettings) => {
      settings = next;
    },
  };
}

function toolByName(tools: MakaTool[], name: string): MakaTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Missing tool ${name}`);
  return tool;
}

function context(
  answer?: string | null,
  capture?: { questions?: unknown },
): MakaToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    cwd: '/tmp',
    toolCallId: 'tool-call-1',
    abortSignal: new AbortController().signal,
    emitOutput: () => {},
    ...(answer !== undefined
      ? {
          askUserQuestion: async (questions) => {
            if (capture) capture.questions = questions;
            return {
              answers: questions.map((question) => ({
                question: question.question,
                answer,
              })),
            };
          },
        }
      : {}),
  };
}

describe('Agent settings tools', () => {
  it('registers a replay-safe read tool and an exclusive confirmed update tool', () => {
    const { tools } = fixture();
    const getTool = toolByName(tools, MAKA_SETTINGS_GET_TOOL_NAME);
    const updateTool = toolByName(tools, MAKA_SETTINGS_UPDATE_TOOL_NAME);

    assert.equal(getTool.categoryHint, 'read');
    assert.equal(getTool.recoveryMode, 'replay_safe');
    assert.equal(updateTool.categoryHint, 'custom_tool');
    assert.equal(updateTool.recoveryMode, 'never_auto_retry');
    assert.equal(updateTool.executionSemantics, 'exclusive_step');
  });

  it('returns only the non-secret settings projection', async () => {
    const h = fixture();
    h.replaceSettings(
      mergeSettings(h.readSettings(), {
        network: { proxy: { password: 'proxy-secret' } },
        webSearch: { providers: { tavily: { apiKey: 'tavily-secret' } } },
        personalization: { displayName: 'cc', assistantTone: 'concise' },
      }),
    );
    const getTool = toolByName(h.tools, MAKA_SETTINGS_GET_TOOL_NAME);
    const result = await getTool.impl({}, context());
    const serialized = JSON.stringify(result);

    assert.deepEqual((result as { personalization: unknown }).personalization, {
      displayName: 'cc',
      assistantTone: 'concise',
      uiLocale: 'auto',
    });
    assert.doesNotMatch(serialized, /proxy-secret|tavily-secret/);
    assert.doesNotMatch(serialized, /apiKey|token|password|openGateway|network/);
  });

  it('rejects non-allowlisted sections at the schema boundary', () => {
    const updateTool = toolByName(fixture().tools, MAKA_SETTINGS_UPDATE_TOOL_NAME);
    const schema = updateTool.parameters as z.ZodType;

    assert.equal(schema.safeParse({ openGateway: { enabled: true } }).success, false);
    assert.equal(schema.safeParse({ chatDefaults: { permissionMode: 'bypass' } }).success, false);
    assert.equal(schema.safeParse({ webSearch: { apiKey: 'secret' } }).success, false);
  });

  it('asks for confirmation, then persists the exact allowlisted patch', async () => {
    const h = fixture();
    const capture: { questions?: unknown } = {};
    const updateTool = toolByName(h.tools, MAKA_SETTINGS_UPDATE_TOOL_NAME);
    const result = (await updateTool.impl(
      {
        appearance: { theme: 'dark' },
        personalization: { assistantTone: 'Be direct.' },
        system: { keepSystemAwake: true },
      },
      context('Apply changes', capture),
    )) as { ok: boolean; applied: boolean; changes: string[] };

    assert.equal(result.ok, true);
    assert.equal(result.applied, true);
    assert.deepEqual(h.patches, [
      {
        appearance: { theme: 'dark' },
        personalization: { assistantTone: 'Be direct.' },
        system: { keepSystemAwake: true },
      },
    ]);
    assert.equal(h.readSettings().appearance.theme, 'dark');
    assert.equal(h.readSettings().personalization.assistantTone, 'Be direct.');
    assert.equal(h.readSettings().system.keepSystemAwake, true);
    assert.match(JSON.stringify(capture.questions), /appearance\.theme/);
    assert.match(JSON.stringify(capture.questions), /system\.keepSystemAwake/);
  });

  it('does not write when the user cancels', async () => {
    const h = fixture();
    const updateTool = toolByName(h.tools, MAKA_SETTINGS_UPDATE_TOOL_NAME);
    const result = (await updateTool.impl(
      { notifications: { runComplete: false } },
      context('Cancel'),
    )) as { ok: boolean; applied: boolean; reason: string };

    assert.deepEqual(result, {
      kind: 'maka_settings_update',
      ok: true,
      applied: false,
      reason: 'cancelled',
      message: 'Maka settings were not changed.',
      settings: {
        appearance: { theme: 'auto', palette: 'default' },
        personalization: { displayName: '', assistantTone: '', uiLocale: 'auto' },
        localMemory: { enabled: true, agentReadEnabled: false },
        workspaceInstructions: { enabled: true },
        privacy: { incognitoActive: false },
        notifications: { runComplete: true },
        system: { keepSystemAwake: false },
        webSearch: { enabled: false },
      },
    });
    assert.deepEqual(h.patches, []);
  });

  it('skips confirmation and writing when every requested value is unchanged', async () => {
    const h = fixture();
    const updateTool = toolByName(h.tools, MAKA_SETTINGS_UPDATE_TOOL_NAME);
    const result = (await updateTool.impl(
      { appearance: { theme: 'auto' }, notifications: { runComplete: true } },
      context(),
    )) as { ok: boolean; applied: boolean };

    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.deepEqual(h.patches, []);
  });

  it('fails closed when the current surface cannot ask for confirmation', async () => {
    const h = fixture();
    const updateTool = toolByName(h.tools, MAKA_SETTINGS_UPDATE_TOOL_NAME);
    const result = (await updateTool.impl(
      { webSearch: { enabled: true } },
      context(),
    )) as { ok: boolean; applied: boolean; reason: string };

    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'confirmation_unavailable');
    assert.deepEqual(h.patches, []);
  });
});
