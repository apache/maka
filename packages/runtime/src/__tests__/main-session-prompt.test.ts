import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

// Shared main-session assembler for #2352. The product identity is a
// module-private detail of assembleMainSessionSystemPrompt, so tests cover it
// through the public assembler. The assembler is order-agnostic (it only
// prepends identity, drops empties, and joins) — these tests pin that contract.
describe('assembleMainSessionSystemPrompt', () => {
  it('always leads with the product identity, even with no other fragments', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    const text = assembleMainSessionSystemPrompt([]);
    assert.ok(text.startsWith('You are Maka,'));
    assert.match(text, /operating on the user's machine/);
    assert.match(text, /reading files, running commands, editing code/);
  });

  it('produces the same identity-leading text on repeated calls (pure static)', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    assert.equal(assembleMainSessionSystemPrompt([]), assembleMainSessionSystemPrompt([]));
  });

  it('prepends identity and joins the supplied fragments in their given order', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    const text = assembleMainSessionSystemPrompt(['PREF', 'SKILLS']);
    // identity leads; fragments follow in the exact order the host supplied
    assert.match(text, /^You are Maka,[\s\S]*\n\nPREF\n\nSKILLS$/);
    assert.doesNotMatch(text, /\n\n\n/);
  });

  it('drops undefined and blank fragments but preserves order of the rest', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    const text = assembleMainSessionSystemPrompt(['PREF', undefined, '   ', 'SKILLS']);
    assert.match(text, /\n\nPREF\n\nSKILLS$/);
    assert.doesNotMatch(text, /\n\n\n/);
  });

  it('omits the identity fragment when identity: false (child-agent reuse)', async () => {
    const { assembleMainSessionSystemPrompt } = await import(
      '../system-prompt/main-session-prompt.js'
    );
    const text = assembleMainSessionSystemPrompt(['SKILLS'], { identity: false });
    assert.doesNotMatch(text, /You are Maka/);
    assert.equal(text, 'SKILLS');
  });
});
