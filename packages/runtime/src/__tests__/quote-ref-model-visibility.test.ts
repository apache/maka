import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatTextWithInlineRefs } from '../model-history.js';

/**
 * A quote chip renders on the user bubble instead of raw body text, so the
 * excerpt only reaches the model if the inline-ref fold puts it there. These
 * pin that contract: the excerpt is model-visible, tagged, and folded from
 * both call shapes (string + explicit refs, and a RuntimeEventTextContent).
 */
describe('inline quote refs are folded into model-facing text', () => {
  it('appends a tagged block carrying the excerpt verbatim', () => {
    const out = formatTextWithInlineRefs('translate this', {
      quotes: [{ text: 'the quick brown fox' }],
    });

    assert.match(out, /^translate this/);
    assert.match(out, /<quoted_excerpt>\nthe quick brown fox\n<\/quoted_excerpt>/);
  });

  it('carries the label and escapes a quote character that would break the tag', () => {
    const out = formatTextWithInlineRefs('explain', {
      quotes: [{ text: 'body', label: 'assistant "reply"' }],
    });

    assert.match(out, /<quoted_excerpt label="assistant 'reply'">/);
    assert.doesNotMatch(out, /label="assistant "reply""/);
  });

  it('folds every quote and keeps attachments after them', () => {
    const out = formatTextWithInlineRefs('compare', {
      quotes: [{ text: 'first' }, { text: 'second' }],
      attachments: [
        {
          kind: 'other',
          name: 'notes.txt',
          mimeType: 'text/plain',
          bytes: 12,
          ref: { kind: 'session_file', sessionId: 's1', relativePath: 'notes-1' },
        },
      ],
    });

    assert.ok(out.indexOf('first') < out.indexOf('second'));
    assert.ok(out.indexOf('second') < out.indexOf('<attachment>'));
    assert.match(out, /"ref":"maka:\/\/runtime\/attachments\/notes-1"/);
  });

  it('gives Read an actionable path for workspace attachments', () => {
    const out = formatTextWithInlineRefs('inspect', {
      attachments: [
        {
          kind: 'other',
          name: 'notes.txt',
          mimeType: 'text/plain',
          bytes: 12,
          ref: { kind: 'workspace_file', relativePath: 'docs/notes.txt' },
        },
      ],
    });

    assert.match(out, /"path":"docs\/notes.txt"/);
  });

  it('reads quotes off a RuntimeEventTextContent without explicit refs', () => {
    const out = formatTextWithInlineRefs({
      kind: 'text',
      text: 'summarize',
      quotes: [{ text: 'ledger excerpt', sourceTurnId: 'turn-7' }],
    });

    assert.match(out, /<quoted_excerpt>\nledger excerpt\n<\/quoted_excerpt>/);
  });

  it('leaves text untouched when the turn carries no refs', () => {
    assert.equal(formatTextWithInlineRefs('plain turn'), 'plain turn');
    assert.equal(formatTextWithInlineRefs('plain turn', { quotes: [] }), 'plain turn');
  });

  it('keeps sent token metadata out of model-facing text', () => {
    assert.equal(
      formatTextWithInlineRefs({
        kind: 'text',
        text: 'inspect @docs/plan.md',
        inlineReferences: [
          {
            kind: 'workspace_file',
            value: '@docs/plan.md',
            label: 'Secret UI label',
            start: 8,
          },
        ],
      }),
      'inspect @docs/plan.md',
    );
  });
});
