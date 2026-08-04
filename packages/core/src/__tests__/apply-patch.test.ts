import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyUpdateChunksToContent,
  assertSafePatchPath,
  canonicalizeApplyPatchHunks,
  parseApplyPatch,
  planApplyPatchMutations,
} from '../apply-patch.js';

function envelope(body: string): string {
  return `*** Begin Patch\n${body}*** End Patch\n`;
}

describe('parseApplyPatch', () => {
  test('parses add, update, move, and delete operations', () => {
    const patch = envelope(
      [
        '*** Add File: hello.txt',
        '+Hello',
        '*** Update File: src/app.py',
        '*** Move to: src/main.py',
        '@@ def greet():',
        '-print("Hi")',
        '+print("Hello")',
        '*** Delete File: obsolete.txt',
        '',
      ].join('\n'),
    );
    const parsed = parseApplyPatch(patch);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.hunks.length, 3);
    assert.deepEqual(parsed.value.hunks[0], {
      kind: 'add',
      path: 'hello.txt',
      contents: 'Hello\n',
    });
    assert.equal(parsed.value.hunks[1]?.kind, 'update');
    if (parsed.value.hunks[1]?.kind === 'update') {
      assert.equal(parsed.value.hunks[1].path, 'src/app.py');
      assert.equal(parsed.value.hunks[1].movePath, 'src/main.py');
      assert.equal(parsed.value.hunks[1].chunks.length, 1);
    }
    assert.deepEqual(parsed.value.hunks[2], { kind: 'delete', path: 'obsolete.txt' });
  });

  test('strips heredoc wrappers in lenient mode', () => {
    const patch = [
      "<<'EOF'",
      '*** Begin Patch',
      '*** Add File: a.txt',
      '+x',
      '*** End Patch',
      'EOF',
    ].join('\n');
    const parsed = parseApplyPatch(patch);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.hunks[0]?.kind, 'add');
  });

  test('rejects absolute paths at the tool safety check', () => {
    assert.ok(assertSafePatchPath('/etc/passwd'));
    assert.ok(assertSafePatchPath('C:/Windows/system32'));
    assert.ok(assertSafePatchPath('../escape'));
    assert.equal(assertSafePatchPath('src/ok.ts'), null);
  });
});

describe('planApplyPatchMutations', () => {
  test('plans aliases and sequential updates against one immutable snapshot', () => {
    const parsed = parseApplyPatch(
      envelope(
        [
          '*** Update File: ./src/a.txt',
          '@@',
          '-one',
          '+two',
          '*** Update File: src//a.txt',
          '@@',
          '-two',
          '+three',
          '',
        ].join('\n'),
      ),
    );
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const hunks = canonicalizeApplyPatchHunks(parsed.value.hunks);
    const plan = planApplyPatchMutations(
      hunks,
      new Map([['src/a.txt', { kind: 'file' as const, content: 'one\n' }]]),
    );
    assert.deepEqual(plan, [
      { operation: 'update', path: 'src/a.txt', content: 'two\n' },
      { operation: 'update', path: 'src/a.txt', content: 'three\n' },
    ]);
  });

  test('allows deleting a symlink entry but never treats it as update content', () => {
    assert.deepEqual(
      planApplyPatchMutations(
        [{ kind: 'delete', path: 'link.txt' }],
        new Map([['link.txt', { kind: 'symlink' as const }]]),
      ),
      [{ operation: 'delete', path: 'link.txt' }],
    );
    assert.throws(
      () =>
        planApplyPatchMutations(
          [
            {
              kind: 'update',
              path: 'link.txt',
              chunks: [{ oldLines: ['a'], newLines: ['b'], isEndOfFile: false }],
            },
          ],
          new Map([['link.txt', { kind: 'symlink' as const }]]),
        ),
      /regular file/,
    );
  });
});

