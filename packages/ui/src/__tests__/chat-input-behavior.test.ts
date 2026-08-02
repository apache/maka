import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createChatInputActionOwner,
  detectMentionTrigger,
  fileTransferContainsFiles,
  focusTextInputAtEnd,
  isChatInputComposing,
  mentionQueryMatches,
  skillMentionQuery,
} from '../chat-input-behavior.js';
import { addUniqueComposerSkillSelection } from '../use-composer-skill-draft.js';

describe('shared chat input behavior', () => {
  it('recognizes composition and file transfers across browser event shapes', () => {
    assert.equal(isChatInputComposing({ key: 'Enter', nativeEvent: { isComposing: true } }), true);
    assert.equal(isChatInputComposing({ key: 'Process', nativeEvent: {} }), true);
    assert.equal(isChatInputComposing({ nativeEvent: {} }, true), true);
    assert.equal(isChatInputComposing({ key: 'Enter', nativeEvent: {} }), false);
    assert.equal(fileTransferContainsFiles(['text/plain', 'Files'], 0), true);
    assert.equal(fileTransferContainsFiles(['text/plain'], 1), true);
    assert.equal(fileTransferContainsFiles(['text/plain'], 0), false);
  });

  it('focuses a text input at the visible value end', () => {
    const calls: Array<string | [number, number]> = [];
    focusTextInputAtEnd({
      value: 'hello',
      focus: () => calls.push('focus'),
      setSelectionRange: (start, end) => calls.push([start, end]),
    });
    assert.deepEqual(calls, ['focus', [5, 5]]);
  });

  it('serializes async actions and releases only their owned pending state', async () => {
    const states: Array<string | null> = [];
    const owner = createChatInputActionOwner<string>((action) => states.push(action));
    let release!: () => void;
    const first = owner.run(
      'drop',
      () => new Promise<string>((resolve) => (release = () => resolve('done'))),
    );
    assert.equal(await owner.run('paste', async () => 'ignored'), undefined);
    release();
    assert.equal(await first, 'done');
    assert.equal(owner.pending, null);
    assert.deepEqual(states, ['drop', null]);
  });

  it('does not let late completion clear state after reset', async () => {
    const states: Array<string | null> = [];
    const owner = createChatInputActionOwner<string>((action) => states.push(action));
    let release!: () => void;
    const action = owner.run('drop', () => new Promise<void>((resolve) => (release = resolve)));
    owner.reset();
    release();
    await action;
    assert.deepEqual(states, ['drop']);
  });
});

describe('detectMentionTrigger', () => {
  it('finds @ queries at boundaries, inside paths, and relative to the caret', () => {
    assert.deepEqual(detectMentionTrigger('@src', 4), { trigger: '@', query: 'src', start: 0 });
    assert.deepEqual(detectMentionTrigger('open @src/app', 13), {
      trigger: '@',
      query: 'src/app',
      start: 5,
    });
    assert.deepEqual(detectMentionTrigger('@src/app', 3), {
      trigger: '@',
      query: 'sr',
      start: 0,
    });
    assert.deepEqual(detectMentionTrigger('@my file', 8), {
      trigger: '@',
      query: 'my file',
      start: 0,
    });
  });

  it('rejects non-boundary and terminated @ queries', () => {
    for (const [value, caret] of [
      ['foo@bar', 7],
      ['user@host.com', 13],
      ['hello world', 11],
      ['@later', 0],
      ['@my  file', 9],
      ['@line\nmore', 10],
    ] as const) {
      assert.equal(detectMentionTrigger(value, caret), null, value);
    }
  });

  it('keeps / queries single-token and chooses the nearest boundary trigger', () => {
    assert.deepEqual(detectMentionTrigger('run /skill', 10), {
      trigger: '/',
      query: 'skill',
      start: 4,
    });
    assert.deepEqual(detectMentionTrigger('@a /b', 5), {
      trigger: '/',
      query: 'b',
      start: 3,
    });
    assert.equal(detectMentionTrigger('/deep research', 14), null);
    assert.equal(detectMentionTrigger('/a\nb', 4), null);
  });
});

describe('mention filtering', () => {
  it('matches case-insensitive AND tokens and treats an empty query as universal', () => {
    assert.equal(mentionQueryMatches('SRC APP', 'src/app.tsx'), true);
    assert.equal(mentionQueryMatches('src app', 'src/main.tsx'), false);
    assert.equal(mentionQueryMatches('', 'anything'), true);
  });

  it('normalizes /skill prefixes while preserving bare queries', () => {
    assert.equal(skillMentionQuery('skill:wri'), 'wri');
    assert.equal(skillMentionQuery('SKILL:wri'), 'wri');
    assert.equal(skillMentionQuery('writer'), 'writer');
  });
});

describe('structured Skill selections', () => {
  it('deduplicates stable identities while keeping same-id selections from distinct refs', () => {
    const alpha = { id: 'alpha', name: 'Alpha' };
    assert.deepEqual(
      addUniqueComposerSkillSelection([alpha], { id: 'ALPHA', name: 'Renamed Alpha' }),
      [alpha],
    );
    const project = { ref: 'project:maka:writer', id: 'writer', name: 'Project Writer' };
    const user = { ref: 'user:agents:writer', id: 'writer', name: 'User Writer' };
    assert.deepEqual(addUniqueComposerSkillSelection([project], user), [project, user]);
  });
});
