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
import {
  addUniqueComposerSkillSelection,
} from '../use-composer-skill-draft.js';

describe('shared chat input behavior', () => {
  it('recognizes IME composition from either the native flag or Process key', () => {
    assert.equal(isChatInputComposing({ key: 'Enter', nativeEvent: { isComposing: true } }), true);
    assert.equal(isChatInputComposing({ key: 'Process', nativeEvent: {} }), true);
    assert.equal(isChatInputComposing({ nativeEvent: {} }, true), true);
    assert.equal(isChatInputComposing({ key: 'Enter', nativeEvent: {} }), false);
  });

  it('recognizes file drag and paste payloads without depending on one event type', () => {
    assert.equal(fileTransferContainsFiles(['text/plain', 'Files'], 0), true);
    assert.equal(fileTransferContainsFiles(['text/plain'], 1), true);
    assert.equal(fileTransferContainsFiles(['text/plain'], 0), false);
  });

  it('focuses a text input and moves its selection to the visible value end', () => {
    const calls: Array<string | [number, number]> = [];
    const input = {
      value: 'hello',
      focus: () => calls.push('focus'),
      setSelectionRange: (start: number, end: number) => calls.push([start, end]),
    };
    focusTextInputAtEnd(input);
    assert.deepEqual(calls, ['focus', [5, 5]]);
  });

  it('owns async input actions synchronously and releases only the active action', async () => {
    const states: Array<string | null> = [];
    const owner = createChatInputActionOwner<string>((action) => states.push(action));
    let release!: () => void;
    const first = owner.run('drop', () => new Promise<string>((resolve) => { release = () => resolve('done'); }));
    assert.equal(owner.pending, 'drop');
    assert.equal(await owner.run('paste', async () => 'ignored'), undefined);
    release();
    assert.equal(await first, 'done');
    assert.equal(owner.pending, null);
    assert.deepEqual(states, ['drop', null]);
  });

  it('reset invalidates late completion cleanup', async () => {
    const states: Array<string | null> = [];
    const owner = createChatInputActionOwner<string>((action) => states.push(action));
    let release!: () => void;
    const action = owner.run('drop', () => new Promise<void>((resolve) => { release = resolve; }));
    owner.reset();
    release();
    await action;
    assert.deepEqual(states, ['drop']);
  });
});

describe('detectMentionTrigger', () => {
  it('fires an @ trigger at start-of-input', () => {
    assert.deepEqual(detectMentionTrigger('@', 1), { trigger: '@', query: '', start: 0 });
    assert.deepEqual(detectMentionTrigger('@src', 4), { trigger: '@', query: 'src', start: 0 });
  });

  it('fires an @ trigger after whitespace (word boundary)', () => {
    assert.deepEqual(detectMentionTrigger('open @src/app', 13), { trigger: '@', query: 'src/app', start: 5 });
    assert.deepEqual(detectMentionTrigger('a\n@x', 4), { trigger: '@', query: 'x', start: 2 });
  });

  it('does NOT fire mid-word (no boundary before the trigger)', () => {
    assert.equal(detectMentionTrigger('foo@bar', 7), null);
    assert.equal(detectMentionTrigger('a/b', 3), null);
    assert.equal(detectMentionTrigger('user@host.com', 13), null);
  });

  it('returns null when there is no trigger before the caret', () => {
    assert.equal(detectMentionTrigger('hello world', 11), null);
    assert.equal(detectMentionTrigger('@later', 0), null); // caret before the @
  });

  it('allows single spaces in an @ query (filenames with spaces)', () => {
    assert.deepEqual(detectMentionTrigger('@my file', 8), { trigger: '@', query: 'my file', start: 0 });
  });

  it('kills an @ query on a double space', () => {
    assert.equal(detectMentionTrigger('@my  file', 9), null);
  });

  it('kills an @ query on a newline', () => {
    assert.equal(detectMentionTrigger('@line\nmore', 10), null);
  });

  it('fires a / trigger as a single token', () => {
    assert.deepEqual(detectMentionTrigger('/', 1), { trigger: '/', query: '', start: 0 });
    assert.deepEqual(detectMentionTrigger('/deep', 5), { trigger: '/', query: 'deep', start: 0 });
    assert.deepEqual(detectMentionTrigger('run /skill', 10), { trigger: '/', query: 'skill', start: 4 });
  });

  it('kills a / query on ANY space or newline', () => {
    assert.equal(detectMentionTrigger('/deep research', 14), null);
    assert.equal(detectMentionTrigger('/a\nb', 4), null);
  });

  it('a path-internal slash does not hijack the @ trigger (only boundary triggers count)', () => {
    // The `/` in `@foo/bar` is not at a word boundary, so it is part of the `@`
    // query, not a competing `/` trigger. The `@` stays active with the full path.
    assert.deepEqual(detectMentionTrigger('@foo/bar', 8), { trigger: '@', query: 'foo/bar', start: 0 });
    assert.deepEqual(detectMentionTrigger('@src/app', 8), { trigger: '@', query: 'src/app', start: 0 });
  });

  it('the nearest boundary-anchored trigger wins', () => {
    // A `/` typed at a boundary after an `@…` wins as the active trigger.
    assert.deepEqual(detectMentionTrigger('@a /b', 5), { trigger: '/', query: 'b', start: 3 });
  });

  it('detects the trigger relative to the caret, not the value end', () => {
    // Caret sits right after `@sr`; the trailing `c/app` is ignored.
    assert.deepEqual(detectMentionTrigger('@src/app', 3), { trigger: '@', query: 'sr', start: 0 });
  });
});

describe('mentionQueryMatches', () => {
  it('matches case-insensitively', () => {
    assert.equal(mentionQueryMatches('APP', 'src/app.tsx'), true);
  });

  it('requires every whitespace-separated token (AND-of-substring)', () => {
    assert.equal(mentionQueryMatches('src app', 'src/app.tsx'), true);
    assert.equal(mentionQueryMatches('src app', 'src/main.tsx'), false);
  });

  it('matches everything on an empty query', () => {
    assert.equal(mentionQueryMatches('', 'anything'), true);
  });
});

describe('Skill mention filtering', () => {
  it('supports direct /skill: filtering and bare names', () => {
    assert.equal(skillMentionQuery('skill:wri'), 'wri');
    assert.equal(skillMentionQuery('SKILL:wri'), 'wri');
    assert.equal(skillMentionQuery('writer'), 'writer');
  });
});

describe('structured Skill selections', () => {
  it('deduplicates ids case-insensitively and preserves first-selection order', () => {
    const first = addUniqueComposerSkillSelection([], { id: 'alpha', name: 'Alpha' });
    const second = addUniqueComposerSkillSelection(first, { id: 'beta', name: 'Beta' });
    const duplicate = addUniqueComposerSkillSelection(second, {
      id: 'ALPHA',
      name: 'Renamed Alpha',
    });
    assert.deepEqual(duplicate, [
      { id: 'alpha', name: 'Alpha' },
      { id: 'beta', name: 'Beta' },
    ]);
  });

  it('keeps same-id selections from different stable refs distinct', () => {
    const project = {
      ref: 'project:maka:writer',
      id: 'writer',
      name: 'Project Writer',
    };
    const user = {
      ref: 'user:agents:writer',
      id: 'writer',
      name: 'User Writer',
    };
    assert.deepEqual(addUniqueComposerSkillSelection([project], user), [project, user]);
  });
});