describe('applyUpdateChunksToContent', () => {
  test('applies a unique hunk and preserves CRLF', () => {
    const original = 'line1\r\nline2\r\nline3\r\n';
    const result = applyUpdateChunksToContent(
      original,
      [
        {
          oldLines: ['line2'],
          newLines: ['line2-updated'],
          isEndOfFile: false,
        },
      ],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'line1\r\nline2-updated\r\nline3\r\n');
  });

  test('fails when the hunk is not unique', () => {
    const original = 'a\nx\nb\nx\nc\n';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: ['x'], newLines: ['y'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, false);
  });

  test('pure insertion without EOF marker appends at EOF', () => {
    const original = 'line1\nline2\n';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: [], newLines: ['appended'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'line1\nline2\nappended\n');
  });

  test('preserves CR-only line endings outside the edit', () => {
    const original = 'a\rb\rc\r';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: ['b'], newLines: ['B'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'a\rB\rc\r');
  });

  test('preserves mixed endings outside the edited region', () => {
    const original = 'a\r\nb\nc\r';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: ['b'], newLines: ['B'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    // Untouched lines keep their original terminators; the replaced line uses
    // the file's dominant default ending (CRLF here because the file has CRLF).
    assert.equal(result.content, 'a\r\nB\r\nc\r');
  });

  test('deleting a final line preserves the preceding untouched newline', () => {
    const result = applyUpdateChunksToContent(
      'first\nlast',
      [{ oldLines: ['last'], newLines: [], isEndOfFile: true }],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'first\n');
  });

  test('Codex context match: a substring-only context does not anchor the hunk', () => {
    // `foo` appears inside `prefix foo suffix` but names no whole line, so the
    // matcher must not use the first substring hit as the context line.
    const original = 'prefix foo suffix\nfoo\ntail\n';
    const result = applyUpdateChunksToContent(
      original,
      [
        {
          changeContext: 'foo',
          oldLines: ['tail'],
          newLines: ['INSERT'],
          isEndOfFile: false,
        },
      ],
      'f.txt',
    );
    // The context line is the second line (`foo`), so the old-lines search
    // starts there and finds `tail` immediately after it.
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'prefix foo suffix\nfoo\nINSERT\n');
  });

  test('Codex pure insertion with a context header anchors after the context line', () => {
    const original = 'first\ncontext line\nlast\n';
    const result = applyUpdateChunksToContent(
      original,
      [
        {
          changeContext: 'context line',
          oldLines: [],
          newLines: ['INSERT'],
          isEndOfFile: false,
        },
      ],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'first\ncontext line\nINSERT\nlast\n');
  });

  test('Codex pure insertion with a substring-only context falls back to EOF', () => {
    // The context names no whole line (only a substring of `prefix foo suffix`),
    // so a pure addition is placed at EOF instead of an arbitrary position.
    const original = 'prefix foo suffix\nlast\n';
    const result = applyUpdateChunksToContent(
      original,
      [
        {
          changeContext: 'foo',
          oldLines: [],
          newLines: ['INSERT'],
          isEndOfFile: false,
        },
      ],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'prefix foo suffix\nlast\nINSERT\n');
  });

  test('Codex ambiguous context prefers the first whole-line match', () => {
    const original = 'a\ncontext\nb\ncontext\nc\n';
    const result = applyUpdateChunksToContent(
      original,
      [
        {
          changeContext: 'context',
          oldLines: [],
          newLines: ['INSERT'],
          isEndOfFile: false,
        },
      ],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'a\ncontext\nINSERT\nb\ncontext\nc\n');
  });

  test('Codex repeated old-lines still requires a unique match', () => {
    const original = 'x\nx\n';
    const result = applyUpdateChunksToContent(
      original,
      [{ oldLines: ['x'], newLines: ['y'], isEndOfFile: false }],
      'f.txt',
    );
    assert.equal(result.ok, false);
  });

  test('Codex EOF marker inserts at the end regardless of context', () => {
    const original = 'context line\nlast\n';
    const result = applyUpdateChunksToContent(
      original,
      [
        {
          changeContext: 'context line',
          oldLines: [],
          newLines: ['INSERT'],
          isEndOfFile: true,
        },
      ],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'context line\nlast\nINSERT\n');
  });

  test('Codex context matching tolerates trailing-whitespace drift', () => {
    const original = 'context line   \nlast\n';
    const result = applyUpdateChunksToContent(
      original,
      [
        {
          changeContext: 'context line',
          oldLines: [],
          newLines: ['INSERT'],
          isEndOfFile: false,
        },
      ],
      'f.txt',
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.content, 'context line   \nINSERT\nlast\n');
  });
});
