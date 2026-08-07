import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// Shared main-session assembler for #2352. The product identity is a
// module-private detail of assembleMainSessionSystemPrompt, so tests cover it
// through the public assembler rather than reaching into the fragment builder.
describe('assembleMainSessionSystemPrompt', () => {
  it('always leads with the product identity, even with no other parts', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    const text = assembleMainSessionSystemPrompt({});
    assert.ok(text.startsWith('You are Maka,'));
    assert.match(text, /operating on the user's machine/);
    assert.match(text, /reading files, running commands, editing code/);
  });

  it('produces the same identity-leading text on repeated calls (pure static)', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    assert.equal(
      assembleMainSessionSystemPrompt({}),
      assembleMainSessionSystemPrompt({}),
    );
  });

  it('drops undefined parts and joins the rest in a fixed order after identity', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    const text = assembleMainSessionSystemPrompt({
      personalization: 'PREF',
      skills: 'SKILLS',
      // workspaceInstructions omitted → must not produce an empty slot
    });
    assert.match(text, /^You are Maka,[\s\S]*\n\nPREF\n\nSKILLS$/);
    assert.doesNotMatch(text, /\n\n\n/);
  });

  it('omits the identity fragment when identity: false (child-agent reuse)', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    const text = assembleMainSessionSystemPrompt({
      identity: false,
      skills: 'SKILLS',
    });
    assert.doesNotMatch(text, /You are Maka/);
    assert.match(text, /^SKILLS$/);
  });
});
